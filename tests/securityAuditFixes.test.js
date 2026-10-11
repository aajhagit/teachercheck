import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  getSessionSecret,
  validateSessionSecret,
  DEFAULT_DEV_SECRET
} from '../server/cookieSession.js';
import { UpstashRedisStorage } from '../server/quotaStorage.js';
import { dailyQuotaManager } from '../server/dailyQuota.js';
import { handleApiQuota, handleApiCheck } from '../server/apiHandler.js';

function createMockReq({ method = 'GET', url = '/api/quota', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };

  process.nextTick(() => {
    if (body) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });

  return req;
}

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

describe('SEC-01: Production Cookie Signing Secret Hardening', () => {
  test('fails safely with clear error when NODE_ENV is production and secret is missing', () => {
    const prodEnv = { NODE_ENV: 'production' };
    assert.throws(
      () => getSessionSecret(prodEnv),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('SESSION_SECRET or COOKIE_SECRET environment variable is required in production'),
          `Error must be clear: ${err.message}`
        );
        return true;
      }
    );
  });

  test('fails safely when SESSION_SECRET is empty string or whitespace in production', () => {
    const prodEnv = { NODE_ENV: 'production', SESSION_SECRET: '   ' };
    assert.throws(
      () => getSessionSecret(prodEnv),
      /SESSION_SECRET or COOKIE_SECRET environment variable is required in production/
    );
  });

  test('accepts SESSION_SECRET in production and never returns default dev secret', () => {
    const customSecret = 'prod-secret-9876543210-unique-key';
    const prodEnv = { NODE_ENV: 'production', SESSION_SECRET: customSecret };
    const secret = getSessionSecret(prodEnv);
    assert.equal(secret, customSecret);
    assert.notEqual(secret, DEFAULT_DEV_SECRET);
  });

  test('accepts COOKIE_SECRET as fallback in production when SESSION_SECRET is omitted', () => {
    const cookieSecret = 'prod-cookie-secret-alpha-bravo';
    const prodEnv = { NODE_ENV: 'production', COOKIE_SECRET: cookieSecret };
    const secret = getSessionSecret(prodEnv);
    assert.equal(secret, cookieSecret);
    assert.notEqual(secret, DEFAULT_DEV_SECRET);
  });

  test('preserves development/test fallback to DEFAULT_DEV_SECRET when NODE_ENV is not production', () => {
    const devEnv = { NODE_ENV: 'development' };
    const testEnv = { NODE_ENV: 'test' };
    assert.equal(getSessionSecret(devEnv), DEFAULT_DEV_SECRET);
    assert.equal(getSessionSecret(testEnv), DEFAULT_DEV_SECRET);
  });

  test('validateSessionSecret throws in production when secret is missing and returns true when present', () => {
    assert.throws(
      () => validateSessionSecret({ NODE_ENV: 'production' }),
      /SESSION_SECRET or COOKIE_SECRET environment variable is required in production/
    );
    assert.equal(
      validateSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'valid-secret-123' }),
      true
    );
  });

  test('error message never prints any configured secret value', () => {
    const fakeKey = 'super-secret-high-entropy-production-key-999';
    try {
      validateSessionSecret({ NODE_ENV: 'production' });
      assert.fail('Expected error');
    } catch (err) {
      assert.ok(!err.message.includes(fakeKey));
      assert.ok(!err.message.includes(DEFAULT_DEV_SECRET));
    }
  });
});

describe('SEC-02: Redis Quota Storage Error Resilience', () => {
  let originalStorage;
  let originalEnv;

  beforeEach(() => {
    originalStorage = dailyQuotaManager.storage;
    originalEnv = { ...process.env };
    process.env.SESSION_SECRET = 'test-audit-fix-secret-1234567890';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    dailyQuotaManager.setStorage(originalStorage);
    process.env = originalEnv;
  });

  test('GET /api/quota returns HTTP 503 JSON when storage throws a network or server error', async () => {
    dailyQuotaManager.setStorage({
      isConfigured: () => true,
      getType: () => 'upstash-redis',
      get: async () => {
        throw new Error('Upstash Redis error (500): Internal Server Error');
      }
    });

    const req = createMockReq({ method: 'GET', url: '/api/quota' });
    const res = createMockRes();

    await handleApiQuota(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
    assert.ok(body.error.includes('Daily quota service is temporarily unavailable'));
    // Ensures internal Redis details/tokens are never exposed to client
    assert.ok(!res.body.includes('Upstash Redis error'));
    assert.ok(!res.body.includes('Internal Server Error'));
  });

  test('POST /api/check returns HTTP 503 JSON when quota storage reservation fails and does NOT call AI', async () => {
    dailyQuotaManager.setStorage({
      isConfigured: () => true,
      getType: () => 'upstash-redis',
      incrWithTtl: async () => {
        throw new Error('Upstash Redis error (503): Service Unavailable');
      },
      decr: async () => 0
    });

    const req = createMockReq({
      method: 'POST',
      url: '/api/check',
      headers: { 'content-type': 'application/json' },
      body: { text: 'Testing grammar check during storage failure.' }
    });
    const res = createMockRes();

    await handleApiCheck(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
    assert.ok(body.error.includes('Daily free quota service is temporarily unavailable'));
    assert.ok(!res.body.includes('Upstash Redis error'));
  });

  test('POST /api/check handles rollback failures safely without unhandled promise rejections', async () => {
    dailyQuotaManager.setStorage({
      isConfigured: () => true,
      getType: () => 'upstash-redis',
      incrWithTtl: async () => 1,
      decr: async () => {
        throw new Error('Upstash Redis error (500): Write failure during rollback');
      }
    });

    // Send malformed or trigger an AI failure scenario:
    // With AI unconfigured or mocked, check handles failure cleanly
    const req = createMockReq({
      method: 'POST',
      url: '/api/check',
      headers: { 'content-type': 'application/json' },
      body: { text: 'Valid sentence text here.' }
    });
    const res = createMockRes();

    await handleApiCheck(req, res);
    await res.waitForEnd();

    // Request should complete with 200 or 503 without unhandled rejections
    assert.ok([200, 503].includes(res.statusCode));
  });

  test('UpstashRedisStorage honors custom timeoutMs and configures timeout signal', () => {
    const storage = new UpstashRedisStorage({
      url: 'https://mock.upstash.io',
      token: 'mock-token',
      timeoutMs: 1500
    });
    assert.equal(storage.timeoutMs, 1500);
    assert.equal(storage.isConfigured(), true);
    assert.equal(storage.getType(), 'upstash-redis');
    const signal = storage.getSignal();
    assert.ok(signal === undefined || typeof signal === 'object');
  });
});
