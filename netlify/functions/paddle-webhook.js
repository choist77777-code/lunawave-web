// paddle-webhook.js - Paddle webhook for international payments
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LUNA_PACKAGES = {
    'starter': 300,
    'creator': 800,
    'pro': 2000
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const data = JSON.parse(event.body);

        // One-time purchase completed
        if (data.event_type === 'transaction.completed') {
            const customData = data.data?.custom_data || {};
            const userId = customData.userId;
            const pkg = customData.package;

            if (!userId || !pkg) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or package' }) };
            }

            let amount = LUNA_PACKAGES[pkg] || 0;
            if (amount === 0) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Unknown package' }) };
            }

            // Check first purchase bonus (2x)
            const { data: user } = await supabase
                .from('profiles')
                .select('first_purchase')
                .eq('id', userId)
                .single();

            if (user && !user.first_purchase) {
                amount *= 2;
                await supabase
                    .from('profiles')
                    .update({ first_purchase: true })
                    .eq('id', userId);
            }

            // Grant paid luna
            await supabase.rpc('add_paid_luna', { p_user_id: userId, p_amount: amount });

            // Log transaction
            await supabase.from('luna_transactions').insert({
                user_id: userId,
                amount: amount,
                type: 'paid_charge',
                description: `${pkg} package (Paddle)`,
                source: 'paddle'
            });

            console.log(`[Paddle] Granted ${amount} luna to ${userId} (${pkg})`);
        }

        // Subscription activated
        if (data.event_type === 'subscription.activated') {
            const customData = data.data?.custom_data || {};
            const userId = customData.userId;
            const plan = customData.plan; // 'pro_monthly' or 'unlimited'

            if (userId && plan) {
                await supabase
                    .from('profiles')
                    .update({ plan_type: plan })
                    .eq('id', userId);

                console.log(`[Paddle] Subscription activated: ${userId} → ${plan}`);
            }
        }

        // Subscription cancelled
        if (data.event_type === 'subscription.canceled') {
            const customData = data.data?.custom_data || {};
            const userId = customData.userId;

            if (userId) {
                await supabase
                    .from('profiles')
                    .update({ plan_type: 'free' })
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
