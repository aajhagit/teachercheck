import { checkEnglishWithAI } from './aiService.js';
import { rateLimiter } from './rateLimiter.js';
import { dailyQuotaManager, getUtcMidnightReset } from './dailyQuota.js';
import { getOrCreateAnonymousId, getPrivacySaltedIpHash } from './cookieSession.js';
import { authService } from './authService.js';
import { entitlementService } from './entitlementService.js';
import { 
  applySecurityHeaders, 
  checkCorsOrigin, 
  sanitizeCheckResponse, 
  logSafeEvent 
} from './securityHeaders.js';

/**
 * Request Handler for GET /api/quota
 * Informs the client of remaining free grammar checks for today.
 */
export async function handleApiQuota(req, res) {
  try {
    applySecurityHeaders(res);

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, OPTIONS');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Token Verification
    const authResult = await authService.verifyUserToken(req.headers['authorization']);
    if (authResult.error) {
      if (authResult.error === 'AUTH_TIMEOUT' || authResult.error === 'AUTH_UNCONFIGURED' || authResult.error === 'AUTH_ERROR') {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: authResult.message || 'Authentication service is temporarily unavailable.' }));
        return;
      }
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: authResult.message || 'Invalid or expired session. Please sign in again.' }));
      return;
    }

    const { anonId, hasCookie } = getOrCreateAnonymousId(req, res);
    const clientIp = rateLimiter.getClientIp(req);
    const { dateKey } = getUtcMidnightReset();
    const anonIdentifier = hasCookie ? `anon:${anonId}` : `ip:${getPrivacySaltedIpHash(clientIp, dateKey)}`;

    const identifier = authResult.authenticated ? `user:${authResult.user.id}` : anonIdentifier;
    
    // Check Server-Side Pro Entitlement
    const entitlement = await entitlementService.getUserEntitlement(identifier);
    const userLimit = entitlement.isPro ? 25 : 5;

    let status;
    try {
      status = await dailyQuotaManager.getStatus(identifier, {
        limit: userLimit,
        linkedIdentifier: authResult.authenticated ? anonIdentifier : null
      });
    } catch (err) {
      logSafeEvent('QUOTA_STORAGE_ERROR', { errorType: err?.name || 'StorageError' });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Daily quota service is temporarily unavailable. Please try again shortly.' 
      }));
      return;
    }

    if (!status.configured && (process.env.NODE_ENV === 'production' || dailyQuotaManager.getStorageType() === 'unconfigured')) {
      logSafeEvent('QUOTA_UNCONFIGURED', { ip: getPrivacySaltedIpHash(clientIp, dateKey) });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Daily quota service is temporarily unavailable. Storage configuration required.' 
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Daily-Limit', status.limit);
    res.setHeader('X-Daily-Remaining', status.remaining);
    res.setHeader('X-Daily-Reset', status.resetsAtEpoch);

    res.end(JSON.stringify({
      limit: status.limit,
      remaining: status.remaining,
      used: status.used,
      resetAt: status.resetAt || status.resetsAt,
      resetsAt: status.resetsAt,
      plan: entitlement.isPro ? 'pro' : 'free',
      planId: entitlement.planId || 'free',
      dailyLimit: status.limit
    }));
  } catch (err) {
    logSafeEvent('QUOTA_HANDLER_ERROR', { errorType: err?.name || 'Error' });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
    }
  }
}

/**
 * Shared Request Handler for POST /api/check
 * Used by both Vite dev server and standalone Node production server.
 */
export async function handleApiCheck(req, res) {
  const startTime = Date.now();
  applySecurityHeaders(res);

  // 1. CORS Origin Validation
  const cors = checkCorsOrigin(req);
  if (!cors.allowed) {
    logSafeEvent('CORS_FORBIDDEN', { origin: req.headers['origin'] });
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
  res.setHeader('Access-Control-Max-Age', '86400');

  // 2. Preflight OPTIONS Handling
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 3. HTTP Method Validation
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // 4. IP-Based Short-Term Burst Rate Limiting Check (Anti-DDoS Shield)
  const rateResult = rateLimiter.check(req);
  res.setHeader('X-RateLimit-Limit', rateLimiter.max);
  res.setHeader('X-RateLimit-Remaining', rateResult.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateResult.resetTime / 1000));

  if (!rateResult.allowed) {
    res.statusCode = 429;
    res.setHeader('Retry-After', rateResult.retryAfterSeconds);
    res.setHeader('Content-Type', 'application/json');
    logSafeEvent('RATE_LIMIT_EXCEEDED', { 
      ip: rateResult.ip, 
      retryAfterSeconds: rateResult.retryAfterSeconds 
    });
    res.end(JSON.stringify({ 
      error: 'Too many check requests from your connection. Please wait a few moments and try again.' 
    }));
    return;
  }

  // 5. Body Stream & Payload Size Protection (max 10KB to prevent memory abuse)
  const MAX_BODY_BYTES = 10 * 1024;
  let body = '';
  let bodySize = 0;
  let isTooLarge = false;

  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_BYTES) {
      isTooLarge = true;
      return;
    }
    body += chunk;
  });

  req.on('end', async () => {
    try {
      if (isTooLarge) {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Payload too large. Please keep your sentence under 600 characters.' }));
        return;
      }

    // 6. JSON Structure & Type Validation
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON request format.' }));
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Request body must be a JSON object.' }));
      return;
    }

    const rawText = parsed.text;
    if (typeof rawText !== 'string') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Text must be a string.' }));
      return;
    }

    const text = rawText.trim();
    if (!text) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Text is required.' }));
      return;
    }

    if (text.length > 600) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Sentence exceeds maximum limit of 600 characters.' }));
      return;
    }

    // 7. Authentication & Token Verification
    const authResult = await authService.verifyUserToken(req.headers['authorization']);
    if (authResult.error) {
      if (authResult.error === 'AUTH_TIMEOUT' || authResult.error === 'AUTH_UNCONFIGURED' || authResult.error === 'AUTH_ERROR') {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: authResult.message || 'Authentication service is temporarily unavailable. Please try again shortly.' }));
        return;
      }
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: authResult.message || 'Invalid or expired session. Please sign in again.' }));
      return;
    }

    // 8. Server-Side Daily Free Quota Reservation (Atomic & Concurrency-Safe)
    const { anonId, hasCookie } = getOrCreateAnonymousId(req, res);
    const clientIp = rateLimiter.getClientIp(req);
    const { dateKey } = getUtcMidnightReset();
    const anonIdentifier = hasCookie ? `anon:${anonId}` : `ip:${getPrivacySaltedIpHash(clientIp, dateKey)}`;

    const identifier = authResult.authenticated ? `user:${authResult.user.id}` : anonIdentifier;

    // Entitlement determines user limit (Free: 5, Pro: 25)
    let userLimit = 5;
    try {
      const entitlement = await entitlementService.getUserEntitlement(identifier);
      userLimit = entitlement.dailyLimit || (entitlement.isPro ? 25 : 5);
    } catch (err) {
      logSafeEvent('ENTITLEMENT_LOOKUP_ERROR', { errorType: err?.name || 'Error' });
      userLimit = 5;
    }

    let reservation;
    try {
      reservation = await dailyQuotaManager.reserveCheck(identifier, {
        limit: userLimit,
        linkedIdentifier: authResult.authenticated ? anonIdentifier : null
      });
    } catch (err) {
      logSafeEvent('QUOTA_STORAGE_ERROR', { errorType: err?.name || 'StorageError' });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Daily free quota service is temporarily unavailable. Please try again shortly.' 
      }));
      return;
    }

    if (reservation.unconfigured) {
      logSafeEvent('QUOTA_UNCONFIGURED', { ip: getPrivacySaltedIpHash(clientIp, dateKey) });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Daily free quota service is temporarily unavailable. Storage configuration required.' 
      }));
      return;
    }

    if (!reservation.allowed) {
      logSafeEvent('DAILY_QUOTA_EXCEEDED', { remaining: 0 });
      res.statusCode = 429;
      res.setHeader('X-Daily-Limit', reservation.limit);
      res.setHeader('X-Daily-Remaining', 0);
      res.setHeader('X-Daily-Reset', reservation.resetsAtEpoch);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        code: 'DAILY_QUOTA_EXCEEDED',
        error: reservation.error,
        quota: {
          limit: reservation.limit,
          remaining: 0,
          resetAt: reservation.resetAt || reservation.resetsAt,
          resetsAt: reservation.resetsAt
        }
      }));
      return;
    }

    // 9. Check with AI & Sanitize Response Output
    try {
      const rawResult = await checkEnglishWithAI(text);
      const sanitized = sanitizeCheckResponse(rawResult);

      const durationMs = Date.now() - startTime;
      logSafeEvent('CHECK_COMPLETED', {
        status: sanitized.status,
        textLength: text.length,
        correctionsCount: sanitized.corrections.length,
        durationMs,
        quotaRemaining: reservation.remaining
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Daily-Limit', reservation.limit);
      res.setHeader('X-Daily-Remaining', reservation.remaining);
      res.setHeader('X-Daily-Reset', reservation.resetsAtEpoch);

      sanitized.quota = {
        limit: reservation.limit,
        remaining: reservation.remaining,
        resetAt: reservation.resetAt || reservation.resetsAt,
        resetsAt: reservation.resetsAt
      };

      res.end(JSON.stringify(sanitized));
    } catch (err) {
      // Compensating Transaction: Roll back reservation so failed checks DO NOT consume user quota
      try {
        await dailyQuotaManager.rollbackReservation(identifier, {
          linkedIdentifier: authResult.authenticated ? anonIdentifier : null
        });
      } catch (rollbackErr) {
        logSafeEvent('QUOTA_ROLLBACK_ERROR', { errorType: rollbackErr?.name || 'StorageError' });
      }

      const durationMs = Date.now() - startTime;
      logSafeEvent('CHECK_ERROR', {
        errorType: err.name || 'UnknownError',
        durationMs
      });

      // Never expose provider errors or stack traces to the client
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'The teacher is temporarily unavailable. Please try again shortly.' 
      }));
    }
  } catch (unhandledErr) {
    logSafeEvent('CHECK_UNHANDLED_ERROR', { errorType: unhandledErr?.name || 'Error' });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
    }
  }
});

  req.on('error', (err) => {
    logSafeEvent('REQUEST_STREAM_ERROR', { errorType: err?.name || 'StreamError' });
    if (!res.headersSent) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Request connection error.' }));
    }
  });
}

// Razorpay Payment & Webhook Endpoints
export { handleApiCreateOrder, handleApiVerifyPayment, handleApiRazorpayWebhook } from './razorpayHandler.js';
