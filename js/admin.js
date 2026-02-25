// LunaWave Admin Panel Logic

let currentTab = 'dashboard';
let chartInstances = {};

document.addEventListener('DOMContentLoaded', async () => {
    // Check auth and admin role
    const session = await LW.getSession();
    if (!session) {
        window.location.href = '/login.html';
        return;
    }

    const isAdmin = await LW.isAdmin();
    if (!isAdmin) {
        window.location.href = '/404.html';
        return;
    }

    // Initialize tabs
    initAdminTabs();

    // Load initial data
    loadAdminDashboard();

    // Logout button
    document.getElementById('adminLogoutBtn')?.addEventListener('click', async () => {
        await LW.signOut();
    });
});

function initAdminTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    currentTab = tabName;

    // Update tab buttons
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update tab content
    document.querySelectorAll('.admin-content').forEach(content => {
        content.classList.toggle('active', content.id === `admin-${tabName}`);
    });

    // Load tab data
    switch (tabName) {
        case 'dashboard':
            loadAdminDashboard();
            break;
        case 'users':
            loadUsers();
            break;
        case 'tokens':
            loadTokenStats();
            break;
        case 'payments':
            loadPayments();
            break;
        case 'marketing':
            loadMarketing();
            break;
        case 'analytics':
            loadAnalytics();
            break;
        case 'cs':
            loadCS();
            break;
        case 'security':
            loadSecurity();
            break;
    }
}

// ========== Dashboard Tab ==========
async function loadAdminDashboard() {
    try {
        const session = await LW.getSession();
        const response = await fetch('/.netlify/functions/admin-stats?type=overview', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();

        if (!data.success) {
            console.error('Failed to load dashboard data');
            return;
        }

        const stats = data.overview;

        // Update stat cards
        updateStatCard('todayRevenue', `₩${stats.today_revenue?.toLocaleString() || 0}`);
        updateStatCard('weekRevenue', `₩${stats.week_revenue?.toLocaleString() || 0}`);
        updateStatCard('monthRevenue', `₩${stats.month_revenue?.toLocaleString() || 0}`);
        updateStatCard('netRevenue', `₩${stats.net_revenue?.toLocaleString() || 0}`);
        updateStatCard('proSubscribers', stats.pro_subscribers || 0);
        updateStatCard('totalUsers', stats.total_users || 0);
        updateStatCard('mrr', `₩${stats.mrr?.toLocaleString() || 0}`);
        updateStatCard('arpu', `₩${stats.arpu?.toLocaleString() || 0}`);
        updateStatCard('todaySignups', stats.today_signups || 0);
        updateStatCard('todayConversions', stats.today_conversions || 0);

        // Load charts
        loadRevenueChart();
        loadRevenueBreakdownChart();

    } catch (err) {
        console.error('Dashboard error:', err);
    }
}

function updateStatCard(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

async function loadRevenueChart() {
    try {
        const session = await LW.getSession();
        const response = await fetch('/.netlify/functions/admin-stats?type=revenue&days=30', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();

        if (!data.success) return;

        const daily = data.revenue?.daily || {};
        const dates = Object.keys(daily).sort();
        const values = dates.map(d => daily[d].total);

        const ctx = document.getElementById('revenueChart');
        if (!ctx) return;

        if (chartInstances.revenue) {
            chartInstances.revenue.destroy();
        }

        chartInstances.revenue = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates.map(d => d.substring(5)),
                datasets: [{
                    label: '일별 매출',
                    data: values,
                    borderColor: '#f5a623',
                    backgroundColor: 'rgba(245, 166, 35, 0.1)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: value => '₩' + value.toLocaleString()
                        }
                    }
                }
            }
        });

    } catch (err) {
        console.error('Revenue chart error:', err);
    }
}

async function loadRevenueBreakdownChart() {
    try {
        const session = await LW.getSession();
        const response = await fetch('/.netlify/functions/admin-stats?type=revenue&days=30', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();

        if (!data.success) return;

        const ctx = document.getElementById('breakdownChart');
        if (!ctx) return;

        if (chartInstances.breakdown) {
            chartInstances.breakdown.destroy();
        }

        chartInstances.breakdown = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['구독', '토큰'],
                datasets: [{
                    data: [data.revenue?.subscription_total || 0, data.revenue?.token_total || 0],
                    backgroundColor: ['#f5a623', '#3b82f6']
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });

    } catch (err) {
        console.error('Breakdown chart error:', err);
    }
}

// ========== Users Tab ==========
async function loadUsers(page = 1) {
    try {
        const session = await LW.getSession();
        const response = await fetch(`/.netlify/functions/admin-stats?type=users&page=${page}&limit=20`, {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();

        if (!data.success) return;

        // Update DAU/WAU/MAU
        updateStatCard('dau', data.users?.dau || 0);
        updateStatCard('wau', data.users?.wau || 0);
        updateStatCard('mau', data.users?.mau || 0);

        // Render users table
        const tableBody = document.getElementById('usersTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (data.users?.list || []).map(user => `
            <tr data-user-id="${user.id}">
                <td>${user.email}</td>
                <td>${user.name || '-'}</td>
                <td><span class="badge ${user.plan === 'pro' ? 'badge-pro' : 'badge-free'}">${user.plan || 'free'}</span></td>
                <td>${Math.floor((user.lunas_free || 0) + (user.lunas_monthly || 0) + (user.lunas_bonus || 0) + (user.tokens_purchased || 0))}</td>
                <td>${new Date(user.created_at).toLocaleDateString('ko-KR')}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="showUserDetail('${user.id}')">상세</button>
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load users error:', err);
    }
}

async function showUserDetail(userId) {
    const supabase = LW.supabase;

    try {
        const { data: user, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (error) throw error;

        const modal = document.getElementById('userDetailModal');
        const content = document.getElementById('userDetailContent');

        if (!modal || !content) return;

        content.innerHTML = `
            <div class="form-group">
                <label>이메일</label>
                <input type="text" class="form-input" value="${user.email}" readonly>
            </div>
            <div class="form-group">
                <label>이름</label>
                <input type="text" class="form-input" value="${user.name || ''}" id="editUserName">
            </div>
            <div class="form-group">
                <label>플랜</label>
                <select class="form-select" id="editUserPlan">
                    <option value="free" ${user.plan === 'free' ? 'selected' : ''}>Free</option>
                    <option value="pro" ${user.plan === 'pro' ? 'selected' : ''}>Pro</option>
                </select>
            </div>
            <div class="form-group">
                <label>일간/월간/보너스 루나</label>
                <input type="number" class="form-input" value="${(user.lunas_free || 0) + (user.lunas_monthly || 0) + (user.lunas_bonus || 0)}" readonly>
            </div>
            <div class="form-group">
                <label>구매 루나</label>
                <input type="number" class="form-input" value="${user.tokens_purchased || 0}" readonly>
            </div>
            <hr style="margin: 20px 0;">
            <div class="form-group">
                <label>토큰 수동 지급</label>
                <div class="flex gap-2">
                    <input type="number" class="form-input" id="grantTokenAmount" placeholder="수량">
                    <input type="text" class="form-input" id="grantTokenReason" placeholder="사유">
                    <button class="btn btn-primary" onclick="grantTokens('${userId}')">지급</button>
                </div>
            </div>
        `;

        modal.style.display = 'flex';

    } catch (err) {
        console.error('Show user detail error:', err);
    }
}

async function grantTokens(userId) {
    const amount = parseFloat(document.getElementById('grantTokenAmount')?.value);
    const reason = document.getElementById('grantTokenReason')?.value || '관리자 지급';

    if (!amount || isNaN(amount)) {
        alert('유효한 수량을 입력하세요.');
        return;
    }

    try {
        const supabase = LW.supabase;
        const session = await LW.getSession();

        const { data, error } = await supabase.rpc('admin_grant_tokens', {
            p_admin_id: session.user.id,
            p_target_user_id: userId,
            p_amount: amount,
            p_reason: reason
        });

        if (error) throw error;

        alert(`${amount} 토큰이 지급되었습니다.`);
        closeModal('userDetailModal');
        loadUsers();

    } catch (err) {
        console.error('Grant tokens error:', err);
        alert('토큰 지급에 실패했습니다.');
    }
}

// ========== Tokens Tab ==========
async function loadTokenStats() {
    try {
        const session = await LW.getSession();
        const response = await fetch('/.netlify/functions/admin-stats?type=tokens', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();

        if (!data.success) return;

        const tokens = data.tokens;

        updateStatCard('totalGranted', Math.floor(tokens.total_granted || 0).toLocaleString());
        updateStatCard('totalUsed', Math.floor(tokens.total_used || 0).toLocaleString());
        updateStatCard('totalBalance', Math.floor(tokens.total_balance || 0).toLocaleString());
        updateStatCard('totalExpired', Math.floor(tokens.total_expired || 0).toLocaleString());

        // Feature usage chart
        loadFeatureUsageChart(tokens.by_feature);

        // Heavy users table
        const tableBody = document.getElementById('heavyUsersTableBody');
        if (tableBody) {
            tableBody.innerHTML = (tokens.heavy_users || []).map(u => `
                <tr>
                    <td>${u.user_id.substring(0, 8)}...</td>
                    <td>${u.today_usage} 토큰</td>
                    <td><button class="btn btn-sm btn-secondary" onclick="showUserDetail('${u.user_id}')">상세</button></td>
                </tr>
            `).join('') || '<tr><td colspan="3" class="text-muted">이상 사용자 없음</td></tr>';
        }

    } catch (err) {
        console.error('Token stats error:', err);
    }
}

function loadFeatureUsageChart(byFeature) {
    const ctx = document.getElementById('featureUsageChart');
    if (!ctx || !byFeature) return;

    if (chartInstances.featureUsage) {
        chartInstances.featureUsage.destroy();
    }

    const labels = Object.keys(byFeature);
    const values = Object.values(byFeature);

    chartInstances.featureUsage = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '토큰 사용량',
                data: values,
                backgroundColor: '#f5a623'
            }]
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            plugins: { legend: { display: false } }
        }
    });
}

// ========== Payments Tab ==========
async function loadPayments(page = 1) {
    const supabase = LW.supabase;

    try {
        const { data: payments, error } = await supabase
            .from('payments')
            .select('*, profiles(email)')
            .order('created_at', { ascending: false })
            .range((page - 1) * 20, page * 20 - 1);

        if (error) throw error;

        const tableBody = document.getElementById('paymentsTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (payments || []).map(p => `
            <tr>
                <td>${new Date(p.created_at).toLocaleDateString('ko-KR')}</td>
                <td>${p.profiles?.email || '-'}</td>
                <td>${p.type === 'subscription' ? '구독' : '토큰'}</td>
                <td>₩${(p.amount || 0).toLocaleString()}</td>
                <td><span class="badge ${p.status === 'paid' ? 'badge-success' : 'badge-free'}">${p.status}</span></td>
                <td>
                    ${p.status === 'paid' ? `<button class="btn btn-sm btn-secondary" onclick="refundPayment('${p.id}')">환불</button>` : '-'}
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load payments error:', err);
    }
}

// ========== Marketing Tab ==========
async function loadMarketing() {
    try {
        const session = await LW.getSession();
        const response = await fetch('/.netlify/functions/admin-stats?type=referrals', {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        const data = await response.json();

        if (!data.success) return;

        const referrals = data.referrals;

        updateStatCard('totalReferrals', referrals.total || 0);
        updateStatCard('completedReferrals', referrals.completed || 0);
        updateStatCard('referralConversion', `${referrals.conversion_rate || 0}%`);
        updateStatCard('totalBonusGranted', `${(referrals.total_bonus_granted || 0).toLocaleString()} 토큰`);

        // Load promo codes
        loadPromoCodes();

    } catch (err) {
        console.error('Marketing error:', err);
    }
}

async function loadPromoCodes() {
    const supabase = LW.supabase;

    try {
        const { data: promos, error } = await supabase
            .from('promo_codes')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const tableBody = document.getElementById('promoCodesTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (promos || []).map(p => `
            <tr>
                <td><code>${p.code}</code></td>
                <td>${p.type}</td>
                <td>${p.value}</td>
                <td>${p.used_count} / ${p.max_uses}</td>
                <td><span class="badge ${p.is_active ? 'badge-success' : 'badge-free'}">${p.is_active ? '활성' : '비활성'}</span></td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="togglePromo('${p.id}', ${!p.is_active})">
                        ${p.is_active ? '비활성화' : '활성화'}
                    </button>
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load promo codes error:', err);
    }
}

async function createPromoCode() {
    const code = document.getElementById('newPromoCode')?.value.trim().toUpperCase();
    const type = document.getElementById('newPromoType')?.value;
    const value = parseFloat(document.getElementById('newPromoValue')?.value);
    const maxUses = parseInt(document.getElementById('newPromoMaxUses')?.value) || 100;

    if (!code || !type || isNaN(value)) {
        alert('모든 필드를 입력하세요.');
        return;
    }

    const supabase = LW.supabase;

    try {
        const { error } = await supabase
            .from('promo_codes')
            .insert({
                code,
                type,
                value,
                max_uses: maxUses
            });

        if (error) throw error;

        alert('프로모션 코드가 생성되었습니다.');
        closeModal('createPromoModal');
        loadPromoCodes();

    } catch (err) {
        console.error('Create promo error:', err);
        alert('프로모션 코드 생성에 실패했습니다.');
    }
}

async function togglePromo(id, active) {
    const supabase = LW.supabase;

    try {
        const { error } = await supabase
            .from('promo_codes')
            .update({ is_active: active })
            .eq('id', id);

        if (error) throw error;
        loadPromoCodes();

    } catch (err) {
        console.error('Toggle promo error:', err);
    }
}

// ========== CS Tab ==========
async function loadCS() {
    loadInquiries();
    loadNotices();
    loadFAQ();
}

async function loadInquiries() {
    const supabase = LW.supabase;

    try {
        const { data: inquiries, error } = await supabase
            .from('inquiries')
            .select('*, profiles(email)')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const tableBody = document.getElementById('inquiriesTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (inquiries || []).map(i => `
            <tr>
                <td>${new Date(i.created_at).toLocaleDateString('ko-KR')}</td>
                <td>${i.profiles?.email || '-'}</td>
                <td>${i.subject}</td>
                <td><span class="badge ${i.status === 'open' ? 'badge-error' : 'badge-success'}">${i.status}</span></td>
                <td>
                    <button class="btn btn-sm btn-primary" onclick="showInquiryDetail('${i.id}')">답변</button>
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load inquiries error:', err);
    }
}

async function loadNotices() {
    const supabase = LW.supabase;

    try {
        const { data: notices, error } = await supabase
            .from('notices')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const tableBody = document.getElementById('noticesTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (notices || []).map(n => `
            <tr>
                <td>${n.title}</td>
                <td><span class="badge">${n.type}</span></td>
                <td>${n.is_active ? '활성' : '비활성'}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="editNotice('${n.id}')">수정</button>
                    <button class="btn btn-sm btn-secondary" onclick="deleteNotice('${n.id}')">삭제</button>
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load notices error:', err);
    }
}

async function loadFAQ() {
    const supabase = LW.supabase;

    try {
        const { data: faq, error } = await supabase
            .from('faq')
            .select('*')
            .order('sort_order', { ascending: true });

        if (error) throw error;

        const tableBody = document.getElementById('faqTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (faq || []).map(f => `
            <tr>
                <td>${f.question}</td>
                <td>${f.category}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="editFAQ('${f.id}')">수정</button>
                    <button class="btn btn-sm btn-secondary" onclick="deleteFAQ('${f.id}')">삭제</button>
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load FAQ error:', err);
    }
}

// ========== Security Tab ==========
async function loadSecurity() {
    loadLoginLogs();
    loadAbuseDevices();
}

async function loadLoginLogs() {
    const supabase = LW.supabase;

    try {
        const { data: logs, error } = await supabase
            .from('login_logs')
            .select('*, profiles(email)')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        const tableBody = document.getElementById('loginLogsTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = (logs || []).map(l => `
            <tr>
                <td>${new Date(l.created_at).toLocaleString('ko-KR')}</td>
                <td>${l.profiles?.email || '-'}</td>
                <td>${l.ip_address || '-'}</td>
                <td>${l.device_id?.substring(0, 12) || '-'}...</td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Load login logs error:', err);
    }
}

async function loadAbuseDevices() {
    const supabase = LW.supabase;

    try {
        // Find devices used by multiple accounts
        const { data: devices, error } = await supabase
            .from('devices')
            .select('device_id, user_id')
            .order('device_id');

        if (error) throw error;

        // Group by device_id
        const deviceMap = {};
        (devices || []).forEach(d => {
            if (!deviceMap[d.device_id]) {
                deviceMap[d.device_id] = [];
            }
            deviceMap[d.device_id].push(d.user_id);
        });

        // Filter devices with 3+ accounts
        const abuseDevices = Object.entries(deviceMap)
            .filter(([, users]) => users.length >= 3)
            .map(([deviceId, users]) => ({ deviceId, count: users.length }));

        const tableBody = document.getElementById('abuseDevicesTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = abuseDevices.map(d => `
            <tr>
                <td>${d.deviceId.substring(0, 16)}...</td>
                <td>${d.count} 계정</td>
                <td><button class="btn btn-sm btn-secondary">조치</button></td>
            </tr>
        `).join('') || '<tr><td colspan="3" class="text-muted">악용 의심 기기 없음</td></tr>';

    } catch (err) {
        console.error('Load abuse devices error:', err);
    }
}

// ========== Analytics Tab ==========
async function loadAnalytics() {
    // Conversion funnel, cohort heatmap, etc.
    // Implementation depends on available data
    console.log('Analytics tab loaded');
}

// ========== Utilities ==========
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'flex';
}

// Export functions for onclick handlers
window.showUserDetail = showUserDetail;
window.grantTokens = grantTokens;
window.createPromoCode = createPromoCode;
window.togglePromo = togglePromo;
window.closeModal = closeModal;
window.openModal = openModal;
