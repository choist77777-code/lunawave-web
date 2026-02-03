// LunaWave Supabase Client
// ES Module - import from CDN

const SUPABASE_URL = 'https://iuyiowozlakcthjzvszu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1eWlvd296bGFrY3Roanp2c3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwMzU0NjUsImV4cCI6MjA4NTYxMTQ2NX0.eYKFDxao53mBrlH1ExE6wlqPEV-PXbzsUSxqXXMgPI4';

// Supabase client will be initialized after loading the SDK
let supabase = null;

// Initialize Supabase
function initSupabase() {
    if (window.supabase && !supabase) {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabase;
}

// Get current session
async function getSession() {
    const client = initSupabase();
    if (!client) return null;

    const { data: { session } } = await client.auth.getSession();
    return session;
}

// Get current user
async function getUser() {
    const session = await getSession();
    return session?.user || null;
}

// Get user profile
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

// Check if user is admin
async function isAdmin() {
    const profile = await getProfile();
    return profile?.role === 'admin';
}

// Sign out
async function signOut() {
    const client = initSupabase();
    if (!client) return;

    await client.auth.signOut();
    window.location.href = '/login.html';
}

// Auth state change listener
function onAuthStateChange(callback) {
    const client = initSupabase();
    if (!client) return;

    client.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

// Export for use in other scripts
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
