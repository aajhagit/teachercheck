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
 * Safely formats auth error messages for end-user display.
 * Translates raw fetch/network exceptions into clear guidance without exposing internal details or credentials.
 */
export function formatAuthError(error, defaultMessage = 'An unexpected error occurred. Please try again.') {
  if (!error) return defaultMessage;
  const msg = typeof error === 'string' ? error : (error.message || '');
  const name = error.name || '';

  // Network, fetch, or CSP failure
  if (
    msg.includes('Failed to fetch') || 
    msg.includes('NetworkError') || 
    name === 'AuthRetryableFetchError' || 
    name === 'TypeError'
  ) {
    return 'Unable to connect to the authentication service. Please check your internet connection or network security settings and try again.';
  }

  return msg || defaultMessage;
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
    if (error) {
      console.warn('[TeacherCheck Auth] Sign in failed:', {
        action: 'signIn',
        status: error.status,
        name: error.name,
        message: error.message
      });
    }
    return { data, error };
  } catch (err) {
    console.warn('[TeacherCheck Auth] Sign in network exception:', {
      action: 'signIn',
      name: err.name,
      message: err.message
    });
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
    const redirectUrl = (typeof window !== 'undefined' && window.location?.origin)
      ? `${window.location.origin}/app`
      : 'https://teachercheckai.com/app';
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: redirectUrl
      }
    });
    if (error) {
      console.warn('[TeacherCheck Auth] Sign up failed:', {
        action: 'signUp',
        status: error.status,
        name: error.name,
        message: error.message
      });
    }
    return { data, error };
  } catch (err) {
    console.warn('[TeacherCheck Auth] Sign up network exception:', {
      action: 'signUp',
      name: err.name,
      message: err.message
    });
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
    const redirectUrl = (typeof window !== 'undefined' && window.location?.origin)
      ? `${window.location.origin}/app`
      : 'https://teachercheckai.com/app';
    const { data, error } = await client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: redirectUrl
    });
    if (error) {
      console.warn('[TeacherCheck Auth] Password reset failed:', {
        action: 'resetPasswordForEmail',
        status: error.status,
        name: error.name,
        message: error.message
      });
    }
    return { data, error };
  } catch (err) {
    console.warn('[TeacherCheck Auth] Password reset network exception:', {
      action: 'resetPasswordForEmail',
      name: err.name,
      message: err.message
    });
    return { data: null, error: err };
  }
}

/**
 * Update current user's password (used for password recovery flow).
 * Requires an active, authenticated recovery session.
 * Never logs or exposes password values.
 */
export async function updateUserPassword(newPassword) {
  const client = getSupabase();
  if (!client) {
    return {
      data: null,
      error: new Error('Supabase is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.')
    };
  }

  try {
    const { data: sessionData, error: sessionErr } = await client.auth.getSession();
    if (sessionErr || !sessionData?.session?.user) {
      return {
        data: null,
        error: new Error('No active recovery session found. Your password reset link may have expired or already been used. Please request a new reset link.')
      };
    }

    const { data, error } = await client.auth.updateUser({
      password: newPassword
    });
    if (error) {
      console.warn('[TeacherCheck Auth] Password update failed:', {
        action: 'updateUserPassword',
        status: error.status,
        name: error.name,
        message: error.message
      });
    }
    return { data, error };
  } catch (err) {
    console.warn('[TeacherCheck Auth] Password update network exception:', {
      action: 'updateUserPassword',
      name: err.name,
      message: err.message
    });
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
