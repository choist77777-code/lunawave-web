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
    cutout_standard: 2,
    cutout_high: 3,
    cutout_ultra: 5,
    render_1img: 20,
    render_2img: 20,
    subtitle_sync: 2,
    halo_remove: 0.3,
    edge_blend: 0.2,
    color_temperature: 0.3,
    oneclick_auto: 10,
    youtube_upload: 10,
    batch_5: 8,
    song_download: 0.5,
    preview_accurate: 3,
    preview_canvas: 0,
    text_behind: 2,
    outline: 1
};

// 일간 루나 지급량
const DAILY_LUNAS = {
    free: 20,
    crescent: 50,
    halfmoon: 200,
    fullmoon: 999
};

// 플랜별 최소 필요 플랜 레벨 (0=free, 1=crescent, 2=halfmoon, 3=fullmoon)
const PLAN_LEVEL = { free: 0, crescent: 1, halfmoon: 2, fullmoon: 3 };

// 기능별 최소 플랜 레벨
const FEATURE_MIN_PLAN = {
    song_generate: 0, auto_input: 0, render_1img: 0, render_2img: 0,
    song_download: 0, preview_canvas: 0,
    cutout_standard: 1, cutout_high: 1, cutout_ultra: 1,
    metadata_gemini: 1, metadata_gpt: 1, metadata_regen: 1,
    subtitle_sync: 1, preview_accurate: 1,
    halo_remove: 1, edge_blend: 1, color_temperature: 1,
    text_behind: 2, outline: 2,
    youtube_trend: 2,
    oneclick_auto: 2,
    youtube_upload: 3, batch_5: 3
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

        const userPlan = profile.plan || 'free';
        const userLevel = PLAN_LEVEL[userPlan] || 0;
        const requiredLevel = FEATURE_MIN_PLAN[feature] || 0;

        // 플랜 레벨 체크 - 기능 사용에 필요한 최소 플랜 미달
        if (userLevel < requiredLevel) {
            const requiredPlan = Object.keys(PLAN_LEVEL).find(k => PLAN_LEVEL[k] === requiredLevel) || 'crescent';
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'plan_required',
                    message: `${requiredPlan} 플랜 이상에서 사용 가능합니다.`,
                    feature: feature,
                    required_plan: requiredPlan
                })
            };
        }

        // 무료 기능 (cost 0)은 바로 허용
        if (cost === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    plan: userPlan,
                    feature: feature,
                    cost: 0,
                    tokens_remaining: (profile.lunas_free || 0) + (profile.lunas_monthly || 0) + (profile.lunas_bonus || 0) + (profile.tokens_purchased || 0),
                    watermark: userPlan === 'free'
                })
            };
        }

        // fullmoon(보름달) 무제한: 차감 없이 허용
        if (userPlan === 'fullmoon') {
            const fullmoonTotal = (profile.lunas_free || 0) + (profile.lunas_monthly || 0) + (profile.lunas_bonus || 0) + (profile.tokens_purchased || 0);
            await supabase.from('tokens_log').insert({
                user_id: user.id,
                action: 'use',
                amount: 0,
                balance_after: fullmoonTotal,
                feature: feature,
                description: getFeatureDescription(feature) + ' (무제한)'
            });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    plan: 'fullmoon',
                    feature: feature,
                    cost: 0,
                    tokens_remaining: fullmoonTotal,
                    watermark: false,
                    unlimited: true
                })
            };
        }

        // 루나 차감: lunas_free → lunas_monthly → lunas_bonus → tokens_purchased 순서
        {
            const lunas_free = profile.lunas_free || 0;
            const lunas_monthly = profile.lunas_monthly || 0;
            const lunas_bonus = profile.lunas_bonus || 0;
            const tokens_purchased = profile.tokens_purchased || 0;
            const total_tokens = lunas_free + lunas_monthly + lunas_bonus + tokens_purchased;

            if (total_tokens < cost) {
                return {
                    statusCode: 402,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'insufficient_tokens',
                        message: '루나가 부족합니다. 플랜을 업그레이드하세요.',
                        cost: cost,
                        current_balance: total_tokens,
                        needed: cost - total_tokens
                    })
                };
            }

            // 4단계 차감: free → monthly → bonus → purchased
            let remaining = cost;
            let new_free = lunas_free;
            let new_monthly = lunas_monthly;
            let new_bonus = lunas_bonus;
            let new_purchased = tokens_purchased;

            if (remaining > 0 && new_free > 0) {
                const take = Math.min(remaining, new_free);
                new_free -= take; remaining -= take;
            }
            if (remaining > 0 && new_monthly > 0) {
                const take = Math.min(remaining, new_monthly);
                new_monthly -= take; remaining -= take;
            }
            if (remaining > 0 && new_bonus > 0) {
                const take = Math.min(remaining, new_bonus);
                new_bonus -= take; remaining -= take;
            }
            if (remaining > 0 && new_purchased > 0) {
                const take = Math.min(remaining, new_purchased);
                new_purchased -= take; remaining -= take;
            }

            const now_ts = new Date();

            await supabase
                .from('profiles')
                .update({
                    lunas_free: new_free,
                    lunas_monthly: new_monthly,
                    lunas_bonus: new_bonus,
                    tokens_purchased: new_purchased,
                    updated_at: now_ts.toISOString()
                })
                .eq('id', user.id);

            const new_total = new_free + new_monthly + new_bonus + new_purchased;

            await supabase
                .from('tokens_log')
                .insert({
                    user_id: user.id,
                    action: 'use',
                    amount: -cost,
                    balance_after: new_total,
                    feature: feature,
                    description: getFeatureDescription(feature)
                });

            // 사용량 통계
            const yearMonth = `${now_ts.getFullYear()}-${String(now_ts.getMonth() + 1).padStart(2, '0')}`;
            await updateUsageStats(user.id, yearMonth, feature, cost);

            let warning = null;
            if (new_total <= 0) {
                warning = 'tokens_depleted';
            } else if (new_total <= total_tokens * 0.1) {
                warning = 'tokens_low_10';
            } else if (new_total <= total_tokens * 0.3) {
                warning = 'tokens_low_30';
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    plan: userPlan,
                    feature: feature,
                    cost: cost,
                    tokens_remaining: new_total,
                    lunas_free: new_free,
                    lunas_monthly: new_monthly,
                    lunas_bonus: new_bonus,
                    tokens_purchased: new_purchased,
                    warning: warning,
                    watermark: userPlan === 'free'
                })
            };
        }

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

    const grantAmount = DAILY_LUNAS[profile.plan] || DAILY_LUNAS.free;

    try {
        // 일간 루나 리셋하고 새로 지급
        await supabase
            .from('profiles')
            .update({
                lunas_free: grantAmount,
                daily_lunas_granted_at: today,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        // 지급 로그
        await supabase
            .from('tokens_log')
            .insert({
                user_id: userId,
                action: 'daily',
                amount: grantAmount,
                balance_after: grantAmount + (profile.lunas_monthly || 0) + (profile.lunas_bonus || 0) + (profile.tokens_purchased || 0),
                description: `일간 루나 지급 (${profile.plan} ${grantAmount})`
            });

        // profile 객체 업데이트
        profile.lunas_free = grantAmount;
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
        song_download: '노래 다운로드',
        preview_accurate: '정밀 미리보기',
        preview_canvas: '캔버스 미리보기',
        text_behind: '텍스트 비하인드',
        outline: '아웃라인'
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
