// monthly-grant.js - 월간 보너스 루나 지급 (Netlify Scheduled Function)
// 매월 1일 00:00 UTC에 실행
// 참고: 일간 루나는 use-token.js와 check-plan.js에서 자동 지급됨
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 플랜별 월간 보너스 루나
const MONTHLY_BONUS = {
    crescent: 1500,
    half: 3000,
    full: 0 // 무제한 (지급 불필요)
};
const ROLLOVER_CAP = 3000;

// Netlify Scheduled Function 설정
exports.schedule = '@monthly'; // 또는 '0 0 1 * *' (매월 1일)

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json'
    };

    try {
        console.log('Starting monthly bonus luna grant...');
        const now = new Date();
        const paidPlans = ['crescent', 'half']; // full은 무제한이므로 제외

        // 활성 유료 구독자 조회 (crescent, half만 - full은 무제한이라 지급 불필요)
        const { data: paidUsers, error: fetchError } = await supabase
            .from('profiles')
            .select('id, email, plan, tokens_balance, tokens_purchased')
            .in('plan', paidPlans)
            .gt('plan_expires_at', now.toISOString());

        if (fetchError) {
            throw fetchError;
        }

        console.log(`Found ${paidUsers?.length || 0} active paid subscribers (crescent/half)`);

        let successCount = 0;
        let failCount = 0;

        for (const user of paidUsers || []) {
            try {
                const bonusAmount = MONTHLY_BONUS[user.plan] || 0;
                if (bonusAmount <= 0) continue;

                // 구매 루나 이월 계산 (최대 3000루나까지)
                const currentPurchased = user.tokens_purchased || 0;
                const rollover = Math.min(currentPurchased, ROLLOVER_CAP);
                const expired = currentPurchased - rollover;
                const newPurchased = rollover + bonusAmount;

                // 프로필 업데이트 (tokens_purchased에 월 보너스 추가)
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

                const planNames = { crescent: '초승달', half: '반달' };
                // 월간 보너스 루나 지급 로그
                await supabase
                    .from('tokens_log')
                    .insert({
                        user_id: user.id,
                        action: 'monthly_bonus',
                        amount: bonusAmount,
                        balance_after: (user.tokens_balance || 0) + newPurchased,
                        description: `월간 ${planNames[user.plan] || user.plan} 보너스 루나 지급`
                    });

                successCount++;
                console.log(`Granted ${bonusAmount} bonus lunas to ${user.email} (plan: ${user.plan}, purchased: ${newPurchased})`);

            } catch (userError) {
                failCount++;
                console.error(`Failed to grant tokens to user ${user.id}:`, userError);
            }
        }

        // 만료된 구독자 처리 (plan_expires_at이 현재 이전인 유료 유저)
        const allPaidPlans = ['crescent', 'half', 'full'];
        const { data: expiredUsers } = await supabase
            .from('profiles')
            .select('id, email, plan')
            .in('plan', allPaidPlans)
            .lt('plan_expires_at', now.toISOString());

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

                const planNames = { crescent: '초승달', half: '반달', full: '보름달' };
                await supabase
                    .from('tokens_log')
                    .insert({
                        user_id: user.id,
                        action: 'plan_expire',
                        amount: 0,
                        description: `${planNames[user.plan] || user.plan} 구독 만료 - Free로 전환 (일간 20루나로 변경)`
                    });

                expiredCount++;
                console.log(`Subscription expired for ${user.email} (plan: ${user.plan})`);
            } catch (expireError) {
                console.error(`Failed to expire subscription for user ${user.id}:`, expireError);
            }
        }

        const result = {
            success: true,
            timestamp: now.toISOString(),
            paid_users_processed: paidUsers?.length || 0,
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
