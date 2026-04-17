// paddle-config.js - 클라이언트에 Paddle 설정을 안전하게 노출
// (client-side token + price IDs는 public이어도 안전. secret은 절대 여기서 반환 안 함)
exports.handler = async () => {
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
            environment: process.env.PADDLE_ENVIRONMENT || 'sandbox',
            token: process.env.PADDLE_CLIENT_TOKEN || '',
            prices: {
                // v7 Factory plans
                subscription: {
                    hobby:    process.env.PADDLE_PRICE_HOBBY   || '',
                    creator:  process.env.PADDLE_PRICE_CREATOR || '',
                    pro:      process.env.PADDLE_PRICE_PRO     || '',
                    studio:   process.env.PADDLE_PRICE_STUDIO  || '',
                    // Legacy v6
                    crescent: process.env.PADDLE_PRICE_CRESCENT || '',
                    halfmoon: process.env.PADDLE_PRICE_HALFMOON || '',
                    fullmoon: process.env.PADDLE_PRICE_FULLMOON || ''
                },
                tokens: {
                    small:  process.env.PADDLE_PRICE_TOKENS_SMALL  || '',
                    medium: process.env.PADDLE_PRICE_TOKENS_MEDIUM || '',
                    large:  process.env.PADDLE_PRICE_TOKENS_LARGE  || ''
                }
            }
        })
    };
};
