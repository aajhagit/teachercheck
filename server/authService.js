import { createClient } from '@supabase/supabase-js';

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Server-side Authentication & Token Verification Service
 * 
 * Verifies Supabase JWT access tokens on incoming requests.
 * Uses only public/anon credentials for token verification (zero service-role key needed).
 */
export class AuthService {
  constructor(options = {}) {
    this.options = options;
    this._client = options.client || null;
  }

  getClient() {
    if (this._client) return this._client;

    const url = this.options.url || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
    const anonKey = this.options.anonKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

    if (!url || !anonKey) {
      return null;
    }

    try {
      this._client = createClient(url, anonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });
      return this._client;
    } catch (err) {
      console.warn('[TeacherCheck Server Auth] Failed to initialize Supabase client:', err.message);
      return null;
    }
  }

  isConfigured() {
    return Boolean(this.getClient());
  }

  /**
   * Verifies an incoming HTTP Authorization header.
   * Format: "Bearer <access_token>"
   * 
   * Returns:
   * - { authenticated: false, user: null } if no Authorization header provided (anonymous)
   * - { authenticated: false, error: 'MALFORMED_TOKEN', message: '...' } if header format is invalid
   * - { authenticated: false, error: 'AUTH_UNCONFIGURED', message: '...' } if server lacks Supabase config
   * - { authenticated: false, error: 'INVALID_TOKEN', message: '...' } if token is invalid/expired
   * - { authenticated: false, error: 'AUTH_TIMEOUT', message: '...' } if verification timed out
   * - { authenticated: true, user: { id, email } } if valid
   */
  async verifyUserToken(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') {
      return { authenticated: false, user: null };
    }

    const trimmed = authHeader.trim();
    if (!trimmed) {
      return { authenticated: false, user: null };
    }

    if (!trimmed.startsWith('Bearer ')) {
      return { 
        authenticated: false, 
        error: 'MALFORMED_TOKEN', 
        message: 'Authorization header must use Bearer scheme.' 
      };
    }

    const token = trimmed.substring(7).trim();
    if (!token) {
      return { 
        authenticated: false, 
        error: 'MALFORMED_TOKEN', 
        message: 'Access token cannot be empty.' 
      };
    }

    const client = this.getClient();
    if (!client) {
      return { 
        authenticated: false, 
        error: 'AUTH_UNCONFIGURED', 
        message: 'Authentication service is not configured on the server.' 
      };
    }

    let timeoutId;
    try {
      const timeoutMs = this.options.timeoutMs || DEFAULT_TIMEOUT_MS;
      const fetchPromise = client.auth.getUser(token);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutErr = new Error('Auth verification timed out');
          timeoutErr.name = 'TimeoutError';
          reject(timeoutErr);
        }, timeoutMs);
      });

      const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);

      if (error || !data?.user) {
        return { 
          authenticated: false, 
          error: 'INVALID_TOKEN', 
          message: error?.message || 'Invalid or expired access token.' 
        };
      }

      return {
        authenticated: true,
        user: {
          id: data.user.id,
          email: data.user.email || null
        }
      };
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (err.name === 'TimeoutError') {
        return { 
          authenticated: false, 
          error: 'AUTH_TIMEOUT', 
          message: 'Authentication verification service timed out.' 
        };
      }
      return { 
        authenticated: false, 
        error: 'AUTH_ERROR', 
        message: 'Authentication verification service error.' 
      };
    }
  }

  /**
   * Future extension point for subscription lookup.
   * Kept strictly at Free tier with 5 checks/day in this phase.
   */
  async getUserPlan(userId) {
    return { plan: 'free', limit: 5 };
  }
}

export const authService = new AuthService();
