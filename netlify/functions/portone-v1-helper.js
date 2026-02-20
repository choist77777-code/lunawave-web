// portone-v1-helper.js - PortOne V1 (iamport) REST API helper
// 환경변수: IMP_REST_API_KEY, IMP_REST_API_SECRET

const IMP_API_BASE = 'https://api.iamport.kr';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * V1 REST API access_token 발급
 */
async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && tokenExpiresAt > now + 60) {
        return cachedToken;
    }

    const res = await fetch(`${IMP_API_BASE}/users/getToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            imp_key: (process.env.IMP_REST_API_KEY || '').trim(),
            imp_secret: (process.env.IMP_REST_API_SECRET || '').trim()
        })
    });

    const data = await res.json();
    if (data.code !== 0) {
        throw new Error(`PortOne V1 token error: ${data.message}`);
    }

    cachedToken = data.response.access_token;
    tokenExpiresAt = data.response.expired_at;
    return cachedToken;
}

/**
 * 결제 정보 조회
 * @param {string} impUid - imp_uid
 */
async function getPayment(impUid) {
    const token = await getAccessToken();
    const res = await fetch(`${IMP_API_BASE}/payments/${impUid}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await res.json();
    if (data.code !== 0) {
        throw new Error(`PortOne V1 getPayment error: ${data.message}`);
    }
    return data.response;
}

/**
 * 빌링키(customer_uid)로 재결제 (자동 갱신용)
 * @param {object} params
 * @param {string} params.customer_uid
 * @param {string} params.merchant_uid
 * @param {number} params.amount
 * @param {string} params.name - 주문명
 */
async function payAgain({ customer_uid, merchant_uid, amount, name }) {
    const token = await getAccessToken();
    const res = await fetch(`${IMP_API_BASE}/subscribe/payments/again`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            customer_uid,
            merchant_uid,
            amount,
            name
        })
    });

    const data = await res.json();
    if (data.code !== 0) {
        throw new Error(`PortOne V1 payAgain error: ${data.message}`);
    }
    return data.response;
}

/**
 * 결제 취소 (환불)
 * @param {object} params
 * @param {string} params.imp_uid - 결제 imp_uid
 * @param {number} params.amount - 환불 금액 (부분환불 시), 생략하면 전액
 * @param {string} params.reason - 환불 사유
 */
async function cancelPayment({ imp_uid, amount, reason }) {
    const token = await getAccessToken();
    const body = {
        imp_uid,
        reason: reason || '사용자 환불 요청'
    };
    if (amount) {
        body.amount = amount;
    }

    const res = await fetch(`${IMP_API_BASE}/payments/cancel`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await res.json();
    if (data.code !== 0) {
        throw new Error(`PortOne V1 cancelPayment error: ${data.message}`);
    }
    return data.response;
}

module.exports = { getAccessToken, getPayment, payAgain, cancelPayment };
