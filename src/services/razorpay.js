/**
 * TeacherCheck Razorpay Checkout Client Service
 * Handles script verification, order/subscription creation, checkout modal, and signature verification.
 */

/**
 * Ensures Razorpay checkout.js script is loaded on window
 */
export function ensureRazorpayScriptLoaded() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      return resolve(window.Razorpay);
    }

    const existingScript = document.querySelector('script[src*="checkout.razorpay.com"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(window.Razorpay));
      existingScript.addEventListener('error', () => reject(new Error('Failed to load Razorpay checkout script.')));
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout script.'));
    document.head.appendChild(script);
  });
}

/**
 * Call backend to create Razorpay Order or Subscription
 * Amount is strictly determined server-side from planId.
 * @param {Object} params - { planId, token }
 * @returns {Promise<{ type: string, order_id?: string, subscription_id?: string, amount: number, currency: string, key_id?: string }>}
 */
export async function createRazorpayOrder({ planId = 'pro_monthly', token = null } = {}) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('/api/create-order', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      planId
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.error || `Server error (${response.status}) creating checkout session.`;
    const error = new Error(errorMsg);
    error.statusCode = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

/**
 * Call backend to verify Razorpay Payment/Subscription Signature
 * @param {Object} params - { planId, razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, razorpay_signature, token }
 * @returns {Promise<{ success: boolean, message: string, entitlement?: Object }>}
 */
export async function verifyPaymentSignature({
  planId = 'pro_monthly',
  razorpay_order_id,
  razorpay_subscription_id,
  razorpay_payment_id,
  razorpay_signature,
  token = null
}) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('/api/verify-payment', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      planId,
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    const errorMsg = data.error || 'Payment signature verification failed.';
    const error = new Error(errorMsg);
    error.statusCode = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

/**
 * Launch Razorpay Standard Web Checkout
 */
export async function openRazorpayCheckout({
  planId = 'pro_monthly',
  name = 'TeacherCheck',
  description = 'TeacherCheck Pro — 25 Grammar Checks/Day',
  userEmail = '',
  userName = 'Student',
  token = null,
  onStart = null,
  onSuccess = null,
  onFailure = null,
  onDismiss = null
} = {}) {
  try {
    if (typeof onStart === 'function') onStart();

    // 1. Ensure Checkout.js is available
    await ensureRazorpayScriptLoaded();

    if (!window.Razorpay) {
      throw new Error('Razorpay SDK could not be initialized.');
    }

    // 2. Create Order / Subscription on Backend
    const sessionData = await createRazorpayOrder({ planId, token });

    const keyId = sessionData.key_id || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RAZORPAY_KEY_ID) || '';

    // 3. Configure Checkout Options
    const options = {
      key: keyId,
      name: name,
      description: description,
      image: '/favicon.svg',
      prefill: {
        name: userName || 'Student',
        email: userEmail || 'student@example.com'
      },
      theme: {
        color: '#C5221F'
      },
      modal: {
        ondismiss: function () {
          if (typeof onDismiss === 'function') {
            onDismiss();
          }
        }
      },
      handler: async function (response) {
        try {
          // Verify with Backend
          const verifyResult = await verifyPaymentSignature({
            planId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_subscription_id: response.razorpay_subscription_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            token
          });

          if (typeof onSuccess === 'function') {
            onSuccess({
              ...response,
              ...verifyResult
            });
          }
        } catch (verifyErr) {
          if (typeof onFailure === 'function') {
            onFailure(verifyErr);
          }
        }
      }
    };

    // Attach order_id or subscription_id
    if (sessionData.subscription_id) {
      options.subscription_id = sessionData.subscription_id;
    } else if (sessionData.order_id) {
      options.order_id = sessionData.order_id;
      options.amount = sessionData.amount;
      options.currency = sessionData.currency;
    }

    const rzp = new window.Razorpay(options);

    rzp.on('payment.failed', function (failResponse) {
      const err = new Error(failResponse.error?.description || failResponse.error?.reason || 'Payment failed.');
      err.data = failResponse.error;
      if (typeof onFailure === 'function') {
        onFailure(err);
      }
    });

    rzp.open();
    return rzp;
  } catch (err) {
    if (typeof onFailure === 'function') {
      onFailure(err);
    } else {
      throw err;
    }
  }
}
