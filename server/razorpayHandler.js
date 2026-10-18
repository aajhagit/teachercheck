import Razorpay from 'razorpay';
import crypto from 'crypto';
import { applySecurityHeaders, checkCorsOrigin, logSafeEvent } from './securityHeaders.js';
import { getPlanConfig, resolveRazorpayPlanId } from './plansConfig.js';
import { authService } from './authService.js';
import { getOrCreateAnonymousId, getPrivacySaltedIpHash } from './cookieSession.js';
import { rateLimiter } from './rateLimiter.js';
import { getUtcMidnightReset } from './dailyQuota.js';
import { entitlementService } from './entitlementService.js';

/**
 * Helper to parse incoming JSON request body with max bytes protection
 */
function parseJsonBody(req, maxBytes = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodySize = 0;
    let isTooLarge = false;

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > maxBytes) {
        isTooLarge = true;
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (isTooLarge) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        return reject(err);
      }
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch {
        const err = new Error('Invalid JSON format');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', err => reject(err));
  });
}

/**
 * Helper to read raw request body as string for webhook HMAC-SHA256 signature validation
 */
function readRawBody(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let totalBytes = 0;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const err = new Error('Webhook payload too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', err => reject(err));
  });
}

/**
 * Helper to extract user identifier (authenticated user ID or anonymous session)
 */
async function resolveUserIdentifier(req, res) {
  const authResult = await authService.verifyUserToken(req.headers['authorization']);
  if (authResult.authenticated && authResult.user) {
    return {
      authenticated: true,
      userId: authResult.user.id,
      userEmail: authResult.user.email,
      identifier: `user:${authResult.user.id}`
    };
  }

  const { anonId, hasCookie } = getOrCreateAnonymousId(req, res);
  const clientIp = rateLimiter.getClientIp(req);
  const { dateKey } = getUtcMidnightReset();
  const anonIdentifier = hasCookie ? `anon:${anonId}` : `ip:${getPrivacySaltedIpHash(clientIp, dateKey)}`;

  return {
    authenticated: false,
    userId: null,
    userEmail: null,
    identifier: anonIdentifier
  };
}

/**
 * Request Handler for POST /api/create-subscription and POST /api/create-order
 * Enforces single source of truth for pricing:
 * - Pro Monthly: ₹199/month (25 checks/day)
 * - Pro Yearly: ₹1,999/year (25 checks/day)
 * Rejects unknown plans, old ₹499 tier, and ₹1 test tier.
 */
export async function handleApiCreateOrder(req, res) {
  applySecurityHeaders(res);

  // 1. CORS Origin Validation
  const cors = checkCorsOrigin(req);
  if (!cors.allowed) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  if (cors.origin) {
    res.setHeader('Access-Control-Allow-Origin', cors.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // 2. Validate Razorpay Server Credentials
  const key_id = (process.env.RAZORPAY_KEY_ID || '').replace(/^["']|["']$/g, '').trim();
  const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').replace(/^["']|["']$/g, '').trim();

  if (!key_id || !key_secret) {
    logSafeEvent('RAZORPAY_AUTH_FAILED', { reason: 'Missing credentials' });
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Razorpay authentication failed: missing API credentials.' }));
    return;
  }

  // 3. Parse JSON Body
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    res.statusCode = err.statusCode || 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
    return;
  }

  // 4. Resolve Plan Configuration from Server Source of Truth
  const planId = body?.planId || body?.plan_id;
  const plan = getPlanConfig(planId);

  // Explicitly reject old ₹499 plan, ₹1 test tier, and unknown plan IDs
  if (!plan) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: "Invalid plan ID. Only 'monthly' (₹199/month) and 'yearly' (₹1,999/year) plans are supported."
    }));
    return;
  }

  // Reject client attempts to specify arbitrary price
  if (body?.amount !== undefined) {
    const parsedAmount = typeof body.amount === 'number' ? body.amount : parseInt(body.amount, 10);
    if (!isNaN(parsedAmount) && parsedAmount !== plan.amount) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: `Price tampering detected. The ${plan.name} price is strictly ₹${plan.amount / 100} (${plan.amount} paise).`
      }));
      return;
    }
  }

  // 5. User association & authentication check
  const userInfo = await resolveUserIdentifier(req, res);
  const requiresAuth = req.headers['x-require-auth'] === 'true' || process.env.REQUIRE_AUTH_FOR_PAYMENT === 'true';
  if (requiresAuth && !userInfo.authenticated) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Authentication required. Please sign in or create an account to upgrade to TeacherCheck Pro.'
    }));
    return;
  }

  // 6. Create Razorpay Subscription or Order
  try {
    const razorpay = new Razorpay({
      key_id,
      key_secret
    });

    // Safely resolve the actual Razorpay plan ID from environment variables
    // "pro_monthly" -> process.env.RAZORPAY_MONTHLY_PLAN_ID
    // "pro_yearly"  -> process.env.RAZORPAY_YEARLY_PLAN_ID
    const configuredRazorpayPlanId = resolveRazorpayPlanId(plan.id);

    // Flow A: Razorpay Recurring Subscription (when actual plan ID is configured in environment)
    if (configuredRazorpayPlanId) {
      const subscriptionOptions = {
        plan_id: configuredRazorpayPlanId,
        total_count: plan.interval === 'yearly' ? 5 : 60,
        quantity: 1,
        customer_notify: 1,
        notes: {
          planId: plan.id,
          userId: userInfo.userId || '',
          identifier: userInfo.identifier
        }
      };

      // SAFE Diagnostic Logging: Verify incoming symbolic plan.id, resolved Razorpay Plan ID, and passed Plan ID
      // Never logs secrets (RAZORPAY_KEY_SECRET, etc.)
      console.log('[TeacherCheck Razorpay Subscription Diagnostic]', {
        symbolicPlanId: plan.id,
        resolvedPlanId: configuredRazorpayPlanId,
        passedPlanId: subscriptionOptions.plan_id,
        planIdLength: subscriptionOptions.plan_id.length,
        keyMode: key_id.startsWith('rzp_live_') ? 'live' : (key_id.startsWith('rzp_test_') ? 'test' : 'unknown'),
        keyIdPrefix: key_id.substring(0, 12)
      });

      const subscription = await razorpay.subscriptions.create(subscriptionOptions);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        type: 'subscription',
        subscription_id: subscription.id,
        plan_id: plan.id,
        amount: plan.amount,
        currency: plan.currency,
        key_id
      }));
      return;
    }

    // Flow B: Razorpay Fixed Order (when subscription Plan ID is not yet created on dashboard)
    const receiptId = `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const orderOptions = {
      amount: plan.amount,
      currency: plan.currency,
      receipt: receiptId.substring(0, 40),
      notes: {
        planId: plan.id,
        interval: plan.interval,
        userId: userInfo.userId || '',
        identifier: userInfo.identifier
      }
    };

    const order = await razorpay.orders.create(orderOptions);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      type: 'order',
      order_id: order.id,
      plan_id: plan.id,
      amount: order.amount,
      currency: order.currency,
      key_id
    }));
  } catch (err) {
    console.error('[TeacherCheck Razorpay Create Order/Subscription Error]', {
      statusCode: err.statusCode,
      errorCode: err.error?.code,
      errorDescription: err.error?.description,
      errorField: err.error?.field,
      errorReason: err.error?.reason
    });
    const isAuthFailure = err.statusCode === 401 || (err.error?.code === 'BAD_REQUEST_ERROR' && /auth/i.test(err.error?.description || ''));
    res.statusCode = isAuthFailure ? 401 : (err.statusCode || 500);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: err.error?.description || err.message || 'Failed to initiate Razorpay checkout transaction.'
    }));
  }
}

/**
 * Request Handler for POST /api/verify-payment
 * Verifies payment/subscription signature using HMAC-SHA256:
 * - Subscriptions: HMAC-SHA256(payment_id + "|" + subscription_id, KEY_SECRET)
 * - Orders: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
 * Validates plan configuration, checks idempotency, and records Pro entitlement server-side.
 */
export async function handleApiVerifyPayment(req, res) {
  applySecurityHeaders(res);

  // 1. CORS Origin Validation
  const cors = checkCorsOrigin(req);
  if (!cors.allowed) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  if (cors.origin) {
    res.setHeader('Access-Control-Allow-Origin', cors.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // 2. Parse Body
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    res.statusCode = err.statusCode || 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: err.message || 'Invalid request body' }));
    return;
  }

  // 3. Extract & Validate Required Fields
  const payment_id = body.razorpay_payment_id || body.payment_id;
  const subscription_id = body.razorpay_subscription_id || body.subscription_id;
  const order_id = body.razorpay_order_id || body.order_id;
  const signature = body.razorpay_signature || body.signature;
  const planId = body.planId || body.plan_id || 'monthly';

  if (!payment_id || (!subscription_id && !order_id) || !signature) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      error: 'Missing required payment verification fields (razorpay_payment_id, razorpay_signature, and subscription_id or order_id).'
    }));
    return;
  }

  const plan = getPlanConfig(planId);
  if (!plan) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      error: `Invalid plan specified: ${planId}. Supported plans are 'monthly' and 'yearly'.`
    }));
    return;
  }

  // 4. Verify Secret Key Presence
  const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').replace(/^["']|["']$/g, '').trim();
  if (!key_secret) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      error: 'Razorpay secret key not configured on server.'
    }));
    return;
  }

  // 5. Signature Verification via HMAC-SHA256
  // Subscriptions: payment_id + "|" + subscription_id
  // Orders: order_id + "|" + payment_id
  const payloadToSign = subscription_id
    ? `${payment_id}|${subscription_id}`
    : `${order_id}|${payment_id}`;

  try {
    const expectedSignature = crypto
      .createHmac('sha256', key_secret)
      .update(payloadToSign)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf-8');
    const signatureBuf = Buffer.from(signature, 'utf-8');
    const isValid = expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);

    if (!isValid) {
      logSafeEvent('PAYMENT_SIGNATURE_MISMATCH', { payment_id });
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        error: 'Invalid payment signature. Verification failed.'
      }));
      return;
    }

    const userInfo = await resolveUserIdentifier(req, res);
    const requiresAuth = req.headers['x-require-auth'] === 'true' || process.env.REQUIRE_AUTH_FOR_PAYMENT === 'true';
    if (requiresAuth && !userInfo.authenticated) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        error: 'Authentication required. Please sign in to verify your TeacherCheck Pro subscription.'
      }));
      return;
    }

    // 6. Idempotency Guard: prevent replay attacks & cross-user payment hijacking
    const isNewPayment = await entitlementService.checkAndRecordPaymentIdempotency(payment_id, {
      planId: plan.id,
      subscriptionId: subscription_id || null,
      orderId: order_id || null,
      identifier: userInfo.identifier,
      userId: userInfo.userId || null
    });

    if (!isNewPayment) {
      logSafeEvent('PAYMENT_REPLAY_DETECTED', { paymentId: payment_id });
      const existingPayment = await entitlementService.getPaymentRecord(payment_id);

      // Check cross-user protection: if payment was originally recorded for a different user
      if (existingPayment?.identifier && existingPayment.identifier !== userInfo.identifier) {
        logSafeEvent('CROSS_USER_PAYMENT_REPLAY_BLOCKED', {
          paymentId: payment_id,
          requestUser: userInfo.identifier,
          originalUser: existingPayment.identifier
        });
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: false,
          error: 'This payment belongs to another user account.'
        }));
        return;
      }

      res.statusCode = 409;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        alreadyProcessed: true,
        code: 'PAYMENT_ALREADY_PROCESSED',
        message: 'This payment has already been processed and verified.',
        error: 'This payment has already been processed and verified.',
        planId: plan.id
      }));
      return;
    }

    // 7. Persist Pro Entitlement Server-Side
    const entitlement = await entitlementService.setUserEntitlement(userInfo.identifier, {
      planId: plan.id,
      paymentId: payment_id,
      subscriptionId: subscription_id || null,
      orderId: order_id || null,
      status: 'active'
    });

    logSafeEvent('PAYMENT_VERIFIED_SUCCESS', {
      planId: plan.id,
      identifier: userInfo.identifier,
      isReplay: false
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      message: 'TeacherCheck Pro activated successfully.',
      planId: plan.id,
      dailyLimit: plan.dailyLimit,
      order_id: order_id || null,
      subscription_id: subscription_id || null,
      payment_id,
      entitlement: {
        planId: plan.id,
        dailyLimit: plan.dailyLimit,
        expiresAt: entitlement.expiresAt,
        status: entitlement.status
      }
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      error: 'Error during payment signature verification and entitlement storage.'
    }));
  }
}

/**
 * Request Handler for POST /api/razorpay-webhook
 * Validates Razorpay Webhook Signatures using HMAC-SHA256 and constant-time comparison.
 * Handles lifecycle events:
 * - subscription.charged: records renewal / active entitlement
 * - payment.captured / order.paid: records active entitlement
 * - subscription.cancelled / halted / paused: updates entitlement status
 * - payment.failed: logs failure safely without leaking sensitive information
 */
export async function handleApiRazorpayWebhook(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!webhookSecret) {
    logSafeEvent('WEBHOOK_CONFIG_ERROR', { error: 'Webhook secret not configured' });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Webhook secret not configured on server' }));
    return;
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature || typeof signature !== 'string') {
    logSafeEvent('WEBHOOK_SIGNATURE_MISSING');
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing X-Razorpay-Signature header' }));
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    res.statusCode = err.statusCode || 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to read request body' }));
    return;
  }

  // Constant-time HMAC-SHA256 signature validation
  try {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf-8');
    const signatureBuf = Buffer.from(signature, 'utf-8');

    const isValid = expectedBuf.length === signatureBuf.length &&
      crypto.timingSafeEqual(expectedBuf, signatureBuf);

    if (!isValid) {
      logSafeEvent('WEBHOOK_SIGNATURE_INVALID');
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
      return;
    }
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Signature verification error' }));
    return;
  }

  // Parse payload JSON safely
  let eventData;
  try {
    eventData = JSON.parse(rawBody);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid JSON event payload' }));
    return;
  }

  const eventType = eventData?.event;
  const payload = eventData?.payload || {};

  logSafeEvent('WEBHOOK_EVENT_RECEIVED', { eventType });

  try {
    switch (eventType) {
      case 'subscription.charged':
      case 'payment.captured':
      case 'order.paid': {
        const paymentEntity = payload.payment?.entity || {};
        const subscriptionEntity = payload.subscription?.entity || {};
        const orderEntity = payload.order?.entity || {};

        const notes = {
          ...orderEntity.notes,
          ...subscriptionEntity.notes,
          ...paymentEntity.notes
        };

        const identifier = notes.identifier || (notes.userId ? `user:${notes.userId}` : null);
        const planId = notes.planId || 'monthly';
        const paymentId = paymentEntity.id || payload.payment?.id || `wh_${Date.now()}`;
        const subscriptionId = subscriptionEntity.id || null;
        const orderId = orderEntity.id || paymentEntity.order_id || null;

        if (identifier) {
          const isNewPayment = await entitlementService.checkAndRecordPaymentIdempotency(paymentId, {
            planId,
            subscriptionId,
            orderId,
            identifier,
            source: 'webhook'
          });

          if (!isNewPayment) {
            logSafeEvent('WEBHOOK_DUPLICATE_PAYMENT', { paymentId, identifier, eventType });
          } else {
            await entitlementService.setUserEntitlement(identifier, {
              planId,
              paymentId,
              subscriptionId,
              orderId,
              status: 'active'
            });
            logSafeEvent('WEBHOOK_ENTITLEMENT_ACTIVATED', { identifier, planId, eventType });
          }
        }
        break;
      }

      case 'subscription.cancelled':
      case 'subscription.halted':
      case 'subscription.paused': {
        const subscriptionEntity = payload.subscription?.entity || {};
        const notes = subscriptionEntity.notes || {};
        const identifier = notes.identifier || (notes.userId ? `user:${notes.userId}` : null);
        const planId = notes.planId || 'monthly';

        if (identifier) {
          await entitlementService.setUserEntitlement(identifier, {
            planId,
            status: eventType.replace('subscription.', ''),
            subscriptionId: subscriptionEntity.id || null
          });
          logSafeEvent('WEBHOOK_SUBSCRIPTION_STATUS_CHANGED', { identifier, status: eventType });
        }
        break;
      }

      case 'payment.failed': {
        const paymentEntity = payload.payment?.entity || {};
        logSafeEvent('WEBHOOK_PAYMENT_FAILED', {
          errorDescription: paymentEntity.error_description || 'Payment failed'
        });
        break;
      }

      default:
        // Gracefully ignore unhandled event types with HTTP 200
        break;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', received: true, event: eventType }));
  } catch {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Error processing webhook event' }));
  }
}
