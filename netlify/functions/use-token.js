// use-token.js - 루나 사용 (앱에서 기능 사용 시 호출)
// 참고: 파일명은 호환성 유지를 위해 use-token.js 유지
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 루나 비용 정의 (새 4단계 요금제)
const LUNA_COSTS = {
    render: 20,
    lyrics: 1,
    preview: 3,
    cutout_ultra: 5,
    cutout_standard: 2,
    behind: 2,
    outline: 1,
    canvas_preview: 0,
    text_edit: 0,
    settings: 0
};

// 일간 루나 지급량 (4단계 플랜)
const DAILY_LUNAS = {
    free: 20,
    crescent: 50,
    half: 200,
    full: 0 // 무제한
};

// 플랜별 기능 접근 제한
// free: Standard Cutout만, Canvas Preview만
// crescent: + Ultra Cutout, Accurate Preview, SRT
// half: + Behind, Outline, AI가사(lyrics), Suno자동화
// full: + YouTube메타데이터, Analytics, 전체 기능
const FEATURE_ACCESS = {
    free: ['cutout_standard', 'canvas_preview', 'text_edit', 'settings', 'render'],
    crescent: ['cutout_standard', 'cutout_ultra', 'preview', 'canvas_preview', 'text_edit', 'settings', 'render'],
    half: ['cutout_standard', 'cutout_ultra', 'preview', 'behind', 'outline', 'lyrics', 'canvas_preview', 'text_edit', 'settings', 'render'],
    full: null // null = 모든 기능 허용
};

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // 인증 확인
        const authHeader = event.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Unauthorized' })
            };
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Invalid token' })
            };
        }

        const body = JSON.parse(event.body);
        const { feature, device_id } = body;

        if (!feature) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Feature is required' })
            };
        }

        // 루나 비용 확인
        const cost = LUNA_COSTS[feature];
        if (cost === undefined) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Unknown feature' })
            };
        }

        // 프로필 조회
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError) {
            throw profileError;
        }

        // 일간 루나 자동 지급 체크
        await checkDailyLunaGrant(user.id, profile);

        // 현재 플랜 확인
        const currentPlan = profile.plan || 'free';
        const isUnlimited = currentPlan === 'full';

        // 기능 접근 제한 확인
        const allowedFeatures = FEATURE_ACCESS[currentPlan];
        if (allowedFeatures !== null && !allowedFeatures.includes(feature)) {
            // 어떤 플랜부터 사용 가능한지 안내
            let requiredPlan = 'full';
            for (const p of ['crescent', 'half', 'full']) {
                const pFeatures = FEATURE_ACCESS[p];
                if (pFeatures === null || pFeatures.includes(feature)) {
                    requiredPlan = p;
                    break;
                }
            }
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'plan_upgrade_required',
                    message: `이 기능은 ${requiredPlan} 플랜 이상에서 사용할 수 있습니다.`,
                    feature: feature,
                    current_plan: currentPlan,
                    required_plan: requiredPlan
                })
            };
        }

        // 무료 기능은 차감 없이 바로 허용 (cost === 0)
        if (cost === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    plan: currentPlan,
                    feature: feature,
                    cost: 0,
                    is_unlimited: isUnlimited,
                    watermark: currentPlan === 'free'
                })
            };
        }

        // 보름달(full) 무제한 플랜 - 차감 로직 스킵
        if (isUnlimited) {
            const now = new Date();

            // 루나 로그 기록 (사용 기록만, 차감 없음)
            await supabase
                .from('tokens_log')
                .insert({
                    user_id: user.id,
                    action: 'use',
                    amount: 0,
                    balance_after: 0,
                    feature: feature,
                    description: getFeatureDescription(feature) + ' (무제한)'
                });

            // 사용량 통계 업데이트
            const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            await updateUsageStats(user.id, yearMonth, feature, cost);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    plan: 'full',
                    feature: feature,
                    cost: 0,
                    is_unlimited: true,
                    watermark: false
                })
            };
        }

        // 유료/무료 플랜 공통 - 루나 차감 (일간 -> 월간 순서)
        const tokens_balance = profile.tokens_balance || 0;
        const tokens_purchased = profile.tokens_purchased || 0;
        const total_tokens = tokens_balance + tokens_purchased;

        if (total_tokens < cost) {
            return {
                statusCode: 402,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'insufficient_tokens',
                    message: '루나가 부족합니다. 플랜을 업그레이드하거나 내일 다시 시도하세요.',
                    cost: cost,
                    current_balance: total_tokens,
                    needed: cost - total_tokens,
                    current_plan: currentPlan
                })
            };
        }

        // 루나 차감 (일간 먼저, 그 다음 월간)
        let new_balance = tokens_balance;
        let new_purchased = tokens_purchased;

        if (tokens_balance >= cost) {
            new_balance = tokens_balance - cost;
        } else {
            const remaining_cost = cost - tokens_balance;
            new_balance = 0;
            new_purchased = tokens_purchased - remaining_cost;
        }

        const now = new Date();

        // 프로필 업데이트
        const { error: updateError } = await supabase
            .from('profiles')
            .update({
                tokens_balance: new_balance,
                tokens_purchased: new_purchased,
                updated_at: now.toISOString()
            })
            .eq('id', user.id);

        if (updateError) {
            throw updateError;
        }

        // 루나 로그 기록
        await supabase
            .from('tokens_log')
            .insert({
                user_id: user.id,
                action: 'use',
                amount: -cost,
                balance_after: new_balance + new_purchased,
                feature: feature,
                description: getFeatureDescription(feature)
            });

        // 사용량 통계 업데이트
        const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        await updateUsageStats(user.id, yearMonth, feature, cost);

        const new_total = new_balance + new_purchased;

        // 루나 잔액 경고
        let warning = null;
        const originalTotal = tokens_balance + tokens_purchased;

        if (new_total <= 0) {
            warning = 'tokens_depleted';
        } else if (new_total <= originalTotal * 0.1) {
            warning = 'tokens_low_10';
        } else if (new_total <= originalTotal * 0.3) {
            warning = 'tokens_low_30';
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                plan: currentPlan,
                feature: feature,
                cost: cost,
                tokens_remaining: new_total,
                tokens_balance: new_balance,
                tokens_purchased: new_purchased,
                warning: warning,
                watermark: currentPlan === 'free'
            })
        };

    } catch (error) {
        console.error('Use luna error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// 일간 루나 자동 지급 체크
async function checkDailyLunaGrant(userId, profile) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const lastGranted = profile.daily_tokens_granted_at;

    // 오늘 이미 지급받았으면 패스
    if (lastGranted === today) {
        return;
    }

    // 보름달(full)은 무제한이므로 일간 지급 불필요
    const currentPlan = profile.plan || 'free';
    if (currentPlan === 'full') {
        // 날짜만 업데이트
        await supabase
            .from('profiles')
            .update({
                daily_tokens_granted_at: today,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);
        profile.daily_tokens_granted_at = today;
        return;
    }

    const grantAmount = DAILY_LUNAS[currentPlan] || DAILY_LUNAS.free;

    try {
        // 일간 루나 리셋하고 새로 지급
        await supabase
            .from('profiles')
            .update({
                tokens_balance: grantAmount,
                daily_tokens_granted_at: today,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        // 지급 로그
        const planNames = { free: 'Free', crescent: '초승달', half: '반달' };
        await supabase
            .from('tokens_log')
            .insert({
                user_id: userId,
                action: 'daily',
                amount: grantAmount,
                balance_after: grantAmount + (profile.tokens_purchased || 0),
                description: `일간 루나 지급 (${planNames[currentPlan] || currentPlan} ${grantAmount})`
            });

        // profile 객체 업데이트
        profile.tokens_balance = grantAmount;
        profile.daily_tokens_granted_at = today;
    } catch (error) {
        console.error('Daily luna grant error:', error);
    }
}

// 기능 설명
function getFeatureDescription(feature) {
    const descriptions = {
        render: '영상 렌더링',
        lyrics: 'AI 가사 생성',
        preview: 'Accurate Preview',
        cutout_ultra: 'Ultra Cutout',
        cutout_standard: 'Standard Cutout',
        behind: 'Behind Person',
        outline: 'Outline',
        canvas_preview: 'Canvas Preview',
        text_edit: '텍스트 편집',
        settings: '설정 변경'
    };
    return descriptions[feature] || feature;
}

// 사용량 통계 업데이트
async function updateUsageStats(userId, yearMonth, feature, cost) {
    try {
        // 기존 통계 조회
        const { data: existing } = await supabase
            .from('usage')
            .select('*')
            .eq('user_id', userId)
            .eq('year_month', yearMonth)
            .single();

        const updates = {
            total_tokens_used: (existing?.total_tokens_used || 0) + cost
        };

        // 기능별 카운트 증가
        if (feature === 'render') {
            updates.render_count = (existing?.render_count || 0) + 1;
        } else if (feature.startsWith('cutout_')) {
            updates.cutout_count = (existing?.cutout_count || 0) + 1;
        } else if (feature === 'lyrics') {
            updates.lyrics_count = (existing?.lyrics_count || 0) + 1;
        } else if (feature === 'preview') {
            updates.preview_count = (existing?.preview_count || 0) + 1;
        } else if (feature === 'behind') {
            updates.behind_count = (existing?.behind_count || 0) + 1;
        } else if (feature === 'outline') {
            updates.outline_count = (existing?.outline_count || 0) + 1;
        }

        if (existing) {
            await supabase
                .from('usage')
                .update(updates)
                .eq('id', existing.id);
        } else {
            await supabase
                .from('usage')
                .insert({
                    user_id: userId,
                    year_month: yearMonth,
                    ...updates
                });
        }
    } catch (error) {
        console.error('Update usage stats error:', error);
    }
}
