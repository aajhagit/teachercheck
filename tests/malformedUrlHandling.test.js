import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { handleHttpRequest } from '../server/prodServer.js';

function createMockReq({ method = 'GET', url = '/', headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };

  process.nextTick(() => {
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

describe('Malformed URL Handling Regression Suite', () => {
  let activeServer = null;

  afterEach(async () => {
    if (activeServer) {
      await new Promise((resolve) => activeServer.close(resolve));
      activeServer = null;
    }
  });

  test('GET /%E0%A4%A returns HTTP 400 Bad Request without crashing', async () => {
    const req = createMockReq({ method: 'GET', url: '/%E0%A4%A' });
    const res = createMockRes();

    assert.doesNotThrow(() => {
      handleHttpRequest(req, res);
    });
    await res.waitForEnd();

    assert.equal(res.statusCode, 400);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    assert.equal(res.body, 'Bad Request');
  });

  test('HEAD /%E0%A4%A returns HTTP 400 Bad Request', async () => {
    const req = createMockReq({ method: 'HEAD', url: '/%E0%A4%A' });
    const res = createMockRes();

    assert.doesNotThrow(() => {
      handleHttpRequest(req, res);
    });
    await res.waitForEnd();

    assert.equal(res.statusCode, 400);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
  });

  test('various malformed percent-encoded paths return HTTP 400 Bad Request', async () => {
    const malformedUrls = [
      '/%',
      '/%2',
      '/%zz',
      '/%E0%A0%',
      '/assets/%E0%A4%A.js'
    ];

    for (const url of malformedUrls) {
      const req = createMockReq({ method: 'GET', url });
      const res = createMockRes();

      assert.doesNotThrow(() => {
        handleHttpRequest(req, res);
      }, `Should not throw on ${url}`);
      await res.waitForEnd();

      assert.equal(res.statusCode, 400, `Expected 400 for ${url}`);
      assert.equal(res.body, 'Bad Request');
    }
  });

  test('live HTTP server returns 400 for malformed URL and remains running for subsequent requests', async () => {
    activeServer = http.createServer(handleHttpRequest);
    await new Promise((resolve) => activeServer.listen(0, '127.0.0.1', resolve));

    const port = activeServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Request 1: Malformed percent-encoded URL (production crash reproduction)
    const malformedRes = await fetch(`${baseUrl}/%E0%A4%A`);
    assert.equal(malformedRes.status, 400);
    const malformedBody = await malformedRes.text();
    assert.equal(malformedBody, 'Bad Request');

    // Request 2: Ensure server is still alive and responds normally to subsequent valid requests
    const healthyRes = await fetch(`${baseUrl}/privacy`);
    assert.equal(healthyRes.status, 200);
    const healthyBody = await healthyRes.text();
    assert.ok(healthyBody.includes('TeacherCheck'));
    assert.ok(healthyBody.includes('Privacy Policy'));
  });
});
