// paddle-webhook.js - Paddle webhook for international payments
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

// Global USD pricing (Paddle Merchant of Record)
// Legacy luna packs (kept for backward compat with old transactions)
const LUNA_PACKAGES = {
    'small': { lunas: 500, price_usd_cents: 499 },
    'medium': { lunas: 1000, price_usd_cents: 999 },
    'large': { lunas: 3000, price_usd_cents: 2499 }
};

// LUNA WAVE v7.0 "Factory" subscription tiers
// Maps plan key to monthly video quota + price
const SUBSCRIPTION_PLANS = {
    // Legacy v6 plans (still accepted from old subscriptions)
    'crescent': { price_usd_cents: 999, factory_quota_monthly: 12 },
    'halfmoon': { price_usd_cents: 2499, factory_quota_monthly: 30 },
    'fullmoon': { price_usd_cents: 4999, factory_quota_monthly: 90 },
    // v7 Factory plans
    'hobby':    { price_usd_cents: 1900,  factory_quota_monthly: 12 },
    'creator':  { price_usd_cents: 4900,  factory_quota_monthly: 30 },
    'pro':      { price_usd_cents: 14900, factory_quota_monthly: 90 },
    'studio':   { price_usd_cents: 39900, factory_quota_monthly: 720 }
};

// Paddle webhook 서명 검증
function verifyWebhookSignature(rawBody, signature) {
    if (!PADDLE_WEBHOOK_SECRET) {
        console.warn('[Paddle] PADDLE_WEBHOOK_SECRET not set, skipping signature verification');
        return true;
    }
    if (!signature) {
        return false;
    }
    try {
        // Paddle v2 uses ts;h1=hash format
        const parts = signature.split(';');
        const tsPart = parts.find(p => p.startsWith('ts='));
        const h1Part = parts.find(p => p.startsWith('h1='));
        if (!tsPart || !h1Part) return false;

        const ts = tsPart.replace('ts=', '');
        const expectedHash = h1Part.replace('h1=', '');
        const signedPayload = `${ts}:${rawBody}`;
        const computedHash = crypto
            .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
            .update(signedPayload)
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(computedHash),
            Buffer.from(expectedHash)
        );
    } catch (err) {
        console.error('[Paddle] Signature verification error:', err.message);
        return false;
    }
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        // Webhook 서명 검증
        const signature = event.headers['paddle-signature'] || event.headers['Paddle-Signature'];
        if (!verifyWebhookSignature(event.body, signature)) {
            console.error('[Paddle] Invalid webhook signature');
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
        }

        const data = JSON.parse(event.body);

        // Extract custom_data (supports both camelCase and snake_case)
        const customData = data.data?.custom_data || {};
        const userId = customData.user_id || customData.userId;
        const pkg = customData.package;
        const plan = customData.plan;
        const txType = customData.type; // 'subscription' | 'tokens'
        const transactionId = data.data?.id || `paddle_${Date.now()}`;
        const now = new Date().toISOString();

        // ============ One-time purchase (token pack) ============
        if (data.event_type === 'transaction.completed' && (txType === 'tokens' || pkg)) {
            if (!userId || !pkg) {
                console.warn('[Paddle] transaction.completed missing user_id/package', { userId, pkg });
                return { statusCode: 200, body: JSON.stringify({ received: true, skipped: 'no_user_or_package' }) };
            }
            const packageInfo = LUNA_PACKAGES[pkg];
            if (!packageInfo) {
                console.warn('[Paddle] Unknown token package:', pkg);
                return { statusCode: 200, body: JSON.stringify({ received: true, skipped: 'unknown_package' }) };
            }

            const lunas = packageInfo.lunas;
            const { data: currentProfile, error: profileError } = await supabase
                .from('profiles').select('tokens_purchased').eq('id', userId).single();
            if (profileError) {
                console.error('[Paddle] Profile lookup error:', profileError.message);
                return { statusCode: 400, body: JSON.stringify({ error: 'User not found' }) };
            }
            const newPurchased = (currentProfile?.tokens_purchased || 0) + lunas;

            const { error: updateError } = await supabase
                .from('profiles')
                .update({ tokens_purchased: newPurchased, updated_at: now })
                .eq('id', userId);
            if (updateError) throw updateError;

            await supabase.from('payments').insert({
                user_id: userId,
                payment_id: transactionId,
                type: 'luna_purchase',
                token_package: pkg,
                tokens_granted: lunas,
                amount: packageInfo.price_usd_cents,
                currency: 'USD',
                status: 'paid',
                paid_at: now,
                provider: 'paddle'
            });

            await supabase.from('tokens_log').insert({
                user_id: userId,
                action: 'purchase',
                amount: lunas,
                balance_after: newPurchased,
                description: `Luna pack (${pkg}, Paddle)`
            });

            console.log(`[Paddle] Granted ${lunas} Luna to ${userId} (${pkg}) tx=${transactionId}`);
        }

        // ============ Subscription activated ============
        if (data.event_type === 'subscription.activated' ||
            data.event_type === 'subscription.created' ||
            data.event_type === 'subscription.updated') {
            if (userId && plan && SUBSCRIPTION_PLANS[plan]) {
                // Compute next billing date from subscription
                const sub = data.data || {};
                const nextBillingAt = sub.next_billed_at || sub.current_billing_period?.ends_at || null;
                const startedAt = sub.first_billed_at || sub.started_at || now;

                const planInfo = SUBSCRIPTION_PLANS[plan];
                const updatePayload = {
                    plan: plan,
                    plan_started_at: startedAt,
                    plan_expires_at: nextBillingAt,
                    auto_renew: true,
                    updated_at: now,
                    // v7 Factory: 플랜에 맞는 월 영상 쿼터 자동 설정
                    factory_plan: plan,
                    factory_quota_monthly: planInfo.factory_quota_monthly,
                    factory_started_at: startedAt
                };
                // Store subscription ID for later cancel
                if (sub.id) updatePayload.paddle_subscription_id = sub.id;

                const { error: updErr } = await supabase
                    .from('profiles').update(updatePayload).eq('id', userId);
                if (updErr) console.warn('[Paddle] Profile update (sub) error:', updErr.message);

                await supabase.from('payments').insert({
                    user_id: userId,
                    payment_id: transactionId,
                    merchant_uid: sub.id || null,
                    type: 'subscription',
                    plan: plan,
                    amount: SUBSCRIPTION_PLANS[plan].price_usd_cents,
                    currency: 'USD',
                    status: 'paid',
                    paid_at: now,
                    provider: 'paddle'
                });

                console.log(`[Paddle] Subscription ${data.event_type}: ${userId} -> ${plan}`);
            }
        }

        // ============ Subscription cancelled ============
        if (data.event_type === 'subscription.canceled' ||
            data.event_type === 'subscription.cancelled') {
            if (userId) {
                await supabase.from('profiles').update({
                    plan: 'free',
                    auto_renew: false,
                    updated_at: now,
                    // v7 Factory: 무료 플랜으로 강등 (월 3 trial)
                    factory_plan: 'free',
                    factory_quota_monthly: 3
                }).eq('id', userId);
                // 자동 파이프라인 정지
                await supabase.from('factory_configs').update({
                    enabled: false,
                    updated_at: now
                }).eq('user_id', userId);
                console.log(`[Paddle] Subscription cancelled + Factory disabled: ${userId}`);
            }
        }

        return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (err) {
        console.error('[Paddle] Webhook error:', err.message);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
