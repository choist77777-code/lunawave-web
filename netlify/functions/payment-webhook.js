// payment-webhook.js - PortOne V1 (iamport) webhook handler
const { createClient } = require('@supabase/supabase-js');
const { getPayment } = require('./portone-v1-helper');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Token packages
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
        const body = JSON.parse(event.body);
        const { imp_uid, merchant_uid, status } = body;

        console.log('Webhook received:', { imp_uid, merchant_uid, status });

        if (!imp_uid) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'imp_uid is required' })
            };
        }

        // PortOne V1 API payment lookup
        const paymentInfo = await getPayment(imp_uid);

        // Look up existing payment record
        // First try by payment_id (imp_uid), then by merchant_uid
        let existingPayment = null;

        const { data: byPaymentId } = await supabase
            .from('payments')
            .select('*')
            .eq('payment_id', imp_uid)
            .single();

        if (byPaymentId) {
            existingPayment = byPaymentId;
        } else if (merchant_uid) {
            const { data: byMerchantUid } = await supabase
                .from('payments')
                .select('*')
                .eq('merchant_uid', merchant_uid)
                .single();

            if (byMerchantUid) {
                existingPayment = byMerchantUid;
            }
        }

        if (!existingPayment) {
            console.log('Payment record not found, creating new one');
        }

        const now = new Date();

        if (status === 'paid') {
            // Payment success
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

                // Grant tokens (only if not already paid)
                if (existingPayment.status !== 'paid') {
                    const userId = existingPayment.user_id;

                    if (existingPayment.type === 'subscription') {
                        // Subscription - activate Pro plan
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
                        // Token purchase
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
            // Payment cancelled or failed
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
