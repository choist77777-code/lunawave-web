// LunaWave Dashboard Logic

const PLAN_NAMES_DASH = {
    free: 'Free',
    crescent: '초승달',
    half: '반달',
    full: '보름달'
};

const PLAN_INFO_DASH = {
    free:     { dailyLuna: 20,  monthlyLuna: 0 },
    crescent: { dailyLuna: 50,  monthlyLuna: 1500 },
    half:     { dailyLuna: 200, monthlyLuna: 3000 },
    full:     { dailyLuna: -1,  monthlyLuna: -1 } // -1 = 무제한
};

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

        // Update plan badge (4단계: free/crescent/half/full)
        const userPlan = profile.plan || 'free';
        const planBadge = document.getElementById('planBadge');
        if (planBadge) {
            planBadge.textContent = PLAN_NAMES_DASH[userPlan] || 'Free';
            planBadge.className = `badge badge-${userPlan}`;
        }

        // Update user email
        const userEmail = document.getElementById('userEmail');
        if (userEmail) {
            userEmail.textContent = profile.email;
        }

        // Update luna balance (4단계 모델)
        const pInfo = PLAN_INFO_DASH[userPlan] || PLAN_INFO_DASH.free;
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
                const dailyStr = pInfo.dailyLuna === -1 ? '무제한' : pInfo.dailyLuna;
                dailyLunaInfo.textContent = `일간 ${dailyStr}루나`;
            }

            // Monthly luna info
            const monthlyLunaInfo = document.getElementById('monthlyLunaInfo');
            if (monthlyLunaInfo) {
                const monthlyStr = pInfo.monthlyLuna === -1 ? '무제한' : pInfo.monthlyLuna.toLocaleString();
                monthlyLunaInfo.textContent = `월간 ${monthlyStr}루나`;
            }

            // Luna progress bar
            const lunaProgress = document.getElementById('lunaProgress') || document.getElementById('tokenProgress');
            if (lunaProgress) {
                if (pInfo.dailyLuna === -1) {
                    lunaProgress.style.width = '100%';
                } else {
                    const percent = Math.min(100, ((profile.lunas_balance || 0) / pInfo.dailyLuna) * 100);
                    lunaProgress.style.width = `${percent}%`;
                }
            }
        }

        // Plan info display
        const planInfoEl = document.getElementById('planInfo');
        if (planInfoEl) {
            const dailyStr = pInfo.dailyLuna === -1 ? '무제한' : pInfo.dailyLuna;
            const monthlyStr = pInfo.monthlyLuna === -1 ? '무제한' : pInfo.monthlyLuna.toLocaleString();
            planInfoEl.textContent = `${PLAN_NAMES_DASH[userPlan]} (일간 ${dailyStr}루나 / 월간 ${monthlyStr}루나)`;
        }

        // Referral code
        const referralCode = document.getElementById('referralCode');
        if (referralCode && profile.referral_code) {
            referralCode.textContent = profile.referral_code;
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
                            <td>${p.type === 'subscription' ? (PLAN_NAMES_DASH[p.plan_id] || '') + ' 구독' : '기타'}</td>
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
