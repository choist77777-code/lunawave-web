// verify-payment.js - 결제 검증 (프론트에서 호출) - PortOne V1
const { createClient } = require('@supabase/supabase-js');
const { getPayment } = require('./portone-v1-helper');

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
        // V1: imp_uid 사용, 하위호환을 위해 payment_id도 수용
        const imp_uid = body.imp_uid || body.payment_id;
        const { merchant_uid, expected_amount } = body;

        if (!imp_uid) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'imp_uid is required' })
            };
        }

        // 포트원 V1 API로 결제 정보 조회
        let paymentInfo = null;

        if (process.env.IMP_REST_API_KEY) {
            let paymentData;
            try {
                paymentData = await getPayment(imp_uid);
            } catch (err) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'Payment not found',
                        message: err.message
                    })
                };
            }

            paymentInfo = {
                status: paymentData.status,
                amount: paymentData.amount,
                imp_uid: paymentData.imp_uid,
                payment_id: paymentData.imp_uid,
                merchant_uid: paymentData.merchant_uid,
                pay_method: paymentData.pay_method,
                paid_at: paymentData.paid_at
            };
        } else {
            // 데모 모드
            console.log('Demo mode: PortOne V1 not configured');
            paymentInfo = {
                status: 'paid',
                amount: expected_amount,
                imp_uid: imp_uid,
                payment_id: imp_uid,
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

        // DB에서 결제 기록 조회 (imp_uid 또는 payment_id로 검색)
        let payment = null;
        const { data: byImpUid } = await supabase
            .from('payments')
            .select('*')
            .eq('imp_uid', imp_uid)
            .single();

        if (byImpUid) {
            payment = byImpUid;
        } else {
            const { data: byPaymentId } = await supabase
                .from('payments')
                .select('*')
                .eq('payment_id', imp_uid)
                .single();
            payment = byPaymentId;
        }

        // 사용자 현재 상태 조회
        const { data: profile } = await supabase
            .from('profiles')
            .select('plan, lunas_free, lunas_monthly, lunas_bonus, tokens_purchased')
            .eq('id', user.id)
            .single();

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                verified: true,
                payment: {
                    imp_uid: paymentInfo.imp_uid,
                    payment_id: paymentInfo.payment_id,
                    merchant_uid: paymentInfo.merchant_uid,
                    amount: paymentInfo.amount,
                    status: paymentInfo.status,
                    pay_method: paymentInfo.pay_method,
                    paid_at: paymentInfo.paid_at
                },
                profile: {
                    plan: profile?.plan,
                    lunas_free: profile?.lunas_free || 0,
                    lunas_monthly: profile?.lunas_monthly || 0,
                    lunas_bonus: profile?.lunas_bonus || 0,
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
