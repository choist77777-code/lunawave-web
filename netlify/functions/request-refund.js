// request-refund.js - 구독 환불 요청 처리
const { createClient } = require('@supabase/supabase-js');
const { cancelPayment } = require('./portone-v1-helper');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REFUND_WINDOW_DAYS = 14;

exports.handler = async (event) => {
    // CORS headers
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
        // 인증 토큰 확인
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

        // 1. 가장 최근 'paid' 상태의 구독 결제 조회
        const { data: payment, error: paymentError } = await supabase
            .from('payments')
            .select('*')
            .eq('user_id', user.id)
            .eq('type', 'subscription')
            .eq('status', 'paid')
            .order('paid_at', { ascending: false })
            .limit(1)
            .single();

        if (paymentError || !payment) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: '환불 가능한 결제 내역이 없습니다.' })
            };
        }

        // 2. 환불 기간 확인 (결제일로부터 14일 이내)
        const paidAt = new Date(payment.paid_at);
        const now = new Date();
        const diffMs = now - paidAt;
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (diffDays > REFUND_WINDOW_DAYS) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: '결제일로부터 14일이 초과되었습니다',
                    paid_at: payment.paid_at,
                    days_elapsed: Math.floor(diffDays)
                })
            };
        }

        // 3. 루나 사용 내역 확인 (결제일 이후 generate/use/use_token 기록)
        const { data: usageLogs, error: usageError } = await supabase
            .from('tokens_log')
            .select('id')
            .eq('user_id', user.id)
            .in('action', ['generate', 'use', 'use_token'])
            .gte('created_at', payment.paid_at)
            .limit(1);

        if (usageError) {
            throw usageError;
        }

        if (usageLogs && usageLogs.length > 0) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: '루나를 사용한 기록이 있어 환불이 불가합니다',
                    paid_at: payment.paid_at
                })
            };
        }

        // 4. 포트원 결제 취소 (환불)
        const cancelResult = await cancelPayment({
            imp_uid: payment.payment_id,
            reason: '사용자 환불 요청 (14일 이내, 미사용)'
        });

        // 5. 결제 레코드 상태 업데이트
        const { error: paymentUpdateError } = await supabase
            .from('payments')
            .update({ status: 'refunded' })
            .eq('id', payment.id);

        if (paymentUpdateError) {
            console.error('Payment status update failed:', paymentUpdateError);
            throw paymentUpdateError;
        }

        // 6. 프로필 업데이트: free 플랜으로 전환, billing_key 제거
        const { error: profileUpdateError } = await supabase
            .from('profiles')
            .update({
                plan: 'free',
                billing_key: null,
                tokens_balance: 0,
                tokens_purchased: 0,
                updated_at: new Date().toISOString()
            })
            .eq('id', user.id);

        if (profileUpdateError) {
            console.error('Profile update failed:', profileUpdateError);
            throw profileUpdateError;
        }

        // 7. 환불 로그 기록
        await supabase.from('tokens_log').insert({
            user_id: user.id,
            action: 'refund',
            amount: 0,
            description: '구독 환불 처리'
        });

        // 8. 관리자 알림 (추후 이메일 등 추가 가능)
        console.log(`[REFUND] user=${user.id} email=${user.email} payment_id=${payment.payment_id} amount=${payment.amount} plan=${payment.plan} cancel_receipt_url=${cancelResult.cancel_receipt_urls?.[0] || 'N/A'}`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: '환불이 완료되었습니다.',
                refunded_amount: payment.amount,
                plan: 'free'
            })
        };

    } catch (error) {
        console.error('Refund error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
