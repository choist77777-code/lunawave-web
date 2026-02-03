// monthly-grant.js - 월간 Pro 보너스 루나 지급 (Netlify Scheduled Function)
// 매월 1일 00:00 UTC에 실행
// 참고: 일간 루나는 use-token.js와 check-plan.js에서 자동 지급됨
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MONTHLY_BONUS_LUNAS = 1500; // Pro 월 보너스
const ROLLOVER_CAP = 3000;

// Netlify Scheduled Function 설정
exports.schedule = '@monthly'; // 또는 '0 0 1 * *' (매월 1일)

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
            .select('id, email, lunas_balance, lunas_purchased')
            .eq('plan', 'pro')
            .gt('plan_expires_at', now.toISOString());

        if (fetchError) {
            throw fetchError;
        }

        console.log(`Found ${proUsers?.length || 0} active Pro subscribers`);

        let successCount = 0;
        let failCount = 0;

        for (const user of proUsers || []) {
            try {
                // 구매 루나 이월 계산 (최대 3000루나까지)
                const currentPurchased = user.lunas_purchased || 0;
                const rollover = Math.min(currentPurchased, ROLLOVER_CAP);
                const expired = currentPurchased - rollover;
                const newPurchased = rollover + MONTHLY_BONUS_LUNAS;

                // 프로필 업데이트 (lunas_purchased에 월 보너스 추가)
                const { error: updateError } = await supabase
                    .from('profiles')
                    .update({
                        lunas_purchased: newPurchased,
                        updated_at: now.toISOString()
                    })
                    .eq('id', user.id);

                if (updateError) {
                    throw updateError;
                }

                // 소멸 루나 로그 (있는 경우)
                if (expired > 0) {
                    await supabase
                        .from('lunas_log')
                        .insert({
                            user_id: user.id,
                            action: 'rollover_expire',
                            amount: -expired,
                            balance_after: (user.lunas_balance || 0) + rollover,
                            description: `이월 상한 초과 소멸 (${ROLLOVER_CAP}루나 초과분)`
                        });
                }

                // 월간 보너스 루나 지급 로그
                await supabase
                    .from('lunas_log')
                    .insert({
                        user_id: user.id,
                        action: 'monthly_bonus',
                        amount: MONTHLY_BONUS_LUNAS,
                        balance_after: (user.lunas_balance || 0) + newPurchased,
                        description: '월간 Pro 보너스 루나 지급'
                    });

                successCount++;
                console.log(`Granted ${MONTHLY_BONUS_LUNAS} bonus lunas to ${user.email} (purchased: ${newPurchased})`);

            } catch (userError) {
                failCount++;
                console.error(`Failed to grant tokens to user ${user.id}:`, userError);
            }
        }

        // 만료된 구독자 처리 (plan_expires_at이 현재 이전인 Pro 유저)
        const { data: expiredUsers } = await supabase
            .from('profiles')
            .select('id, email')
            .eq('plan', 'pro')
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

                await supabase
                    .from('lunas_log')
                    .insert({
                        user_id: user.id,
                        action: 'plan_expire',
                        amount: 0,
                        description: 'Pro 구독 만료 - Free로 전환 (일간 20루나로 변경)'
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
            lunas_granted: successCount,
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
