import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CSP_POLICY, getCspPolicy, DEFAULT_SUPABASE_ORIGIN, applySecurityHeaders } from '../server/securityHeaders.js';
import { normalizeSupabaseUrl, formatAuthError } from '../src/services/supabase.js';

describe('Content Security Policy (CSP) & Supabase Auth Hardening', () => {
  test('CSP_POLICY includes https://mxmzafzselbwjogfheha.supabase.co in connect-src directive', () => {
    assert.ok(
      CSP_POLICY.includes('connect-src'),
      'CSP_POLICY should include a connect-src directive'
    );
    assert.ok(
      CSP_POLICY.includes('https://mxmzafzselbwjogfheha.supabase.co'),
      'CSP_POLICY connect-src should allow correct project origin https://mxmzafzselbwjogfheha.supabase.co'
    );
  });

  test('getCspPolicy dynamically incorporates configured environment Supabase URL', () => {
    const prevUrl = process.env.VITE_SUPABASE_URL;
    try {
      process.env.VITE_SUPABASE_URL = 'https://custom-project-ref.supabase.co';
      const dynamicPolicy = getCspPolicy();
      assert.ok(
        dynamicPolicy.includes('https://custom-project-ref.supabase.co'),
        'getCspPolicy should include dynamically configured Supabase origin'
      );
      assert.ok(
        dynamicPolicy.includes(DEFAULT_SUPABASE_ORIGIN),
        'getCspPolicy should also include default project origin'
      );
    } finally {
      if (prevUrl !== undefined) {
        process.env.VITE_SUPABASE_URL = prevUrl;
      } else {
        delete process.env.VITE_SUPABASE_URL;
      }
    }
  });

  test('CSP_POLICY preserves required origins for self and Google Analytics without wildcards on supabase', () => {
    assert.ok(CSP_POLICY.includes("'self'"), 'CSP_POLICY should preserve self');
    assert.ok(CSP_POLICY.includes('https://www.google-analytics.com'), 'CSP_POLICY should preserve GA');
    assert.ok(CSP_POLICY.includes('https://www.googletagmanager.com'), 'CSP_POLICY should preserve GTM');
    assert.ok(
      !CSP_POLICY.includes('https://*.supabase.co'),
      'CSP_POLICY should NOT use broad wildcards for Supabase'
    );
    assert.ok(
      !CSP_POLICY.includes("'unsafe-eval'"),
      'CSP_POLICY should not allow unsafe-eval'
    );
  });

  test('applySecurityHeaders sets Content-Security-Policy response header properly', () => {
    const headers = {};
    const mockRes = {
      setHeader(key, value) {
        headers[key] = value;
      }
    };

    applySecurityHeaders(mockRes);
    assert.ok(headers['Content-Security-Policy'].includes('connect-src'));
    assert.ok(headers['Content-Security-Policy'].includes('https://mxmzafzselbwjogfheha.supabase.co'));
  });

  test('normalizeSupabaseUrl strips accidental /rest/v1 path segments and formats root project origin', () => {
    const inputWithRest = 'https://mxmzafzselbwjogfheha.supabase.co/rest/v1';
    assert.equal(
      normalizeSupabaseUrl(inputWithRest),
      'https://mxmzafzselbwjogfheha.supabase.co'
    );

    const inputWithRestTrailingSlash = 'https://mxmzafzselbwjogfheha.supabase.co/rest/v1/';
    assert.equal(
      normalizeSupabaseUrl(inputWithRestTrailingSlash),
      'https://mxmzafzselbwjogfheha.supabase.co'
    );

    const inputWithTrailingSlash = 'https://mxmzafzselbwjogfheha.supabase.co/';
    assert.equal(
      normalizeSupabaseUrl(inputWithTrailingSlash),
      'https://mxmzafzselbwjogfheha.supabase.co'
    );

    const inputClean = 'https://mxmzafzselbwjogfheha.supabase.co';
    assert.equal(
      normalizeSupabaseUrl(inputClean),
      'https://mxmzafzselbwjogfheha.supabase.co'
    );

    const inputWhitespace = '   https://mxmzafzselbwjogfheha.supabase.co   ';
    assert.equal(
      normalizeSupabaseUrl(inputWhitespace),
      'https://mxmzafzselbwjogfheha.supabase.co'
    );

    assert.equal(normalizeSupabaseUrl(''), '');
    assert.equal(normalizeSupabaseUrl(null), '');
    assert.equal(normalizeSupabaseUrl(undefined), '');
  });

  test('formatAuthError translates fetch and network failures into user-friendly diagnostic guidance', () => {
    const fetchErr = new Error('Failed to fetch');
    assert.equal(
      formatAuthError(fetchErr),
      'Unable to connect to the authentication service. Please check your internet connection or network security settings and try again.'
    );

    const authRetryableErr = { name: 'AuthRetryableFetchError', message: 'Failed to fetch' };
    assert.equal(
      formatAuthError(authRetryableErr),
      'Unable to connect to the authentication service. Please check your internet connection or network security settings and try again.'
    );

    const typeErr = new TypeError('Failed to fetch');
    assert.equal(
      formatAuthError(typeErr),
      'Unable to connect to the authentication service. Please check your internet connection or network security settings and try again.'
    );

    const credsErr = new Error('Invalid login credentials');
    assert.equal(
      formatAuthError(credsErr),
      'Invalid login credentials'
    );

    assert.equal(
      formatAuthError(null, 'Custom fallback'),
      'Custom fallback'
    );
  });
});
