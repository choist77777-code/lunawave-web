// grant-signup-bonus.js - 신규 가입 시 300 루나 보너스 자동 지급
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
        // Auth check
        const authHeader = event.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
        }

        // Check if already received welcome bonus
        const { data: existingLog } = await supabase
            .from('tokens_log')
            .select('id')
            .eq('user_id', user.id)
            .eq('action', 'welcome_bonus')
            .limit(1);

        if (existingLog && existingLog.length > 0) {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, already: true }) };
        }

        // Grant 300 luna bonus
        const { error: updateError } = await supabase
            .from('profiles')
            .update({ lunas_bonus: 300 })
            .eq('id', user.id);

        if (updateError) {
            console.error('Grant bonus update error:', updateError);
            return { statusCode: 500, headers, body: JSON.stringify({ error: updateError.message }) };
        }

        // Log the bonus
        await supabase.from('tokens_log').insert({
            user_id: user.id,
            action: 'welcome_bonus',
            amount: 300,
            description: '첫 가입 환영 보너스 300 루나'
        });

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, granted: 300 }) };

    } catch (error) {
        console.error('grant-signup-bonus error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
