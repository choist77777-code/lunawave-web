// process-referral.js - 추천인 처리
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REFERRER_BONUS = 200;  // 추천인 보너스 루나
const REFERRED_BONUS = 200;  // 피추천인 보너스 루나

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
        const { referral_code, action } = body;

        // action: 'register' (가입 시 등록) 또는 'complete' (첫 결제 완료 시)

        if (action === 'register') {
            // 가입 시 추천 코드 등록
            if (!referral_code) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Referral code is required' })
                };
            }

            // 추천인 조회
            const { data: referrer, error: referrerError } = await supabase
                .from('profiles')
                .select('id, email, referral_code')
                .eq('referral_code', referral_code.toUpperCase())
                .single();

            if (referrerError || !referrer) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'invalid_code',
                        message: '유효하지 않은 추천 코드입니다.'
                    })
                };
            }

            // 자기 자신 추천 방지
            if (referrer.id === user.id) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'self_referral',
                        message: '자신의 추천 코드는 사용할 수 없습니다.'
                    })
                };
            }

            // 이미 추천 기록이 있는지 확인
            const { data: existingReferral } = await supabase
                .from('referrals')
                .select('id')
                .eq('referred_id', user.id)
                .single();

            if (existingReferral) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'already_referred',
                        message: '이미 추천 코드가 등록되어 있습니다.'
                    })
                };
            }

            // 추천 기록 생성 (pending 상태)
            const { error: insertError } = await supabase
                .from('referrals')
                .insert({
                    referrer_id: referrer.id,
                    referred_id: user.id,
                    referrer_bonus: REFERRER_BONUS,
                    referred_bonus: REFERRED_BONUS,
                    status: 'pending'
                });

            if (insertError) {
                throw insertError;
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    message: '추천 코드가 등록되었습니다. Pro 구독 시 양쪽에 200 루나가 지급됩니다.',
                    referrer_bonus: REFERRER_BONUS,
                    referred_bonus: REFERRED_BONUS,
                    status: 'pending'
                })
            };

        } else if (action === 'complete') {
            // 첫 결제 완료 시 - 추천 보너스 지급
            const { data: referral, error: referralError } = await supabase
                .from('referrals')
                .select('*, referrer:referrer_id(id, lunas_purchased)')
                .eq('referred_id', user.id)
                .eq('status', 'pending')
                .single();

            if (referralError || !referral) {
                // 추천 기록 없음 - 정상 (추천 없이 가입한 경우)
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        has_referral: false
                    })
                };
            }

            const now = new Date();

            // 추천인에게 보너스 지급
            const referrerNewPurchased = (referral.referrer?.lunas_purchased || 0) + REFERRER_BONUS;
            await supabase
                .from('profiles')
                .update({
                    lunas_purchased: referrerNewPurchased,
                    updated_at: now.toISOString()
                })
                .eq('id', referral.referrer_id);

            await supabase
                .from('lunas_log')
                .insert({
                    user_id: referral.referrer_id,
                    action: 'referral_bonus',
                    amount: REFERRER_BONUS,
                    balance_after: referrerNewPurchased,
                    description: '추천 보너스 (추천인)'
                });

            // 피추천인에게 보너스 지급
            const { data: referredProfile } = await supabase
                .from('profiles')
                .select('lunas_purchased')
                .eq('id', user.id)
                .single();

            const referredNewPurchased = (referredProfile?.lunas_purchased || 0) + REFERRED_BONUS;
            await supabase
                .from('profiles')
                .update({
                    lunas_purchased: referredNewPurchased,
                    updated_at: now.toISOString()
                })
                .eq('id', user.id);

            await supabase
                .from('lunas_log')
                .insert({
                    user_id: user.id,
                    action: 'referral_bonus',
                    amount: REFERRED_BONUS,
                    balance_after: referredNewPurchased,
                    description: '추천 보너스 (피추천인)'
                });

            // 추천 상태 완료로 변경
            await supabase
                .from('referrals')
                .update({ status: 'completed' })
                .eq('id', referral.id);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    has_referral: true,
                    bonus_granted: REFERRED_BONUS,
                    new_balance: referredNewPurchased,
                    message: `추천 보너스 ${REFERRED_BONUS} 루나가 지급되었습니다!`
                })
            };

        } else {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid action' })
            };
        }

    } catch (error) {
        console.error('Process referral error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
