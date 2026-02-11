// verify-payment.js - 구독 결제 검증 (프론트에서 호출)
// 구독(subscription) 전용 - 루나 패키지 구매(token_purchase)는 폐지됨
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_IMP_KEY = process.env.PORTONE_IMP_KEY;
const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;

// 유효한 플랜 목록
const VALID_PLANS = ['crescent', 'half', 'full'];
const PLAN_PRICES = {
    crescent: 13900,
    half: 33000,
    full: 79000
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
        const { imp_uid, merchant_uid, expected_amount, plan } = body;

        if (!imp_uid) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'imp_uid is required' })
            };
        }

        // 포트원 API로 결제 정보 조회
        let paymentInfo = null;

        if (PORTONE_API_SECRET) {
            // 액세스 토큰 획득
            const tokenResponse = await fetch('https://api.iamport.kr/users/getToken', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    imp_key: PORTONE_IMP_KEY,
                    imp_secret: PORTONE_API_SECRET
                })
            });
            const tokenData = await tokenResponse.json();

            if (tokenData.code !== 0) {
                throw new Error('Failed to get PortOne access token');
            }

            const accessToken = tokenData.response.access_token;

            // 결제 정보 조회
            const paymentResponse = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
                headers: { 'Authorization': accessToken }
            });
            const paymentData = await paymentResponse.json();

            if (paymentData.code !== 0) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'Payment not found',
                        message: paymentData.message
                    })
                };
            }

            paymentInfo = paymentData.response;
        } else {
            // 데모 모드 - 포트원 설정 없이 테스트
            console.log('Demo mode: PortOne not configured');
            paymentInfo = {
                status: 'paid',
                amount: expected_amount,
                imp_uid: imp_uid,
                merchant_uid: merchant_uid
            };
        }

        // 결제 상태 확인
        if (paymentInfo.status !== 'paid') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'Payment not completed',
                    status: paymentInfo.status
                })
            };
        }

        // 금액 확인
        if (expected_amount && paymentInfo.amount !== expected_amount) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'Amount mismatch',
                    expected: expected_amount,
                    actual: paymentInfo.amount
                })
            };
        }

        // DB에서 결제 기록 조회
        const { data: payment } = await supabase
            .from('payments')
            .select('*')
            .eq('payment_id', imp_uid)
            .single();

        // plan 파라미터가 있으면 유효성 검증
        if (plan && !VALID_PLANS.includes(plan)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'Invalid plan',
                    message: 'plan must be crescent, half, or full'
                })
            };
        }

        // plan이 지정된 경우 예상 금액과 플랜 가격 교차 검증
        if (plan && PLAN_PRICES[plan] && paymentInfo.amount !== PLAN_PRICES[plan]) {
            // 프로모션 할인 등으로 금액이 다를 수 있으므로 경고만 로그
            console.log(`Plan price mismatch: plan=${plan}, expected=${PLAN_PRICES[plan]}, actual=${paymentInfo.amount}`);
        }

        // 사용자 현재 상태 조회
        const { data: profile } = await supabase
            .from('profiles')
            .select('plan, tokens_balance, tokens_purchased')
            .eq('id', user.id)
            .single();

        const planNames = { crescent: '초승달', half: '반달', full: '보름달' };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                verified: true,
                payment: {
                    imp_uid: paymentInfo.imp_uid,
                    merchant_uid: paymentInfo.merchant_uid,
                    amount: paymentInfo.amount,
                    status: paymentInfo.status,
                    pay_method: paymentInfo.pay_method,
                    paid_at: paymentInfo.paid_at
                },
                profile: {
                    plan: profile?.plan,
                    plan_name: planNames[profile?.plan] || 'Free',
                    is_unlimited: profile?.plan === 'full',
                    tokens_balance: profile?.tokens_balance || 0,
                    tokens_purchased: profile?.tokens_purchased || 0
                }
            })
        };

    } catch (error) {
        console.error('Verify payment error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
