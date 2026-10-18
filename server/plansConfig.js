/**
 * TeacherCheck Pricing & Plans — Single Source of Truth
 * 
 * Pricing Specifications:
 * - FREE: ₹0 — 5 successful English grammar checks per day
 * - PRO MONTHLY: ₹199/month — 25 successful English grammar checks per day
 * - PRO YEARLY: ₹1,999/year — 25 successful English grammar checks per day (Yearly recurring)
 */

/**
 * Safely maps frontend symbolic plan IDs to server-side configured Razorpay Plan IDs.
 * - 'pro_monthly' -> process.env.RAZORPAY_MONTHLY_PLAN_ID
 * - 'pro_yearly'  -> process.env.RAZORPAY_YEARLY_PLAN_ID
 *
 * Prevents symbolic IDs (e.g. "pro_monthly") from being passed as actual Razorpay Plan IDs,
 * which would trigger Razorpay's "The ID provided is invalid or could not be found" error.
 * Never exposes server-side plan configuration or secrets to the client.
 */
export function resolveRazorpayPlanId(symbolicPlanId) {
  if (!symbolicPlanId || typeof symbolicPlanId !== 'string') return null;
  const normalized = symbolicPlanId.trim().toLowerCase();

  let envPlanId = null;
  if (normalized === 'pro_monthly' || normalized === 'monthly') {
    envPlanId = process.env.RAZORPAY_MONTHLY_PLAN_ID;
  } else if (normalized === 'pro_yearly' || normalized === 'yearly') {
    envPlanId = process.env.RAZORPAY_YEARLY_PLAN_ID;
  } else {
    return null;
  }

  if (!envPlanId || typeof envPlanId !== 'string') return null;
  const cleaned = envPlanId.replace(/^["']|["']$/g, '').trim();

  // If the env variable was erroneously set to the symbolic name itself, treat as unconfigured
  if (!cleaned || cleaned === 'pro_monthly' || cleaned === 'pro_yearly' || cleaned === 'monthly' || cleaned === 'yearly') {
    return null;
  }

  return cleaned;
}

export const PLANS = {
  pro_monthly: {
    id: 'pro_monthly',
    name: 'TeacherCheck Pro Monthly',
    amount: 19900, // 199 INR in paise
    currency: 'INR',
    interval: 'monthly',
    dailyLimit: 25,
    getPlanId: () => resolveRazorpayPlanId('pro_monthly')
  },
  pro_yearly: {
    id: 'pro_yearly',
    name: 'TeacherCheck Pro Yearly',
    amount: 199900, // 1,999 INR in paise
    currency: 'INR',
    interval: 'yearly',
    dailyLimit: 25,
    getPlanId: () => resolveRazorpayPlanId('pro_yearly')
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
  return null;
}
