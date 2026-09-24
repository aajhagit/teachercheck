import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleApiCheck } from './apiHandler.js';
import { applySecurityHeaders } from './securityHeaders.js';

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
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  // Always apply security headers to every response
  applySecurityHeaders(res);

  // 1. API Route: /api/check
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  if (pathname === '/api/check') {
    handleApiCheck(req, res);
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

  // 5. SPA Fallback: Serve dist/index.html for SPA routes (e.g. /, /app, /privacy, /terms)
  const indexFile = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(indexFile).pipe(res);
    return;
  }

  // Fallback if dist hasn't been built yet
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Production build not found. Please run "npm run build" first.');
});

server.listen(PORT, () => {
  console.log(`[TeacherCheck] Production server running on http://localhost:${PORT}`);
  console.log(`[TeacherCheck] Serving static assets from: ${DIST_DIR}`);
  console.log(`[TeacherCheck] Environment: ${process.env.NODE_ENV || 'production'}`);
});

export default server;
