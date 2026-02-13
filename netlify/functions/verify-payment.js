// verify-payment.js - 결제 검증 (프론트에서 호출)
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_V2_API_SECRET = process.env.PORTONE_V2_API_SECRET;

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
        const { payment_id, merchant_uid, expected_amount } = body;

        if (!payment_id) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'payment_id is required' })
            };
        }

        // 포트원 V2 API로 결제 정보 조회
        let paymentInfo = null;

        if (PORTONE_V2_API_SECRET) {
            const paymentResponse = await fetch(`https://api.portone.io/payments/${encodeURIComponent(payment_id)}`, {
                headers: { 'Authorization': `PortOne ${PORTONE_V2_API_SECRET}` }
            });

            if (!paymentResponse.ok) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'Payment not found',
                        message: `HTTP ${paymentResponse.status}`
                    })
                };
            }

            const paymentData = await paymentResponse.json();
            paymentInfo = {
                status: paymentData.status === 'PAID' ? 'paid' : paymentData.status,
                amount: paymentData.amount?.total,
                payment_id: paymentData.id,
                merchant_uid: paymentData.merchantId,
                pay_method: paymentData.method?.type,
                paid_at: paymentData.paidAt
            };
        } else {
            // 데모 모드
            console.log('Demo mode: PortOne not configured');
            paymentInfo = {
                status: 'paid',
                amount: expected_amount,
                payment_id: payment_id,
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
            .eq('payment_id', payment_id)
            .single();

        // 사용자 현재 상태 조회
        const { data: profile } = await supabase
            .from('profiles')
            .select('plan, tokens_balance, tokens_purchased')
            .eq('id', user.id)
            .single();

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                verified: true,
                payment: {
                    payment_id: paymentInfo.payment_id,
                    merchant_uid: paymentInfo.merchant_uid,
                    amount: paymentInfo.amount,
                    status: paymentInfo.status,
                    pay_method: paymentInfo.pay_method,
                    paid_at: paymentInfo.paid_at
                },
                profile: {
                    plan: profile?.plan,
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
