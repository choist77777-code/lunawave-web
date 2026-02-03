// check-plan.js - 플랜/루나 조회 (앱에서 호출)
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 일간 루나 지급량
const DAILY_LUNAS = {
    free: 20,
    pro: 50
};

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
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

        // 쿼리 파라미터에서 device_id 추출
        const params = event.queryStringParameters || {};
        const device_id = params.device_id;

        // 프로필 조회
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError && profileError.code !== 'PGRST116') {
            throw profileError;
        }

        // 프로필이 없으면 생성 (첫 가입 시 바로 일간 루나 지급)
        if (!profile) {
            const today = new Date().toISOString().split('T')[0];
            const newProfile = {
                id: user.id,
                email: user.email,
                name: user.user_metadata?.name || null,
                plan: 'free',
                lunas_balance: DAILY_LUNAS.free, // 첫 가입 시 바로 20루나 지급
                lunas_purchased: 0,
                daily_lunas_granted_at: today,
                free_songs_used: 0,
                referral_code: generateReferralCode()
            };

            const { error: insertError } = await supabase
                .from('profiles')
                .insert(newProfile);

            if (insertError) {
                throw insertError;
            }

            // 가입 루나 지급 로그
            await supabase
                .from('lunas_log')
                .insert({
                    user_id: user.id,
                    action: 'daily',
                    amount: DAILY_LUNAS.free,
                    balance_after: DAILY_LUNAS.free,
                    description: '첫 가입 - 일간 루나 지급 (Free 20)'
                });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    profile: {
                        plan: 'free',
                        lunas_balance: DAILY_LUNAS.free,
                        lunas_purchased: 0,
                        lunas_total: DAILY_LUNAS.free,
                        daily_lunas_granted_at: today,
                        referral_code: newProfile.referral_code,
                        device_limit: 2
                    },
                    is_new: true
                })
            };
        }

        // 일간 루나 자동 지급 체크
        const today = new Date().toISOString().split('T')[0];
        if (profile.daily_lunas_granted_at !== today) {
            const grantAmount = profile.plan === 'pro' ? DAILY_LUNAS.pro : DAILY_LUNAS.free;

            await supabase
                .from('profiles')
                .update({
                    lunas_balance: grantAmount,
                    daily_lunas_granted_at: today,
                    updated_at: new Date().toISOString()
                })
                .eq('id', user.id);

            await supabase
                .from('lunas_log')
                .insert({
                    user_id: user.id,
                    action: 'daily',
                    amount: grantAmount,
                    balance_after: grantAmount + (profile.lunas_purchased || 0),
                    description: profile.plan === 'pro' ? '일간 루나 지급 (Pro 50)' : '일간 루나 지급 (Free 20)'
                });

            profile.lunas_balance = grantAmount;
            profile.daily_lunas_granted_at = today;
        }

        // 기기 정보 처리
        let deviceInfo = null;
        let deviceWarning = null;

        if (device_id) {
            // 현재 기기 조회
            const { data: device } = await supabase
                .from('devices')
                .select('*')
                .eq('device_id', device_id)
                .single();

            if (device) {
                // 기기 업데이트
                await supabase
                    .from('devices')
                    .update({
                        last_active_at: new Date().toISOString(),
                        user_id: user.id
                    })
                    .eq('device_id', device_id);

                deviceInfo = {
                    device_id: device.device_id,
                    device_name: device.device_name,
                    is_free_used: device.is_free_used
                };

                // Free 플랜에서 이미 무료 사용한 기기인 경우
                if (profile.plan === 'free' && device.is_free_used && device.user_id !== user.id) {
                    deviceWarning = 'device_free_used';
                }
            } else {
                // 새 기기 등록
                const { error: deviceInsertError } = await supabase
                    .from('devices')
                    .insert({
                        user_id: user.id,
                        device_id: device_id,
                        device_name: params.device_name || 'Unknown Device',
                        is_free_used: false
                    });

                if (!deviceInsertError) {
                    deviceInfo = {
                        device_id: device_id,
                        device_name: params.device_name || 'Unknown Device',
                        is_free_used: false
                    };
                }
            }

            // Pro 플랜 기기 수 제한 확인
            if (profile.plan === 'pro') {
                const { count } = await supabase
                    .from('devices')
                    .select('id', { count: 'exact' })
                    .eq('user_id', user.id);

                if (count > (profile.device_limit || 2)) {
                    deviceWarning = 'device_limit_exceeded';
                }
            }
        }

        // 유저의 등록된 기기 목록
        const { data: devices } = await supabase
            .from('devices')
            .select('device_id, device_name, last_active_at')
            .eq('user_id', user.id)
            .order('last_active_at', { ascending: false })
            .limit(5);

        // 구독 만료 확인
        let planStatus = 'active';
        if (profile.plan === 'pro' && profile.plan_expires_at) {
            const expiresAt = new Date(profile.plan_expires_at);
            const now = new Date();
            const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

            if (daysUntilExpiry <= 0) {
                planStatus = 'expired';
            } else if (daysUntilExpiry <= 7) {
                planStatus = 'expiring_soon';
            }
        }

        const lunas_total = (profile.lunas_balance || 0) + (profile.lunas_purchased || 0);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                profile: {
                    plan: profile.plan,
                    plan_status: planStatus,
                    plan_started_at: profile.plan_started_at,
                    plan_expires_at: profile.plan_expires_at,
                    lunas_balance: profile.lunas_balance || 0,
                    lunas_purchased: profile.lunas_purchased || 0,
                    lunas_total: lunas_total,
                    daily_lunas_granted_at: profile.daily_lunas_granted_at,
                    referral_code: profile.referral_code,
                    device_limit: profile.device_limit || 2
                },
                device: deviceInfo,
                devices: devices || [],
                device_warning: deviceWarning
            })
        };

    } catch (error) {
        console.error('Check plan error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// 추천 코드 생성
function generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'LW';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}
