// log-login.js - 로그인 로그 기록 (service_role로 RLS 우회)
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const authHeader = event.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
        }

        const body = JSON.parse(event.body || '{}');

        const { error: insertError } = await supabase.from('login_logs').insert({
            user_id: user.id,
            ip_address: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
            device_id: body.device_id || body.device_name || 'web',
            user_agent: body.user_agent ? body.user_agent.substring(0, 200) : null
        });

        if (insertError) {
            console.error('login_logs insert error:', insertError);
            return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: insertError.message }) };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    } catch (error) {
        console.error('log-login error:', error);
        return { statusCode: 200, headers, body: JSON.stringify({ success: false }) };
    }
};
