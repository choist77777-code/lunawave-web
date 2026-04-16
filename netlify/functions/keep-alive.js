// keep-alive.js - Supabase pause 방지용 주기적 ping
// Netlify Scheduled Functions로 매일 1회 자동 실행됨
// 참고: https://docs.netlify.com/functions/scheduled-functions/
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
    const startedAt = new Date().toISOString();
    const results = {};

    try {
        // 1. profiles 테이블 count 쿼리 (읽기)
        const { count: profilesCount, error: profilesErr } = await supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true });
        results.profiles = profilesErr ? `ERR: ${profilesErr.message}` : `OK (${profilesCount} rows)`;

        // 2. ai_config 테이블 읽기
        const { data: aiCfg, error: aiErr } = await supabase
            .from('ai_config')
            .select('id, active_provider, updated_at')
            .eq('id', 1)
            .single();
        results.ai_config = aiErr ? `ERR: ${aiErr.message}` : `OK (provider: ${aiCfg?.active_provider})`;

        // 3. Auth API ping (auth 서비스도 활성 상태 유지)
        try {
            const { data: { users }, error: authErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
            results.auth = authErr ? `ERR: ${authErr.message}` : `OK (${users?.length || 0} user fetched)`;
        } catch (e) {
            results.auth = `EXCEPTION: ${e.message}`;
        }

        console.log(`[keep-alive] ${startedAt}`, results);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                timestamp: startedAt,
                results
            })
        };
    } catch (e) {
        console.error('[keep-alive] exception:', e);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: e.message, results })
        };
    }
};

// Netlify Scheduled Function: 매일 UTC 0시 (한국 오전 9시)
exports.config = {
    schedule: '@daily'
};
