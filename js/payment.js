// LunaWave Payment Logic

const PORTONE_IMP_CODE = 'YOUR_PORTONE_IMP_CODE'; // Replace with actual code

const PRICES = {
    plans: {
        free:     { name: 'Free',   price: 0,     dailyLuna: 20,  monthlyLuna: 0 },
        crescent: { name: '초승달', price: 13900, dailyLuna: 50,  monthlyLuna: 1500 },
        half:     { name: '반달',   price: 33000, dailyLuna: 200, monthlyLuna: 3000 },
        full:     { name: '보름달', price: 79000, dailyLuna: -1,  monthlyLuna: -1 } // -1 = 무제한
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    // Check auth
    const session = await LW.getSession();
    if (!session) {
        window.location.href = '/login.html';
        return;
    }

    // Initialize tabs
    initTabs();

    // Load user info
    loadUserInfo();

    // Subscribe buttons (각 플랜별)
    document.querySelectorAll('[data-plan]').forEach(el => {
        el.addEventListener('click', () => handleSubscribe(el.dataset.plan));
    });

    // Promo code
    document.getElementById('applyPromoBtn')?.addEventListener('click', applyPromoCode);
});

function initTabs() {
    const tabBtns = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;

            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`tab-${tabName}`)?.classList.add('active');
        });
    });
}

const PLAN_NAMES = {
    free: 'Free',
    crescent: '초승달',
    half: '반달',
    full: '보름달'
};

async function loadUserInfo() {
    const profile = await LW.getProfile();
    if (!profile) return;

    const userPlan = profile.plan || 'free';

    // Show current plan
    const currentPlan = document.getElementById('currentPlan');
    if (currentPlan) {
        currentPlan.textContent = PLAN_NAMES[userPlan] || 'Free';
    }

    // If already subscribed, show current plan info
    if (userPlan !== 'free') {
        const subInfo = document.getElementById('subscriptionInfo');
        if (subInfo) {
            const planInfo = PRICES.plans[userPlan];
            const expiresStr = profile.plan_expires_at
                ? new Date(profile.plan_expires_at).toLocaleDateString('ko-KR')
                : '-';
            const dailyStr = planInfo.dailyLuna === -1 ? '무제한' : planInfo.dailyLuna;
            const monthlyStr = planInfo.monthlyLuna === -1 ? '무제한' : planInfo.monthlyLuna.toLocaleString();
            subInfo.innerHTML = `
                <div class="alert alert-success">
                    현재 ${planInfo.name} 플랜 구독 중입니다.<br>
                    일간 루나: ${dailyStr} / 월간 루나: ${monthlyStr}<br>
                    다음 결제일: ${expiresStr}
                </div>
            `;
        }
    }

    // Highlight current plan, disable lower/same plans
    document.querySelectorAll('[data-plan]').forEach(btn => {
        const btnPlan = btn.dataset.plan;
        const planOrder = ['free', 'crescent', 'half', 'full'];
        const currentIdx = planOrder.indexOf(userPlan);
        const btnIdx = planOrder.indexOf(btnPlan);

        if (btnIdx <= currentIdx) {
            btn.disabled = true;
            if (btnIdx === currentIdx) {
                btn.textContent = '현재 플랜';
            } else {
                btn.textContent = '하위 플랜';
            }
        }
    });
}

// (토큰 패키지 관련 코드 제거 - 4단계 구독 모델로 전환)

async function applyPromoCode() {
    const codeInput = document.getElementById('promoCode');
    const code = codeInput?.value.trim();
    if (!code) return;

    try {
        const session = await LW.getSession();
        const response = await fetch('/.netlify/functions/apply-promo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ code })
        });

        const data = await response.json();

        if (data.success) {
            alert(data.message || '프로모션 코드가 적용되었습니다.');

            // Store promo for checkout
            window.appliedPromo = data;

            // Update UI
            updatePriceWithDiscount(data);
        } else {
            alert(data.message || '유효하지 않은 프로모션 코드입니다.');
        }
    } catch (err) {
        console.error('Promo error:', err);
        alert('프로모션 코드 적용에 실패했습니다.');
    }
}

function updatePriceWithDiscount(promo) {
    // Update pricing display based on promo type
    if (promo.discount_type === 'percent') {
        // Apply percent discount
    } else if (promo.discount_type === 'fixed') {
        // Apply fixed discount
    } else if (promo.discount_type === 'bonus') {
        // Show bonus tokens info
    }
}

async function handleSubscribe(planId) {
    if (!planId || planId === 'free') {
        alert('Free 플랜은 결제가 필요하지 않습니다.');
        return;
    }

    const planInfo = PRICES.plans[planId];
    if (!planInfo) {
        alert('유효하지 않은 플랜입니다.');
        return;
    }

    const profile = await LW.getProfile();
    const currentPlan = profile?.plan || 'free';
    const planOrder = ['free', 'crescent', 'half', 'full'];

    if (planOrder.indexOf(planId) <= planOrder.indexOf(currentPlan)) {
        alert('현재 플랜과 동일하거나 하위 플랜입니다.');
        return;
    }

    // Check if PortOne is configured
    if (PORTONE_IMP_CODE === 'YOUR_PORTONE_IMP_CODE') {
        alert('결제 시스템이 아직 설정되지 않았습니다. 관리자에게 문의하세요.');
        return;
    }

    const IMP = window.IMP;
    if (!IMP) {
        alert('결제 모듈을 불러오지 못했습니다.');
        return;
    }

    IMP.init(PORTONE_IMP_CODE);

    const user = await LW.getUser();
    const amount = planInfo.price;
    const merchantUid = `sub_${planId}_${Date.now()}_${user.id.substring(0, 8)}`;

    IMP.request_pay({
        pg: 'kcp_billing',
        pay_method: 'card',
        merchant_uid: merchantUid,
        name: `LunaWave ${planInfo.name} 구독`,
        amount: amount,
        buyer_email: user.email,
        buyer_name: profile?.name || ''
    }, async (response) => {
        if (response.success) {
            try {
                const session = await LW.getSession();
                const verifyResponse = await fetch('/.netlify/functions/subscribe', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({
                        imp_uid: response.imp_uid,
                        merchant_uid: merchantUid,
                        plan_id: planId
                    })
                });

                const result = await verifyResponse.json();

                if (result.success) {
                    alert(`${planInfo.name} 구독이 완료되었습니다!`);
                    window.location.href = '/dashboard.html';
                } else {
                    alert('결제 처리 중 오류가 발생했습니다.');
                }
            } catch (err) {
                console.error('Subscribe error:', err);
                alert('결제 처리 중 오류가 발생했습니다.');
            }
        } else {
            alert('결제가 취소되었습니다.');
        }
    });
}

// (handlePurchaseTokens 제거 - 4단계 구독 모델로 전환)
