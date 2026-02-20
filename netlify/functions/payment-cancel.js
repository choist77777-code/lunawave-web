// payment-cancel.js - 구독 취소 (빌링키 삭제 + auto_renew 해제)
const { createClient } = require('@supabase/supabase-js');
const { getAccessToken } = require('./portone-v1-helper');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ ok: false, message: 'Method not allowed' }) };
    }

    try {
        const { userId } = JSON.parse(event.body || '{}');
        if (!userId) {
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: 'userId 필요' }) };
        }

        // 1. Supabase에서 프로필 조회
        const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('billing_key, plan, plan_expires_at, customer_uid')
            .eq('id', userId)
            .single();

        if (profileErr || !profile) {
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: '프로필을 찾을 수 없습니다.' }) };
        }

        if (!profile.billing_key && !profile.customer_uid) {
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, message: '활성 구독이 없습니다.' }) };
        }

        // 2. 포트원 빌링키 삭제 (customer_uid 기반)
        const customerUid = profile.customer_uid || profile.billing_key;
        if (customerUid) {
            try {
                const accessToken = await getAccessToken();
                const delRes = await fetch(`https://api.iamport.kr/subscribe/customers/${customerUid}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                const delData = await delRes.json();
                console.log('[payment-cancel] PortOne delete billing key:', delData.code, delData.message);
            } catch (portErr) {
                console.error('[payment-cancel] PortOne error (non-fatal):', portErr.message);
            }
        }

        // 3. Supabase: billing_key 제거, auto_renew 해제 (plan은 만료일까지 유지)
        const { error: updateErr } = await supabase
            .from('profiles')
            .update({
                billing_key: null,
                customer_uid: null,
                auto_renew: false
            })
            .eq('id', userId);

        if (updateErr) {
            console.error('[payment-cancel] Supabase update error:', updateErr);
            return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: '구독 취소 처리 중 오류' }) };
        }

        console.log(`[payment-cancel] Subscription cancelled for user ${userId}, plan ${profile.plan} expires at ${profile.plan_expires_at}`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ ok: true, message: '구독이 취소되었습니다. 만료일까지 계속 이용 가능합니다.' })
        };

    } catch (err) {
        console.error('[payment-cancel] Error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: err.message }) };
    }
};
