// LunaWave Auth Logic

document.addEventListener('DOMContentLoaded', () => {
    // Wait for Supabase to load
    if (!window.LW) {
        console.error('Supabase client not loaded');
        return;
    }

    const supabase = LW.supabase;
    if (!supabase) return;

    // Login Form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    // Signup Form
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }

    // Social Login Buttons
    document.getElementById('googleLogin')?.addEventListener('click', () => handleSocialLogin('google'));
    document.getElementById('kakaoLogin')?.addEventListener('click', () => handleSocialLogin('kakao'));

    // Check if already logged in
    checkAuthAndRedirect();
});

async function checkAuthAndRedirect() {
    const session = await LW.getSession();
    if (session) {
        // Google 로그인 시 이름 자동 저장
        const user = session.user;
        if (user && user.user_metadata && user.user_metadata.full_name) {
            try {
                const supabase = LW.supabase;
                const { data: profile } = await supabase.from('profiles').select('name').eq('id', user.id).single();
                if (profile && (!profile.name || !profile.name.trim())) {
                    await supabase.from('profiles').update({ name: user.user_metadata.full_name }).eq('id', user.id);
                }
            } catch (_) {}
        }
        // Already logged in, redirect to dashboard
        const currentPath = window.location.pathname;
        if (currentPath.includes('login') || currentPath.includes('signup')) {
            window.location.href = '/dashboard.html';
        }
    }
}

async function handleLogin(e) {
    e.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const submitBtn = document.getElementById('submitBtn');
    const alertEl = document.getElementById('alert');

    if (!email || !password) {
        showAlert(alertEl, '이메일과 비밀번호를 입력해주세요.', 'error');
        return;
    }

    setLoading(submitBtn, true);
    hideAlert(alertEl);

    try {
        const supabase = LW.supabase;
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            if (error.message.includes('Invalid login')) {
                showAlert(alertEl, '이메일 또는 비밀번호가 올바르지 않습니다.', 'error');
            } else if (error.message.includes('Email not confirmed')) {
                showAlert(alertEl, '이메일 인증이 필요합니다. 이메일을 확인해주세요.', 'error');
            } else {
                showAlert(alertEl, error.message, 'error');
            }
            setLoading(submitBtn, false);
            return;
        }

        // Login success
        window.location.href = '/dashboard.html';

    } catch (err) {
        showAlert(alertEl, '로그인 중 오류가 발생했습니다.', 'error');
        setLoading(submitBtn, false);
    }
}

async function handleSignup(e) {
    e.preventDefault();

    const name = document.getElementById('name')?.value.trim() || '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const referralCode = document.getElementById('referralCode')?.value.trim() || '';
    const submitBtn = document.getElementById('submitBtn');
    const alertEl = document.getElementById('alert');

    if (!email || !password) {
        showAlert(alertEl, '이메일과 비밀번호를 입력해주세요.', 'error');
        return;
    }

    if (password.length < 6) {
        showAlert(alertEl, '비밀번호는 6자 이상이어야 합니다.', 'error');
        return;
    }

    setLoading(submitBtn, true);
    hideAlert(alertEl);

    try {
        const supabase = LW.supabase;
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    name: name,
                    referral_code: referralCode
                },
                emailRedirectTo: window.location.origin + '/dashboard.html'
            }
        });

        if (error) {
            if (error.message.includes('already registered')) {
                showAlert(alertEl, '이미 등록된 이메일입니다.', 'error');
            } else {
                showAlert(alertEl, error.message, 'error');
            }
            setLoading(submitBtn, false);
            return;
        }

        // Check if email confirmation is needed
        if (data?.user?.identities?.length === 0) {
            showAlert(alertEl, '이미 등록된 이메일입니다.', 'error');
            setLoading(submitBtn, false);
            return;
        }

        // Process referral code if provided
        if (referralCode && data.user) {
            try {
                await processReferralCode(data.user.id, referralCode);
            } catch (refErr) {
                console.log('Referral code error:', refErr);
            }
        }

        // Show success message
        showAlert(alertEl, '회원가입이 완료되었습니다! 이메일을 확인하여 인증을 완료해주세요.', 'success');
        setLoading(submitBtn, false);

        // Show success modal if exists
        const successModal = document.getElementById('successModal');
        if (successModal) {
            successModal.style.display = 'flex';
        }

    } catch (err) {
        showAlert(alertEl, '회원가입 중 오류가 발생했습니다.', 'error');
        setLoading(submitBtn, false);
    }
}

async function handleSocialLogin(provider) {
    try {
        const supabase = LW.supabase;
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: provider,
            options: {
                redirectTo: window.location.origin + '/dashboard.html'
            }
        });

        if (error) {
            const alertEl = document.getElementById('alert');
            showAlert(alertEl, error.message, 'error');
        }
    } catch (err) {
        console.error('Social login error:', err);
    }
}

async function processReferralCode(userId, code) {
    // Call the Netlify function to process referral
    const response = await fetch('/.netlify/functions/process-referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'register',
            referral_code: code
        })
    });
    return response.json();
}

function showAlert(el, message, type = 'error') {
    if (!el) return;
    el.textContent = message;
    el.className = `alert alert-${type}`;
    el.style.display = 'block';
}

function hideAlert(el) {
    if (!el) return;
    el.style.display = 'none';
}

function setLoading(btn, loading) {
    if (!btn) return;
    const btnText = btn.querySelector('.btn-text') || btn;
    const btnSpinner = btn.querySelector('.spinner');

    btn.disabled = loading;

    if (btnSpinner) {
        btnSpinner.style.display = loading ? 'block' : 'none';
    }

    if (btnText && btnText !== btn) {
        btnText.style.display = loading ? 'none' : 'inline';
    }
}

// Forgot Password
async function handleForgotPassword(email) {
    if (!email) {
        alert('이메일을 입력해주세요.');
        return;
    }

    try {
        const supabase = LW.supabase;
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/reset-password.html'
        });

        if (error) {
            alert(error.message);
            return;
        }

        alert('비밀번호 재설정 링크가 이메일로 전송되었습니다.');
    } catch (err) {
        alert('오류가 발생했습니다.');
    }
}

// Export for global use
window.handleForgotPassword = handleForgotPassword;
