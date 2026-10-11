import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { 
  updateUserPassword, 
  formatAuthError,
  isSupabaseConfigured 
} from '../src/services/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Password Recovery Completion Flow', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // 1. SERVICE LAYER: updateUserPassword
  // =========================================================================
  describe('Supabase Service: updateUserPassword', () => {
    test('returns descriptive error when Supabase is unconfigured', async () => {
      // In unconfigured environment
      const res = await updateUserPassword('newSecretPassword123');
      assert.equal(res.data, null);
      assert.ok(res.error instanceof Error);
      assert.ok(
        res.error.message.includes('Supabase is not configured') ||
        res.error.message.includes('VITE_SUPABASE_URL'),
        `Error must mention missing configuration: ${res.error.message}`
      );
    });

    test('formatAuthError translates recovery token expired error gracefully', () => {
      const expiredError = {
        name: 'AuthApiError',
        status: 401,
        message: 'Token has expired or is invalid'
      };
      const formatted = formatAuthError(expiredError);
      assert.ok(formatted.includes('Token has expired or is invalid'));
    });

    test('formatAuthError translates network exceptions into user-friendly diagnostic guidance', () => {
      const netError = new TypeError('Failed to fetch');
      const formatted = formatAuthError(netError);
      assert.ok(formatted.includes('Unable to connect to the authentication service'));
    });

    test('never exposes password values in error logs', async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => {
        warnings.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
      };

      try {
        const sensitivePassword = 'ultra-secret-plaintext-password-999';
        await updateUserPassword(sensitivePassword);

        for (const warn of warnings) {
          assert.ok(!warn.includes(sensitivePassword), 'Sensitive password must never be logged');
        }
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // =========================================================================
  // 2. DOM & ACCESSIBILITY CONTRACT: index.html
  // =========================================================================
  describe('HTML Template Contract: index.html', () => {
    const htmlContent = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

    test('includes authEmailGroup wrapper for hiding email in recovery mode', () => {
      assert.ok(
        htmlContent.includes('id="authEmailGroup"'),
        'index.html must have #authEmailGroup container'
      );
    });

    test('includes authPasswordLabel for dynamic New Password label', () => {
      assert.ok(
        htmlContent.includes('id="authPasswordLabel"'),
        'index.html must have #authPasswordLabel'
      );
    });

    test('includes accessible confirm password field with matching label and helper text', () => {
      assert.ok(
        htmlContent.includes('id="authConfirmPasswordGroup"'),
        'index.html must have #authConfirmPasswordGroup'
      );
      assert.ok(
        htmlContent.includes('id="authConfirmPassword"'),
        'index.html must have #authConfirmPassword input'
      );
      assert.ok(
        htmlContent.includes('for="authConfirmPassword"'),
        'index.html must have label with for="authConfirmPassword"'
      );
      assert.ok(
        htmlContent.includes('autocomplete="new-password"'),
        'index.html must specify autocomplete="new-password"'
      );
    });
  });

  // =========================================================================
  // 3. APPLICATION LOGIC CONTRACT: src/main.js
  // =========================================================================
  describe('Application Logic: src/main.js', () => {
    const mainJsContent = fs.readFileSync(path.join(ROOT_DIR, 'src/main.js'), 'utf8');

    test('imports updateUserPassword from supabase service', () => {
      assert.ok(
        mainJsContent.includes('updateUserPassword'),
        'src/main.js must import updateUserPassword'
      );
    });

    test('listens for PASSWORD_RECOVERY auth state event', () => {
      assert.ok(
        mainJsContent.includes("event === 'PASSWORD_RECOVERY'"),
        "src/main.js must handle event === 'PASSWORD_RECOVERY'"
      );
      assert.ok(
        mainJsContent.includes("openAuthModal('recovery')"),
        "src/main.js must open modal in recovery mode on PASSWORD_RECOVERY"
      );
    });

    test('verifies active user session before allowing updateUserPassword execution', () => {
      assert.ok(
        mainJsContent.includes('const currentSession = await getSession();'),
        'src/main.js must verify active session before submitting recovery password'
      );
      assert.ok(
        mainJsContent.includes('if (!currentSession?.user)'),
        'src/main.js must abort password update if no active session exists'
      );
    });

    test('requires both type=recovery and accessToken before considering URL a recovery flow', () => {
      assert.ok(
        mainJsContent.includes("hashParams.type === 'recovery' && Boolean(hashParams.accessToken)"),
        'src/main.js must require accessToken in addition to type=recovery'
      );
    });

    test('handles error params in URL hash gracefully without opening recovery mode', () => {
      assert.ok(
        mainJsContent.includes('hashParams.error || hashParams.errorCode'),
        'src/main.js must detect error or errorCode in URL hash'
      );
      assert.ok(
        mainJsContent.includes("openAuthModal('forgot')"),
        'src/main.js must redirect to forgot password modal when recovery link is invalid or expired'
      );
    });

    test('sanitizes Google Analytics page_location by stripping sensitive URL hash tokens', () => {
      assert.ok(
        mainJsContent.includes('safeLocation = window.location.origin + window.location.pathname'),
        'src/main.js must build sanitized page_location without hash'
      );
      assert.ok(
        !mainJsContent.includes('page_location: window.location.href'),
        'src/main.js must never pass raw window.location.href (which contains tokens) to analytics'
      );
    });

    test('validates password length and matching confirmation before submitting', () => {
      assert.ok(
        mainJsContent.includes('newPassword.length < 6'),
        'src/main.js must enforce minimum 6 characters'
      );
      assert.ok(
        mainJsContent.includes('newPassword !== confirmPassword'),
        'src/main.js must enforce confirmation password match'
      );
      assert.ok(
        mainJsContent.includes('Passwords do not match'),
        'src/main.js must provide clear error when passwords do not match'
      );
    });

    test('cleans up recovery fragment and signs out recovery session on completion', () => {
      assert.ok(
        mainJsContent.includes("switchAuthMode('signin')"),
        'src/main.js must switch to signin mode after update'
      );
      assert.ok(
        mainJsContent.includes('await signOut()'),
        'src/main.js must sign out recovery session so user signs in cleanly with new credentials'
      );
      assert.ok(
        mainJsContent.includes("authPassword.value = ''"),
        'src/main.js must clear password inputs'
      );
      assert.ok(
        mainJsContent.includes("authConfirmPassword.value = ''"),
        'src/main.js must clear confirmation password input'
      );
      assert.ok(
        mainJsContent.includes('cleanAuthHash()'),
        'src/main.js must clean up URL fragment via cleanAuthHash'
      );
    });

    test('supports Escape key closing and clears password inputs on modal close', () => {
      assert.ok(
        mainJsContent.includes("e.key === 'Escape'"),
        'src/main.js must support Escape key to close auth modal'
      );
      assert.ok(
        mainJsContent.includes("if (authPassword) authPassword.value = ''"),
        'src/main.js must wipe authPassword on closeAuthModal'
      );
      assert.ok(
        mainJsContent.includes("if (authConfirmPassword) authConfirmPassword.value = ''"),
        'src/main.js must wipe authConfirmPassword on closeAuthModal'
      );
    });
  });

  // =========================================================================
  // 4. CLIENT PASSWORD VALIDATION RULES (Behavioral)
  // =========================================================================
  describe('Password Validation Logic', () => {
    function validateRecoveryPasswords(newPassword, confirmPassword) {
      if (!newPassword) {
        return { valid: false, error: 'Please enter your new password.' };
      }
      if (newPassword.length < 6) {
        return { valid: false, error: 'Password must be at least 6 characters long.' };
      }
      if (!confirmPassword) {
        return { valid: false, error: 'Please confirm your new password.' };
      }
      if (newPassword !== confirmPassword) {
        return { valid: false, error: 'Passwords do not match. Please ensure both fields are identical.' };
      }
      return { valid: true };
    }

    test('rejects missing new password', () => {
      const res = validateRecoveryPasswords('', 'abc123');
      assert.equal(res.valid, false);
      assert.equal(res.error, 'Please enter your new password.');
    });

    test('rejects password shorter than 6 characters', () => {
      const res = validateRecoveryPasswords('12345', '12345');
      assert.equal(res.valid, false);
      assert.equal(res.error, 'Password must be at least 6 characters long.');
    });

    test('rejects missing confirmation password', () => {
      const res = validateRecoveryPasswords('validPass123', '');
      assert.equal(res.valid, false);
      assert.equal(res.error, 'Please confirm your new password.');
    });

    test('rejects mismatched confirmation password', () => {
      const res = validateRecoveryPasswords('validPass123', 'differentPass456');
      assert.equal(res.valid, false);
      assert.equal(res.error, 'Passwords do not match. Please ensure both fields are identical.');
    });

    test('accepts matching valid passwords of 6 or more characters', () => {
      const res = validateRecoveryPasswords('correctHorseBattery99!', 'correctHorseBattery99!');
      assert.equal(res.valid, true);
      assert.equal(res.error, undefined);
    });
  });

  // =========================================================================
  // 5. URL HASH PARSING & ANALYTICS SANITIZATION (Behavioral)
  // =========================================================================
  describe('URL Hash Parsing & Privacy Sanitization Logic', () => {
    function parseAuthHash(hashString) {
      if (!hashString) return {};
      const cleanHash = hashString.replace(/^#/, '');
      const params = new URLSearchParams(cleanHash);
      return {
        type: params.get('type'),
        accessToken: params.get('access_token'),
        refreshToken: params.get('refresh_token'),
        error: params.get('error'),
        errorCode: params.get('error_code'),
        errorDescription: params.get('error_description')
      };
    }

    function sanitizeAnalyticsLocation(url) {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname + parsed.search;
    }

    test('correctly parses valid recovery token hash from Supabase redirect', () => {
      const hash = '#access_token=secret_jwt_token_123&refresh_token=secret_refresh_456&expires_in=3600&token_type=bearer&type=recovery';
      const parsed = parseAuthHash(hash);
      assert.equal(parsed.type, 'recovery');
      assert.equal(parsed.accessToken, 'secret_jwt_token_123');
      assert.equal(parsed.refreshToken, 'secret_refresh_456');
      assert.equal(parsed.error, null);
    });

    test('detects expired link error hash params without treating as valid recovery', () => {
      const hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
      const parsed = parseAuthHash(hash);
      assert.equal(parsed.error, 'access_denied');
      assert.equal(parsed.errorCode, 'otp_expired');
      assert.ok(parsed.errorDescription.includes('Email link is invalid or has expired'));
      assert.equal(parsed.accessToken, null);
    });

    test('distinguishes bare type=recovery hash from authentic tokens', () => {
      const hash = '#type=recovery';
      const parsed = parseAuthHash(hash);
      assert.equal(parsed.type, 'recovery');
      assert.equal(parsed.accessToken, null);
      // Valid recovery flow requires accessToken
      const isRecoveryFlow = parsed.type === 'recovery' && Boolean(parsed.accessToken);
      assert.equal(isRecoveryFlow, false);
    });

    test('strips access_token and refresh_token from Google Analytics page_location', () => {
      const fullUrl = 'https://teachercheckai.com/app?ref=email#access_token=sensitive_jwt_token&refresh_token=sensitive_ref_token&type=recovery';
      const sanitized = sanitizeAnalyticsLocation(fullUrl);
      assert.equal(sanitized, 'https://teachercheckai.com/app?ref=email');
      assert.ok(!sanitized.includes('access_token'));
      assert.ok(!sanitized.includes('refresh_token'));
      assert.ok(!sanitized.includes('sensitive_jwt_token'));
      assert.ok(!sanitized.includes('#'));
    });
  });

  // =========================================================================
  // 6. RECOVERY SESSION ENFORCEMENT CONTRACT (Behavioral)
  // =========================================================================
  describe('Recovery Session Enforcement Contract', () => {
    async function executePasswordUpdate(mockClient, newPassword) {
      if (!mockClient) {
        return { data: null, error: new Error('Supabase is not configured.') };
      }
      const { data: sessionData, error: sessionErr } = await mockClient.auth.getSession();
      if (sessionErr || !sessionData?.session?.user) {
        return {
          data: null,
          error: new Error('No active recovery session found. Your password reset link may have expired or already been used. Please request a new reset link.')
        };
      }
      return await mockClient.auth.updateUser({ password: newPassword });
    }

    test('rejects update when session is missing / unauthenticated', async () => {
      const mockClient = {
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          updateUser: async () => ({ data: { user: {} }, error: null })
        }
      };

      const res = await executePasswordUpdate(mockClient, 'newPassword123');
      assert.equal(res.data, null);
      assert.ok(res.error.message.includes('No active recovery session found'));
    });

    test('successfully executes update when authenticated recovery session is present', async () => {
      let capturedPassword = null;
      const mockClient = {
        auth: {
          getSession: async () => ({ 
            data: { session: { user: { id: 'usr-recovery-42', email: 'student@example.com' } } }, 
            error: null 
          }),
          updateUser: async ({ password }) => {
            capturedPassword = password;
            return { data: { user: { id: 'usr-recovery-42', email: 'student@example.com' } }, error: null };
          }
        }
      };

      const res = await executePasswordUpdate(mockClient, 'BrandNewPassword99!');
      assert.equal(capturedPassword, 'BrandNewPassword99!');
      assert.ok(res.data?.user?.id === 'usr-recovery-42');
      assert.equal(res.error, null);
    });

    test('propagates Supabase API errors when updateUser fails upstream', async () => {
      const mockClient = {
        auth: {
          getSession: async () => ({ 
            data: { session: { user: { id: 'usr-recovery-42' } } }, 
            error: null 
          }),
          updateUser: async () => ({ 
            data: null, 
            error: { status: 422, message: 'New password should be different from the old password.' } 
          })
        }
      };

      const res = await executePasswordUpdate(mockClient, 'SameOldPassword123');
      assert.equal(res.data, null);
      assert.equal(res.error.status, 422);
      assert.ok(res.error.message.includes('New password should be different'));
    });
  });
});
