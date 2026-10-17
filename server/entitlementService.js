import { dailyQuotaManager } from './dailyQuota.js';
import { getPlanConfig, FREE_PLAN } from './plansConfig.js';

const ENTITLEMENT_KEY_PREFIX = 'tc:entitlement:';
const PAYMENT_IDEMPOTENCY_PREFIX = 'tc:payment:';

/**
 * Service to manage server-side Pro entitlement persistence, retrieval, and payment idempotency.
 */
export class EntitlementService {
  constructor(quotaManager = dailyQuotaManager) {
    this.quotaManager = quotaManager;
  }

  get storage() {
    return this.quotaManager.storage;
  }

  buildEntitlementKey(identifier) {
    return `${ENTITLEMENT_KEY_PREFIX}${identifier}`;
  }

  buildPaymentKey(paymentId) {
    return `${PAYMENT_IDEMPOTENCY_PREFIX}${paymentId}`;
  }

  /**
   * Retrieves user Pro entitlement status from persistent storage.
   * If valid and unexpired, returns Pro entitlement with 25 checks/day.
   * Otherwise returns Free plan status with 5 checks/day.
   */
  async getUserEntitlement(identifier) {
    if (!identifier || !this.storage || !this.storage.isConfigured()) {
      return {
        isPro: false,
        planId: FREE_PLAN.id,
        dailyLimit: FREE_PLAN.dailyLimit,
        status: 'free'
      };
    }

    try {
      const key = this.buildEntitlementKey(identifier);
      const raw = await this.storage.getRaw(key);

      if (!raw) {
        return {
          isPro: false,
          planId: FREE_PLAN.id,
          dailyLimit: FREE_PLAN.dailyLimit,
          status: 'free'
        };
      }

      const entitlement = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (!entitlement || entitlement.status !== 'active') {
        return {
          isPro: false,
          planId: FREE_PLAN.id,
          dailyLimit: FREE_PLAN.dailyLimit,
          status: entitlement?.status || 'inactive'
        };
      }

      // Verify expiration timestamp
      if (entitlement.expiresAt) {
        const expiresTime = new Date(entitlement.expiresAt).getTime();
        if (!isNaN(expiresTime) && Date.now() > expiresTime) {
          return {
            isPro: false,
            planId: FREE_PLAN.id,
            dailyLimit: FREE_PLAN.dailyLimit,
            status: 'expired',
            expiredAt: entitlement.expiresAt
          };
        }
      }

      return {
        isPro: true,
        planId: entitlement.planId || 'monthly',
        dailyLimit: entitlement.dailyLimit || 25,
        status: 'active',
        paymentId: entitlement.paymentId,
        subscriptionId: entitlement.subscriptionId || null,
        orderId: entitlement.orderId || null,
        expiresAt: entitlement.expiresAt,
        activatedAt: entitlement.activatedAt
      };
    } catch {
      return {
        isPro: false,
        planId: FREE_PLAN.id,
        dailyLimit: FREE_PLAN.dailyLimit,
        status: 'free'
      };
    }
  }

  /**
   * Persists a verified Pro subscription or order entitlement for a user.
   */
  async setUserEntitlement(identifier, {
    planId,
    paymentId,
    subscriptionId = null,
    orderId = null,
    status = 'active'
  }) {
    if (!identifier) {
      throw new Error('Identifier is required to set entitlement');
    }

    const plan = getPlanConfig(planId);
    if (!plan) {
      throw new Error(`Invalid plan ID: ${planId}`);
    }

    const now = new Date();
    // Monthly: 30 days + 2 days grace; Yearly: 365 days + 2 days grace
    const durationDays = plan.interval === 'yearly' ? 367 : 32;
    const ttlSeconds = durationDays * 86400;
    const expiresAt = new Date(now.getTime() + (durationDays * 86400 * 1000)).toISOString();

    const record = {
      identifier,
      planId: plan.id,
      dailyLimit: plan.dailyLimit,
      status,
      paymentId,
      subscriptionId,
      orderId,
      activatedAt: now.toISOString(),
      expiresAt
    };

    const key = this.buildEntitlementKey(identifier);
    await this.storage.setRawWithTtl(key, JSON.stringify(record), ttlSeconds);

    return {
      isPro: true,
      ...record
    };
  }

  /**
   * Prevents payment replay attacks by atomically tracking processed payment IDs.
   * Returns true if payment is new and successfully recorded, false if already processed.
   */
  async checkAndRecordPaymentIdempotency(paymentId, details = {}) {
    if (!paymentId || !this.storage || !this.storage.isConfigured()) {
      return true;
    }

    const key = this.buildPaymentKey(paymentId);
    const existing = await this.storage.getRaw(key);

    if (existing) {
      return false; // Already processed
    }

    // Record for 90 days
    const ttlSeconds = 90 * 86400;
    await this.storage.setRawWithTtl(key, JSON.stringify({
      paymentId,
      recordedAt: new Date().toISOString(),
      ...details
    }), ttlSeconds);

    return true;
  }
}

export const entitlementService = new EntitlementService();
