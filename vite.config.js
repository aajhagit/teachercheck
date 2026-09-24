import { defineConfig } from 'vite';
import { handleApiCheck } from './server/apiHandler.js';
import { applySecurityHeaders } from './server/securityHeaders.js';

export default defineConfig({
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

        // Protected API route: POST /api/check
        server.middlewares.use('/api/check', handleApiCheck);
      }
    }
  ]
});
