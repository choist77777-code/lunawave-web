// purchase-tokens.js - 추가 루나 구매 처리
// 참고: 파일명은 호환성 유지를 위해 purchase-tokens.js 유지
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;

// 루나 패키지 정의
const LUNA_PACKAGES = {
    'small': { lunas: 500, price: 7900 },
    'medium': { lunas: 1000, price: 12900 },
    'large': { lunas: 3000, price: 29900 }
};

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
        const { imp_uid, merchant_uid, package_type, promo_code } = body;

        // 패키지 확인
        const pkg = LUNA_PACKAGES[package_type];
        if (!pkg) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid package type' })
            };
        }

        let amount = pkg.price;
        let bonus_lunas = 0;

        // 프로모션 코드 적용
        if (promo_code) {
            const { data: promo } = await supabase
                .from('promo_codes')
                .select('*')
                .eq('code', promo_code.toUpperCase())
                .eq('is_active', true)
                .single();

            if (promo && promo.used_count < promo.max_uses) {
                if (!promo.expires_at || new Date(promo.expires_at) > new Date()) {
                    if (promo.type === 'percent') {
                        amount = Math.floor(amount * (1 - promo.value / 100));
                    } else if (promo.type === 'fixed') {
                        amount = Math.max(0, amount - promo.value);
                    } else if (promo.type === 'bonus_lunas') {
                        bonus_lunas = promo.value;
                    }

                    await supabase
                        .from('promo_codes')
                        .update({ used_count: promo.used_count + 1 })
                        .eq('id', promo.id);
                }
            }
        }

        // 포트원 결제 검증
        if (PORTONE_API_SECRET && imp_uid) {
            const verifyResponse = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
                headers: {
                    'Authorization': `Bearer ${PORTONE_API_SECRET}`
                }
            });
            const verifyData = await verifyResponse.json();

            if (verifyData.response.status !== 'paid' || verifyData.response.amount !== amount) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Payment verification failed' })
                };
            }
        }

        const now = new Date();
        const total_lunas = pkg.lunas + bonus_lunas;

        // 프로필 업데이트 - 구매 루나에 추가
        const { data: currentProfile } = await supabase
            .from('profiles')
            .select('lunas_purchased')
            .eq('id', user.id)
            .single();

        const newPurchased = (currentProfile?.lunas_purchased || 0) + total_lunas;

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

        // 결제 기록 저장
        await supabase
            .from('payments')
            .insert({
                user_id: user.id,
                payment_id: imp_uid,
                merchant_uid: merchant_uid,
                type: 'luna_purchase',
                token_package: package_type, // 컬럼명은 유지 (DB 호환성)
                tokens_granted: total_lunas, // 컬럼명은 유지 (DB 호환성)
                amount: amount,
                status: 'paid',
                paid_at: now.toISOString()
            });

        // 루나 로그 기록
        await supabase
            .from('lunas_log')
            .insert({
                user_id: user.id,
                action: 'purchase',
                amount: total_lunas,
                balance_after: newPurchased,
                description: `루나 구매 (${package_type})${bonus_lunas > 0 ? ` + 보너스 ${bonus_lunas}` : ''}`
            });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                lunas_granted: total_lunas,
                lunas_purchased: newPurchased,
                bonus_lunas: bonus_lunas
            })
        };

    } catch (error) {
        console.error('Purchase lunas error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
