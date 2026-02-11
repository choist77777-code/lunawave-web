// apply-promo.js - 프로모션 코드 적용
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        const { code, payment_type } = body;

        if (!code) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Promo code is required' })
            };
        }

        // 프로모션 코드 조회
        const { data: promo, error: promoError } = await supabase
            .from('promo_codes')
            .select('*')
            .eq('code', code.toUpperCase())
            .eq('is_active', true)
            .single();

        if (promoError || !promo) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'invalid_code',
                    message: '유효하지 않은 프로모션 코드입니다.'
                })
            };
        }

        // 만료 확인
        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'expired',
                    message: '만료된 프로모션 코드입니다.'
                })
            };
        }

        // 사용 횟수 확인
        if (promo.used_count >= promo.max_uses) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'limit_reached',
                    message: '사용 한도에 도달한 프로모션 코드입니다.'
                })
            };
        }

        // 프로모션 유형별 처리
        let result = {
            success: true,
            code: promo.code,
            type: promo.type,
            value: promo.value
        };

        switch (promo.type) {
            case 'percent':
                // 퍼센트 할인
                result.discount_type = 'percent';
                result.discount_percent = promo.value;
                result.message = `${promo.value}% 할인이 적용됩니다.`;
                break;

            case 'fixed':
                // 고정 금액 할인
                result.discount_type = 'fixed';
                result.discount_amount = promo.value;
                result.message = `₩${promo.value.toLocaleString()} 할인이 적용됩니다.`;
                break;

            case 'bonus_lunas':
                // 보너스 루나 지급 (결제 완료 후)
                result.discount_type = 'bonus';
                result.bonus_tokens = promo.value;
                result.message = `결제 완료 시 ${promo.value} 루나가 추가 지급됩니다.`;
                break;

            case 'subscription_discount':
                // 구독 할인 (구독 결제 시 적용)
                result.discount_type = 'subscription';
                result.discount_percent = promo.value;
                result.applicable_plans = promo.applicable_plans || ['crescent', 'half', 'full'];
                result.message = `구독 결제 시 ${promo.value}% 할인이 적용됩니다.`;
                break;

            case 'free_lunas':
                // 즉시 루나 지급
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('tokens_purchased, tokens_balance')
                    .eq('id', user.id)
                    .single();

                const newPurchased = (profile?.tokens_purchased || 0) + promo.value;

                await supabase
                    .from('profiles')
                    .update({
                        tokens_purchased: newPurchased,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', user.id);

                // 프로모션 사용 횟수 증가
                await supabase
                    .from('promo_codes')
                    .update({ used_count: promo.used_count + 1 })
                    .eq('id', promo.id);

                // 루나 로그
                await supabase
                    .from('tokens_log')
                    .insert({
                        user_id: user.id,
                        action: 'promo',
                        amount: promo.value,
                        balance_after: (profile?.tokens_balance || 0) + newPurchased,
                        description: `프로모션 코드 적용: ${promo.code}`
                    });

                result.tokens_granted = promo.value;
                result.new_balance = (profile?.tokens_balance || 0) + newPurchased;
                result.message = `${promo.value} 루나가 지급되었습니다!`;
                result.applied = true;
                break;

            case 'free_month':
                // 1개월 무료 구독 (프로모션에 target_plan이 있으면 해당 플랜, 없으면 crescent)
                const promoPlan = promo.target_plan || 'crescent';
                const promoPlanConfig = {
                    crescent: { daily: 50, monthly: 1500, name: '초승달' },
                    half: { daily: 200, monthly: 3000, name: '반달' },
                    full: { daily: 0, monthly: 0, is_unlimited: true, name: '보름달' }
                };
                const targetConfig = promoPlanConfig[promoPlan] || promoPlanConfig.crescent;

                const now = new Date();
                const today = now.toISOString().split('T')[0];
                const plan_expires_at = new Date(now);
                plan_expires_at.setMonth(plan_expires_at.getMonth() + 1);

                const updateData = {
                    plan: promoPlan,
                    plan_started_at: now.toISOString(),
                    plan_expires_at: plan_expires_at.toISOString(),
                    daily_tokens_granted_at: today,
                    updated_at: now.toISOString()
                };

                if (targetConfig.is_unlimited) {
                    updateData.tokens_balance = 0;
                    updateData.tokens_purchased = 0;
                } else {
                    updateData.tokens_balance = targetConfig.daily;
                    updateData.tokens_purchased = targetConfig.monthly;
                }

                await supabase
                    .from('profiles')
                    .update(updateData)
                    .eq('id', user.id);

                await supabase
                    .from('promo_codes')
                    .update({ used_count: promo.used_count + 1 })
                    .eq('id', promo.id);

                const totalGranted = targetConfig.is_unlimited ? 0 : targetConfig.daily + targetConfig.monthly;

                await supabase
                    .from('tokens_log')
                    .insert({
                        user_id: user.id,
                        action: 'promo',
                        amount: totalGranted,
                        balance_after: totalGranted,
                        description: `프로모션 코드 적용: ${promo.code} (1개월 무료 ${targetConfig.name})`
                    });

                result.plan = promoPlan;
                result.plan_name = targetConfig.name;
                result.plan_expires_at = plan_expires_at.toISOString();
                result.is_unlimited = targetConfig.is_unlimited || false;
                result.tokens_granted = totalGranted;
                result.message = targetConfig.is_unlimited
                    ? `${targetConfig.name} 1개월 무료 이용이 시작되었습니다! (무제한)`
                    : `${targetConfig.name} 1개월 무료 이용이 시작되었습니다! (매일 ${targetConfig.daily}루나 + 월 ${targetConfig.monthly}루나)`;
                result.applied = true;
                break;

            default:
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'unknown_type',
                        message: '알 수 없는 프로모션 유형입니다.'
                    })
                };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Apply promo error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
