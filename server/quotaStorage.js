/**
 * TeacherCheck Daily Quota Storage Drivers
 * 
 * Supports:
 * 1. Upstash Redis REST API (zero npm dependencies, native fetch, survives Render restarts & scales across instances)
 * 2. In-memory Map (strictly for local automated testing when ALLOW_DEV_MEMORY_QUOTA=true)
 */

export class UpstashRedisStorage {
  constructor(options = {}) {
    if (options.validate || options.strict) {
      if (!options.url && !process.env.UPSTASH_REDIS_REST_URL) {
        throw new Error('UPSTASH_REDIS_REST_URL is required');
      }
      if (!options.token && !process.env.UPSTASH_REDIS_REST_TOKEN) {
        throw new Error('UPSTASH_REDIS_REST_TOKEN is required');
      }
    }
    if (options.url === null) {
      throw new Error('UPSTASH_REDIS_REST_URL is required');
    }
    if (options.token === null) {
      throw new Error('UPSTASH_REDIS_REST_TOKEN is required');
    }
    this.url = (options.url || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
    this.token = options.token || process.env.UPSTASH_REDIS_REST_TOKEN || '';
    this.timeoutMs = options.timeoutMs || 5000;
  }

  isConfigured() {
    return Boolean(this.url && this.token);
  }

  getType() {
    return 'upstash-redis';
  }

  getSignal() {
    return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined;
  }

  async incrWithTtl(key, ttlSeconds) {
    if (!this.isConfigured()) {
      throw new Error('UPSTASH_STORAGE_UNCONFIGURED');
    }

    // Pipeline atomic INCR + EXPIRE
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, ttlSeconds]
      ]),
      signal: this.getSignal()
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Upstash Redis error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const incrResult = data[0]?.result;
    return typeof incrResult === 'number' ? incrResult : parseInt(incrResult, 10);
  }

  async decr(key) {
    if (!this.isConfigured()) {
      throw new Error('UPSTASH_STORAGE_UNCONFIGURED');
    }

    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['DECR', key]),
      signal: this.getSignal()
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Upstash Redis error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return typeof data.result === 'number' ? data.result : parseInt(data.result, 10);
  }

  async get(key) {
    if (!this.isConfigured()) {
      throw new Error('UPSTASH_STORAGE_UNCONFIGURED');
    }

    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['GET', key]),
      signal: this.getSignal()
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Upstash Redis error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (data.result === null || data.result === undefined) return 0;
    return typeof data.result === 'number' ? data.result : parseInt(data.result, 10);
  }

  async setWithTtl(key, value, ttlSeconds) {
    if (!this.isConfigured()) {
      throw new Error('UPSTASH_STORAGE_UNCONFIGURED');
    }

    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', key, value, 'EX', ttlSeconds]),
      signal: this.getSignal()
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Upstash Redis error (${res.status}): ${errText}`);
    }

    return value;
  }
}

export class InMemoryQuotaStorage {
  constructor() {
    this.store = new Map();
  }

  get map() {
    return this.store;
  }

  isConfigured() {
    return true;
  }

  getType() {
    return 'in-memory-test';
  }

  async incrWithTtl(key, ttlSeconds) {
    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || now > entry.expiresAt) {
      entry = {
        count: 1,
        expiresAt: now + (ttlSeconds * 1000)
      };
      this.store.set(key, entry);
      return 1;
    }

    entry.count += 1;
    return entry.count;
  }

  async decr(key) {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.count = Math.max(0, entry.count - 1);
    return entry.count;
  }

  async setWithTtl(key, value, ttlSeconds) {
    const now = Date.now();
    this.store.set(key, {
      count: value,
      expiresAt: now + (ttlSeconds * 1000)
    });
    return value;
  }

  async get(key) {
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || now > entry.expiresAt) {
      return 0;
    }
    return entry.count;
  }

  clear() {
    this.store.clear();
  }
}

/**
 * Factory that chooses the appropriate storage implementation.
 * Refuses to use in-memory in production without explicit test opt-in.
 */
export function createQuotaStorage(options = {}) {
  // If explicitly injected (e.g. for unit testing)
  if (options.storage) {
    return options.storage;
  }

  const env = options.env || process.env;
  const allowDevMemory = options.allowDevMemory ?? (env.ALLOW_DEV_MEMORY_QUOTA === 'true');
  const isProd = (env.NODE_ENV === 'production');

  const upstash = new UpstashRedisStorage({
    url: options.url || env.UPSTASH_REDIS_REST_URL,
    token: options.token || env.UPSTASH_REDIS_REST_TOKEN
  });

  if (upstash.isConfigured()) {
    return upstash;
  }

  // If in-memory is explicitly allowed for tests or dev
  if (allowDevMemory) {
    return new InMemoryQuotaStorage();
  }

  // If in production or strict mode, fail safely and explain exact setup
  if (isProd || options.strict) {
    throw new Error(
      'Persistent quota storage is unconfigured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables in Render to enable persistent quota enforcement. Ephemeral in-memory storage is not permitted in production.'
    );
  }

  // Return unconfigured upstash instance so callers can detect configuration state
  return upstash;
}
