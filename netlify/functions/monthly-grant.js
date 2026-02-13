// monthly-grant.js - 월간 Pro 보너스 루나 지급 (Netlify Scheduled Function)
// 매월 1일 00:00 UTC에 실행
// 참고: 일간 루나는 use-token.js와 check-plan.js에서 자동 지급됨
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MONTHLY_BONUS = {
    crescent: 1500,
    halfmoon: 3000,
    fullmoon: 0
};
const ROLLOVER_CAP = 3000;
const PAID_PLANS = ['crescent', 'halfmoon', 'fullmoon'];
const PLAN_PRICES = {
    crescent: 13900,
    halfmoon: 33000,
    fullmoon: 79000
};
const PLAN_MONTHLY = {
    crescent: 1500,
    halfmoon: 3000,
    fullmoon: 0
};
const PLAN_DAILY = {
    crescent: 50,
    halfmoon: 200,
    fullmoon: 999
};

// V2 빌링키 자동 결제
async function attemptAutoRenewal(user) {
    const PORTONE_V2_SECRET = process.env.PORTONE_V2_API_SECRET;
    if (!PORTONE_V2_SECRET || !user.billing_key) return { success: false, reason: 'no_secret_or_key' };

    const plan = user.plan;
    const amount = PLAN_PRICES[plan];
    if (!amount) return { success: false, reason: 'invalid_plan' };

    const paymentId = `renew_${Date.now()}_${user.id.slice(0, 8)}`;
    const PLAN_NAMES = { crescent: '초승달', halfmoon: '반달', fullmoon: '보름달' };

    try {
        const res = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}/billing-key`, {
            method: 'POST',
            headers: {
                'Authorization': `PortOne ${PORTONE_V2_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                billingKey: user.billing_key,
                orderName: `LunaWave ${PLAN_NAMES[plan] || plan} 구독 갱신`,
                customer: {
                    id: user.id
                },
                amount: {
                    total: amount,
                    currency: 'KRW'
                }
            })
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            return { success: false, reason: errData.message || `HTTP ${res.status}` };
        }

        // 결제 상태 확인
        const verifyRes = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
            headers: { 'Authorization': `PortOne ${PORTONE_V2_SECRET}` }
        });
        const verifyData = await verifyRes.json();

        if (verifyData.status === 'PAID') {
            return { success: true, payment_id: paymentId, merchant_uid: paymentId };
        } else {
            return { success: false, reason: `status: ${verifyData.status}` };
        }
    } catch (e) {
        console.error('Auto renewal error:', e);
        return { success: false, reason: e.message };
    }
}

// Netlify Scheduled Function 설정
exports.schedule = '@daily';

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json'
    };

    try {
        console.log('Starting monthly Pro bonus luna grant...');
        const now = new Date();

        // 활성 Pro 구독자 조회 (plan_expires_at이 현재 이후인 유저)
        const { data: proUsers, error: fetchError } = await supabase
            .from('profiles')
            .select('id, email, plan, tokens_balance, tokens_purchased, plan_started_at, billing_key, plan_expires_at')
            .in('plan', PAID_PLANS)
            .gt('plan_expires_at', now.toISOString());

        if (fetchError) {
            throw fetchError;
        }

        console.log(`Found ${proUsers?.length || 0} active Pro subscribers`);

        let successCount = 0;
        let failCount = 0;

        for (const user of proUsers || []) {
            try {
                const bonus = MONTHLY_BONUS[user.plan] || 0;
                if (bonus === 0) {
                    // fullmoon은 무제한이라 월간 보너스 불필요
                    successCount++;
                    continue;
                }

                // 결제일 기준 체크: plan_started_at의 day와 오늘 day 비교
                const billingDay = user.plan_started_at ? new Date(user.plan_started_at).getDate() : 1;
                const todayDay = now.getDate();
                if (billingDay !== todayDay) {
                    continue; // 오늘이 결제일이 아니면 스킵
                }

                // 자동 갱신 결제 시도
                if (user.billing_key) {
                    // 만료일이 3일 이내면 자동 갱신 시도
                    const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
                    const daysUntilExpiry = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : 0;

                    if (daysUntilExpiry <= 3) {
                        const renewResult = await attemptAutoRenewal(user);

                        if (renewResult.success) {
                            // 결제 성공 - 구독 갱신
                            const newExpiry = new Date(now);
                            newExpiry.setMonth(newExpiry.getMonth() + 1);
                            const monthlyBonus = PLAN_MONTHLY[user.plan] || 0;
                            const dailyAmount = PLAN_DAILY[user.plan] || 20;

                            await supabase.from('profiles').update({
                                plan_started_at: now.toISOString(),
                                plan_expires_at: newExpiry.toISOString(),
                                updated_at: now.toISOString()
                            }).eq('id', user.id);

                            await supabase.from('payments').insert({
                                user_id: user.id,
                                payment_id: renewResult.payment_id,
                                merchant_uid: renewResult.merchant_uid,
                                type: 'subscription',
                                plan: user.plan,
                                tokens_granted: monthlyBonus,
                                amount: PLAN_PRICES[user.plan],
                                status: 'paid',
                                paid_at: now.toISOString()
                            });

                            await supabase.from('tokens_log').insert({
                                user_id: user.id,
                                action: 'auto_renewal',
                                amount: 0,
                                balance_after: (user.tokens_balance || 0) + (user.tokens_purchased || 0),
                                description: `${user.plan} 구독 자동 갱신 결제 완료`
                            });

                            console.log(`Auto renewal success: ${user.email} (${user.plan})`);
                        } else {
                            // 결제 실패 로그
                            await supabase.from('tokens_log').insert({
                                user_id: user.id,
                                action: 'renewal_failed',
                                amount: 0,
                                description: `자동 갱신 실패: ${renewResult.reason}`
                            });
                            console.error(`Auto renewal failed: ${user.email} - ${renewResult.reason}`);
                        }
                    }
                }

                // 구매 루나 이월 계산 (최대 3000루나까지)
                const currentPurchased = user.tokens_purchased || 0;
                const rollover = Math.min(currentPurchased, ROLLOVER_CAP);
                const expired = currentPurchased - rollover;
                const newPurchased = rollover + bonus;

                // 프로필 업데이트 (lunas_purchased에 월 보너스 추가)
                const { error: updateError } = await supabase
                    .from('profiles')
                    .update({
                        tokens_purchased: newPurchased,
                        updated_at: now.toISOString()
                    })
                    .eq('id', user.id);

                if (updateError) {
                    throw updateError;
                }

                // 소멸 루나 로그 (있는 경우)
                if (expired > 0) {
                    await supabase
                        .from('tokens_log')
                        .insert({
                            user_id: user.id,
                            action: 'rollover_expire',
                            amount: -expired,
                            balance_after: (user.tokens_balance || 0) + rollover,
                            description: `이월 상한 초과 소멸 (${ROLLOVER_CAP}루나 초과분)`
                        });
                }

                // 월간 보너스 루나 지급 로그
                await supabase
                    .from('tokens_log')
                    .insert({
                        user_id: user.id,
                        action: 'monthly_bonus',
                        amount: bonus,
                        balance_after: (user.tokens_balance || 0) + newPurchased,
                        description: `월간 ${user.plan} 보너스 루나 지급 (+${bonus})`
                    });

                successCount++;
                console.log(`Granted ${bonus} bonus lunas to ${user.email} (purchased: ${newPurchased})`);

            } catch (userError) {
                failCount++;
                console.error(`Failed to grant tokens to user ${user.id}:`, userError);
            }
        }

        // 만료된 구독자 처리 (plan_expires_at이 현재 이전인 Pro 유저)
        const { data: expiredUsers } = await supabase
            .from('profiles')
            .select('id, email, plan, billing_key')
            .in('plan', PAID_PLANS)
            .lt('plan_expires_at', now.toISOString())
            .is('billing_key', null);

        let expiredCount = 0;
        for (const user of expiredUsers || []) {
            try {
                await supabase
                    .from('profiles')
                    .update({
                        plan: 'free',
                        updated_at: now.toISOString()
                    })
                    .eq('id', user.id);

                await supabase
                    .from('tokens_log')
                    .insert({
                        user_id: user.id,
                        action: 'plan_expire',
                        amount: 0,
                        description: `${user.plan} 구독 만료 - Free로 전환`
                    });

                expiredCount++;
                console.log(`Subscription expired for ${user.email}`);
            } catch (expireError) {
                console.error(`Failed to expire subscription for user ${user.id}:`, expireError);
            }
        }

        const result = {
            success: true,
            timestamp: now.toISOString(),
            pro_users_processed: proUsers?.length || 0,
            tokens_granted: successCount,
            grant_failures: failCount,
            subscriptions_expired: expiredCount
        };

        console.log('Monthly bonus grant completed:', result);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Monthly grant error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
