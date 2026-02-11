// purchase-tokens.js - 루나 패키지 구매 (폐지됨)
// 4단계 구독 모델 전환으로 개별 루나 구매 기능은 더 이상 사용되지 않습니다.
// 파일은 Netlify 배포 호환성을 위해 유지합니다.

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    return {
        statusCode: 410,
        headers,
        body: JSON.stringify({
            success: false,
            error: 'deprecated',
            message: '루나 패키지 구매 기능은 더 이상 사용되지 않습니다. 구독 플랜(초승달/반달/보름달)을 이용해 주세요.'
        })
    };
};
