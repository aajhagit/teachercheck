import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AuthService, authService } from '../server/authService.js';
import { DailyQuotaManager } from '../server/dailyQuota.js';
import { InMemoryQuotaStorage } from '../server/quotaStorage.js';
import { handleApiCheck, handleApiQuota } from '../server/apiHandler.js';
import { dailyQuotaManager } from '../server/dailyQuota.js';
import { getAccessToken } from '../src/services/supabase.js';

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
      if (data) this.body = data;
      if (this._onEnd) this._onEnd(this);
    },
    onEnd() {
      return new Promise(resolve => {
        this._onEnd = resolve;
      });
    }
  };
  return res;
}

describe('Server-Side Authentication & Token Verification (AuthService)', () => {
  test('returns authenticated: false when Authorization header is absent', async () => {
    const service = new AuthService();
    const result = await service.verifyUserToken(undefined);
    assert.equal(result.authenticated, false);
    assert.equal(result.user, null);

    const emptyResult = await service.verifyUserToken('');
    assert.equal(emptyResult.authenticated, false);
  });

  test('rejects malformed Authorization headers with MALFORMED_TOKEN', async () => {
    const service = new AuthService();
    const noBearer = await service.verifyUserToken('Basic dXNlcjpwYXNz');
    assert.equal(noBearer.authenticated, false);
    assert.equal(noBearer.error, 'MALFORMED_TOKEN');

    const emptyToken = await service.verifyUserToken('Bearer   ');
    assert.equal(emptyToken.authenticated, false);
    assert.equal(emptyToken.error, 'MALFORMED_TOKEN');
  });

  test('rejects expired or invalid tokens with INVALID_TOKEN', async () => {
    const mockClient = {
      auth: {
        async getUser(token) {
          assert.equal(token, 'invalid-jwt-token');
          return { data: { user: null }, error: new Error('JWT expired or signature invalid') };
        }
      }
    };

    const service = new AuthService({ client: mockClient });
    const result = await service.verifyUserToken('Bearer invalid-jwt-token');
    assert.equal(result.authenticated, false);
    assert.equal(result.error, 'INVALID_TOKEN');
  });

  test('successfully extracts user identity on valid token', async () => {
    const mockClient = {
      auth: {
        async getUser(token) {
          assert.equal(token, 'valid-user-token');
          return {
            data: {
              user: {
                id: 'usr_abc_12345',
                email: 'teacher@example.com'
              }
            },
            error: null
          };
        }
      }
    };

    const service = new AuthService({ client: mockClient });
    const result = await service.verifyUserToken('Bearer valid-user-token');
    assert.equal(result.authenticated, true);
    assert.equal(result.user.id, 'usr_abc_12345');
    assert.equal(result.user.email, 'teacher@example.com');
  });

  test('handles Supabase verification timeout safely (fast-fails with AUTH_TIMEOUT)', async () => {
    const mockClient = {
      auth: {
        getUser() {
          // Never resolves to simulate network hang
          return new Promise(() => {});
        }
      }
    };

    const service = new AuthService({ client: mockClient, timeoutMs: 50 });
    const result = await service.verifyUserToken('Bearer hanging-token');
    assert.equal(result.authenticated, false);
    assert.equal(result.error, 'AUTH_TIMEOUT');
  });
});

describe('API CORS & Auth Header Allowance', () => {
  test('handleApiQuota and handleApiCheck permit Authorization header in CORS', async () => {
    // OPTIONS on /api/quota
    const reqQuota = createMockReq({ method: 'OPTIONS', url: '/api/quota' });
    const resQuota = createMockRes();
    const waitQuota = resQuota.onEnd();
    handleApiQuota(reqQuota, resQuota);
    await waitQuota;

    assert.ok(
      resQuota.headers['access-control-allow-headers'].includes('Authorization'),
      'OPTIONS /api/quota must allow Authorization header'
    );

    // OPTIONS on /api/check
    const reqCheck = createMockReq({ method: 'OPTIONS', url: '/api/check' });
    const resCheck = createMockRes();
    const waitCheck = resCheck.onEnd();
    handleApiCheck(reqCheck, resCheck);
    await waitCheck;

    assert.ok(
      resCheck.headers['access-control-allow-headers'].includes('Authorization'),
      'OPTIONS /api/check must allow Authorization header'
    );
  });
});

describe('Anonymous-to-Authenticated Quota Continuity', () => {
  let storage;
  let manager;

  beforeEach(() => {
    storage = new InMemoryQuotaStorage();
    manager = new DailyQuotaManager({ storage });
  });

  test('anonymous usage carries over to authenticated user account upon login', async () => {
    const anonId = 'anon:cookie-user-123';
    const userId = 'user:usr_persistent_456';

    // 1. User performs 3 anonymous checks
    for (let i = 0; i < 3; i++) {
      const res = await manager.reserveCheck(anonId);
      assert.equal(res.allowed, true);
    }

    const anonStatus = await manager.getStatus(anonId);
    assert.equal(anonStatus.used, 3);
    assert.equal(anonStatus.remaining, 2);

    // 2. User logs in. Querying status with linkedIdentifier syncs count to 3
    const authStatus = await manager.getStatus(userId, { linkedIdentifier: anonId });
    assert.equal(authStatus.used, 3);
    assert.equal(authStatus.remaining, 2);

    // 3. User performs check #4 while authenticated
    const check4 = await manager.reserveCheck(userId, { linkedIdentifier: anonId });
    assert.equal(check4.allowed, true);
    assert.equal(check4.remaining, 1);

    // 4. User performs check #5 while authenticated
    const check5 = await manager.reserveCheck(userId, { linkedIdentifier: anonId });
    assert.equal(check5.allowed, true);
    assert.equal(check5.remaining, 0);

    // 5. User attempts check #6 -> blocked by 5-check limit
    const check6 = await manager.reserveCheck(userId, { linkedIdentifier: anonId });
    assert.equal(check6.allowed, false);

    // 6. User logs out: anonymous session reflects the 5 checks and cannot check again today
    const logoutAnonCheck = await manager.reserveCheck(anonId);
    assert.equal(logoutAnonCheck.allowed, false);
  });

  test('user who used 5 anonymous checks cannot get a fresh allowance by signing in', async () => {
    const anonId = 'anon:maxed-cookie-789';
    const userId = 'user:newly-registered-user';

    // Exhaust all 5 checks anonymously
    for (let i = 0; i < 5; i++) {
      const res = await manager.reserveCheck(anonId);
      assert.equal(res.allowed, true);
    }

    // Attempting check while authenticated is blocked immediately
    const loginAttempt = await manager.reserveCheck(userId, { linkedIdentifier: anonId });
    assert.equal(loginAttempt.allowed, false);
    assert.equal(loginAttempt.remaining, 0);
  });
});

describe('End-to-End API Auth & Quota Handling', () => {
  let memoryStorage;
  let originalClient;

  beforeEach(() => {
    memoryStorage = new InMemoryQuotaStorage();
    dailyQuotaManager.setStorage(memoryStorage);
    originalClient = authService._client;
  });

  afterEach(() => {
    authService._client = originalClient;
  });

  test('request with invalid Bearer token returns HTTP 401 Unauthorized', async () => {
    authService._client = {
      auth: {
        async getUser() {
          return { data: { user: null }, error: new Error('Token expired') };
        }
      }
    };

    const req = createMockReq({
      method: 'POST',
      url: '/api/check',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer expired-or-tampered-token'
      },
      body: { text: 'I has a question.' }
    });
    const res = createMockRes();
    const wait = res.onEnd();

    handleApiCheck(req, res);
    await wait;

    assert.equal(res.statusCode, 401);
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.error.includes('expired') || parsed.error.includes('Token'));
  });

  test('request with valid Bearer token tracks quota under user ID and enforces 5-check limit', async () => {
    const testUserId = 'mock_uuid_authenticated_user_99';
    authService._client = {
      auth: {
        async getUser() {
          return { data: { user: { id: testUserId, email: 'student@example.com' } }, error: null };
        }
      }
    };

    // Use GET /api/quota with auth header
    const reqQuota = createMockReq({
      method: 'GET',
      url: '/api/quota',
      headers: {
        'authorization': 'Bearer valid-user-token'
      }
    });
    const resQuota = createMockRes();
    const waitQuota = resQuota.onEnd();
    handleApiQuota(reqQuota, resQuota);
    await waitQuota;

    assert.equal(resQuota.statusCode, 200);
    const quotaData = JSON.parse(resQuota.body);
    assert.equal(quotaData.limit, 5);
    assert.equal(quotaData.remaining, 5);

    // Verify quota reservation under user ID
    for (let i = 0; i < 5; i++) {
      const res = await dailyQuotaManager.reserveCheck(`user:${testUserId}`);
      assert.equal(res.allowed, true);
    }

    const exhaustedReservation = await dailyQuotaManager.reserveCheck(`user:${testUserId}`);
    assert.equal(exhaustedReservation.allowed, false);
    assert.equal(exhaustedReservation.remaining, 0);
  });

  test('anonymous request without Authorization header preserves anonymous access', async () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/quota'
    });
    const res = createMockRes();
    const wait = res.onEnd();
    handleApiQuota(req, res);
    await wait;

    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.remaining, 5);
  });

  test('getAccessToken helper returns null in unconfigured node environment', async () => {
    const token = await getAccessToken();
    assert.equal(token, null);
  });
});
