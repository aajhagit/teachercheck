import { createClient } from '@supabase/supabase-js';

/**
 * Normalizes the Supabase URL to ensure it points to the project origin
 * (e.g. strips accidental trailing slashes, /rest/v1, or /auth/v1 paths).
 */
export function normalizeSupabaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '').replace(/\/auth\/v1\/?$/, '');
  }
}

// Retrieve environment variables for Supabase (compatible with both Vite and Node test environments)
const env = (typeof import.meta !== 'undefined' && import.meta.env) 
  ? import.meta.env 
  : (typeof process !== 'undefined' && process.env ? process.env : {});

const rawSupabaseUrl = env.VITE_SUPABASE_URL || '';
const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
const supabaseAnonKey = (env.VITE_SUPABASE_ANON_KEY || '').trim();

let supabaseInstance = null;

/**
 * Checks if Supabase client configuration is present in environment
 */
export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

/**
 * Returns the singleton Supabase client or null if unconfigured
 */
export function getSupabase() {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!supabaseInstance) {
    try {
      supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage
        }
      });
    } catch (err) {
      console.warn('[TeacherCheck Auth] Failed to initialize Supabase client:', err);
      return null;
    }
  }

  return supabaseInstance;
}

/**
 * Sign in existing user with email and password
 */
export async function signIn(email, password) {
  const client = getSupabase();
  if (!client) {
    return { 
      data: null, 
      error: new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.') 
    };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password
    });
    return { data, error };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Sign up a new user with email and password
 */
export async function signUp(email, password) {
  const client = getSupabase();
  if (!client) {
    return { 
      data: null, 
      error: new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.') 
    };
  }

  try {
    const redirectUrl = `${window.location.origin}/app`;
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: redirectUrl
      }
    });
    return { data, error };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Sign out current user
 */
export async function signOut() {
  const client = getSupabase();
  if (!client) {
    return { error: null };
  }

  try {
    const { error } = await client.auth.signOut();
    return { error };
  } catch (err) {
    return { error: err };
  }
}

/**
 * Send password reset email
 */
export async function resetPasswordForEmail(email) {
  const client = getSupabase();
  if (!client) {
    return { 
      data: null, 
      error: new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.') 
    };
  }

  try {
    const redirectUrl = `${window.location.origin}/app`;
    const { data, error } = await client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: redirectUrl
    });
    return { data, error };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Get current session
 */
export async function getSession() {
  const client = getSupabase();
  if (!client) {
    return null;
  }

  try {
    const { data } = await client.auth.getSession();
    return data?.session || null;
  } catch {
    return null;
  }
}

/**
 * Returns current user's access token (JWT) if authenticated, or null
 */
export async function getAccessToken() {
  const session = await getSession();
  return session?.access_token || null;
}

/**
 * Subscribe to auth state changes (login, logout, token refresh)
 */
export function onAuthStateChange(callback) {
  const client = getSupabase();
  if (!client) {
    return { data: { subscription: { unsubscribe: () => {} } } };
  }

  return client.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}
