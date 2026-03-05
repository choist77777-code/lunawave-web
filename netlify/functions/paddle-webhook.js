// paddle-webhook.js - Paddle webhook for international payments
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

// purchase-tokens.js와 동일한 패키지 정의
const LUNA_PACKAGES = {
    'small': { lunas: 500, price: 7900 },
    'medium': { lunas: 1000, price: 12900 },
    'large': { lunas: 3000, price: 29900 }
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

        // One-time purchase completed
        if (data.event_type === 'transaction.completed') {
            const customData = data.data?.custom_data || {};
            const userId = customData.userId;
            const pkg = customData.package;
            const transactionId = data.data?.id || `paddle_${Date.now()}`;

            if (!userId || !pkg) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or package' }) };
            }

            const packageInfo = LUNA_PACKAGES[pkg];
            if (!packageInfo) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Unknown package' }) };
            }

            const lunas = packageInfo.lunas;
            const now = new Date().toISOString();

            // 현재 프로필 조회
            const { data: currentProfile, error: profileError } = await supabase
                .from('profiles')
                .select('tokens_purchased')
                .eq('id', userId)
                .single();

            if (profileError) {
                console.error('[Paddle] Profile lookup error:', profileError.message);
                return { statusCode: 400, body: JSON.stringify({ error: 'User not found' }) };
            }

            const newPurchased = (currentProfile?.tokens_purchased || 0) + lunas;

            // profiles 업데이트 - tokens_purchased에 추가
            const { error: updateError } = await supabase
                .from('profiles')
                .update({
                    tokens_purchased: newPurchased,
                    updated_at: now
                })
                .eq('id', userId);

            if (updateError) {
                console.error('[Paddle] Profile update error:', updateError.message);
                throw updateError;
            }

            // 결제 기록 저장 (payments 테이블)
            await supabase.from('payments').insert({
                user_id: userId,
                payment_id: transactionId,
                type: 'luna_purchase',
                token_package: pkg,
                tokens_granted: lunas,
                amount: packageInfo.price,
                status: 'paid',
                paid_at: now
            });

            // 루나 로그 기록 (tokens_log 테이블)
            await supabase.from('tokens_log').insert({
                user_id: userId,
                action: 'purchase',
                amount: lunas,
                balance_after: newPurchased,
                description: `루나 구매 (${pkg}, Paddle)`
            });

            console.log(`[Paddle] Granted ${lunas} luna to ${userId} (${pkg})`);
        }

        // Subscription activated
        if (data.event_type === 'subscription.activated') {
            const customData = data.data?.custom_data || {};
            const userId = customData.userId;
            const plan = customData.plan; // 'crescent', 'halfmoon', 'fullmoon'

            if (userId && plan) {
                await supabase
                    .from('profiles')
                    .update({
                        plan: plan,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', userId);

                console.log(`[Paddle] Subscription activated: ${userId} -> ${plan}`);
            }
        }

        // Subscription cancelled
        if (data.event_type === 'subscription.canceled') {
            const customData = data.data?.custom_data || {};
            const userId = customData.userId;

            if (userId) {
                await supabase
                    .from('profiles')
                    .update({
                        plan: 'free',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', userId);

                console.log(`[Paddle] Subscription cancelled: ${userId}`);
            }
        }

        return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (err) {
        console.error('[Paddle] Webhook error:', err.message);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
