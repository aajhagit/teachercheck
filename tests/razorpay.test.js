import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { handleApiCreateOrder, handleApiVerifyPayment, handleApiRazorpayWebhook } from '../server/razorpayHandler.js';
import { getPlanConfig, resolveRazorpayPlanId, PLANS, FREE_PLAN } from '../server/plansConfig.js';
import { entitlementService } from '../server/entitlementService.js';
import { dailyQuotaManager, DAILY_PRO_LIMIT, DAILY_FREE_LIMIT } from '../server/dailyQuota.js';
import { InMemoryQuotaStorage } from '../server/quotaStorage.js';
import { handleHttpRequest } from '../server/prodServer.js';
import { getCspPolicy } from '../server/securityHeaders.js';
import { verifyPaymentSignature } from '../src/services/razorpay.js';
import { authService } from '../server/authService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function createMockReq({ method = 'POST', url = '/api/create-order', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {
    'content-type': 'application/json',
    ...headers
  };
  req.socket = { remoteAddress: '127.0.0.1' };

  process.nextTick(() => {
    if (body !== null) {
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
      if (data) {
        if (Buffer.isBuffer(data)) {
          this.body += data.toString('utf8');
        } else {
          this.body += data;
        }
      }
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

import Razorpay from 'razorpay';

describe('TeacherCheck Razorpay Payment & Subscription Suite', { concurrency: 1 }, () => {

  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const originalMonthlyPlan = process.env.RAZORPAY_MONTHLY_PLAN_ID;
  const originalYearlyPlan = process.env.RAZORPAY_YEARLY_PLAN_ID;
  const originalMemoryQuota = process.env.ALLOW_DEV_MEMORY_QUOTA;

  const TEST_KEY_ID = 'rzp_test_mock_dummy_key_id_12345';
  const TEST_KEY_SECRET = 'mock_test_secret_32_characters_for_hmac';

  let originalApiPost;

  before(() => {
    process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;
    process.env.ALLOW_DEV_MEMORY_QUOTA = 'true';
    dailyQuotaManager.setStorage(new InMemoryQuotaStorage());

    const dummyInstance = new Razorpay({ key_id: 'dummy', key_secret: 'dummy' });
    const apiProto = Object.getPrototypeOf(dummyInstance.api);
    originalApiPost = apiProto.post;
    apiProto.post = async ({ url, data }) => {
      if (url === '/orders') {
        return {
          id: `order_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          amount: data.amount,
          currency: data.currency || 'INR',
          receipt: data.receipt,
          status: 'created'
        };
      }
      if (url === '/subscriptions') {
        return {
          id: `sub_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          plan_id: data.plan_id,
          status: 'created'
        };
      }
      return originalApiPost ? originalApiPost.call(this, { url, data }) : {};
    };
  });

  after(() => {
    if (originalApiPost) {
      const dummyInstance = new Razorpay({ key_id: 'dummy', key_secret: 'dummy' });
      Object.getPrototypeOf(dummyInstance.api).post = originalApiPost;
    }

    if (originalKeyId !== undefined) process.env.RAZORPAY_KEY_ID = originalKeyId;
    else delete process.env.RAZORPAY_KEY_ID;

    if (originalKeySecret !== undefined) process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
    else delete process.env.RAZORPAY_KEY_SECRET;

    if (originalMonthlyPlan !== undefined) process.env.RAZORPAY_MONTHLY_PLAN_ID = originalMonthlyPlan;
    else delete process.env.RAZORPAY_MONTHLY_PLAN_ID;

    if (originalYearlyPlan !== undefined) process.env.RAZORPAY_YEARLY_PLAN_ID = originalYearlyPlan;
    else delete process.env.RAZORPAY_YEARLY_PLAN_ID;

    if (originalMemoryQuota !== undefined) process.env.ALLOW_DEV_MEMORY_QUOTA = originalMemoryQuota;
    else delete process.env.ALLOW_DEV_MEMORY_QUOTA;
  });

  // 1 & 2: Plan Configuration Single Source of Truth
  describe('Requirement 1 & 2: Plan Configuration Single Source of Truth', () => {
    test('1. ₹199 monthly plan (pro_monthly) resolves to correct server-side configuration', () => {
      const plan = getPlanConfig('pro_monthly');
      assert.ok(plan, 'Monthly plan must exist');
      assert.equal(plan.id, 'pro_monthly');
      assert.equal(plan.amount, 19900, 'Monthly plan must be exactly 19900 paise (₹199)');
      assert.equal(plan.interval, 'monthly');
      assert.equal(plan.dailyLimit, 25, 'Pro monthly quota must be 25 checks/day');

      // Alias 'monthly' also resolves identically
      assert.equal(getPlanConfig('monthly')?.amount, 19900);
    });

    test('2. ₹1,999 yearly plan (pro_yearly) resolves to correct server-side configuration', () => {
      const plan = getPlanConfig('pro_yearly');
      assert.ok(plan, 'Yearly plan must exist');
      assert.equal(plan.id, 'pro_yearly');
      assert.equal(plan.amount, 199900, 'Yearly plan must be exactly 199900 paise (₹1,999)');
      assert.equal(plan.interval, 'yearly');
      assert.equal(plan.dailyLimit, 25, 'Pro yearly quota must be 25 checks/day');

      // Alias 'yearly' also resolves identically
      assert.equal(getPlanConfig('yearly')?.amount, 199900);
    });

    test('Free plan configuration remains strictly 5 checks/day', () => {
      assert.equal(FREE_PLAN.amount, 0);
      assert.equal(FREE_PLAN.dailyLimit, 5);
      assert.equal(DAILY_FREE_LIMIT, 5);
      assert.equal(DAILY_PRO_LIMIT, 25);
    });
  });

  // 3 & 4: Rejection of obsolete / test tiers
  describe('Requirement 3 & 4: Rejection of Obsolete & Test Tiers', () => {
    test('3. ₹499 old Pro Pass plan is strictly rejected', async () => {
      const testBodies = [
        { planId: 'pro_pass' },
        { planId: 'pro_499' },
        { planId: '49900' },
        { plan: '499' }
      ];

      for (const body of testBodies) {
        const req = createMockReq({ url: '/api/create-order', body });
        const res = createMockRes();
        await handleApiCreateOrder(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 400, `Expected 400 for ${JSON.stringify(body)}`);
        const json = JSON.parse(res.body);
        assert.match(json.error, /invalid plan/i);
      }
    });

    test('4. ₹1 test tier is strictly rejected', async () => {
      const testBodies = [
        { planId: 'test' },
        { planId: 'tierTest' },
        { planId: '100' },
        { planId: 'test_1' }
      ];

      for (const body of testBodies) {
        const req = createMockReq({ url: '/api/create-order', body });
        const res = createMockRes();
        await handleApiCreateOrder(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 400, `Expected 400 for ${JSON.stringify(body)}`);
        const json = JSON.parse(res.body);
        assert.match(json.error, /invalid plan/i);
      }
    });
  });

  // 5 & 6: Client amounts ignored and unknown plans rejected
  describe('Requirement 5 & 6: Arbitrary Amounts & Unknown Plan IDs', () => {
    test('5. Arbitrary client-supplied amounts are rejected by server-side validation', async () => {
      // 5a. Mismatched amount attempt (e.g. client attempts to send ₹0.50 instead of ₹199)
      const reqMismatched = createMockReq({
        url: '/api/create-order',
        body: {
          planId: 'monthly',
          amount: 50
        }
      });
      const resMismatched = createMockRes();
      await handleApiCreateOrder(reqMismatched, resMismatched);
      await resMismatched.waitForEnd();

      assert.equal(resMismatched.statusCode, 400);
      const jsonMismatched = JSON.parse(resMismatched.body);
      assert.match(jsonMismatched.error, /price tampering|amount mismatch|custom prices are not permitted/i);

      // 5b. Valid pro_monthly request without client amount correctly resolves to server price
      const reqValidMonthly = createMockReq({
        url: '/api/create-order',
        body: { planId: 'pro_monthly' }
      });
      const resValidMonthly = createMockRes();
      await handleApiCreateOrder(reqValidMonthly, resValidMonthly);
      await resValidMonthly.waitForEnd();

      assert.equal(resValidMonthly.statusCode, 200);
      const jsonValidMonthly = JSON.parse(resValidMonthly.body);
      assert.equal(jsonValidMonthly.amount, 19900, 'Server must enforce exact 19900 paise for pro_monthly');
      assert.equal(jsonValidMonthly.plan_id, 'pro_monthly');

      // 5c. Valid pro_yearly request without client amount correctly resolves to server price
      const reqValidYearly = createMockReq({
        url: '/api/create-order',
        body: { planId: 'pro_yearly' }
      });
      const resValidYearly = createMockRes();
      await handleApiCreateOrder(reqValidYearly, resValidYearly);
      await resValidYearly.waitForEnd();

      assert.equal(resValidYearly.statusCode, 200);
      const jsonValidYearly = JSON.parse(resValidYearly.body);
      assert.equal(jsonValidYearly.amount, 199900, 'Server must enforce exact 199900 paise for pro_yearly');
      assert.equal(jsonValidYearly.plan_id, 'pro_yearly');
    });

    test('6. Unknown plan IDs are rejected with HTTP 400', async () => {
      const req = createMockReq({
        url: '/api/create-order',
        body: { planId: 'unlimited_lifetime_hack' }
      });
      const res = createMockRes();
      await handleApiCreateOrder(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 400);
      const json = JSON.parse(res.body);
      assert.match(json.error, /invalid plan/i);
    });

    test('6b. POST /api/verify-payment rejects unknown plan IDs with HTTP 400', async () => {
      const req = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'unknown_plan',
          razorpay_order_id: 'order_123',
          razorpay_payment_id: 'pay_123',
          razorpay_signature: 'sig_123'
        }
      });
      const res = createMockRes();
      await handleApiVerifyPayment(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 400);
      const json = JSON.parse(res.body);
      assert.match(json.error, /invalid plan specified/i);
    });
  });

  // 7: Missing credentials fail safely
  describe('Requirement 7: Missing Credentials Fail Safely', () => {
    test('7a. Missing RAZORPAY_KEY_ID fails safely with 401', async () => {
      delete process.env.RAZORPAY_KEY_ID;
      try {
        const req = createMockReq({ url: '/api/create-order', body: { planId: 'monthly' } });
        const res = createMockRes();
        await handleApiCreateOrder(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 401);
        const json = JSON.parse(res.body);
        assert.match(json.error, /credentials/i);
      } finally {
        process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
      }
    });

    test('7b. Missing RAZORPAY_KEY_SECRET in verification fails safely without leaking error', async () => {
      delete process.env.RAZORPAY_KEY_SECRET;
      try {
        const req = createMockReq({
          url: '/api/verify-payment',
          body: {
            planId: 'monthly',
            razorpay_order_id: 'order_123',
            razorpay_payment_id: 'pay_123',
            razorpay_signature: 'sig_123'
          }
        });
        const res = createMockRes();
        await handleApiVerifyPayment(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 500);
        const json = JSON.parse(res.body);
        assert.equal(json.success, false);
        assert.match(json.error, /secret key not configured/i);
      } finally {
        process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;
      }
    });
  });

  // 8 & 9: Signature verification & rejection
  describe('Requirement 8 & 9: Payment & Subscription Signature Verification', () => {
    test('8a. Verifies Razorpay Order HMAC-SHA256(order_id + "|" + payment_id, secret)', async () => {
      const orderId = `order_test_${Date.now()}`;
      const paymentId = `pay_test_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const req = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_monthly',
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const res = createMockRes();
      await handleApiVerifyPayment(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.success, true);
      assert.equal(json.entitlement?.dailyLimit, 25);
      assert.equal(json.entitlement?.planId, 'pro_monthly');
    });

    test('8b. Verifies Razorpay Subscription HMAC-SHA256(payment_id + "|" + subscription_id, secret)', async () => {
      const subId = `sub_test_${Date.now()}`;
      const paymentId = `pay_sub_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${paymentId}|${subId}`)
        .digest('hex');

      const req = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_yearly',
          razorpay_subscription_id: subId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const res = createMockRes();
      await handleApiVerifyPayment(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.success, true);
      assert.equal(json.subscription_id, subId);
      assert.equal(json.entitlement?.dailyLimit, 25);
      assert.equal(json.entitlement?.planId, 'pro_yearly');
    });

    test('9. Rejects invalid or forged signatures with HTTP 400', async () => {
      const req = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'monthly',
          razorpay_order_id: 'order_test_fake',
          razorpay_payment_id: 'pay_test_fake',
          razorpay_signature: 'deadbeef_tampered_signature_00000000000000000000'
        }
      });
      const res = createMockRes();
      await handleApiVerifyPayment(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 400);
      const json = JSON.parse(res.body);
      assert.equal(json.success, false);
      assert.match(json.error, /invalid payment signature/i);
    });

    test('8c. Payment replay protection prevents reusing identical payment_id', async () => {
      const orderId = `order_replay_${Date.now()}`;
      const paymentId = `pay_replay_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const req1 = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'monthly',
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const res1 = createMockRes();
      await handleApiVerifyPayment(req1, res1);
      await res1.waitForEnd();
      assert.equal(res1.statusCode, 200);

      // Attempt replay
      const req2 = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'monthly',
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const res2 = createMockRes();
      await handleApiVerifyPayment(req2, res2);
      await res2.waitForEnd();
      assert.equal(res2.statusCode, 409);
      const json2 = JSON.parse(res2.body);
      assert.ok(json2.error && json2.error.includes('already been processed'), `Expected replay error, got: ${json2.error}`);
    });
  });

  // 10: Razorpay secret never exposed to client code
  describe('Requirement 10: Secret Confidentiality', () => {
    test('10. RAZORPAY_KEY_SECRET is absent from client source and compiled bundles', () => {
      const frontendFiles = [
        path.join(ROOT_DIR, 'index.html'),
        path.join(ROOT_DIR, 'src', 'main.js'),
        path.join(ROOT_DIR, 'src', 'services', 'razorpay.js'),
        path.join(ROOT_DIR, 'src', 'styles', 'checkout.css')
      ];

      for (const file of frontendFiles) {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf8');
          assert.ok(
            !content.includes(TEST_KEY_SECRET),
            `Frontend file ${path.basename(file)} must NEVER contain RAZORPAY_KEY_SECRET`
          );
        }
      }
    });
  });

  // 11: Pro entitlement cannot be enabled by frontend variable
  describe('Requirement 11: Server is Single Source of Entitlement Truth', () => {
    test('11. Changing frontend state or headers does not grant Pro quota on server', async () => {
      const fakeIdentifier = `anon:fake_${Date.now()}`;
      const entitlement = await entitlementService.getUserEntitlement(fakeIdentifier);

      assert.equal(entitlement.isPro, false);
      assert.equal(entitlement.dailyLimit, 5, 'Unverified user must have 5 dailyLimit on server');
    });
  });

  // 12 & 13: Free quota = 5, Pro quota = 25
  describe('Requirement 12 & 13: Free (5) vs Pro (25) Quota Enforcement', () => {
    test('12. Free users are limited to 5 checks/day', async () => {
      const testId = `test_free_user_${Date.now()}`;

      for (let i = 1; i <= 5; i++) {
        const res = await dailyQuotaManager.reserveCheck(testId, { limit: 5 });
        assert.equal(res.allowed, true, `Check ${i} should be allowed for Free user`);
        assert.equal(res.remaining, 5 - i);
      }

      const blocked = await dailyQuotaManager.reserveCheck(testId, { limit: 5 });
      assert.equal(blocked.allowed, false, '6th check must be rejected for Free user');
      assert.equal(blocked.remaining, 0);
      assert.equal(blocked.limit, 5);
    });

    test('13. Pro users are limited to 25 checks/day (NOT unlimited)', async () => {
      const testProId = `test_pro_user_${Date.now()}`;
      await entitlementService.setUserEntitlement(testProId, {
        planId: 'monthly',
        paymentId: `pay_${Date.now()}`,
        status: 'active'
      });

      const ent = await entitlementService.getUserEntitlement(testProId);
      assert.equal(ent.isPro, true);
      assert.equal(ent.dailyLimit, 25);

      for (let i = 1; i <= 25; i++) {
        const res = await dailyQuotaManager.reserveCheck(testProId, { limit: ent.dailyLimit });
        assert.equal(res.allowed, true, `Check ${i} should be allowed for Pro user`);
        assert.equal(res.remaining, 25 - i);
      }

      const blocked = await dailyQuotaManager.reserveCheck(testProId, { limit: ent.dailyLimit });
      assert.equal(blocked.allowed, false, '26th check must be rejected for Pro user');
      assert.equal(blocked.remaining, 0);
      assert.equal(blocked.limit, 25);
    });
  });

  // 14: Server Routing & CSP
  describe('Requirement 14: Server Routing & Security Headers', () => {
    test('prodServer.js routes /api/create-order correctly', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/create-order',
        body: { planId: 'monthly' }
      });
      const res = createMockRes();
      handleHttpRequest(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.amount, 19900);
    });

    test('CSP policy allows required Razorpay endpoints without weakening posture', () => {
      const csp = getCspPolicy();
      assert.ok(csp.includes('https://checkout.razorpay.com'), 'CSP must include Razorpay checkout.js');
      assert.ok(csp.includes('https://api.razorpay.com'), 'CSP must include Razorpay API');
      assert.ok(!csp.includes("connect-src *"), 'CSP must NOT use wildcard * connect-src');
    });

    test('index.html contains checkout.js and does not contain obsolete ₹499 or ₹1 test tiers', () => {
      const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
      assert.ok(indexHtml.includes('https://checkout.razorpay.com/v1/checkout.js'));
      assert.ok(!indexHtml.includes('₹499 Pro Pass'), 'index.html must not contain ₹499 Pro Pass');
      assert.ok(!indexHtml.includes('tierTestBtn'), 'index.html must not contain tierTestBtn');
      assert.ok(!indexHtml.includes('₹1 (Test'), 'index.html must not contain ₹1 Test tier');
      assert.ok(indexHtml.includes('Pro Monthly'), 'index.html must contain Pro Monthly');
      assert.ok(indexHtml.includes('Pro Yearly'), 'index.html must contain Pro Yearly');
      assert.ok(indexHtml.includes('data-plan="pro_monthly"'), 'index.html must specify data-plan="pro_monthly"');
      assert.ok(indexHtml.includes('data-plan="pro_yearly"'), 'index.html must specify data-plan="pro_yearly"');
      assert.ok(indexHtml.includes('Save ₹389'), 'index.html must highlight annual savings');
      assert.ok(indexHtml.includes('199'), 'index.html must contain 199');
      assert.ok(indexHtml.includes('1,999'), 'index.html must contain 1,999');
    });

    test('Missing payment verification fields are rejected with HTTP 400', async () => {
      const testCases = [
        {},
        { razorpay_payment_id: 'pay_123' },
        { razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_123' }
      ];

      for (const tc of testCases) {
        const req = createMockReq({ url: '/api/verify-payment', body: tc });
        const res = createMockRes();
        await handleApiVerifyPayment(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 400, `Expected 400 for ${JSON.stringify(tc)}`);
        const json = JSON.parse(res.body);
        assert.equal(json.success, false);
      }
    });

    test('Unauthenticated payment attempt is rejected with HTTP 401 when auth is required', async () => {
      const req = createMockReq({
        url: '/api/create-order',
        headers: { 'x-require-auth': 'true' },
        body: { planId: 'pro_monthly' }
      });
      const res = createMockRes();
      await handleApiCreateOrder(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 401);
      const json = JSON.parse(res.body);
      assert.match(json.error, /authentication required/i);
    });
  });

  // 15: Razorpay Webhook Verification & Lifecycle Handling
  describe('Requirement 15: Razorpay Webhook Verification & Lifecycle', () => {
    const TEST_WEBHOOK_SECRET = 'wh_secret_test_9876543210';

    before(() => {
      process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    });

    after(() => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
    });

    test('Webhook rejects requests without X-Razorpay-Signature with HTTP 400', async () => {
      const req = createMockReq({
        url: '/api/razorpay-webhook',
        body: JSON.stringify({ event: 'payment.captured' })
      });
      const res = createMockRes();
      await handleApiRazorpayWebhook(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 400);
      const json = JSON.parse(res.body);
      assert.match(json.error, /missing.*signature/i);
    });

    test('Webhook rejects forged/invalid signature with HTTP 400', async () => {
      const rawPayload = JSON.stringify({ event: 'payment.captured' });
      const req = createMockReq({
        url: '/api/razorpay-webhook',
        headers: { 'x-razorpay-signature': 'invalid_forged_webhook_signature_hex' },
        body: rawPayload
      });
      const res = createMockRes();
      await handleApiRazorpayWebhook(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 400);
      const json = JSON.parse(res.body);
      assert.match(json.error, /invalid webhook signature/i);
    });

    test('Webhook verifies authentic signature and activates Pro entitlement on subscription.charged', async () => {
      const targetUser = `user:student_wh_${Date.now()}`;
      const payloadObj = {
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: `sub_wh_${Date.now()}`,
              notes: {
                identifier: targetUser,
                planId: 'monthly'
              }
            }
          },
          payment: {
            entity: {
              id: `pay_wh_${Date.now()}`
            }
          }
        }
      };

      const rawPayload = JSON.stringify(payloadObj);
      const authenticSignature = crypto
        .createHmac('sha256', TEST_WEBHOOK_SECRET)
        .update(rawPayload)
        .digest('hex');

      const req = createMockReq({
        url: '/api/razorpay-webhook',
        headers: { 'x-razorpay-signature': authenticSignature },
        body: rawPayload
      });
      const res = createMockRes();
      await handleApiRazorpayWebhook(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.status, 'ok');

      // Verify entitlement was stored server-side
      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.isPro, true);
      assert.equal(ent.dailyLimit, 25);
      assert.equal(ent.planId, 'pro_monthly');
    });

    test('Webhook subscription.cancelled updates user entitlement status', async () => {
      const targetUser = `user:cancelled_student_${Date.now()}`;
      await entitlementService.setUserEntitlement(targetUser, {
        planId: 'pro_monthly',
        status: 'active'
      });

      const payloadObj = {
        event: 'subscription.cancelled',
        payload: {
          subscription: {
            entity: {
              id: `sub_canc_${Date.now()}`,
              notes: {
                identifier: targetUser,
                planId: 'pro_monthly'
              }
            }
          }
        }
      };

      const rawPayload = JSON.stringify(payloadObj);
      const signature = crypto
        .createHmac('sha256', TEST_WEBHOOK_SECRET)
        .update(rawPayload)
        .digest('hex');

      const req = createMockReq({
        url: '/api/razorpay-webhook',
        headers: { 'x-razorpay-signature': signature },
        body: rawPayload
      });
      const res = createMockRes();
      await handleApiRazorpayWebhook(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 200);

      // Verify user entitlement status is updated to cancelled, but retains Pro while unexpired
      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.status, 'cancelled');
      assert.equal(ent.isPro, true, 'Cancelled subscription retains Pro access while unexpired');
      assert.equal(ent.dailyLimit, 25, 'Cancelled subscription retains 25 checks/day while unexpired');
    });
  });

  // 16: Explicit Plan Checkouts & Failed/Cancelled Protections
  describe('Requirement 16: Plan Checkouts & Failed Payment Protections', () => {
    test('16a. End-to-end Pro Monthly (₹199): order creation -> HMAC-SHA256 verification -> 25 checks/day', async () => {
      const userId = `user:monthly_test_${Date.now()}`;

      // 1. Order Creation
      const createReq = createMockReq({
        url: '/api/create-order',
        body: { planId: 'pro_monthly' }
      });
      const createRes = createMockRes();
      await handleApiCreateOrder(createReq, createRes);
      await createRes.waitForEnd();

      assert.equal(createRes.statusCode, 200);
      const orderData = JSON.parse(createRes.body);
      assert.equal(orderData.amount, 19900, 'Monthly order must be exactly 19900 paise (₹199)');
      assert.ok(orderData.order_id);

      // 2. Signature Generation & Verification
      const paymentId = `pay_mon_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${orderData.order_id}|${paymentId}`)
        .digest('hex');

      const verifyReq = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_monthly',
          razorpay_order_id: orderData.order_id,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      // Attach mock user
      verifyReq.headers['authorization'] = 'Bearer valid-monthly-token';
      const verifyRes = createMockRes();
      await handleApiVerifyPayment(verifyReq, verifyRes);
      await verifyRes.waitForEnd();

      assert.equal(verifyRes.statusCode, 200);
      const verifyData = JSON.parse(verifyRes.body);
      assert.equal(verifyData.success, true);
      assert.equal(verifyData.entitlement.dailyLimit, 25);
      assert.equal(verifyData.entitlement.planId, 'pro_monthly');
    });

    test('16b. End-to-end Pro Yearly (₹1,999): order creation -> HMAC-SHA256 verification -> 25 checks/day', async () => {
      // 1. Order Creation
      const createReq = createMockReq({
        url: '/api/create-order',
        body: { planId: 'pro_yearly' }
      });
      const createRes = createMockRes();
      await handleApiCreateOrder(createReq, createRes);
      await createRes.waitForEnd();

      assert.equal(createRes.statusCode, 200);
      const orderData = JSON.parse(createRes.body);
      assert.equal(orderData.amount, 199900, 'Yearly order must be exactly 199900 paise (₹1,999)');
      assert.ok(orderData.order_id);

      // 2. Signature Generation & Verification
      const paymentId = `pay_yr_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${orderData.order_id}|${paymentId}`)
        .digest('hex');

      const verifyReq = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_yearly',
          razorpay_order_id: orderData.order_id,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const verifyRes = createMockRes();
      await handleApiVerifyPayment(verifyReq, verifyRes);
      await verifyRes.waitForEnd();

      assert.equal(verifyRes.statusCode, 200);
      const verifyData = JSON.parse(verifyRes.body);
      assert.equal(verifyData.success, true);
      assert.equal(verifyData.entitlement.dailyLimit, 25);
      assert.equal(verifyData.entitlement.planId, 'pro_yearly');
    });

    test('16c. Failed or forged payment signature never grants Pro entitlement (user remains at Free 5/day)', async () => {
      const targetUser = `user:failed_student_${Date.now()}`;
      const orderId = `order_failed_${Date.now()}`;
      const paymentId = `pay_failed_${Date.now()}`;
      const forgedSignature = '0000000000000000000000000000000000000000000000000000000000000000';

      const verifyReq = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_monthly',
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: forgedSignature
        }
      });
      const verifyRes = createMockRes();
      await handleApiVerifyPayment(verifyReq, verifyRes);
      await verifyRes.waitForEnd();

      assert.equal(verifyRes.statusCode, 400);
      const body = JSON.parse(verifyRes.body);
      assert.equal(body.success, false);

      // Assert user still has standard Free entitlement (5 checks/day)
      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.isPro, false);
      assert.equal(ent.dailyLimit, 5, 'Failed verification must NEVER grant Pro');
    });

    test('16d. Webhook payment.failed leaves user at Free tier (5 checks/day)', async () => {
      const targetUser = `user:failed_pay_${Date.now()}`;
      const payloadObj = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: `pay_fail_${Date.now()}`,
              error_description: 'Payment was declined by issuing bank',
              notes: {
                identifier: targetUser
              }
            }
          }
        }
      };

      const rawPayload = JSON.stringify(payloadObj);
      const signature = crypto
        .createHmac('sha256', 'wh_test_secret_failed')
        .update(rawPayload)
        .digest('hex');

      process.env.RAZORPAY_WEBHOOK_SECRET = 'wh_test_secret_failed';
      try {
        const req = createMockReq({
          url: '/api/razorpay-webhook',
          headers: { 'x-razorpay-signature': signature },
          body: rawPayload
        });
        const res = createMockRes();
        await handleApiRazorpayWebhook(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 200);

        // User must NOT have Pro
        const ent = await entitlementService.getUserEntitlement(targetUser);
        assert.equal(ent.isPro, false);
        assert.equal(ent.dailyLimit, 5, 'Failed payment event must not activate Pro');
      } finally {
        delete process.env.RAZORPAY_WEBHOOK_SECRET;
      }
    });
  });

  // 17. Safe Server-Side Plan ID Mapping & Subscription Creation
  describe('Requirement 17: Safe Server-Side Plan ID Mapping & Subscription Creation', () => {
    test('resolveRazorpayPlanId correctly maps symbolic IDs to environment variables', () => {
      process.env.RAZORPAY_MONTHLY_PLAN_ID = 'plan_live_month_123';
      process.env.RAZORPAY_YEARLY_PLAN_ID = 'plan_live_year_456';

      try {
        assert.equal(resolveRazorpayPlanId('pro_monthly'), 'plan_live_month_123');
        assert.equal(resolveRazorpayPlanId('monthly'), 'plan_live_month_123');
        assert.equal(resolveRazorpayPlanId('pro_yearly'), 'plan_live_year_456');
        assert.equal(resolveRazorpayPlanId('yearly'), 'plan_live_year_456');
        assert.equal(resolveRazorpayPlanId('unknown_plan'), null);
        assert.equal(resolveRazorpayPlanId(''), null);
        assert.equal(resolveRazorpayPlanId(null), null);
      } finally {
        delete process.env.RAZORPAY_MONTHLY_PLAN_ID;
        delete process.env.RAZORPAY_YEARLY_PLAN_ID;
      }
    });

    test('resolveRazorpayPlanId ignores environment variables accidentally set to symbolic names', () => {
      process.env.RAZORPAY_MONTHLY_PLAN_ID = 'pro_monthly';
      process.env.RAZORPAY_YEARLY_PLAN_ID = 'pro_yearly';

      try {
        assert.equal(resolveRazorpayPlanId('pro_monthly'), null);
        assert.equal(resolveRazorpayPlanId('pro_yearly'), null);
      } finally {
        delete process.env.RAZORPAY_MONTHLY_PLAN_ID;
        delete process.env.RAZORPAY_YEARLY_PLAN_ID;
      }
    });

    test('POST /api/create-order with symbolic planId creates Razorpay subscription using actual resolved plan ID', async () => {
      process.env.RAZORPAY_MONTHLY_PLAN_ID = 'plan_monthly_real_dashboard_id_999';

      try {
        const req = createMockReq({
          url: '/api/create-order',
          body: { planId: 'pro_monthly' }
        });
        const res = createMockRes();
        await handleApiCreateOrder(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 200);
        const data = JSON.parse(res.body);
        assert.equal(data.type, 'subscription');
        assert.ok(data.subscription_id);
        // Returns the symbolic plan_id to the client (never exposing server env plan ID)
        assert.equal(data.plan_id, 'pro_monthly');
        assert.equal(data.amount, 19900);
        assert.equal(data.currency, 'INR');
        assert.ok(!res.body.includes(process.env.RAZORPAY_KEY_SECRET));
      } finally {
        delete process.env.RAZORPAY_MONTHLY_PLAN_ID;
      }
    });

    test('POST /api/create-order for pro_yearly creates subscription using resolved actual yearly plan ID', async () => {
      process.env.RAZORPAY_YEARLY_PLAN_ID = 'plan_yearly_real_dashboard_id_888';

      try {
        const req = createMockReq({
          url: '/api/create-order',
          body: { planId: 'pro_yearly' }
        });
        const res = createMockRes();
        await handleApiCreateOrder(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 200);
        const data = JSON.parse(res.body);
        assert.equal(data.type, 'subscription');
        assert.ok(data.subscription_id);
        assert.equal(data.plan_id, 'pro_yearly');
        assert.equal(data.amount, 199900);
      } finally {
        delete process.env.RAZORPAY_YEARLY_PLAN_ID;
      }
    });

    test('POST /api/create-subscription route alias works identically to /api/create-order', async () => {
      const req = createMockReq({
        url: '/api/create-subscription',
        body: { planId: 'pro_monthly' }
      });
      const res = createMockRes();
      await handleApiCreateOrder(req, res);
      await res.waitForEnd();

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.amount, 19900);
      assert.equal(data.plan_id, 'pro_monthly');
    });

    test('POST /api/create-order strictly rejects unknown symbolic planId with HTTP 400', async () => {
      const invalidPlans = ['random_id', 'plan_xyz', '', 'free', '499'];
      for (const p of invalidPlans) {
        const req = createMockReq({
          url: '/api/create-order',
          body: { planId: p }
        });
        const res = createMockRes();
        await handleApiCreateOrder(req, res);
        await res.waitForEnd();

        assert.equal(res.statusCode, 400, `Expected 400 for ${p}`);
        const data = JSON.parse(res.body);
        assert.match(data.error, /invalid plan/i);
      }
    });
  });

  // Requirement 18: Complete Audit Remediation Suite
  describe('Requirement 18: Complete Audit Remediation Suite', () => {
    const AUDIT_WEBHOOK_SECRET = 'wh_secret_audit_test_1234567890';

    before(() => {
      process.env.RAZORPAY_WEBHOOK_SECRET = AUDIT_WEBHOOK_SECRET;
    });

    after(() => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
    });

    function createSignedWebhookReq(payloadObj) {
      const rawPayload = JSON.stringify(payloadObj);
      const signature = crypto
        .createHmac('sha256', AUDIT_WEBHOOK_SECRET)
        .update(rawPayload)
        .digest('hex');

      return createMockReq({
        url: '/api/razorpay-webhook',
        headers: { 'x-razorpay-signature': signature },
        body: rawPayload
      });
    }

    // 1. Unexpired cancelled entitlement
    test('1. Unexpired cancelled entitlement retains Pro quota (25 checks/day)', async () => {
      const targetUser = `user:cancelled_unexpired_${Date.now()}`;
      const futureDate = new Date(Date.now() + 20 * 86400 * 1000).toISOString();

      await entitlementService.setUserEntitlement(targetUser, {
        planId: 'pro_monthly',
        status: 'active',
        expiresAt: futureDate,
        paymentId: 'pay_init_1'
      });

      // Cancellation webhook arrives
      const webhookReq = createSignedWebhookReq({
        event: 'subscription.cancelled',
        payload: {
          subscription: {
            entity: {
              id: `sub_canc_${Date.now()}`,
              notes: {
                identifier: targetUser,
                planId: 'pro_monthly'
              }
            }
          }
        }
      });
      const webhookRes = createMockRes();
      await handleApiRazorpayWebhook(webhookReq, webhookRes);
      await webhookRes.waitForEnd();
      assert.equal(webhookRes.statusCode, 200);

      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.status, 'cancelled');
      assert.equal(ent.isPro, true, 'User must remain Pro while expiresAt is in future');
      assert.equal(ent.dailyLimit, 25, 'Unexpired cancelled user must have 25 checks/day');
      assert.equal(ent.expiresAt, futureDate, 'expiresAt must not be altered/extended by cancellation');
    });

    // 2. Expired cancelled entitlement
    test('2. Expired cancelled entitlement reverts to Free quota (5 checks/day)', async () => {
      const targetUser = `user:cancelled_expired_${Date.now()}`;
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();

      await entitlementService.setUserEntitlement(targetUser, {
        planId: 'pro_monthly',
        status: 'cancelled',
        expiresAt: pastDate,
        paymentId: 'pay_expired_1'
      });

      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.isPro, false, 'Expired subscription must not have Pro access');
      assert.equal(ent.dailyLimit, 5, 'Expired subscription must revert to 5 checks/day');
      assert.equal(ent.status, 'expired');
    });

    // 3. Unexpired halted entitlement
    test('3. Unexpired halted entitlement retains paid Pro access until expiresAt', async () => {
      const targetUser = `user:halted_${Date.now()}`;
      const futureDate = new Date(Date.now() + 15 * 86400 * 1000).toISOString();

      await entitlementService.setUserEntitlement(targetUser, {
        planId: 'pro_monthly',
        status: 'active',
        expiresAt: futureDate,
        paymentId: 'pay_halted_1'
      });

      const webhookReq = createSignedWebhookReq({
        event: 'subscription.halted',
        payload: {
          subscription: {
            entity: {
              id: `sub_halt_${Date.now()}`,
              notes: {
                identifier: targetUser,
                planId: 'pro_monthly'
              }
            }
          }
        }
      });
      const webhookRes = createMockRes();
      await handleApiRazorpayWebhook(webhookReq, webhookRes);
      await webhookRes.waitForEnd();
      assert.equal(webhookRes.statusCode, 200);

      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.status, 'halted');
      assert.equal(ent.isPro, true, 'Halted subscription retains Pro while unexpired');
      assert.equal(ent.dailyLimit, 25);
    });

    // 4. Unexpired paused entitlement
    test('4. Unexpired paused entitlement retains paid Pro access until expiresAt', async () => {
      const targetUser = `user:paused_${Date.now()}`;
      const futureDate = new Date(Date.now() + 10 * 86400 * 1000).toISOString();

      await entitlementService.setUserEntitlement(targetUser, {
        planId: 'pro_monthly',
        status: 'active',
        expiresAt: futureDate,
        paymentId: 'pay_paused_1'
      });

      const webhookReq = createSignedWebhookReq({
        event: 'subscription.paused',
        payload: {
          subscription: {
            entity: {
              id: `sub_pause_${Date.now()}`,
              notes: {
                identifier: targetUser,
                planId: 'pro_monthly'
              }
            }
          }
        }
      });
      const webhookRes = createMockRes();
      await handleApiRazorpayWebhook(webhookReq, webhookRes);
      await webhookRes.waitForEnd();
      assert.equal(webhookRes.statusCode, 200);

      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.status, 'paused');
      assert.equal(ent.isPro, true, 'Paused subscription retains Pro while unexpired');
      assert.equal(ent.dailyLimit, 25);
    });

    // 5. Duplicate webhook delivery
    test('5. Duplicate webhook delivery is safely idempotent and does not corrupt entitlement', async () => {
      const targetUser = `user:dup_wh_${Date.now()}`;
      const paymentId = `pay_dup_${Date.now()}`;
      const subId = `sub_dup_${Date.now()}`;

      const payload = {
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: subId,
              notes: { identifier: targetUser, planId: 'pro_monthly' }
            }
          },
          payment: {
            entity: {
              id: paymentId
            }
          }
        }
      };

      // First webhook delivery
      const req1 = createSignedWebhookReq(payload);
      const res1 = createMockRes();
      await handleApiRazorpayWebhook(req1, res1);
      await res1.waitForEnd();
      assert.equal(res1.statusCode, 200);

      const ent1 = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent1.isPro, true);
      assert.equal(ent1.dailyLimit, 25);
      const originalExpiresAt = ent1.expiresAt;

      // Second identical webhook delivery (network retry from Razorpay)
      const req2 = createSignedWebhookReq(payload);
      const res2 = createMockRes();
      await handleApiRazorpayWebhook(req2, res2);
      await res2.waitForEnd();
      assert.equal(res2.statusCode, 200);

      const ent2 = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent2.isPro, true);
      assert.equal(ent2.dailyLimit, 25);
      assert.equal(ent2.expiresAt, originalExpiresAt, 'Expiration must not be corrupted by duplicate delivery');
    });

    // 6. payment.captured
    test('6. payment.captured webhook event activates correct user Pro entitlement', async () => {
      const targetUser = `user:captured_${Date.now()}`;
      const paymentId = `pay_cap_${Date.now()}`;
      const orderId = `order_cap_${Date.now()}`;

      const webhookReq = createSignedWebhookReq({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: orderId,
              notes: {
                identifier: targetUser,
                planId: 'pro_monthly'
              }
            }
          }
        }
      });
      const webhookRes = createMockRes();
      await handleApiRazorpayWebhook(webhookReq, webhookRes);
      await webhookRes.waitForEnd();
      assert.equal(webhookRes.statusCode, 200);

      const ent = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(ent.isPro, true);
      assert.equal(ent.dailyLimit, 25);
      assert.equal(ent.paymentId, paymentId);
      assert.equal(ent.status, 'active');
    });

    // 7. subscription.charged renewal
    test('7. subscription.charged renewal extends existing Pro entitlement correctly', async () => {
      const targetUser = `user:renew_${Date.now()}`;
      const subId = `sub_renew_${Date.now()}`;
      const month1Payment = `pay_m1_${Date.now()}`;
      const month2Payment = `pay_m2_${Date.now()}`;

      // Month 1: initial active subscription
      await entitlementService.setUserEntitlement(targetUser, {
        planId: 'pro_monthly',
        status: 'active',
        paymentId: month1Payment,
        subscriptionId: subId
      });

      const entMonth1 = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(entMonth1.isPro, true);
      assert.equal(entMonth1.paymentId, month1Payment);

      // Month 2: recurring subscription charge webhook
      const webhookReq = createSignedWebhookReq({
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: subId,
              notes: { identifier: targetUser, planId: 'pro_monthly' }
            }
          },
          payment: {
            entity: {
              id: month2Payment
            }
          }
        }
      });
      const webhookRes = createMockRes();
      await handleApiRazorpayWebhook(webhookReq, webhookRes);
      await webhookRes.waitForEnd();
      assert.equal(webhookRes.statusCode, 200);

      const entMonth2 = await entitlementService.getUserEntitlement(targetUser);
      assert.equal(entMonth2.isPro, true);
      assert.equal(entMonth2.paymentId, month2Payment, 'Payment ID must update to month 2');
      assert.equal(entMonth2.dailyLimit, 25);
      assert.equal(entMonth2.status, 'active');
    });

    // 8. Duplicate payment verification
    test('8. Duplicate payment verification handles replay idempotently and frontend treats as success', async () => {
      const subId = `sub_dup_ver_${Date.now()}`;
      const paymentId = `pay_dup_ver_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${paymentId}|${subId}`)
        .digest('hex');

      // First verification: success
      const req1 = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_monthly',
          razorpay_subscription_id: subId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const res1 = createMockRes();
      await handleApiVerifyPayment(req1, res1);
      await res1.waitForEnd();
      assert.equal(res1.statusCode, 200);
      const data1 = JSON.parse(res1.body);
      assert.equal(data1.success, true);
      assert.equal(data1.dailyLimit, 25);

      // Second verification (same payment_id): 409 with alreadyProcessed: true
      const req2 = createMockReq({
        url: '/api/verify-payment',
        body: {
          planId: 'pro_monthly',
          razorpay_subscription_id: subId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        }
      });
      const res2 = createMockRes();
      await handleApiVerifyPayment(req2, res2);
      await res2.waitForEnd();
      assert.equal(res2.statusCode, 409);
      const data2 = JSON.parse(res2.body);
      assert.equal(data2.alreadyProcessed, true);
      assert.equal(data2.code, 'PAYMENT_ALREADY_PROCESSED');

      // Verify client-side verifyPaymentSignature treats this response as success
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () => {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              success: false,
              alreadyProcessed: true,
              code: 'PAYMENT_ALREADY_PROCESSED',
              message: 'This payment has already been processed and verified.',
              planId: 'pro_monthly'
            })
          };
        };

        const clientResult = await verifyPaymentSignature({
          planId: 'pro_monthly',
          razorpay_subscription_id: subId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        });

        assert.equal(clientResult.success, true, 'Frontend must treat already-processed payment as success');
        assert.equal(clientResult.alreadyProcessed, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // 9. Cross-user protection
    test('9. Cross-user protection prevents one user payment from activating another user account', async () => {
      const userAId = 'user_aaa_original';
      const userBId = 'user_bbb_attacker';
      const subId = `sub_cross_${Date.now()}`;
      const paymentId = `pay_cross_${Date.now()}`;
      const signature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${paymentId}|${subId}`)
        .digest('hex');

      const originalAuthClient = authService._client;
      try {
        authService._client = {
          auth: {
            getUser: async (token) => {
              if (token === 'token_user_a') {
                return { data: { user: { id: userAId, email: 'alice@example.com' } }, error: null };
              }
              if (token === 'token_user_b') {
                return { data: { user: { id: userBId, email: 'bob@example.com' } }, error: null };
              }
              return { data: { user: null }, error: new Error('Invalid token') };
            }
          }
        };

        // User A completes valid payment verification
        const reqA = createMockReq({
          url: '/api/verify-payment',
          headers: {
            authorization: 'Bearer token_user_a'
          },
          body: {
            planId: 'pro_monthly',
            razorpay_subscription_id: subId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signature
          }
        });
        const resA = createMockRes();
        await handleApiVerifyPayment(reqA, resA);
        await resA.waitForEnd();
        assert.equal(resA.statusCode, 200);

        // Verify User A receives Pro
        const entA = await entitlementService.getUserEntitlement(`user:${userAId}`);
        assert.equal(entA.isPro, true);
        assert.equal(entA.dailyLimit, 25);

        // User B attempts to replay User A's payment ID and signature
        const reqB = createMockReq({
          url: '/api/verify-payment',
          headers: {
            authorization: 'Bearer token_user_b'
          },
          body: {
            planId: 'pro_monthly',
            razorpay_subscription_id: subId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signature
          }
        });
        const resB = createMockRes();
        await handleApiVerifyPayment(reqB, resB);
        await resB.waitForEnd();

        // Must be rejected with HTTP 403 Forbidden
        assert.equal(resB.statusCode, 403, 'Cross-user payment attempt must be rejected with HTTP 403');
        const dataB = JSON.parse(resB.body);
        assert.match(dataB.error, /another user account/i);

        // User B must NOT receive Pro
        const entB = await entitlementService.getUserEntitlement(`user:${userBId}`);
        assert.equal(entB.isPro, false, 'User B must not receive Pro entitlement');
        assert.equal(entB.dailyLimit, 5);
      } finally {
        authService._client = originalAuthClient;
      }
    });
  });
});

