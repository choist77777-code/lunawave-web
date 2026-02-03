// payment-webhook.js - 포트원 웹훅 수신 및 처리
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;
const PORTONE_WEBHOOK_SECRET = process.env.PORTONE_WEBHOOK_SECRET;

// 토큰 패키지 정의
const TOKEN_PACKAGES = {
    'small': { tokens: 500, price: 7900 },
    'medium': { tokens: 1000, price: 12900 },
    'large': { tokens: 3000, price: 29900 }
};

const MONTHLY_TOKENS = 1500;

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json'
    };

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // 웹훅 시그니처 검증 (선택적)
        if (PORTONE_WEBHOOK_SECRET) {
            const signature = event.headers['x-portone-signature'];
            const expectedSignature = crypto
                .createHmac('sha256', PORTONE_WEBHOOK_SECRET)
                .update(event.body)
                .digest('hex');

            if (signature !== expectedSignature) {
                console.error('Invalid webhook signature');
                return {
                    statusCode: 401,
                    headers,
                    body: JSON.stringify({ error: 'Invalid signature' })
                };
            }
        }

        const body = JSON.parse(event.body);
        const { imp_uid, merchant_uid, status } = body;

        console.log('Webhook received:', { imp_uid, merchant_uid, status });

        // 포트원 API로 결제 정보 조회
        let paymentInfo;
        if (PORTONE_API_SECRET) {
            // 액세스 토큰 획득
            const tokenResponse = await fetch('https://api.iamport.kr/users/getToken', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    imp_key: process.env.PORTONE_IMP_KEY,
                    imp_secret: PORTONE_API_SECRET
                })
            });
            const tokenData = await tokenResponse.json();
            const accessToken = tokenData.response.access_token;

            // 결제 정보 조회
            const paymentResponse = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
                headers: { 'Authorization': accessToken }
            });
            const paymentData = await paymentResponse.json();
            paymentInfo = paymentData.response;
        }

        // 기존 결제 기록 조회
        const { data: existingPayment } = await supabase
            .from('payments')
            .select('*')
            .eq('merchant_uid', merchant_uid)
            .single();

        if (!existingPayment) {
            console.log('Payment record not found, creating new one');
        }

        const now = new Date();

        if (status === 'paid') {
            // 결제 성공 처리
            const updateData = {
                payment_id: imp_uid,
                status: 'paid',
                paid_at: now.toISOString(),
                payment_method: paymentInfo?.pay_method || null
            };

            if (existingPayment) {
                await supabase
                    .from('payments')
                    .update(updateData)
                    .eq('id', existingPayment.id);

                // 토큰 지급 (아직 지급되지 않은 경우)
                if (existingPayment.status !== 'paid') {
                    const userId = existingPayment.user_id;

                    if (existingPayment.type === 'subscription') {
                        // 구독 결제 - Pro 플랜 활성화
                        const plan_expires_at = new Date(now);
                        plan_expires_at.setMonth(plan_expires_at.getMonth() + 1);

                        const { data: profile } = await supabase
                            .from('profiles')
                            .select('tokens_balance')
                            .eq('id', userId)
                            .single();

                        const newBalance = (profile?.tokens_balance || 0) + MONTHLY_TOKENS;

                        await supabase
                            .from('profiles')
                            .update({
                                plan: 'pro',
                                plan_started_at: now.toISOString(),
                                plan_expires_at: plan_expires_at.toISOString(),
                                tokens_balance: newBalance,
                                updated_at: now.toISOString()
                            })
                            .eq('id', userId);

                        await supabase
                            .from('tokens_log')
                            .insert({
                                user_id: userId,
                                action: 'subscription',
                                amount: MONTHLY_TOKENS,
                                balance_after: newBalance,
                                description: 'Pro 구독 - 월간 토큰 지급 (웹훅)'
                            });

                    } else if (existingPayment.type === 'token_purchase') {
                        // 토큰 구매
                        const tokens = existingPayment.tokens_granted || 0;

                        const { data: profile } = await supabase
                            .from('profiles')
                            .select('tokens_purchased')
                            .eq('id', userId)
                            .single();

                        const newPurchased = (profile?.tokens_purchased || 0) + tokens;

                        await supabase
                            .from('profiles')
                            .update({
                                tokens_purchased: newPurchased,
                                updated_at: now.toISOString()
                            })
                            .eq('id', userId);

                        await supabase
                            .from('tokens_log')
                            .insert({
                                user_id: userId,
                                action: 'purchase',
                                amount: tokens,
                                balance_after: newPurchased,
                                description: '토큰 구매 (웹훅)'
                            });
                    }
                }
            }

        } else if (status === 'cancelled' || status === 'failed') {
            // 결제 취소/실패 처리
            if (existingPayment) {
                await supabase
                    .from('payments')
                    .update({
                        status: status,
                        updated_at: now.toISOString()
                    })
                    .eq('id', existingPayment.id);
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        console.error('Webhook error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
