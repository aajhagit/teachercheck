/**
 * TeacherCheck Security Headers, CORS Policy & Response Sanitization
 */

export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

/**
 * Applies HTTP security headers to any outgoing HTTP response
 */
export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

/**
 * Validates request origin against allowed origins policy
 */
export function checkCorsOrigin(req) {
  const origin = req.headers['origin'];
  
  // Direct same-origin requests or curl without origin header are allowed
  if (!origin) {
    return { allowed: true, origin: null };
  }

  const configuredOrigin = process.env.ALLOWED_ORIGIN;
  if (configuredOrigin) {
    if (origin === configuredOrigin) {
      return { allowed: true, origin };
    }
    return { allowed: false, origin };
  }

  // Development / Default allowed origins
  const host = req.headers['host'];
  try {
    const originUrl = new URL(origin);
    const originHost = originUrl.host;

    // Check if origin matches host header
    if (host && originHost === host) {
      return { allowed: true, origin };
    }

    // Standard local dev hosts
    if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
      return { allowed: true, origin };
    }
  } catch {
    return { allowed: false, origin };
  }

  return { allowed: false, origin };
}

/**
 * Strict response sanitization: only returns necessary client properties
 * and strips any provider dumps, errors, internal paths, or tokens.
 */
export function sanitizeCheckResponse(rawResult) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      status: 'unavailable',
      originalText: '',
      hasCorrections: false,
      corrections: [],
      teacherNote: "TeacherCheck couldn't complete the check. Please try again.",
      positiveNote: "Check temporarily unavailable."
    };
  }

  const sanitized = {
    status: typeof rawResult.status === 'string' ? rawResult.status : 'live',
    originalText: typeof rawResult.originalText === 'string' ? rawResult.originalText : '',
    hasCorrections: Boolean(rawResult.hasCorrections),
    corrections: [],
    teacherNote: typeof rawResult.teacherNote === 'string' ? rawResult.teacherNote : '',
    positiveNote: typeof rawResult.positiveNote === 'string' ? rawResult.positiveNote : ''
  };

  if (Array.isArray(rawResult.corrections)) {
    sanitized.corrections = rawResult.corrections
      .filter(c => c && typeof c === 'object')
      .map(c => ({
        original: String(c.original || ''),
        startIndex: typeof c.startIndex === 'number' ? c.startIndex : 0,
        endIndex: typeof c.endIndex === 'number' ? c.endIndex : 0,
        corrected: String(c.corrected || ''),
        explanation: String(c.explanation || '')
      }));
  }

  if (typeof rawResult.notice === 'string') {
    sanitized.notice = rawResult.notice;
  }

  return sanitized;
}

/**
 * Safe logger that logs request telemetry without exposing raw text or secrets
 */
export function logSafeEvent(event, meta = {}) {
  const timestamp = new Date().toISOString();
  const safeMeta = { ...meta };
  
  // Never log raw text or credentials
  delete safeMeta.apiKey;
  delete safeMeta.authorization;
  delete safeMeta.key;
  delete safeMeta.token;
  delete safeMeta.headers;

  const parts = [`[${timestamp}]`, `[TeacherCheck]`, event];
  if (Object.keys(safeMeta).length > 0) {
    parts.push(JSON.stringify(safeMeta));
  }
  console.log(parts.join(' '));
}
