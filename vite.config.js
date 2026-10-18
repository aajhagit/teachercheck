import 'dotenv/config';
import { defineConfig } from 'vite';
import { handleApiCheck, handleApiQuota, handleApiCreateOrder, handleApiVerifyPayment, handleApiRazorpayWebhook } from './server/apiHandler.js';
import { applySecurityHeaders } from './server/securityHeaders.js';

export default defineConfig({
  envPrefix: ['VITE_', 'SUPABASE_'],
  server: {
    watch: {
      ignored: ['**/scratch/**']
    }
  },
  plugins: [
    {
      name: 'production-hardening-backend',
      configureServer(server) {
        // Global security headers middleware applied to all requests
        server.middlewares.use((req, res, next) => {
          applySecurityHeaders(res);
          next();
        });

        // Protected API routes
        server.middlewares.use('/api/quota', handleApiQuota);
        server.middlewares.use('/api/check', handleApiCheck);
        server.middlewares.use('/api/create-order', handleApiCreateOrder);
        server.middlewares.use('/api/create-subscription', handleApiCreateOrder);
        server.middlewares.use('/api/verify-payment', handleApiVerifyPayment);
        server.middlewares.use('/api/razorpay-webhook', handleApiRazorpayWebhook);
      }
    }
  ]
});
