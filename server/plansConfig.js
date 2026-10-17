/**
 * TeacherCheck Pricing & Plans — Single Source of Truth
 * 
 * Pricing Specifications:
 * - FREE: ₹0 — 5 successful English grammar checks per day
 * - PRO MONTHLY: ₹199/month — 25 successful English grammar checks per day
 * - PRO YEARLY: ₹1,999/year — 25 successful English grammar checks per day (Yearly recurring)
 */

export const PLANS = {
  pro_monthly: {
    id: 'pro_monthly',
    name: 'TeacherCheck Pro Monthly',
    amount: 19900, // 199 INR in paise
    currency: 'INR',
    interval: 'monthly',
    dailyLimit: 25,
    getPlanId: () => (process.env.RAZORPAY_MONTHLY_PLAN_ID || '').trim() || null
  },
  pro_yearly: {
    id: 'pro_yearly',
    name: 'TeacherCheck Pro Yearly',
    amount: 199900, // 1,999 INR in paise
    currency: 'INR',
    interval: 'yearly',
    dailyLimit: 25,
    getPlanId: () => (process.env.RAZORPAY_YEARLY_PLAN_ID || '').trim() || null
  }
};

export const FREE_PLAN = {
  id: 'free',
  name: 'TeacherCheck Free',
  amount: 0,
  currency: 'INR',
  dailyLimit: 5
};

/**
 * Resolves a plan by its identifier.
 * Strictly maps explicit plan IDs (pro_monthly, pro_yearly) to configured prices.
 * Never accepts arbitrary pricing.
 */
export function getPlanConfig(planId) {
  if (!planId || typeof planId !== 'string') return null;
  const normalized = planId.trim().toLowerCase();
  if (normalized === 'pro_monthly' || normalized === 'monthly') {
    return PLANS.pro_monthly;
  }
  if (normalized === 'pro_yearly' || normalized === 'yearly') {
    return PLANS.pro_yearly;
  }
  return PLANS[normalized] || null;
}
