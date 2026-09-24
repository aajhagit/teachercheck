import { checkEnglishWithAI } from './aiService.js';
import { rateLimiter } from './rateLimiter.js';
import { 
  applySecurityHeaders, 
  checkCorsOrigin, 
  sanitizeCheckResponse, 
  logSafeEvent 
} from './securityHeaders.js';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  // 4. IP-Based Rate Limiting Check
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

    // 7. Check with AI & Sanitize Response Output
    try {
      const rawResult = await checkEnglishWithAI(text);
      const sanitized = sanitizeCheckResponse(rawResult);

      const durationMs = Date.now() - startTime;
      logSafeEvent('CHECK_COMPLETED', {
        status: sanitized.status,
        textLength: text.length,
        correctionsCount: sanitized.corrections.length,
        durationMs
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(sanitized));
    } catch (err) {
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
  });
}
