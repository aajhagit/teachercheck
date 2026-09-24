/**
 * TeacherCheck In-Memory IP Rate Limiter
 * 
 * Provides robust protection against API abuse and denial-of-service attempts.
 * Configurable via CHECK_RATE_LIMIT_WINDOW_MS and CHECK_RATE_LIMIT_MAX.
 */

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes default
const DEFAULT_MAX_REQUESTS = 30;           // 30 requests per window default

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || parseInt(process.env.CHECK_RATE_LIMIT_WINDOW_MS || `${DEFAULT_WINDOW_MS}`, 10);
    this.max = options.max || parseInt(process.env.CHECK_RATE_LIMIT_MAX || `${DEFAULT_MAX_REQUESTS}`, 10);
    this.hits = new Map();

    // Clean expired entries every 5 minutes to prevent memory leaks
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Extracts client IP address accurately, supporting reverse proxies safely
   */
  getClientIp(req) {
    // 1. X-Forwarded-For (standard reverse proxy header)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && typeof forwarded === 'string') {
      const firstIp = forwarded.split(',')[0].trim();
      if (firstIp) return firstIp;
    }

    // 2. X-Real-IP (nginx / cloudflare / load balancer)
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') {
      return realIp.trim();
    }

    // 3. Socket remote address
    const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress;
    if (socketIp) {
      // Normalize IPv6 mapped IPv4 (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
      if (socketIp.startsWith('::ffff:')) {
        return socketIp.substring(7);
      }
      return socketIp;
    }

    return '127.0.0.1';
  }

  /**
   * Checks if an incoming request exceeds the configured rate limit
   */
  check(req) {
    const ip = this.getClientIp(req);
    const now = Date.now();

    let entry = this.hits.get(ip);

    if (!entry || now > entry.resetTime) {
      entry = {
        count: 1,
        resetTime: now + this.windowMs
      };
      this.hits.set(ip, entry);
      return {
        allowed: true,
        remaining: this.max - 1,
        resetTime: entry.resetTime,
        retryAfterSeconds: 0,
        ip
      };
    }

    entry.count += 1;

    if (entry.count > this.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
        retryAfterSeconds,
        ip
      };
    }

    return {
      allowed: true,
      remaining: this.max - entry.count,
      resetTime: entry.resetTime,
      retryAfterSeconds: 0,
      ip
    };
  }

  /**
   * Resets hit count for all or specific IP (primarily for testing)
   */
  reset(ip) {
    if (ip) {
      this.hits.delete(ip);
    } else {
      this.hits.clear();
    }
  }

  /**
   * Purges expired rate limit records from memory
   */
  cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this.hits.entries()) {
      if (now > entry.resetTime) {
        this.hits.delete(ip);
      }
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

export const rateLimiter = new RateLimiter();
