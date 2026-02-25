// admin-db.js - Admin CRUD proxy (service_role key, bypasses RLS)
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_TABLES = ['profiles', 'payments', 'events', 'notices', 'promo_codes', 'ai_config'];

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

        // Admin role check
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        if (!profile || profile.role !== 'admin') {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
        }

        const body = JSON.parse(event.body);
        const { table, action } = body;

        if (!ALLOWED_TABLES.includes(table)) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid table: ' + table }) };
        }

        const result = await executeQuery(body);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result.data, error: result.error, count: result.count })
        };

    } catch (error) {
        console.error('admin-db error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};

async function executeQuery(body) {
    const { table, action, data, filters, select, selectOpts, order, limit, single, range } = body;

    let query;

    switch (action) {
        case 'select':
            query = supabase.from(table).select(select || '*', selectOpts || {});
            break;
        case 'insert':
            query = supabase.from(table).insert(data);
            if (body.returning !== false) query = query.select();
            break;
        case 'update':
            query = supabase.from(table).update(data);
            break;
        case 'delete':
            query = supabase.from(table).delete();
            break;
        default:
            return { data: null, error: { message: 'Invalid action: ' + action } };
    }

    // Apply filters
    if (filters && Array.isArray(filters)) {
        for (const f of filters) {
            switch (f.op) {
                case 'eq': query = query.eq(f.col, f.val); break;
                case 'neq': query = query.neq(f.col, f.val); break;
                case 'gte': query = query.gte(f.col, f.val); break;
                case 'lte': query = query.lte(f.col, f.val); break;
                case 'gt': query = query.gt(f.col, f.val); break;
                case 'lt': query = query.lt(f.col, f.val); break;
                case 'in': query = query.in(f.col, f.val); break;
                case 'is': query = query.is(f.col, f.val); break;
                case 'not': query = query.not(f.col, f.innerOp || 'is', f.val); break;
            }
        }
    }

    // Apply order
    if (order) {
        const orders = Array.isArray(order) ? order : [order];
        for (const o of orders) {
            query = query.order(o.column, { ascending: o.ascending !== undefined ? o.ascending : false });
        }
    }

    // Apply limit
    if (limit) query = query.limit(limit);

    // Apply range
    if (range && Array.isArray(range) && range.length === 2) {
        query = query.range(range[0], range[1]);
    }

    // Single
    if (single) query = query.single();

    return await query;
}
