// LunaWave Dashboard Logic

document.addEventListener('DOMContentLoaded', async () => {
    // Check auth
    const session = await LW.getSession();
    if (!session) {
        window.location.href = '/login.html';
        return;
    }

    // Load dashboard data
    loadDashboard();

    // Logout button
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
        await LW.signOut();
    });

    // Copy referral link
    document.getElementById('copyReferralBtn')?.addEventListener('click', copyReferralLink);

    // Remove device buttons
    document.querySelectorAll('.remove-device-btn').forEach(btn => {
        btn.addEventListener('click', (e) => removeDevice(e.target.dataset.deviceId));
    });

    // Inquiry form
    document.getElementById('inquiryForm')?.addEventListener('submit', handleInquiry);
});

async function loadDashboard() {
    try {
        const profile = await LW.getProfile();
        if (!profile) {
            console.error('Failed to load profile');
            return;
        }

        // Update plan badge
        const planBadge = document.getElementById('planBadge');
        if (planBadge) {
            const PLAN_NAMES = { free: 'Free', crescent: '초승달', halfmoon: '반달', fullmoon: '보름달' };
            const plan = profile.plan || 'free';
            planBadge.textContent = PLAN_NAMES[plan] || 'Free';
            planBadge.className = `badge badge-${plan}`;
        }

        // Update user email
        const userEmail = document.getElementById('userEmail');
        if (userEmail) {
            userEmail.textContent = profile.email;
        }

        // Update luna balance
        const lunaSection = document.getElementById('lunaSection') || document.getElementById('tokenSection');

        if (lunaSection) {
            lunaSection.style.display = 'block';

            const lunaBalance = document.getElementById('lunaBalance') || document.getElementById('tokenBalance');
            if (lunaBalance) {
                const total = (profile.lunas_balance || 0) + (profile.lunas_purchased || 0);
                lunaBalance.textContent = Math.floor(total).toLocaleString();
            }

            // Daily luna info
            const dailyLunaInfo = document.getElementById('dailyLunaInfo');
            if (dailyLunaInfo) {
                const DAILY_AMOUNTS = { free: 20, crescent: 50, halfmoon: 200, fullmoon: 999 };
                const dailyAmt = DAILY_AMOUNTS[profile.plan] || 20;
                if (profile.plan === 'fullmoon') {
                    dailyLunaInfo.textContent = '무제한';
                } else {
                    dailyLunaInfo.textContent = `일간 ${dailyAmt}루나`;
                }
            }

            // Luna progress bar (일간 루나 기준)
            const lunaProgress = document.getElementById('lunaProgress') || document.getElementById('tokenProgress');
            if (lunaProgress) {
                const DAILY_MAX = { free: 20, crescent: 50, halfmoon: 200, fullmoon: 999 };
                const dailyMax = DAILY_MAX[profile.plan] || 20;
                const percent = Math.min(100, ((profile.lunas_balance || 0) / dailyMax) * 100);
                lunaProgress.style.width = `${percent}%`;
            }
        }

        // Plan info display
        const planInfo = document.getElementById('planInfo');
        if (planInfo) {
            const PLAN_DESCS = {
                free: 'Free (매일 20루나)',
                crescent: '초승달 (매일 50루나 + 월 1,500루나)',
                halfmoon: '반달 (매일 200루나 + 월 3,000루나)',
                fullmoon: '보름달 (무제한)'
            };
            planInfo.textContent = PLAN_DESCS[profile.plan] || PLAN_DESCS.free;
        }

        // Referral code
        const referralCode = document.getElementById('referralCode');
        if (referralCode && profile.referral_code) {
            referralCode.textContent = profile.referral_code;
        }

        // Grant signup bonus if not yet received
        if (!profile.lunas_bonus || profile.lunas_bonus === 0) {
            try {
                const session = await LW.getSession();
                if (session) {
                    const res = await fetch('/api/grant-signup-bonus', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token }
                    });
                    const result = await res.json();
                    if (result.granted) {
                        profile.lunas_bonus = 300;
                        // Update luna display
                        const lunaBalance = document.getElementById('lunaBalance') || document.getElementById('tokenBalance');
                        if (lunaBalance) {
                            const total = (profile.lunas_balance || 0) + (profile.lunas_purchased || 0) + 300;
                            lunaBalance.textContent = Math.floor(total).toLocaleString();
                        }
                    }
                }
            } catch (_) {}
        }

        // Load additional data
        await Promise.all([
            loadDevices(),
            loadPayments(),
            loadNotices()
        ]);

    } catch (err) {
        console.error('Dashboard load error:', err);
    }
}

async function loadDevices() {
    const supabase = LW.supabase;
    const user = await LW.getUser();
    if (!user) return;

    try {
        const { data: devices, error } = await supabase
            .from('devices')
            .select('*')
            .eq('user_id', user.id)
            .order('last_active_at', { ascending: false });

        if (error) throw error;

        const devicesList = document.getElementById('devicesList');
        if (!devicesList) return;

        if (!devices || devices.length === 0) {
            devicesList.innerHTML = '<p class="text-muted">등록된 기기가 없습니다.</p>';
            return;
        }

        devicesList.innerHTML = devices.map(device => `
            <div class="device-item flex items-center justify-between" style="padding: 12px 0; border-bottom: 1px solid var(--border);">
                <div>
                    <div style="font-weight: 500;">${device.device_name || '알 수 없는 기기'}</div>
                    <div class="text-muted" style="font-size: 13px;">
                        최근 접속: ${new Date(device.last_active_at).toLocaleDateString('ko-KR')}
                    </div>
                </div>
                <button class="btn btn-sm btn-secondary remove-device-btn" data-device-id="${device.device_id}">
                    해제
                </button>
            </div>
        `).join('');

        // Add event listeners
        devicesList.querySelectorAll('.remove-device-btn').forEach(btn => {
            btn.addEventListener('click', () => removeDevice(btn.dataset.deviceId));
        });

    } catch (err) {
        console.error('Load devices error:', err);
    }
}

async function loadPayments() {
    const supabase = LW.supabase;
    const user = await LW.getUser();
    if (!user) return;

    try {
        const { data: payments, error } = await supabase
            .from('payments')
            .select('*')
            .eq('user_id', user.id)
            .eq('status', 'paid')
            .order('paid_at', { ascending: false })
            .limit(5);

        if (error) throw error;

        const paymentsList = document.getElementById('paymentsList');
        if (!paymentsList) return;

        if (!payments || payments.length === 0) {
            paymentsList.innerHTML = '<p class="text-muted">결제 내역이 없습니다.</p>';
            return;
        }

        paymentsList.innerHTML = `
            <table class="table">
                <thead>
                    <tr>
                        <th>날짜</th>
                        <th>유형</th>
                        <th>금액</th>
                    </tr>
                </thead>
                <tbody>
                    ${payments.map(p => `
                        <tr>
                            <td>${new Date(p.paid_at).toLocaleDateString('ko-KR')}</td>
                            <td>${p.type === 'subscription' ? (p.plan ? (p.plan === 'crescent' ? '초승달 구독' : p.plan === 'halfmoon' ? '반달 구독' : p.plan === 'fullmoon' ? '보름달 구독' : '구독') : '구독') : '루나 구매'}</td>
                            <td>₩${p.amount.toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

    } catch (err) {
        console.error('Load payments error:', err);
    }
}

async function loadNotices() {
    const supabase = LW.supabase;

    try {
        const { data: notices, error } = await supabase
            .from('notices')
            .select('*')
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) throw error;

        const noticesList = document.getElementById('noticesList');
        if (!noticesList) return;

        if (!notices || notices.length === 0) {
            noticesList.innerHTML = '<p class="text-muted">공지사항이 없습니다.</p>';
            return;
        }

        noticesList.innerHTML = notices.map(notice => `
            <div class="notice-item" style="padding: 12px 0; border-bottom: 1px solid var(--border);">
                <div class="flex items-center gap-2" style="margin-bottom: 4px;">
                    ${notice.type === 'urgent' ? '<span class="badge badge-error">긴급</span>' : ''}
                    <span style="font-weight: 500;">${notice.title}</span>
                </div>
                <div class="text-muted" style="font-size: 13px;">
                    ${new Date(notice.created_at).toLocaleDateString('ko-KR')}
                </div>
            </div>
        `).join('');

    } catch (err) {
        console.error('Load notices error:', err);
    }
}

async function removeDevice(deviceId) {
    if (!confirm('이 기기를 해제하시겠습니까?')) return;

    try {
        const supabase = LW.supabase;
        const { error } = await supabase
            .from('devices')
            .delete()
            .eq('device_id', deviceId);

        if (error) throw error;

        // Reload devices list
        await loadDevices();
        alert('기기가 해제되었습니다.');

    } catch (err) {
        console.error('Remove device error:', err);
        alert('기기 해제에 실패했습니다.');
    }
}

function copyReferralLink() {
    const code = document.getElementById('referralCode')?.textContent;
    if (!code) return;

    const link = `${window.location.origin}/signup.html?ref=${code}`;
    navigator.clipboard.writeText(link).then(() => {
        alert('추천 링크가 복사되었습니다!');
    }).catch(() => {
        prompt('추천 링크:', link);
    });
}

async function handleInquiry(e) {
    e.preventDefault();

    const subject = document.getElementById('inquirySubject')?.value.trim();
    const message = document.getElementById('inquiryMessage')?.value.trim();

    if (!subject || !message) {
        alert('제목과 내용을 입력해주세요.');
        return;
    }

    try {
        const supabase = LW.supabase;
        const user = await LW.getUser();
        if (!user) {
            alert('로그인이 필요합니다.');
            return;
        }

        const { error } = await supabase
            .from('inquiries')
            .insert({
                user_id: user.id,
                subject,
                message
            });

        if (error) throw error;

        alert('문의가 접수되었습니다. 빠른 시일 내에 답변드리겠습니다.');

        // Clear form
        document.getElementById('inquirySubject').value = '';
        document.getElementById('inquiryMessage').value = '';

    } catch (err) {
        console.error('Inquiry error:', err);
        alert('문의 접수에 실패했습니다.');
    }
}
