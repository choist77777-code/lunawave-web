// admin-stats.js - 관리자 대시보드 통계 API
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

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
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

        // 관리자 권한 확인
        const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();

        if (!profile || profile.role !== 'admin') {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ error: 'Admin access required' })
            };
        }

        const params = event.queryStringParameters || {};
        const stat_type = params.type || 'overview';

        let result = {};

        switch (stat_type) {
            case 'overview':
                result = await getOverviewStats();
                break;
            case 'revenue':
                result = await getRevenueStats(params);
                break;
            case 'users':
                result = await getUserStats(params);
                break;
            case 'lunas':
            case 'tokens': // 호환성
                result = await getLunaStats();
                break;
            case 'referrals':
                result = await getReferralStats();
                break;
            default:
                result = await getOverviewStats();
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, ...result })
        };

    } catch (error) {
        console.error('Admin stats error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// 전체 개요 통계
async function getOverviewStats() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeekStart = new Date(today);
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // 총 유저 수
    const { count: totalUsers } = await supabase
        .from('profiles')
        .select('id', { count: 'exact' });

    // Pro 구독자 수
    const { count: proUsers } = await supabase
        .from('profiles')
        .select('id', { count: 'exact' })
        .eq('plan', 'pro')
        .gt('plan_expires_at', now.toISOString());

    // 오늘 매출
    const { data: todayPayments } = await supabase
        .from('payments')
        .select('amount')
        .eq('status', 'paid')
        .gte('paid_at', today.toISOString());

    const todayRevenue = todayPayments?.reduce((sum, p) => sum + p.amount, 0) || 0;

    // 이번 주 매출
    const { data: weekPayments } = await supabase
        .from('payments')
        .select('amount')
        .eq('status', 'paid')
        .gte('paid_at', thisWeekStart.toISOString());

    const weekRevenue = weekPayments?.reduce((sum, p) => sum + p.amount, 0) || 0;

    // 이번 달 매출
    const { data: monthPayments } = await supabase
        .from('payments')
        .select('amount')
        .eq('status', 'paid')
        .gte('paid_at', thisMonthStart.toISOString());

    const monthRevenue = monthPayments?.reduce((sum, p) => sum + p.amount, 0) || 0;

    // MRR (월간 반복 매출) = Pro 구독자 * 17,900
    const mrr = (proUsers || 0) * 17900;

    // 실수령액 (수수료 2.9% 차감)
    const feeRate = 0.029;
    const netMonthRevenue = Math.floor(monthRevenue * (1 - feeRate));

    // ARPU (유저당 평균 매출)
    const arpu = totalUsers > 0 ? Math.floor(monthRevenue / totalUsers) : 0;

    // 오늘 신규 가입
    const { count: todaySignups } = await supabase
        .from('profiles')
        .select('id', { count: 'exact' })
        .gte('created_at', today.toISOString());

    // 오늘 Pro 전환
    const { count: todayConversions } = await supabase
        .from('payments')
        .select('id', { count: 'exact' })
        .eq('type', 'subscription')
        .eq('status', 'paid')
        .gte('paid_at', today.toISOString());

    return {
        overview: {
            total_users: totalUsers || 0,
            pro_subscribers: proUsers || 0,
            today_revenue: todayRevenue,
            week_revenue: weekRevenue,
            month_revenue: monthRevenue,
            net_revenue: netMonthRevenue,
            mrr: mrr,
            arpu: arpu,
            today_signups: todaySignups || 0,
            today_conversions: todayConversions || 0
        }
    };
}

// 매출 통계
async function getRevenueStats(params) {
    const days = parseInt(params.days) || 30;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // 일별 매출 조회
    const { data: payments } = await supabase
        .from('payments')
        .select('amount, type, paid_at')
        .eq('status', 'paid')
        .gte('paid_at', startDate.toISOString())
        .lte('paid_at', endDate.toISOString())
        .order('paid_at', { ascending: true });

    // 일별 그룹화
    const dailyRevenue = {};
    let subscriptionTotal = 0;
    let tokenTotal = 0;

    for (const payment of payments || []) {
        const date = payment.paid_at.substring(0, 10);
        if (!dailyRevenue[date]) {
            dailyRevenue[date] = { subscription: 0, token: 0, total: 0 };
        }

        if (payment.type === 'subscription') {
            dailyRevenue[date].subscription += payment.amount;
            subscriptionTotal += payment.amount;
        } else {
            dailyRevenue[date].token += payment.amount;
            tokenTotal += payment.amount;
        }
        dailyRevenue[date].total += payment.amount;
    }

    return {
        revenue: {
            daily: dailyRevenue,
            subscription_total: subscriptionTotal,
            token_total: tokenTotal,
            grand_total: subscriptionTotal + tokenTotal,
            period_days: days
        }
    };
}

// 유저 통계
async function getUserStats(params) {
    const page = parseInt(params.page) || 1;
    const limit = parseInt(params.limit) || 20;
    const offset = (page - 1) * limit;

    // 유저 목록
    const { data: users, count } = await supabase
        .from('profiles')
        .select('id, email, name, plan, lunas_balance, lunas_purchased, daily_lunas_granted_at, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    // DAU (오늘 활성 유저)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: dau } = await supabase
        .from('login_logs')
        .select('user_id', { count: 'exact', head: true })
        .gte('created_at', today.toISOString());

    // WAU (7일 활성 유저)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const { data: wauData } = await supabase
        .from('login_logs')
        .select('user_id')
        .gte('created_at', weekAgo.toISOString());
    const wau = new Set(wauData?.map(l => l.user_id)).size;

    // MAU (30일 활성 유저)
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const { data: mauData } = await supabase
        .from('login_logs')
        .select('user_id')
        .gte('created_at', monthAgo.toISOString());
    const mau = new Set(mauData?.map(l => l.user_id)).size;

    return {
        users: {
            list: users || [],
            total: count || 0,
            page: page,
            limit: limit,
            dau: dau || 0,
            wau: wau,
            mau: mau
        }
    };
}

// 루나 통계
async function getLunaStats() {
    // 총 발행량 (subscription + purchase + promo + referral_bonus + daily + monthly_bonus)
    const { data: grantedLogs } = await supabase
        .from('lunas_log')
        .select('amount')
        .in('action', ['subscription', 'purchase', 'promo', 'referral_bonus', 'daily', 'monthly_bonus']);

    const totalGranted = grantedLogs?.reduce((sum, l) => sum + l.amount, 0) || 0;

    // 총 사용량
    const { data: usedLogs } = await supabase
        .from('lunas_log')
        .select('amount')
        .eq('action', 'use');

    const totalUsed = Math.abs(usedLogs?.reduce((sum, l) => sum + l.amount, 0) || 0);

    // 총 소멸량
    const { data: expiredLogs } = await supabase
        .from('lunas_log')
        .select('amount')
        .eq('action', 'rollover_expire');

    const totalExpired = Math.abs(expiredLogs?.reduce((sum, l) => sum + l.amount, 0) || 0);

    // 현재 잔액 총합
    const { data: balances } = await supabase
        .from('profiles')
        .select('lunas_balance, lunas_purchased');

    const totalBalance = balances?.reduce((sum, p) =>
        sum + (p.lunas_balance || 0) + (p.lunas_purchased || 0), 0) || 0;

    // 기능별 사용량
    const { data: featureUsage } = await supabase
        .from('lunas_log')
        .select('feature, amount')
        .eq('action', 'use')
        .not('feature', 'is', null);

    const byFeature = {};
    for (const log of featureUsage || []) {
        if (!byFeature[log.feature]) {
            byFeature[log.feature] = 0;
        }
        byFeature[log.feature] += Math.abs(log.amount);
    }

    // 이상 사용 유저 (하루 100루나 이상 - 일간 50 기준)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data: todayUsage } = await supabase
        .from('lunas_log')
        .select('user_id, amount')
        .eq('action', 'use')
        .gte('created_at', today.toISOString());

    const userDailyUsage = {};
    for (const log of todayUsage || []) {
        if (!userDailyUsage[log.user_id]) {
            userDailyUsage[log.user_id] = 0;
        }
        userDailyUsage[log.user_id] += Math.abs(log.amount);
    }

    const heavyUsers = Object.entries(userDailyUsage)
        .filter(([, usage]) => usage >= 100)
        .map(([userId, usage]) => ({ user_id: userId, today_usage: usage }));

    return {
        lunas: {
            total_granted: totalGranted,
            total_used: totalUsed,
            total_expired: totalExpired,
            total_balance: totalBalance,
            by_feature: byFeature,
            heavy_users: heavyUsers
        }
    };
}

// 추천 통계
async function getReferralStats() {
    // 총 추천 수
    const { count: totalReferrals } = await supabase
        .from('referrals')
        .select('id', { count: 'exact' });

    // 완료된 추천 (Pro 전환)
    const { count: completedReferrals } = await supabase
        .from('referrals')
        .select('id', { count: 'exact' })
        .eq('status', 'completed');

    // 총 지급 보너스
    const totalBonus = (completedReferrals || 0) * 400; // 추천인 + 피추천인

    // 상위 추천인
    const { data: topReferrers } = await supabase
        .from('referrals')
        .select('referrer_id, profiles!referrals_referrer_id_fkey(email)')
        .eq('status', 'completed');

    const referrerCounts = {};
    for (const r of topReferrers || []) {
        if (!referrerCounts[r.referrer_id]) {
            referrerCounts[r.referrer_id] = {
                email: r.profiles?.email,
                count: 0
            };
        }
        referrerCounts[r.referrer_id].count++;
    }

    const topList = Object.entries(referrerCounts)
        .map(([id, data]) => ({ user_id: id, email: data.email, referrals: data.count }))
        .sort((a, b) => b.referrals - a.referrals)
        .slice(0, 10);

    return {
        referrals: {
            total: totalReferrals || 0,
            completed: completedReferrals || 0,
            conversion_rate: totalReferrals > 0
                ? ((completedReferrals || 0) / totalReferrals * 100).toFixed(1)
                : 0,
            total_bonus_granted: totalBonus,
            top_referrers: topList
        }
    };
}
