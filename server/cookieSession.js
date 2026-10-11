import crypto from 'crypto';

export const COOKIE_NAME = 'tc_anon_id';
export const DEFAULT_DEV_SECRET = 'teachercheck-dev-quota-secret-2026';

/**
 * Returns the secret key used for signing anonymous session cookies.
 * In production (NODE_ENV === 'production'), strictly requires SESSION_SECRET or COOKIE_SECRET.
 * In development and test environments, falls back to DEFAULT_DEV_SECRET.
 * Never prints secret values.
 */
export function getSessionSecret(env = process.env) {
  const secret = (env.SESSION_SECRET || env.COOKIE_SECRET || '').trim();
  if (secret) {
    return secret;
  }

  const isProd = (env.NODE_ENV === 'production');
  if (isProd) {
    throw new Error(
      'SESSION_SECRET or COOKIE_SECRET environment variable is required in production. ' +
      'Set SESSION_SECRET in Render environment variables to securely sign anonymous quota cookies.'
    );
  }

  return DEFAULT_DEV_SECRET;
}

/**
 * Validates that the session secret is properly configured for the current environment.
 * Throws in production if missing; returns true when valid.
 */
export function validateSessionSecret(env = process.env) {
  getSessionSecret(env);
  return true;
}

/**
 * Signs an anonymous identifier with HMAC-SHA256
 */
export function sign(value, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${hmac}`;
}

export const signCookie = sign;

/**
 * Verifies a signed value and returns original value if valid, or null if tampered.
 */
export function unsign(signedValue, secret) {
  if (typeof signedValue !== 'string' || !signedValue.includes('.')) {
    return null;
  }
  const dotIndex = signedValue.lastIndexOf('.');
  const value = signedValue.substring(0, dotIndex);
  const hmac = signedValue.substring(dotIndex + 1);

  if (!value || !hmac) return null;

  try {
    const expectedHmac = crypto.createHmac('sha256', secret).update(value).digest('hex');
    const hmacBuf = Buffer.from(hmac, 'utf8');
    const expectedBuf = Buffer.from(expectedHmac, 'utf8');

    if (hmacBuf.length !== expectedBuf.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(hmacBuf, expectedBuf)) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

export const verifyAndParseCookie = unsign;

/**
 * Parses HTTP Cookie header into key-value map
 */
export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Extracts or issues a cryptographically signed anonymous ID cookie (tc_anon_id).
 * If no valid cookie exists, generates a fresh random UUID and signs it.
 */
export function getOrCreateAnonymousId(req, res, options = {}) {
  const secret = options.secret || getSessionSecret();
  const cookies = parseCookies(req?.headers?.['cookie']);
  const rawCookie = cookies[COOKIE_NAME];
  
  let anonId = rawCookie ? unsign(rawCookie, secret) : null;
  let isNew = false;

  if (!anonId) {
    anonId = crypto.randomUUID();
    isNew = true;
  }

  // Set or refresh cookie on response
  if (res && typeof res.setHeader === 'function') {
    const signedValue = sign(anonId, secret);
    const isSecure = process.env.NODE_ENV === 'production' || 
                     req?.headers?.['x-forwarded-proto'] === 'https' ||
                     Boolean(req?.socket?.encrypted);

    const flags = [
      `${COOKIE_NAME}=${encodeURIComponent(signedValue)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=31536000' // 1 year
    ];

    if (isSecure) {
      flags.push('Secure');
    }

    const cookieStr = flags.join('; ');
    const existing = res.getHeader('Set-Cookie');

    if (existing) {
      const arr = Array.isArray(existing) ? existing : [existing];
      // Only append if not already setting tc_anon_id
      const filtered = arr.filter(c => !c.startsWith(`${COOKIE_NAME}=`));
      res.setHeader('Set-Cookie', [...filtered, cookieStr]);
    } else {
      res.setHeader('Set-Cookie', cookieStr);
    }
  }

  return {
    anonId,
    isNew,
    hasCookie: Boolean(rawCookie && anonId)
  };
}

export const resolveSession = getOrCreateAnonymousId;

/**
 * Generates a privacy-safe, salted, daily-rotating hash for client IP when cookies are not provided.
 * Raw IP is never stored. The hash rotates every midnight UTC.
 */
export function getPrivacySaltedIpHash(clientIp, dateKey, secret) {
  const effectiveSecret = secret || getSessionSecret();
  const safeIp = clientIp || '127.0.0.1';
  return crypto.createHmac('sha256', effectiveSecret)
    .update(`tc-ip-v1:${safeIp}:${dateKey}`)
    .digest('hex')
    .substring(0, 32);
}
