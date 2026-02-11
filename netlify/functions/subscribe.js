// subscribe.js - 월정액 구독 처리 (crescent/half/full 3단계)
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;

// 플랜별 설정
const PLAN_CONFIG = {
    crescent: { price: 13900, daily_lunas: 50, monthly_lunas: 1500, name: '초승달' },
    half:     { price: 33000, daily_lunas: 200, monthly_lunas: 3000, name: '반달' },
    full:     { price: 79000, daily_lunas: 0, monthly_lunas: 0, is_unlimited: true, name: '보름달' }
};

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
        const { imp_uid, merchant_uid, billing_key, plan, promo_code } = body;

        // 플랜 유효성 검사
        if (!plan || !PLAN_CONFIG[plan]) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid plan. Must be crescent, half, or full.' })
            };
        }

        const planConfig = PLAN_CONFIG[plan];

        // 결제 금액 계산
        let amount = planConfig.price;
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

        // 프로필 업데이트 - 플랜 활성화
        const today = now.toISOString().split('T')[0];
        const { data: currentProfile } = await supabase
            .from('profiles')
            .select('tokens_purchased')
            .eq('id', user.id)
            .single();

        // 보름달(full)은 무제한이므로 월 루나 지급 불필요
        const monthlyLunas = planConfig.monthly_lunas || 0;
        const dailyLunas = planConfig.daily_lunas || 0;
        const newPurchased = planConfig.is_unlimited ? 0 : (currentProfile?.tokens_purchased || 0) + monthlyLunas;

        const updateData = {
            plan: plan,
            plan_started_at: now.toISOString(),
            plan_expires_at: plan_expires_at.toISOString(),
            daily_tokens_granted_at: today,
            billing_key: billing_key || null,
            updated_at: now.toISOString()
        };

        if (planConfig.is_unlimited) {
            // 보름달: 무제한이므로 루나 수치는 의미 없음
            updateData.tokens_balance = 0;
            updateData.tokens_purchased = 0;
        } else {
            updateData.tokens_balance = dailyLunas;
            updateData.tokens_purchased = newPurchased;
        }

        const { error: updateError } = await supabase
            .from('profiles')
            .update(updateData)
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
                plan: plan,
                tokens_granted: monthlyLunas, // 컬럼명은 유지
                amount: amount,
                status: 'paid',
                paid_at: now.toISOString()
            });

        // 루나 로그 기록
        const logDescription = planConfig.is_unlimited
            ? `${planConfig.name} 구독 - 무제한 플랜`
            : `${planConfig.name} 구독 - 월간 ${monthlyLunas}루나 지급 (+ 일간 ${dailyLunas}루나)`;

        await supabase
            .from('tokens_log')
            .insert({
                user_id: user.id,
                action: 'subscription',
                amount: monthlyLunas,
                balance_after: planConfig.is_unlimited ? 0 : dailyLunas + newPurchased,
                description: logDescription
            });

        const responseData = {
            success: true,
            plan: plan,
            plan_name: planConfig.name,
            plan_expires_at: plan_expires_at.toISOString()
        };

        if (planConfig.is_unlimited) {
            responseData.is_unlimited = true;
        } else {
            responseData.tokens_balance = dailyLunas;
            responseData.tokens_purchased = newPurchased;
            responseData.tokens_total = dailyLunas + newPurchased;
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(responseData)
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
