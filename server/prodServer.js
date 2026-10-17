import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleApiCheck, handleApiQuota, handleApiCreateOrder, handleApiVerifyPayment, handleApiRazorpayWebhook } from './apiHandler.js';
import { applySecurityHeaders } from './securityHeaders.js';
import { validateSessionSecret } from './cookieSession.js';

// SEC-01: In production, fail safely on startup if cookie signing secret is missing
if (process.env.NODE_ENV === 'production') {
  validateSessionSecret(process.env);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');
const PORT = process.env.PORT || 3000;

// Standard MIME types map
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const BASE_CANONICAL_URL = 'https://teachercheckai.com';

export const ROUTE_METADATA = {
  '/': {
    title: 'TeacherCheck — Free AI Grammar Checker That Keeps Your Voice',
    description: 'Fix English grammar mistakes without rewriting your personality. TeacherCheck helps correct genuine errors while keeping your words and writing style yours.',
    canonical: `${BASE_CANONICAL_URL}/`,
    robots: 'index, follow',
    activeView: 'landingView'
  },
  '/privacy': {
    title: 'Privacy Policy — TeacherCheck',
    description: 'Read the TeacherCheck Privacy Policy. Learn how your English text is processed for grammar checking and how your privacy is protected.',
    canonical: `${BASE_CANONICAL_URL}/privacy`,
    robots: 'index, follow',
    activeView: 'privacyView'
  },
  '/terms': {
    title: 'Terms of Service — TeacherCheck',
    description: 'Read the TeacherCheck Terms of Service. Understand terms of use, educational guidance disclaimers, and service conditions.',
    canonical: `${BASE_CANONICAL_URL}/terms`,
    robots: 'index, follow',
    activeView: 'termsView'
  },
  '/app': {
    title: 'TeacherCheck — Red Pen Grammar Correction',
    description: 'Submit English sentences for instant, teacher-style red-pen grammar feedback while keeping your authentic tone.',
    canonical: `${BASE_CANONICAL_URL}/app`,
    robots: 'noindex, nofollow',
    activeView: 'appView'
  }
};

/**
 * Transforms the base SPA index.html into route-specific initial HTML
 * ensuring that canonical tags, titles, meta descriptions, and visible containers
 * match the requested route on initial page load without relying on client-side JS hydration.
 */
export function buildRouteHtml(baseHtml, pathname) {
  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  const meta = ROUTE_METADATA[cleanPath] || ROUTE_METADATA['/'];

  let html = baseHtml;

  // 1. Title tag
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${meta.title}</title>`);

  // 2. Meta description
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${meta.description}">`
  );

  // 3. Meta robots directive
  if (/<meta\s+name="robots"/i.test(html)) {
    html = html.replace(
      /<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="robots" content="${meta.robots}">`
    );
  } else {
    html = html.replace(
      /<link\s+rel="canonical"/i,
      `<meta name="robots" content="${meta.robots}">\n  <link rel="canonical"`
    );
  }

  // 4. Canonical URL tag
  html = html.replace(
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i,
    `<link rel="canonical" href="${meta.canonical}">`
  );

  // 5. Open Graph tags
  html = html.replace(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:title" content="${meta.title}">`
  );
  html = html.replace(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:url" content="${meta.canonical}">`
  );
  html = html.replace(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:description" content="${meta.description}">`
  );

  // 6. Twitter tags
  html = html.replace(
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="twitter:title" content="${meta.title}">`
  );
  html = html.replace(
    /<meta\s+name="twitter:url"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="twitter:url" content="${meta.canonical}">`
  );
  html = html.replace(
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="twitter:description" content="${meta.description}">`
  );

  // 7. Toggle initial view containers and heading hierarchy so target content is visible with correct primary H1
  if (meta.activeView === 'privacyView') {
    html = html.replace('id="landingView" class="landing-container"', 'id="landingView" class="landing-container hidden"');
    html = html.replace('id="privacyView" class="legal-container hidden"', 'id="privacyView" class="legal-container"');
    html = html.replace(
      /<h1(\s+class="hero-headline"\s+id="landingHeroHeading")>([\s\S]*?)<\/h1>/i,
      '<h2$1>$2</h2>'
    );
    html = html.replace(
      /<h2(\s+class="legal-title"\s+id="privacyHeading")>Privacy Policy<\/h2>/i,
      '<h1$1>Privacy Policy</h1>'
    );
  } else if (meta.activeView === 'termsView') {
    html = html.replace('id="landingView" class="landing-container"', 'id="landingView" class="landing-container hidden"');
    html = html.replace('id="termsView" class="legal-container hidden"', 'id="termsView" class="legal-container"');
    html = html.replace(
      /<h1(\s+class="hero-headline"\s+id="landingHeroHeading")>([\s\S]*?)<\/h1>/i,
      '<h2$1>$2</h2>'
    );
    html = html.replace(
      /<h2(\s+class="legal-title"\s+id="termsHeading")>Terms of Service<\/h2>/i,
      '<h1$1>Terms of Service</h1>'
    );
  } else if (meta.activeView === 'appView') {
    html = html.replace('id="landingView" class="landing-container"', 'id="landingView" class="landing-container hidden"');
    html = html.replace('id="appView" class="app-container hidden"', 'id="appView" class="app-container"');
    html = html.replace(
      /<h1(\s+class="hero-headline"\s+id="landingHeroHeading")>([\s\S]*?)<\/h1>/i,
      '<h2$1>$2</h2>'
    );
    html = html.replace(
      /<h2(\s+class="app-title"\s+id="appHeading")>TeacherCheck<\/h2>/i,
      '<h1$1>TeacherCheck</h1>'
    );
  }

  return html;
}

let cachedIndexHtml = null;
let cachedIndexMtime = 0;
const renderedPagesCache = new Map();

export function getRenderedPage(cleanPath) {
  const indexFile = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return null;
  }
  const stat = fs.statSync(indexFile);
  if (!cachedIndexHtml || stat.mtimeMs !== cachedIndexMtime) {
    cachedIndexHtml = fs.readFileSync(indexFile, 'utf8');
    cachedIndexMtime = stat.mtimeMs;
    renderedPagesCache.clear();
  }

  if (renderedPagesCache.has(cleanPath)) {
    return renderedPagesCache.get(cleanPath);
  }

  const rendered = buildRouteHtml(cachedIndexHtml, cleanPath);
  renderedPagesCache.set(cleanPath, rendered);
  return rendered;
}

export function handleHttpRequest(req, res) {
  // Always apply security headers to every response
  applySecurityHeaders(res);

  // 1. API Routes: /api/check and /api/quota (SEC-02: prevent unhandled promise rejections)
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;
  const normalizedApiPath = pathname.replace(/\/+$/, '') || '/';

  if (normalizedApiPath === '/api/check') {
    Promise.resolve(handleApiCheck(req, res)).catch(err => {
      console.error('[TeacherCheck Server] Unhandled error in /api/check:', err?.name || 'Error');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
      }
    });
    return;
  }

  if (normalizedApiPath === '/api/quota') {
    Promise.resolve(handleApiQuota(req, res)).catch(err => {
      console.error('[TeacherCheck Server] Unhandled error in /api/quota:', err?.name || 'Error');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
      }
    });
    return;
  }

  if (normalizedApiPath === '/api/create-order') {
    Promise.resolve(handleApiCreateOrder(req, res)).catch(err => {
      console.error('[TeacherCheck Server] Unhandled error in /api/create-order:', err?.name || 'Error');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
      }
    });
    return;
  }

  if (normalizedApiPath === '/api/verify-payment') {
    Promise.resolve(handleApiVerifyPayment(req, res)).catch(err => {
      console.error('[TeacherCheck Server] Unhandled error in /api/verify-payment:', err?.name || 'Error');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
      }
    });
    return;
  }

  if (normalizedApiPath === '/api/razorpay-webhook') {
    Promise.resolve(handleApiRazorpayWebhook(req, res)).catch(err => {
      console.error('[TeacherCheck Server] Unhandled error in /api/razorpay-webhook:', err?.name || 'Error');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
      }
    });
    return;
  }

  // 1b. Unknown API endpoints: Return HTTP 404 JSON (never return SPA HTML for /api or /api/*)
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
    return;
  }

  // 2. HTTP Method Validation for static/SPA routes
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  // 3. Resolve file path safely within DIST_DIR (Path Traversal Protection)
  const decodedPath = decodeURIComponent(pathname);
  const normalizedRelativePath = path.normalize(decodedPath).replace(/^(\.\.[\/\\])+/, '');
  const requestedFile = path.join(DIST_DIR, normalizedRelativePath);

  if (!requestedFile.startsWith(DIST_DIR)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Forbidden');
    return;
  }

  // 4. Check if the path targets a specific file with an extension
  const ext = path.extname(decodedPath).toLowerCase();

  if (ext) {
    // Explicit static file requested (e.g. /assets/index.js, /favicon.svg)
    if (fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      
      // Long-term immutable caching for hashed Vite assets; short-term for root static files
      if (pathname.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      fs.createReadStream(requestedFile).pipe(res);
      return;
    }

    // Genuinely missing static asset
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
    return;
  }

  // 5. SPA Route Rendering & Fallback: Serve tailored HTML for /, /privacy, /terms, /app
  const cleanPath = pathname.replace(/\/+$/, '') || '/';

  // Apply noindex to /app and /app/
  if (cleanPath === '/app') {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  const renderedHtml = getRenderedPage(cleanPath);
  if (renderedHtml !== null) {
    const bodyBuffer = Buffer.from(renderedHtml, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', bodyBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(bodyBuffer);
    return;
  }

  // Fallback if dist hasn't been built yet
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Production build not found. Please run "npm run build" first.');
}

const server = http.createServer(handleHttpRequest);

// Only listen automatically when run directly as the main process
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  server.listen(PORT, () => {
    console.log(`[TeacherCheck] Production server running on http://localhost:${PORT}`);
    console.log(`[TeacherCheck] Serving static assets from: ${DIST_DIR}`);
    console.log(`[TeacherCheck] Environment: ${process.env.NODE_ENV || 'production'}`);
  });
}

export default server;
