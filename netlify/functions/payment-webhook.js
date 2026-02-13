// payment-webhook.js - 포트원 웹훅 수신 및 처리
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_V2_API_SECRET = process.env.PORTONE_V2_API_SECRET;
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
            const signature = event.headers['webhook-signature'];
            if (signature) {
                // Standard Webhooks: webhook-id + webhook-timestamp + body 를 HMAC-SHA256
                const webhookId = event.headers['webhook-id'];
                const webhookTimestamp = event.headers['webhook-timestamp'];
                const signedContent = `${webhookId}.${webhookTimestamp}.${event.body}`;
                const secretBytes = Buffer.from(PORTONE_WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
                const expectedSignature = crypto
                    .createHmac('sha256', secretBytes)
                    .update(signedContent)
                    .digest('base64');

                const signatures = signature.split(' ').map(s => s.split(',')[1]);
                if (!signatures.includes(expectedSignature)) {
                    console.error('Invalid webhook signature');
                    return {
                        statusCode: 401,
                        headers,
                        body: JSON.stringify({ error: 'Invalid signature' })
                    };
                }
            }
        }

        const body = JSON.parse(event.body);
        const { type, data } = body;
        const paymentId = data?.paymentId;

        console.log('Webhook received:', { type, paymentId });

        // 포트원 V2 API로 결제 정보 조회
        let paymentInfo;
        if (PORTONE_V2_API_SECRET && paymentId) {
            const paymentResponse = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
                headers: { 'Authorization': `PortOne ${PORTONE_V2_API_SECRET}` }
            });
            if (paymentResponse.ok) {
                paymentInfo = await paymentResponse.json();
            }
        }

        // 기존 결제 기록 조회
        const { data: existingPayment } = await supabase
            .from('payments')
            .select('*')
            .eq('payment_id', paymentId)
            .single();

        if (!existingPayment) {
            console.log('Payment record not found, creating new one');
        }

        const now = new Date();

        if (type === 'Transaction.Paid') {
            // 결제 성공 처리
            const updateData = {
                payment_id: paymentId,
                status: 'paid',
                paid_at: now.toISOString(),
                payment_method: paymentInfo?.method?.type || null
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

        } else if (type === 'Transaction.Cancelled' || type === 'Transaction.Failed') {
            // 결제 취소/실패 처리
            if (existingPayment) {
                await supabase
                    .from('payments')
                    .update({
                        status: type === 'Transaction.Cancelled' ? 'cancelled' : 'failed',
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
