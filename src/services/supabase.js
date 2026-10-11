import { createClient } from '@supabase/supabase-js';

// Retrieve Vite environment variables for Supabase
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

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
