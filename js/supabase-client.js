// LunaWave Supabase Client
const SUPABASE_URL = 'https://iuyiowozlakcthjzvszu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1eWlvd296bGFrY3Roanp2c3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwMzU0NjUsImV4cCI6MjA4NTYxMTQ2NX0.eYKFDxao53mBrlH1ExE6wlqPEV-PXbzsUSxqXXMgPI4';

// Supabase client - 변수명을 _sbClient로 사용하여 window.supabase와 충돌 방지
let _sbClient = null;

function initSupabase() {
    if (window.supabase && !_sbClient) {
        _sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _sbClient;
}

async function getSession() {
    const client = initSupabase();
    if (!client) return null;
    const { data: { session } } = await client.auth.getSession();
    return session;
}

async function getUser() {
    const session = await getSession();
    return session?.user || null;
}

async function getProfile() {
    const client = initSupabase();
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
    if (error) {
        console.error('Error fetching profile:', error);
        return null;
    }
    return data;
}

async function isAdmin() {
    const profile = await getProfile();
    return profile?.role === 'admin';
}

async function signOut() {
    const client = initSupabase();
    if (!client) return;
    await client.auth.signOut();
    window.location.href = '/login.html';
}

function onAuthStateChange(callback) {
    const client = initSupabase();
    if (!client) return;
    client.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

window.LW = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    initSupabase,
    getSession,
    getUser,
    getProfile,
    isAdmin,
    signOut,
    onAuthStateChange,
    get supabase() { return initSupabase(); }
};
