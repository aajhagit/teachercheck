import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CSP_POLICY, applySecurityHeaders } from '../server/securityHeaders.js';
import { normalizeSupabaseUrl } from '../src/services/supabase.js';

describe('Content Security Policy (CSP) & Supabase Auth Hardening', () => {
  test('CSP_POLICY includes https://mxmzafzselbwjoqfheha.supabase.co in connect-src directive', () => {
    assert.ok(
      CSP_POLICY.includes('connect-src'),
      'CSP_POLICY should include a connect-src directive'
    );
    assert.ok(
      CSP_POLICY.includes('https://mxmzafzselbwjoqfheha.supabase.co'),
      'CSP_POLICY connect-src should allow https://mxmzafzselbwjoqfheha.supabase.co'
    );
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
    assert.equal(headers['Content-Security-Policy'], CSP_POLICY);
  });

  test('normalizeSupabaseUrl strips accidental /rest/v1 path segments and formats root project origin', () => {
    const inputWithRest = 'https://mxmzafzselbwjoqfheha.supabase.co/rest/v1';
    assert.equal(
      normalizeSupabaseUrl(inputWithRest),
      'https://mxmzafzselbwjoqfheha.supabase.co'
    );

    const inputWithRestTrailingSlash = 'https://mxmzafzselbwjoqfheha.supabase.co/rest/v1/';
    assert.equal(
      normalizeSupabaseUrl(inputWithRestTrailingSlash),
      'https://mxmzafzselbwjoqfheha.supabase.co'
    );

    const inputWithTrailingSlash = 'https://mxmzafzselbwjoqfheha.supabase.co/';
    assert.equal(
      normalizeSupabaseUrl(inputWithTrailingSlash),
      'https://mxmzafzselbwjoqfheha.supabase.co'
    );

    const inputClean = 'https://mxmzafzselbwjoqfheha.supabase.co';
    assert.equal(
      normalizeSupabaseUrl(inputClean),
      'https://mxmzafzselbwjoqfheha.supabase.co'
    );

    const inputWhitespace = '   https://mxmzafzselbwjoqfheha.supabase.co   ';
    assert.equal(
      normalizeSupabaseUrl(inputWhitespace),
      'https://mxmzafzselbwjoqfheha.supabase.co'
    );

    assert.equal(normalizeSupabaseUrl(''), '');
    assert.equal(normalizeSupabaseUrl(null), '');
    assert.equal(normalizeSupabaseUrl(undefined), '');
  });
});
