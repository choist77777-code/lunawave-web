// use-token.js - 루나 사용 (앱에서 기능 사용 시 호출)
// 참고: 파일명은 호환성 유지를 위해 use-token.js 유지
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 루나 비용 정의
const LUNA_COSTS = {
    song_generate: 1,
    auto_input: 1,
    metadata_gemini: 1.5,
    metadata_gpt: 2,
    metadata_regen: 1,
    youtube_trend: 0.5,
    cutout_standard: 0.5,
    cutout_high: 1,
    cutout_ultra: 2,
    render_1img: 1,
    render_2img: 5,
    subtitle_sync: 2,
    halo_remove: 0.3,
    edge_blend: 0.2,
    color_temperature: 0.3,
    oneclick_auto: 10,
    youtube_upload: 10,
    batch_5: 8,
    song_download: 0.5
};

// 일간 루나 지급량
const DAILY_LUNAS = {
    free: 20,
    pro: 50
};

// Pro 전용 기능
const PRO_ONLY_FEATURES = [
    'render_2img',
    'cutout_standard',
    'cutout_high',
    'cutout_ultra',
    'metadata_gemini',
    'metadata_gpt',
    'metadata_regen',
    'subtitle_sync',
    'halo_remove',
    'edge_blend',
    'color_temperature',
    'youtube_upload',
    'batch_5'
];

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

        // 일간 루나 자동 지급 체크
        await checkDailyLunaGrant(user.id, profile);

        // 프로필 조회
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError) {
            throw profileError;
        }

        // Free 플랜 처리 - 이제 루나 기반으로 동작
        if (profile.plan === 'free' || profile.plan === null) {
            // Pro 전용 기능 차단
            if (PRO_ONLY_FEATURES.includes(feature)) {
                return {
                    statusCode: 403,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'pro_required',
                        message: 'Pro 플랜 전용 기능입니다.',
                        feature: feature
                    })
                };
            }

            // Free 플랜도 루나 차감 방식 사용 (매일 20루나 지급)
            const lunas_balance = profile.lunas_balance || 0;
            const lunas_purchased = profile.lunas_purchased || 0;
            const total_lunas = lunas_balance + lunas_purchased;

            if (total_lunas < cost) {
                return {
                    statusCode: 402,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'insufficient_lunas',
                        message: '루나가 부족합니다. 내일 다시 시도하거나 Pro로 업그레이드하세요.',
                        cost: cost,
                        current_balance: total_lunas
                    })
                };
            }

            // 루나 차감 (일간 먼저, 그 다음 구매)
            let new_balance = lunas_balance;
            let new_purchased = lunas_purchased;

            if (lunas_balance >= cost) {
                new_balance = lunas_balance - cost;
            } else {
                const remaining_cost = cost - lunas_balance;
                new_balance = 0;
                new_purchased = lunas_purchased - remaining_cost;
            }

            await supabase
                .from('profiles')
                .update({
                    lunas_balance: new_balance,
                    lunas_purchased: new_purchased,
                    updated_at: new Date().toISOString()
                })
                .eq('id', user.id);

            // 루나 로그 기록
            await supabase
                .from('lunas_log')
                .insert({
                    user_id: user.id,
                    action: 'use',
                    amount: -cost,
                    balance_after: new_balance + new_purchased,
                    feature: feature,
                    description: getFeatureDescription(feature)
                });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    plan: 'free',
                    feature: feature,
                    cost: cost,
                    lunas_remaining: new_balance + new_purchased,
                    lunas_balance: new_balance,
                    lunas_purchased: new_purchased,
                    watermark: true // Free는 워터마크 필수
                })
            };
        }

        // Pro 플랜 - 루나 차감
        const lunas_balance = profile.lunas_balance || 0;
        const lunas_purchased = profile.lunas_purchased || 0;
        const total_lunas = lunas_balance + lunas_purchased;

        if (total_lunas < cost) {
            return {
                statusCode: 402,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'insufficient_lunas',
                    message: '루나가 부족합니다.',
                    cost: cost,
                    current_balance: total_lunas,
                    needed: cost - total_lunas
                })
            };
        }

        // 루나 차감 (일간 먼저, 그 다음 구매)
        let new_balance = lunas_balance;
        let new_purchased = lunas_purchased;

        if (lunas_balance >= cost) {
            new_balance = lunas_balance - cost;
        } else {
            const remaining_cost = cost - lunas_balance;
            new_balance = 0;
            new_purchased = lunas_purchased - remaining_cost;
        }

        const now = new Date();

        // 프로필 업데이트
        const { error: updateError } = await supabase
            .from('profiles')
            .update({
                lunas_balance: new_balance,
                lunas_purchased: new_purchased,
                updated_at: now.toISOString()
            })
            .eq('id', user.id);

        if (updateError) {
            throw updateError;
        }

        // 루나 로그 기록
        await supabase
            .from('lunas_log')
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
        const originalTotal = lunas_balance + lunas_purchased;

        if (new_total <= 0) {
            warning = 'lunas_depleted';
        } else if (new_total <= originalTotal * 0.1) {
            warning = 'lunas_low_10';
        } else if (new_total <= originalTotal * 0.3) {
            warning = 'lunas_low_30';
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                plan: 'pro',
                feature: feature,
                cost: cost,
                lunas_remaining: new_total,
                lunas_balance: new_balance,
                lunas_purchased: new_purchased,
                warning: warning,
                watermark: false
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
    const lastGranted = profile.daily_lunas_granted_at;

    // 오늘 이미 지급받았으면 패스
    if (lastGranted === today) {
        return;
    }

    const grantAmount = profile.plan === 'pro' ? DAILY_LUNAS.pro : DAILY_LUNAS.free;

    try {
        // 일간 루나 리셋하고 새로 지급
        await supabase
            .from('profiles')
            .update({
                lunas_balance: grantAmount,
                daily_lunas_granted_at: today,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        // 지급 로그
        await supabase
            .from('lunas_log')
            .insert({
                user_id: userId,
                action: 'daily',
                amount: grantAmount,
                balance_after: grantAmount + (profile.lunas_purchased || 0),
                description: profile.plan === 'pro' ? '일간 루나 지급 (Pro 50)' : '일간 루나 지급 (Free 20)'
            });

        // profile 객체 업데이트
        profile.lunas_balance = grantAmount;
        profile.daily_lunas_granted_at = today;
    } catch (error) {
        console.error('Daily luna grant error:', error);
    }
}

// 기능 설명
function getFeatureDescription(feature) {
    const descriptions = {
        song_generate: '노래 생성',
        auto_input: '자동 입력',
        metadata_gemini: '메타데이터 생성 (Gemini)',
        metadata_gpt: '메타데이터 생성 (GPT)',
        metadata_regen: '메타데이터 재생성',
        youtube_trend: '유튜브 트렌드 분석',
        cutout_standard: '컷아웃 (표준)',
        cutout_high: '컷아웃 (고품질)',
        cutout_ultra: '컷아웃 (울트라)',
        render_1img: '1이미지 렌더링',
        render_2img: '2이미지 렌더링',
        subtitle_sync: '자막 싱크',
        halo_remove: 'Halo 제거',
        edge_blend: 'Edge Blend',
        color_temperature: '색온도 조정',
        oneclick_auto: '원클릭 자동 생성',
        youtube_upload: '유튜브 업로드',
        batch_5: '일괄 처리 (5곡)',
        song_download: '노래 다운로드'
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
            total_lunas_used: (existing?.total_lunas_used || 0) + cost
        };

        // 기능별 카운트 증가
        if (feature === 'render_2img') {
            updates.render_2img_count = (existing?.render_2img_count || 0) + 1;
        } else if (feature === 'render_1img') {
            updates.render_1img_count = (existing?.render_1img_count || 0) + 1;
        } else if (feature.startsWith('cutout_')) {
            updates.cutout_count = (existing?.cutout_count || 0) + 1;
        } else if (feature.startsWith('metadata_')) {
            updates.metadata_count = (existing?.metadata_count || 0) + 1;
        } else if (feature === 'song_generate') {
            updates.song_count = (existing?.song_count || 0) + 1;
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
