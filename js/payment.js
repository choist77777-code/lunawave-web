// LunaWave Payment Logic

const PORTONE_IMP_CODE = 'YOUR_PORTONE_IMP_CODE'; // Replace with actual code

const PRICES = {
    subscription: {
        normal: 17900,
        firstMonth: 8950
    },
    tokens: {
        small: { tokens: 500, price: 7900 },
        medium: { tokens: 1000, price: 12900 },
        large: { tokens: 3000, price: 29900 }
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

    // Token package selection
    document.querySelectorAll('.token-package').forEach(el => {
        el.addEventListener('click', () => selectTokenPackage(el.dataset.package));
    });

    // Subscribe button
    document.getElementById('subscribeBtn')?.addEventListener('click', handleSubscribe);

    // Purchase tokens button
    document.getElementById('purchaseTokensBtn')?.addEventListener('click', handlePurchaseTokens);

    // Promo code
    document.getElementById('applyPromoBtn')?.addEventListener('click', applyPromoCode);

    // Parse URL params
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab === 'tokens') {
        document.querySelector('[data-tab="tokens"]')?.click();
    }

    const pkg = params.get('package');
    if (pkg) {
        selectTokenPackage(pkg);
    }
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

async function loadUserInfo() {
    const profile = await LW.getProfile();
    if (!profile) return;

    // Show current plan
    const currentPlan = document.getElementById('currentPlan');
    if (currentPlan) {
        currentPlan.textContent = profile.plan === 'pro' ? 'Pro' : 'Free';
    }

    // If already Pro, hide subscription tab content
    if (profile.plan === 'pro') {
        const subInfo = document.getElementById('subscriptionInfo');
        if (subInfo) {
            subInfo.innerHTML = `
                <div class="alert alert-success">
                    이미 Pro 구독 중입니다. 만료일: ${new Date(profile.plan_expires_at).toLocaleDateString('ko-KR')}
                </div>
            `;
        }
    }

    // Show current token balance
    const currentTokens = document.getElementById('currentTokens');
    if (currentTokens) {
        const total = (profile.tokens_balance || 0) + (profile.tokens_purchased || 0);
        currentTokens.textContent = Math.floor(total).toLocaleString();
    }
}

let selectedPackage = null;

function selectTokenPackage(pkg) {
    selectedPackage = pkg;

    document.querySelectorAll('.token-package').forEach(el => {
        el.classList.toggle('selected', el.dataset.package === pkg);
    });

    const purchaseBtn = document.getElementById('purchaseTokensBtn');
    if (purchaseBtn) {
        purchaseBtn.disabled = !pkg;
    }

    // Update summary
    updateTokenSummary();
}

function updateTokenSummary() {
    const summary = document.getElementById('tokenSummary');
    if (!summary || !selectedPackage) return;

    const pkg = PRICES.tokens[selectedPackage];
    if (!pkg) return;

    summary.innerHTML = `
        <div class="flex justify-between" style="margin-bottom: 8px;">
            <span>${pkg.tokens} 토큰</span>
            <span>₩${pkg.price.toLocaleString()}</span>
        </div>
        <div id="promoDiscount" style="display: none;" class="flex justify-between text-success">
            <span>할인</span>
            <span id="discountAmount">-₩0</span>
        </div>
        <hr style="margin: 12px 0; border: none; border-top: 1px solid var(--border);">
        <div class="flex justify-between" style="font-weight: 600; font-size: 18px;">
            <span>총 결제 금액</span>
            <span id="totalAmount">₩${pkg.price.toLocaleString()}</span>
        </div>
    `;
}

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

async function handleSubscribe() {
    const profile = await LW.getProfile();
    if (profile?.plan === 'pro') {
        alert('이미 Pro 구독 중입니다.');
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
    const amount = profile?.payments?.length === 0 ? PRICES.subscription.firstMonth : PRICES.subscription.normal;
    const merchantUid = `sub_${Date.now()}_${user.id.substring(0, 8)}`;

    IMP.request_pay({
        pg: 'kginicis',
        pay_method: 'card',
        merchant_uid: merchantUid,
        name: 'LunaWave Pro 구독',
        amount: amount,
        buyer_email: user.email,
        buyer_name: profile?.name || ''
    }, async (response) => {
        if (response.success) {
            // Verify and process payment
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
                        is_first_payment: profile?.payments?.length === 0
                    })
                });

                const result = await verifyResponse.json();

                if (result.success) {
                    alert('Pro 구독이 완료되었습니다!');
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

async function handlePurchaseTokens() {
    if (!selectedPackage) {
        alert('토큰 패키지를 선택해주세요.');
        return;
    }

    const pkg = PRICES.tokens[selectedPackage];
    if (!pkg) return;

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
    const profile = await LW.getProfile();
    const merchantUid = `token_${Date.now()}_${user.id.substring(0, 8)}`;

    IMP.request_pay({
        pg: 'kginicis',
        pay_method: 'card',
        merchant_uid: merchantUid,
        name: `LunaWave 토큰 ${pkg.tokens}개`,
        amount: pkg.price,
        buyer_email: user.email,
        buyer_name: profile?.name || ''
    }, async (response) => {
        if (response.success) {
            try {
                const session = await LW.getSession();
                const verifyResponse = await fetch('/.netlify/functions/purchase-tokens', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session.access_token}`
                    },
                    body: JSON.stringify({
                        imp_uid: response.imp_uid,
                        merchant_uid: merchantUid,
                        package_type: selectedPackage,
                        promo_code: window.appliedPromo?.code
                    })
                });

                const result = await verifyResponse.json();

                if (result.success) {
                    alert(`${result.tokens_granted} 토큰이 충전되었습니다!`);
                    window.location.href = '/dashboard.html';
                } else {
                    alert('결제 처리 중 오류가 발생했습니다.');
                }
            } catch (err) {
                console.error('Purchase error:', err);
                alert('결제 처리 중 오류가 발생했습니다.');
            }
        } else {
            alert('결제가 취소되었습니다.');
        }
    });
}
