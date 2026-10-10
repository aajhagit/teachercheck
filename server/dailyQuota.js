import { createQuotaStorage } from './quotaStorage.js';

export const DAILY_FREE_LIMIT = 5;
export const DAILY_QUOTA_LIMIT = DAILY_FREE_LIMIT;

/**
 * Calculates current UTC date and exact seconds until the next 00:00:00 UTC boundary.
 */
export function getUtcMidnightReset(now = new Date()) {
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  
  const dateKey = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const ttlSeconds = Math.max(60, Math.ceil((nextReset.getTime() - now.getTime()) / 1000));
  
  return {
    dateKey,
    dateStr: dateKey,
    resetAt: nextReset.toISOString(),
    nextResetIso: nextReset.toISOString(),
    nextResetEpoch: Math.ceil(nextReset.getTime() / 1000),
    ttlSeconds
  };
}

export class DailyQuotaManager {
  constructor(options = {}) {
    this.limit = options.limit || DAILY_FREE_LIMIT;
    this.options = options;
    if (options.storage) {
      this._storage = options.storage;
    }
  }

  get storage() {
    if (!this._storage || !this._storage.isConfigured()) {
      try {
        const candidate = createQuotaStorage(this.options);
        if (candidate.isConfigured()) {
          this._storage = candidate;
        } else if (!this._storage) {
          this._storage = candidate;
        }
      } catch {
        // In strict mode or production without config, retain unconfigured
      }
    }
    return this._storage || createQuotaStorage({ ...this.options, allowUnconfigured: true });
  }

  setStorage(storage) {
    this._storage = storage;
  }

  isConfigured() {
    return Boolean(this.storage && this.storage.isConfigured());
  }

  getStorageType() {
    return this.storage ? this.storage.getType() : 'unconfigured';
  }

  buildKey(identifier, dateKey) {
    return `tc:quota:${identifier}:${dateKey}`;
  }

  /**
   * Reads current quota status without modifying counters.
   */
  async getStatus(identifier) {
    const { dateKey, nextResetIso, nextResetEpoch } = getUtcMidnightReset();

    if (!this.storage.isConfigured()) {
      return {
        configured: false,
        limit: this.limit,
        remaining: this.limit,
        used: 0,
        resetsAt: nextResetIso,
        resetsAtEpoch: nextResetEpoch
      };
    }

    const key = this.buildKey(identifier, dateKey);
    const count = await this.storage.get(key);
    const remaining = Math.max(0, this.limit - count);

    return {
      configured: true,
      limit: this.limit,
      remaining,
      used: Math.min(this.limit, count),
      count,
      resetAt: nextResetIso,
      resetsAt: nextResetIso,
      resetsAtEpoch: nextResetEpoch
    };
  }

  /**
   * Atomically reserves a check quota slot BEFORE calling the AI service.
   * Handles concurrent bursts safely: simultaneous requests increment atomically,
   * and any request that pushes the count beyond the limit is immediately rejected and rolled back.
   */
  async reserveCheck(identifier) {
    const { dateKey, nextResetIso, nextResetEpoch, ttlSeconds } = getUtcMidnightReset();

    if (!this.storage.isConfigured()) {
      return {
        allowed: false,
        unconfigured: true,
        error: 'Daily quota storage is not configured. UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production.',
        limit: this.limit,
        remaining: 0,
        count: 0,
        resetAt: nextResetIso,
        resetsAt: nextResetIso,
        resetsAtEpoch: nextResetEpoch
      };
    }

    const key = this.buildKey(identifier, dateKey);
    // Add 1 hour grace period to key TTL to handle clock skew across machines
    const storageTtl = ttlSeconds + 3600;
    
    // Atomic increment in persistent storage
    const newCount = await this.storage.incrWithTtl(key, storageTtl);

    if (newCount > this.limit) {
      // Revert reservation immediately so count does not inflate indefinitely
      await this.storage.decr(key);
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        used: this.limit,
        count: this.limit,
        resetAt: nextResetIso,
        resetsAt: nextResetIso,
        resetsAtEpoch: nextResetEpoch,
        error: `Daily free limit reached (${this.limit}/${this.limit} checks used today). Your allowance resets at midnight UTC.`
      };
    }

    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, this.limit - newCount),
      used: newCount,
      count: newCount,
      resetAt: nextResetIso,
      resetsAt: nextResetIso,
      resetsAtEpoch: nextResetEpoch,
      key
    };
  }

  /**
   * Compensating transaction: rolls back the reservation if upstream AI check fails.
   */
  async rollbackReservation(identifier) {
    const { dateKey } = getUtcMidnightReset();
    if (!this.storage.isConfigured()) return 0;
    const key = this.buildKey(identifier, dateKey);
    return await this.storage.decr(key);
  }
}

export const dailyQuotaManager = new DailyQuotaManager();
