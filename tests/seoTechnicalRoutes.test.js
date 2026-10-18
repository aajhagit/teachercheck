import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHttpRequest, buildRouteHtml, ROUTE_METADATA } from '../server/prodServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function createMockReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };

  process.nextTick(() => {
    if (body) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });

  return req;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    end(data) {
      if (data) {
        if (Buffer.isBuffer(data)) {
          this.body += data.toString('utf8');
        } else {
          this.body += data;
        }
      }
      this.ended = true;
      if (this._onEnd) this._onEnd();
    },
    waitForEnd() {
      if (this.ended) return Promise.resolve();
      return new Promise((resolve) => {
        this._onEnd = resolve;
      });
    }
  };
  return res;
}

describe('SEO Technical Routes & Canonical Verification', () => {

  test('GET / returns HTTP 200 with homepage canonical and visible landing container', async () => {
    const req = createMockReq({ method: 'GET', url: '/' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, 'Homepage must not have noindex tag');

    // Title & Meta Description
    assert.match(res.body, /<title>TeacherCheck — Free AI Grammar Checker That Keeps Your Voice<\/title>/);
    assert.match(res.body, /<meta name="description" content="Fix English grammar mistakes without rewriting your personality. TeacherCheck helps correct genuine errors while keeping your words and writing style yours.">/);
    // Canonical
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/">/);
    // Meta robots
    assert.match(res.body, /<meta name="robots" content="index, follow">/);
    // Containers
    assert.match(res.body, /id="landingView" class="landing-container"/);
    assert.match(res.body, /id="privacyView" class="legal-container hidden"/);
    assert.match(res.body, /id="termsView" class="legal-container hidden"/);
    assert.match(res.body, /id="appView" class="app-container hidden"/);

    // Heading Semantics: exactly 1 H1 on homepage; hidden legal headings are H2
    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, 'Homepage initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /Free AI Grammar Checker/);
    assert.match(res.body, /<h2\s+class="legal-title"\s+id="privacyHeading">Privacy Policy<\/h2>/);
    assert.match(res.body, /<h2\s+class="legal-title"\s+id="termsHeading">Terms of Service<\/h2>/);
  });

  test('GET /privacy returns HTTP 200 with /privacy canonical and visible privacy container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/privacy' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/privacy must not have noindex tag');

    // Title
    assert.match(res.body, /<title>Privacy Policy — TeacherCheck<\/title>/);
    // Canonical
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/privacy">/);
    // Meta robots
    assert.match(res.body, /<meta name="robots" content="index, follow">/);
    // Privacy content is visibly rendered in initial HTML
    assert.match(res.body, /id="privacyView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="privacyView" class="legal-container hidden"/);
    // Landing container is hidden
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    // Privacy copy content is present
    assert.match(res.body, /This Privacy Policy describes how we handle text/);

    // Heading Semantics: exactly 1 H1 on /privacy (Privacy Policy); landing heading demoted to H2
    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/privacy initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /Privacy Policy/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /terms returns HTTP 200 with /terms canonical and visible terms container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/terms' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/terms must not have noindex tag');

    // Title
    assert.match(res.body, /<title>Terms of Service — TeacherCheck<\/title>/);
    // Canonical
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/terms">/);
    // Meta robots
    assert.match(res.body, /<meta name="robots" content="index, follow">/);
    // Terms content is visibly rendered in initial HTML
    assert.match(res.body, /id="termsView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="termsView" class="legal-container hidden"/);
    // Landing container is hidden
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    // Terms copy content is present
    assert.match(res.body, /TeacherCheck is an interactive English grammar checking application/);

    // Heading Semantics: exactly 1 H1 on /terms (Terms of Service); landing heading demoted to H2
    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/terms initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /Terms of Service/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /app returns HTTP 200, X-Robots-Tag: noindex, nofollow, and visible app container', async () => {
    const req = createMockReq({ method: 'GET', url: '/app' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow', '/app must return X-Robots-Tag: noindex, nofollow');

    // Title & Canonical
    assert.match(res.body, /<title>TeacherCheck — Red Pen Grammar Correction<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/app">/);
    assert.match(res.body, /<meta name="robots" content="noindex, nofollow">/);

    // App view is visible, landing view is hidden
    assert.match(res.body, /id="appView" class="app-container"/);
    assert.doesNotMatch(res.body, /id="appView" class="app-container hidden"/);
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);

    // Heading Semantics: exactly 1 H1 on /app (TeacherCheck); landing heading demoted to H2
    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/app initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /TeacherCheck/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /app/ with trailing slash also returns X-Robots-Tag: noindex, nofollow', async () => {
    const req = createMockReq({ method: 'GET', url: '/app/' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  });

  test('GET /for-students returns HTTP 200 with /for-students canonical and visible forStudents container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/for-students' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/for-students must not have noindex tag');

    assert.match(res.body, /<title>English Grammar Checker for Students — Fix Errors, Keep Your Voice \| TeacherCheck<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/for-students">/);
    assert.match(res.body, /<meta name="robots" content="index, follow">/);

    assert.match(res.body, /id="forStudentsView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="forStudentsView" class="legal-container hidden"/);
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    assert.match(res.body, /Loss of Personal Academic Voice/);

    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/for-students initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /English Grammar Checker for Students/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /for-ielts-writing returns HTTP 200 with /for-ielts-writing canonical and visible forIelts container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/for-ielts-writing' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/for-ielts-writing must not have noindex tag');

    assert.match(res.body, /<title>IELTS Writing Grammar Check — Teacher-Style Correction \| TeacherCheck<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/for-ielts-writing">/);
    assert.match(res.body, /<meta name="robots" content="index, follow">/);

    assert.match(res.body, /id="forIeltsView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="forIeltsView" class="legal-container hidden"/);
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    assert.match(res.body, /Band 6 vs Band 7 Grammar Threshold/);

    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/for-ielts-writing initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /IELTS Writing Grammar Checker/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /vs-ai-rewriters returns HTTP 200 with /vs-ai-rewriters canonical and visible vsAiRewriters container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/vs-ai-rewriters' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/vs-ai-rewriters must not have noindex tag');

    assert.match(res.body, /<title>Why AI Rewriters Ruin Your Writing Style \(And What to Use Instead\) \| TeacherCheck<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/vs-ai-rewriters">/);
    assert.match(res.body, /<meta name="robots" content="index, follow">/);

    assert.match(res.body, /id="vsAiRewritersView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="vsAiRewritersView" class="legal-container hidden"/);
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    assert.match(res.body, /Why Fixing Grammar Is Better Than Paraphrasing/);

    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/vs-ai-rewriters initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /TeacherCheck vs\. AI Rewriters/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /grammar/its-vs-its returns HTTP 200 with canonical and visible itsVsIts container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/grammar/its-vs-its' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/grammar/its-vs-its must not have noindex tag');

    assert.match(res.body, /<title>It's vs Its: Rules, Easy Memory Tricks & Examples \| TeacherCheck Grammar Guide<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/grammar\/its-vs-its">/);
    assert.match(res.body, /<meta name="robots" content="index, follow">/);

    assert.match(res.body, /id="itsVsItsView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="itsVsItsView" class="legal-container hidden"/);
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    assert.match(res.body, /The 5-Second Rule to Never Confuse Them Again/);

    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/grammar/its-vs-its initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /It's vs\. Its/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('GET /grammar/affect-vs-effect returns HTTP 200 with canonical and visible affectVsEffect container in initial HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/grammar/affect-vs-effect' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], undefined, '/grammar/affect-vs-effect must not have noindex tag');

    assert.match(res.body, /<title>Affect vs Effect: Grammar Rules, The RAVEN Trick & Examples \| TeacherCheck<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/teachercheckai\.com\/grammar\/affect-vs-effect">/);
    assert.match(res.body, /<meta name="robots" content="index, follow">/);

    assert.match(res.body, /id="affectVsEffectView" class="legal-container"/);
    assert.doesNotMatch(res.body, /id="affectVsEffectView" class="legal-container hidden"/);
    assert.match(res.body, /id="landingView" class="landing-container hidden"/);
    assert.match(res.body, /The RAVEN mnemonic/);

    const h1Matches = res.body.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
    assert.equal(h1Matches.length, 1, '/grammar/affect-vs-effect initial HTML must contain exactly one H1');
    assert.match(h1Matches[0], /Affect vs\. Effect/);
    assert.doesNotMatch(res.body, /<h1[^>]*id="landingHeroHeading"/);
  });

  test('HEAD requests for public pages return status 200 with headers and empty body', async () => {
    const req = createMockReq({ method: 'HEAD', url: '/privacy' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(Number(res.headers['content-length']) > 0);
    assert.equal(res.body, '');
  });
});

describe('API Route Isolation & 404 JSON Enforcement', () => {

  test('GET /api returns HTTP 404 with JSON and not SPA HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/api' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Endpoint not found');
  });

  test('GET /api/ returns HTTP 404 with JSON and not SPA HTML', async () => {
    const req = createMockReq({ method: 'GET', url: '/api/' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Endpoint not found');
  });

  test('GET /api/unknown-endpoint returns HTTP 404 with JSON', async () => {
    const req = createMockReq({ method: 'GET', url: '/api/unknown-endpoint' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Endpoint not found');
  });

  test('POST /api/unknown-endpoint returns HTTP 404 with JSON', async () => {
    const req = createMockReq({ method: 'POST', url: '/api/unknown-endpoint', body: { foo: 'bar' } });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = JSON.parse(res.body);
    assert.equal(data.error, 'Endpoint not found');
  });

  test('GET /api/quota remains functional and handled by API handler', async () => {
    const req = createMockReq({ method: 'GET', url: '/api/quota' });
    const res = createMockRes();

    handleHttpRequest(req, res);
    await res.waitForEnd();

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const data = JSON.parse(res.body);
    assert.equal(typeof data.remaining, 'number');
    assert.equal(typeof data.limit, 'number');
  });
});

describe('Sitemap & Robots.txt Integrity', () => {

  test('public/sitemap.xml lists only canonical public pages and excludes /app and /api', () => {
    const sitemapPath = path.join(ROOT_DIR, 'public', 'sitemap.xml');
    const sitemapContent = fs.readFileSync(sitemapPath, 'utf8');

    // Must contain canonical public pages
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/privacy<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/terms<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/for-students<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/for-ielts-writing<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/vs-ai-rewriters<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/grammar\/its-vs-its<\/loc>/);
    assert.match(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/grammar\/affect-vs-effect<\/loc>/);

    // Must NOT contain /app
    assert.doesNotMatch(sitemapContent, /<loc>https:\/\/teachercheckai\.com\/app<\/loc>/);

    // Must NOT contain any /api routes
    assert.doesNotMatch(sitemapContent, /\/api/);

    // All URLs must use HTTPS on production domain
    const locMatches = sitemapContent.match(/<loc>(.*?)<\/loc>/g) || [];
    assert.equal(locMatches.length, 8, 'Sitemap should contain exactly 8 public canonical URLs');
    for (const m of locMatches) {
      assert.ok(m.startsWith('<loc>https://teachercheckai.com/'), `URL must be HTTPS on teachercheckai.com: ${m}`);
    }
  });

  test('public/robots.txt contains correct sitemap and API disallow without blocking public pages', () => {
    const robotsPath = path.join(ROOT_DIR, 'public', 'robots.txt');
    const robotsContent = fs.readFileSync(robotsPath, 'utf8');

    assert.match(robotsContent, /User-agent:\s*\*/i);
    assert.match(robotsContent, /Allow:\s*\//i);
    assert.match(robotsContent, /Disallow:\s*\/api\//i);
    assert.match(robotsContent, /Sitemap:\s*https:\/\/teachercheckai\.com\/sitemap\.xml/i);

    // Must NOT disallow /app (Google needs to crawl /app to see noindex)
    assert.doesNotMatch(robotsContent, /Disallow:\s*\/app/i);
    // Must NOT disallow /privacy or /terms
    assert.doesNotMatch(robotsContent, /Disallow:\s*\/privacy/i);
    assert.doesNotMatch(robotsContent, /Disallow:\s*\/terms/i);
  });
});
