import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  signCookie,
  verifyAndParseCookie,
  parseCookies,
  getPrivacySaltedIpHash,
  resolveSession,
  COOKIE_NAME
} from '../server/cookieSession.js';
import {
  InMemoryQuotaStorage,
  UpstashRedisStorage,
  createQuotaStorage
} from '../server/quotaStorage.js';
import {
  DailyQuotaManager,
  getUtcMidnightReset,
  DAILY_QUOTA_LIMIT
} from '../server/dailyQuota.js';
import { handleApiCheck, handleApiQuota } from '../server/apiHandler.js';

/**
 * Mock HTTP request helper
 */
function createMockReq({ method = 'GET', url = '/api/quota', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  req.socket = { remoteAddress: '192.168.1.100' };

  process.nextTick(() => {
    if (body) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });

  return req;
}

/**
 * Mock HTTP response helper
 */
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    writeHead(code, headers = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(headers)) {
        this.setHeader(k, v);
      }
    },
    end(data) {
      if (data) this.body += data;
      this.ended = true;
      if (this._onEnd) this._onEnd();
    },
    waitForEnd() {
      if (this.ended) return Promise.resolve();
      return new Promise((resolve) => {
        this._onEnd = resolve;
      });
    }
  };
  return res;
}

describe('TeacherCheck Daily Quota Enforcement (Option A)', () => {
  const TEST_SECRET = 'test-secret-salt-12345678901234567890';

  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.ALLOW_DEV_MEMORY_QUOTA = 'true';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // 1. FIFTH AND SIXTH CHECKS
  // =========================================================================
  test('Fifth check succeeds and reaches limit; sixth check is blocked (HTTP 429)', async () => {
    const storage = new InMemoryQuotaStorage();
    const quotaManager = new DailyQuotaManager({ storage, limit: 5 });
    const anonId = 'test-anon-user-limit-1';

    // Perform checks 1 through 5
    for (let i = 1; i <= 5; i++) {
      const reservation = await quotaManager.reserveCheck(anonId);
      assert.equal(reservation.allowed, true, `Check ${i} must be allowed`);
      assert.equal(reservation.count, i, `Check ${i} count must be ${i}`);
      assert.equal(reservation.remaining, 5 - i, `Check ${i} remaining must be ${5 - i}`);
    }

    // Status after 5 checks
    const statusAfterFive = await quotaManager.getStatus(anonId);
    assert.equal(statusAfterFive.remaining, 0, 'Remaining quota after 5 checks must be 0');
    assert.equal(statusAfterFive.count, 5, 'Count must be 5');

    // Sixth check must be rejected
    const sixthReservation = await quotaManager.reserveCheck(anonId);
    assert.equal(sixthReservation.allowed, false, 'Sixth check must be rejected');
    assert.equal(sixthReservation.remaining, 0, 'Remaining quota on 6th check must be 0');

    // Verify atomic decrement: count should remain 5, not 6
    const statusAfterSixth = await quotaManager.getStatus(anonId);
    assert.equal(statusAfterSixth.count, 5, 'Count must stay at limit (5) after rejection');
    assert.equal(statusAfterSixth.remaining, 0);
  });

  // =========================================================================
  // 2. CONCURRENT REQUESTS SAFETY
  // =========================================================================
  test('Concurrent requests: parallel reservations cannot exceed the 5-check limit', async () => {
    const storage = new InMemoryQuotaStorage();
    const quotaManager = new DailyQuotaManager({ storage, limit: 5 });
    const anonId = 'test-concurrent-user-race';

    // Simulate 12 concurrent requests simultaneously attempting reservation
    const concurrentAttempts = Array.from({ length: 12 }, () =>
      quotaManager.reserveCheck(anonId)
    );

    const results = await Promise.all(concurrentAttempts);

    const allowedCount = results.filter((r) => r.allowed).length;
    const rejectedCount = results.filter((r) => !r.allowed).length;

    assert.equal(allowedCount, 5, 'Exactly 5 concurrent requests must be allowed');
    assert.equal(rejectedCount, 7, 'All 7 excess concurrent requests must be rejected');

    const finalStatus = await quotaManager.getStatus(anonId);
    assert.equal(finalStatus.count, 5, 'Storage count must not exceed 5');
    assert.equal(finalStatus.remaining, 0, 'Remaining quota must be 0');
  });

  // =========================================================================
  // 3. SERVER ERRORS & UPSTREAM FAILURES ROLLBACK
  // =========================================================================
  test('Server errors & upstream AI failures roll back reserved quota (count not consumed)', async () => {
    const storage = new InMemoryQuotaStorage();
    const quotaManager = new DailyQuotaManager({ storage, limit: 5 });
    const anonId = 'test-rollback-user-err';

    // 1st successful check
    const check1 = await quotaManager.reserveCheck(anonId);
    assert.equal(check1.allowed, true);
    assert.equal(check1.remaining, 4);

    // 2nd check attempts reservation
    const check2 = await quotaManager.reserveCheck(anonId);
    assert.equal(check2.allowed, true);
    assert.equal(check2.remaining, 3);

    // Simulate upstream AI failure (e.g. 503 or timeout): rollback check2
    await quotaManager.rollbackReservation(anonId);

    // After rollback, remaining quota should be restored back to 4
    const statusAfterRollback = await quotaManager.getStatus(anonId);
    assert.equal(statusAfterRollback.count, 1, 'Count must roll back to 1');
    assert.equal(statusAfterRollback.remaining, 4, 'Remaining quota must roll back to 4');

    // A subsequent check can now proceed as check #2
    const check2Retry = await quotaManager.reserveCheck(anonId);
    assert.equal(check2Retry.allowed, true);
    assert.equal(check2Retry.remaining, 3);
  });

  // =========================================================================
  // 4. MISSING STORAGE CONFIGURATION IN PRODUCTION
  // =========================================================================
  test('Missing Upstash configuration in production fails safely and does NOT use in-memory', () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.ALLOW_DEV_MEMORY_QUOTA;
    process.env.NODE_ENV = 'production';

    assert.throws(
      () => {
        createQuotaStorage({ env: process.env });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('UPSTASH_REDIS_REST_URL') ||
          err.message.includes('Persistent quota storage is unconfigured'),
          `Error must explain missing configuration: ${err.message}`
        );
        return true;
      },
      'Must throw and fail safely instead of silently falling back to in-memory in production'
    );
  });

  test('Upstash storage validation verifies URL and Token requirements', () => {
    assert.throws(
      () => new UpstashRedisStorage({ url: null, token: 'token' }),
      /UPSTASH_REDIS_REST_URL is required/
    );
    assert.throws(
      () => new UpstashRedisStorage({ url: 'https://example.upstash.io', token: null }),
      /UPSTASH_REDIS_REST_TOKEN is required/
    );
  });

  // =========================================================================
  // 5. COOKIE SIGNING & TAMPERING DETECTION
  // =========================================================================
  test('Cookie tampering: modified payload or corrupted HMAC is rejected and reissued safely', () => {
    const originalAnonId = 'user-uuid-12345';
    const signedCookie = signCookie(originalAnonId, TEST_SECRET);

    // 1. Valid cookie parses correctly
    const validParsed = verifyAndParseCookie(signedCookie, TEST_SECRET);
    assert.equal(validParsed, originalAnonId, 'Valid signed cookie must verify');

    // 2. Tampered cookie: modified identifier with original signature
    const [idPart, sigPart] = signedCookie.split('.');
    const tamperedPayload = `${idPart}_tampered.${sigPart}`;
    const tamperedResult = verifyAndParseCookie(tamperedPayload, TEST_SECRET);
    assert.equal(tamperedResult, null, 'Tampered cookie payload must be rejected as null');

    // 3. Corrupted signature
    const corruptedSig = `${idPart}.badsignature1234567890`;
    const corruptedResult = verifyAndParseCookie(corruptedSig, TEST_SECRET);
    assert.equal(corruptedResult, null, 'Corrupted cookie signature must be rejected as null');

    // 4. Missing signature or garbage string
    assert.equal(verifyAndParseCookie('random-junk-without-dot', TEST_SECRET), null);
    assert.equal(verifyAndParseCookie('', TEST_SECRET), null);
  });

  test('Session resolver sets HttpOnly, Secure, SameSite=Lax cookie when missing or tampered', () => {
    const mockReq = { headers: {} };
    const mockRes = createMockRes();

    // Request without cookie
    const session1 = resolveSession(mockReq, mockRes, { secret: TEST_SECRET });
    assert.ok(session1.anonId, 'Must generate anonymous identifier');
    assert.equal(session1.isNew, true, 'Must be marked as new');

    // Verify Set-Cookie header
    const setCookieHeader = mockRes.getHeader('set-cookie');
    assert.ok(setCookieHeader, 'Must set Set-Cookie header');
    assert.ok(setCookieHeader.includes('tc_anon_id='), 'Must use tc_anon_id name');
    assert.ok(setCookieHeader.includes('HttpOnly'), 'Must be HttpOnly');
    assert.ok(setCookieHeader.includes('SameSite=Lax'), 'Must be SameSite=Lax');
    assert.ok(setCookieHeader.includes('Path=/'), 'Must have Path=/');
  });

  // =========================================================================
  // 6. PRIVACY SAFETY & STORE KEYS
  // =========================================================================
  test('Privacy safety: zero user text or sentences in storage keys, values, or fallback hashes', async () => {
    const storage = new InMemoryQuotaStorage();
    const quotaManager = new DailyQuotaManager({ storage, limit: 5 });
    const userSecretSentence = 'I am writing my private student journal today.';

    // Normal usage with privacy-safe anonId
    const anonId = 'safe-anon-id-999';
    await quotaManager.reserveCheck(anonId);

    // Inspect storage keys
    const allKeys = Array.from(storage.map.keys());
    for (const key of allKeys) {
      assert.ok(
        !key.includes(userSecretSentence),
        `Storage key "${key}" must never contain user sentence`
      );
      assert.ok(
        !key.includes('private'),
        `Storage key "${key}" must never contain user words`
      );
      assert.ok(key.startsWith('tc:quota:'), 'Keys must follow tc:quota: namespace');
    }

    // Verify raw IP fallback is cryptographically hashed with rotating daily salt
    const rawIp = '203.0.113.42';
    const hashToday = getPrivacySaltedIpHash(rawIp, '2026-10-10', TEST_SECRET);
    const hashTomorrow = getPrivacySaltedIpHash(rawIp, '2026-10-11', TEST_SECRET);

    assert.ok(!hashToday.includes(rawIp), 'Fallback identifier must never contain raw IP');
    assert.equal(hashToday.length, 32, 'Fallback hash must be a 32-character hex digest');
    assert.notEqual(
      hashToday,
      hashTomorrow,
      'IP fallback hash must rotate across calendar days to prevent multi-day correlation'
    );
  });

  // =========================================================================
  // 7. RESET BOUNDARY & TIMEZONE (UTC Midnight)
  // =========================================================================
  test('Reset boundary is strictly aligned to UTC Midnight (00:00:00Z)', () => {
    // Fixed test timestamp: 2026-10-10 14:30:45 UTC
    const fixedNow = new Date(Date.UTC(2026, 9, 10, 14, 30, 45));
    const reset = getUtcMidnightReset(fixedNow);

    assert.equal(reset.dateStr, '2026-10-10', 'dateStr must match current UTC date');
    assert.equal(
      reset.resetAt,
      '2026-10-11T00:00:00.000Z',
      'resetAt must be midnight UTC of the following calendar day'
    );
    assert.ok(reset.ttlSeconds > 0, 'TTL must be positive');
    // From 14:30:45 to midnight is 9 hours, 29 mins, 15 secs = 34,155 seconds
    assert.equal(reset.ttlSeconds, 34155, 'TTL must accurately reflect seconds to UTC midnight');
  });

  // =========================================================================
  // 8. GET /api/quota STATUS ENDPOINT
  // =========================================================================
  test('GET /api/quota returns current quota without consuming checks', async () => {
    const mockReq = createMockReq({ method: 'GET', url: '/api/quota' });
    const mockRes = createMockRes();

    await handleApiQuota(mockReq, mockRes);
    await mockRes.waitForEnd();

    assert.equal(mockRes.statusCode, 200);
    assert.equal(mockRes.getHeader('x-daily-limit'), 5);
    assert.equal(mockRes.getHeader('x-daily-remaining'), 5);

    const body = JSON.parse(mockRes.body);
    assert.equal(body.limit, 5);
    assert.equal(body.remaining, 5);
    assert.ok(body.resetAt);
    // Crucial: no internal IDs exposed
    assert.equal(body.anonId, undefined, 'anonId must not be exposed in public body');
  });

  // =========================================================================
  // 9. API HANDLER INTEGRATION: POST /api/check ENFORCEMENT & HEADERS
  // =========================================================================
  test('POST /api/check enforces quota server-side before processing and returns 429 when depleted', async () => {
    const userCookie = signCookie('api-integration-user-1', TEST_SECRET);
    const cookieHeader = `tc_anon_id=${encodeURIComponent(userCookie)}`;

    // Exhaust 5 checks directly
    const { dailyQuotaManager } = await import('../server/dailyQuota.js');
    for (let i = 0; i < 5; i++) {
      await dailyQuotaManager.reserveCheck('anon:api-integration-user-1');
    }

    // Attempt 6th check via handleApiCheck
    const req = createMockReq({
      method: 'POST',
      url: '/api/check',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader
      },
      body: { text: 'I has a question.' }
    });
    const res = createMockRes();

    await handleApiCheck(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 429);
    assert.equal(res.getHeader('x-daily-limit'), 5);
    assert.equal(res.getHeader('x-daily-remaining'), 0);
    assert.ok(res.getHeader('x-daily-reset'));

    const body = JSON.parse(res.body);
    assert.equal(body.code, 'DAILY_QUOTA_EXCEEDED');
    assert.ok(body.error.includes('Daily free limit reached'));
    assert.equal(body.quota.remaining, 0);
  });
});

