// subscribe.js - 월정액 Pro 구독 처리
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;
const PRO_MONTHLY_PRICE = 17900;
const PRO_FIRST_MONTH_PRICE = 8950; // 50% 할인
const MONTHLY_BONUS_LUNAS = 1500; // 월 보너스 루나
const DAILY_LUNAS_PRO = 50; // Pro 일간 루나

exports.handler = async (event) => {
    // CORS headers
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
        // 인증 토큰 확인
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
        const { imp_uid, merchant_uid, billing_key, is_first_payment, promo_code } = body;

        // 결제 금액 계산
        let amount = is_first_payment ? PRO_FIRST_MONTH_PRICE : PRO_MONTHLY_PRICE;
        let promo_discount = 0;

        // 프로모션 코드 적용
        if (promo_code) {
            const { data: promo } = await supabase
                .from('promo_codes')
                .select('*')
                .eq('code', promo_code.toUpperCase())
                .eq('is_active', true)
                .single();

            if (promo && promo.used_count < promo.max_uses) {
                if (!promo.expires_at || new Date(promo.expires_at) > new Date()) {
                    if (promo.type === 'percent') {
                        promo_discount = Math.floor(amount * (promo.value / 100));
                    } else if (promo.type === 'fixed') {
                        promo_discount = promo.value;
                    }
                    amount = Math.max(0, amount - promo_discount);

                    // 사용 횟수 증가
                    const { error: promoUpdateError } = await supabase
                        .from('promo_codes')
                        .update({ used_count: promo.used_count + 1 })
                        .eq('id', promo.id);

                    if (promoUpdateError) {
                        console.error('Promo code update failed:', promoUpdateError);
                    }
                }
            }
        }

        // 포트원 결제 검증 (실제 환경에서)
        if (PORTONE_API_SECRET && imp_uid) {
            const verifyResponse = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
                headers: {
                    'Authorization': `Bearer ${PORTONE_API_SECRET}`
                }
            });
            const verifyData = await verifyResponse.json();

            if (verifyData.response.status !== 'paid' || verifyData.response.amount !== amount) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Payment verification failed' })
                };
            }
        }

        // 현재 시간
        const now = new Date();
        const plan_expires_at = new Date(now);
        plan_expires_at.setMonth(plan_expires_at.getMonth() + 1);

        // 프로필 업데이트 - Pro 플랜 활성화
        const today = now.toISOString().split('T')[0];
        const { data: currentProfile } = await supabase
            .from('profiles')
            .select('tokens_purchased')
            .eq('id', user.id)
            .single();

        // Pro 첫 구독 시: 일간 50루나 + 월 보너스 1,500루나
        const newPurchased = (currentProfile?.tokens_purchased || 0) + MONTHLY_BONUS_LUNAS;

        const { error: updateError } = await supabase
            .from('profiles')
            .update({
                plan: 'pro',
                plan_started_at: now.toISOString(),
                plan_expires_at: plan_expires_at.toISOString(),
                tokens_balance: DAILY_LUNAS_PRO, // 일간 루나 리셋 및 Pro 50 지급
                tokens_purchased: newPurchased,
                daily_tokens_granted_at: today,
                billing_key: billing_key || null,
                updated_at: now.toISOString()
            })
            .eq('id', user.id);

        if (updateError) {
            throw updateError;
        }

        // 결제 기록 저장
        await supabase
            .from('payments')
            .insert({
                user_id: user.id,
                payment_id: imp_uid,
                merchant_uid: merchant_uid,
                type: 'subscription',
                plan: 'pro',
                tokens_granted: MONTHLY_BONUS_LUNAS, // 컬럼명은 유지
                amount: amount,
                status: 'paid',
                paid_at: now.toISOString()
            });

        // 루나 로그 기록
        await supabase
            .from('tokens_log')
            .insert({
                user_id: user.id,
                action: 'subscription',
                amount: MONTHLY_BONUS_LUNAS,
                balance_after: DAILY_LUNAS_PRO + newPurchased,
                description: 'Pro 구독 - 월간 보너스 루나 지급 (+ 일간 50루나)'
            });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                plan: 'pro',
                tokens_balance: DAILY_LUNAS_PRO,
                tokens_purchased: newPurchased,
                tokens_total: DAILY_LUNAS_PRO + newPurchased,
                plan_expires_at: plan_expires_at.toISOString()
            })
        };

    } catch (error) {
        console.error('Subscribe error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
