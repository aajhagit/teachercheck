import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRetryDelay,
  cancellableSleep,
  classifyGeminiError,
  classifyGroqError,
  callGeminiAPI,
  callGroqAPI,
  checkGeminiHealth,
  checkEnglishWithAI,
  handleAIFailure,
  DEFAULT_RETRY_DELAYS
} from '../server/aiService.js';

// Helper to create mock responses
function createMockResponse(status, bodyObj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj)
  };
}

const SAMPLE_SUCCESS_BODY = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              corrections: [
                {
                  original: "don't",
                  startIndex: 4,
                  endIndex: 9,
                  corrected: "doesn't",
                  explanation: "With 'she', use 'doesn't' instead of 'don't'."
                },
                {
                  original: "knows",
                  startIndex: 10,
                  endIndex: 15,
                  corrected: "know",
                  explanation: "After 'doesn't', use the base verb 'know'."
                }
              ],
              teacherNote: "With 'she', use 'doesn't'. After 'doesn't', use base verb 'know'.",
              positiveNote: "Good effort — 2 small corrections."
            })
          }
        ]
      }
    }
  ]
};

const SAMPLE_503_BODY = {
  error: {
    code: 503,
    message: "This model is currently experiencing high demand. Spikes in demand are usually temporary.",
    status: "UNAVAILABLE"
  }
};

const SAMPLE_429_BODY = {
  error: {
    code: 429,
    message: "Resource has been exhausted (e.g. check quota).",
    status: "RESOURCE_EXHAUSTED"
  }
};

const SAMPLE_401_BODY = {
  error: {
    code: 401,
    message: "API key not valid. Please pass a valid API key.",
    status: "UNAUTHENTICATED"
  }
};

const SAMPLE_403_BODY = {
  error: {
    code: 403,
    message: "The caller does not have permission",
    status: "PERMISSION_DENIED"
  }
};

const SAMPLE_400_BODY = {
  error: {
    code: 400,
    message: "Request contains an invalid argument.",
    status: "INVALID_ARGUMENT"
  }
};

describe('1. Backoff and Jitter Calculation', () => {
  it('returns default base delays when jitter is disabled', () => {
    assert.equal(calculateRetryDelay(0, { jitter: false }), DEFAULT_RETRY_DELAYS[0]);
    assert.equal(calculateRetryDelay(1, { jitter: false }), DEFAULT_RETRY_DELAYS[1]);
    assert.equal(calculateRetryDelay(2, { jitter: false }), DEFAULT_RETRY_DELAYS[2]);
    // Caps at the last defined delay if index exceeds array length
    assert.equal(calculateRetryDelay(5, { jitter: false }), DEFAULT_RETRY_DELAYS[2]);
  });

  it('applies bounded jitter within +/- 15% range', () => {
    for (let i = 0; i < 20; i++) {
      const delay0 = calculateRetryDelay(0);
      assert.ok(delay0 >= 1700 && delay0 <= 2300, `Delay ${delay0} out of +/-15% bounds for 2000`);

      const delay1 = calculateRetryDelay(1);
      assert.ok(delay1 >= 4250 && delay1 <= 5750, `Delay ${delay1} out of +/-15% bounds for 5000`);

      const delay2 = calculateRetryDelay(2);
      assert.ok(delay2 >= 8500 && delay2 <= 11500, `Delay ${delay2} out of +/-15% bounds for 10000`);
    }
  });

  it('supports custom test retry delays', () => {
    const testDelays = [10, 20, 30];
    assert.equal(calculateRetryDelay(0, { retryDelays: testDelays, jitter: false }), 10);
    assert.equal(calculateRetryDelay(1, { retryDelays: testDelays, jitter: false }), 20);
    assert.equal(calculateRetryDelay(2, { retryDelays: testDelays, jitter: false }), 30);
  });
});

describe('2. Cancellable Sleep and Timer Cleanup', () => {
  it('resolves after the specified duration', async () => {
    const start = Date.now();
    await cancellableSleep(20);
    assert.ok(Date.now() - start >= 15);
  });

  it('aborts immediately and cleans up timer if signal aborts while sleeping', async () => {
    const controller = new AbortController();
    const sleepPromise = cancellableSleep(5000, controller.signal);

    setTimeout(() => {
      controller.abort(new Error("Test abort"));
    }, 20);

    await assert.rejects(sleepPromise, /Test abort/);
  });

  it('rejects immediately if signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already aborted"));
    await assert.rejects(cancellableSleep(1000, controller.signal), /Already aborted/);
  });
});

describe('3. Error Classification', () => {
  it('classifies 503 / UNAVAILABLE as transient and retryable', () => {
    const c1 = classifyGeminiError({ status: 503, providerStatus: 'UNAVAILABLE', message: 'high demand' });
    assert.equal(c1.isTransient, true);
    assert.equal(c1.shouldRetry, true);
    assert.equal(c1.shouldTryNextModel, true);
    assert.equal(c1.category, 'PROVIDER_UNAVAILABLE_503');

    // Message match without provider status
    const c2 = classifyGeminiError({ status: 503, message: 'This model is currently experiencing high demand.' });
    assert.equal(c2.shouldRetry, true);
    assert.equal(c2.category, 'PROVIDER_UNAVAILABLE_503');
  });

  it('classifies 500, 502, 504 as transient provider errors', () => {
    for (const status of [500, 502, 504]) {
      const c = classifyGeminiError({ status });
      assert.equal(c.isTransient, true);
      assert.equal(c.shouldRetry, true);
      assert.equal(c.shouldTryNextModel, true);
    }
  });

  it('classifies network timeouts and fetch failures as transient', () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    const c1 = classifyGeminiError({ err: timeoutErr });
    assert.equal(c1.isTransient, true);
    assert.equal(c1.shouldRetry, true);
    assert.equal(c1.category, 'TIMEOUT_ERROR');

    const connReset = new Error("reset");
    connReset.code = "ECONNRESET";
    const c2 = classifyGeminiError({ err: connReset });
    assert.equal(c2.isTransient, true);
    assert.equal(c2.shouldRetry, true);
    assert.equal(c2.category, 'NETWORK_ERROR');
  });

  it('classifies 400 as non-retryable permanent error', () => {
    const c = classifyGeminiError({ status: 400, providerStatus: 'INVALID_ARGUMENT' });
    assert.equal(c.isTransient, false);
    assert.equal(c.shouldRetry, false);
    assert.equal(c.shouldTryNextModel, false);
    assert.equal(c.category, 'INVALID_REQUEST_400');
  });

  it('classifies 401 and 403 as non-retryable authentication errors', () => {
    const c401 = classifyGeminiError({ status: 401, providerStatus: 'UNAUTHENTICATED' });
    assert.equal(c401.shouldRetry, false);
    assert.equal(c401.shouldTryNextModel, false);

    const c403 = classifyGeminiError({ status: 403, providerStatus: 'PERMISSION_DENIED' });
    assert.equal(c403.shouldRetry, false);
    assert.equal(c403.shouldTryNextModel, false);
  });

  it('classifies 429 as non-retryable on same model, but allows next candidate model', () => {
    const c = classifyGeminiError({ status: 429, providerStatus: 'RESOURCE_EXHAUSTED' });
    assert.equal(c.isTransient, false);
    assert.equal(c.shouldRetry, false);
    assert.equal(c.shouldTryNextModel, true);
    assert.equal(c.category, 'RATE_LIMIT_429');
  });
});

describe('4. Core Scenarios A-H', () => {
  // A. Gemini 503 -> retry -> eventual success
  it('Scenario A: Gemini 503 -> retry -> eventual success', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount < 3) {
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      return createMockResponse(200, SAMPLE_SUCCESS_BODY);
    };

    const result = await callGeminiAPI("She don't knows the answer.", "fake-key", {
      fetch: mockFetch,
      retryDelays: [5, 10, 15],
      jitter: false,
      candidateModels: ['gemini-test-model']
    });

    assert.equal(callCount, 3, "Should have retried twice and succeeded on the 3rd attempt");
    assert.equal(result.hasCorrections, true);
    assert.equal(result.corrections.length, 2);
    assert.equal(result.corrections[0].original, "don't");
    assert.equal(result.corrections[0].corrected, "doesn't");
  });

  // B. Gemini 503 -> all retries fail -> next model/fallback
  it('Scenario B1: Gemini 503 on Model 1 -> all retries fail -> Model 2 succeeds', async () => {
    const modelCalls = {};
    const mockFetch = async (url) => {
      const match = url.match(/models\/([^:]+):generateContent/);
      const model = match ? match[1] : 'unknown';
      modelCalls[model] = (modelCalls[model] || 0) + 1;

      if (model === 'model-1') {
        // Fail all retries on model 1 with 503
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      // Model 2 succeeds
      return createMockResponse(200, SAMPLE_SUCCESS_BODY);
    };

    const result = await callGeminiAPI("She don't knows the answer.", "fake-key", {
      fetch: mockFetch,
      retryDelays: [5, 10, 15],
      jitter: false,
      maxRetries: 2, // 1 initial + 2 retries = 3 calls on model-1
      candidateModels: ['model-1', 'model-2']
    });

    assert.equal(modelCalls['model-1'], 3, "Model 1 should have been tried 3 times (1 initial + 2 retries)");
    assert.equal(modelCalls['model-2'], 1, "Model 2 should have been called and succeeded");
    assert.equal(result.hasCorrections, true);
  });

  it('Scenario B2: Gemini 503 on all models -> all retries fail -> throws last error', async () => {
    let totalCalls = 0;
    const mockFetch = async () => {
      totalCalls++;
      return createMockResponse(503, SAMPLE_503_BODY);
    };

    await assert.rejects(
      callGeminiAPI("She don't knows the answer.", "fake-key", {
        fetch: mockFetch,
        retryDelays: [5, 10],
        jitter: false,
        maxRetries: 1, // 2 calls per model
        candidateModels: ['model-1', 'model-2']
      }),
      /Provider HTTP 503/
    );

    assert.equal(totalCalls, 4, "Should have tried 2 calls per model across 2 candidate models");
  });

  // C. Gemini 401/403 -> no retry
  it('Scenario C: Gemini 401/403 -> no retry, immediately throws without calling other models', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return createMockResponse(401, SAMPLE_401_BODY);
    };

    await assert.rejects(
      callGeminiAPI("She don't knows the answer.", "bad-key", {
        fetch: mockFetch,
        retryDelays: [5, 10, 15],
        jitter: false,
        candidateModels: ['model-1', 'model-2']
      }),
      /Provider HTTP 401/
    );

    assert.equal(callCount, 1, "Should fail immediately with 0 retries and not call model-2");
  });

  it('Scenario C (403): Gemini 403 -> no retry, immediately throws', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return createMockResponse(403, SAMPLE_403_BODY);
    };

    await assert.rejects(
      callGeminiAPI("She don't knows the answer.", "bad-key", {
        fetch: mockFetch,
        retryDelays: [5, 10, 15],
        jitter: false,
        candidateModels: ['model-1', 'model-2']
      }),
      /Provider HTTP 403/
    );

    assert.equal(callCount, 1, "Should fail immediately with 0 retries");
  });

  // D. Gemini 400 -> no retry
  it('Scenario D: Gemini 400 -> no retry, immediately throws', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return createMockResponse(400, SAMPLE_400_BODY);
    };

    await assert.rejects(
      callGeminiAPI("She don't knows the answer.", "bad-key", {
        fetch: mockFetch,
        retryDelays: [5, 10, 15],
        jitter: false,
        candidateModels: ['model-1', 'model-2']
      }),
      /Provider HTTP 400/
    );

    assert.equal(callCount, 1, "Should fail immediately on 400 with 0 retries");
  });

  // E. Gemini 429 -> preserve existing behavior (no backoff retry on same model, tries next model)
  it('Scenario E: Gemini 429 -> does not retry same model with backoff, moves to next candidate model', async () => {
    const modelCalls = {};
    const mockFetch = async (url) => {
      const match = url.match(/models\/([^:]+):generateContent/);
      const model = match ? match[1] : 'unknown';
      modelCalls[model] = (modelCalls[model] || 0) + 1;

      if (model === 'model-1') {
        return createMockResponse(429, SAMPLE_429_BODY);
      }
      return createMockResponse(200, SAMPLE_SUCCESS_BODY);
    };

    const result = await callGeminiAPI("She don't knows the answer.", "fake-key", {
      fetch: mockFetch,
      retryDelays: [5, 10, 15],
      jitter: false,
      candidateModels: ['model-1', 'model-2']
    });

    assert.equal(modelCalls['model-1'], 1, "Model 1 should NOT be retried on 429");
    assert.equal(modelCalls['model-2'], 1, "Model 2 should be called immediately as next candidate");
    assert.equal(result.hasCorrections, true);
  });

  // F. Live AI unavailable + offline correction exists -> fallback correction
  it('Scenario F: Live AI unavailable + offline correction exists -> fallback correction', async () => {
    // Sentence: "I have did this yesterday." -> offline rules can fix 'did' -> 'done'
    const sentence = "I have did this yesterday.";
    
    // Simulate checkEnglishWithAI when live AI fails completely
    const mockFetch = async () => {
      return createMockResponse(503, SAMPLE_503_BODY);
    };

    const prevKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "dummy-key";
      const result = await checkEnglishWithAI(sentence, {
        fetch: mockFetch,
        retryDelays: [2, 2],
        maxRetries: 1,
        jitter: false,
        candidateModels: ['model-1']
      });

      assert.equal(result.status, 'fallback', "Status must be 'fallback'");
      assert.equal(result.hasCorrections, true);
      assert.ok(result.notice && result.notice.includes('offline rules'));
      assert.equal(result.corrections.length, 1);
      assert.equal(result.corrections[0].original, 'did');
      assert.equal(result.corrections[0].corrected, 'done');
    } finally {
      process.env.GEMINI_API_KEY = prevKey;
    }
  });

  // G. Live AI unavailable + no safe offline correction -> unavailable
  it('Scenario G: Live AI unavailable + no safe offline correction -> unavailable (never claims clean)', async () => {
    // Sentence: "I went to college today." has 0 grammar errors.
    const sentence = "I went to college today.";

    const mockFetch = async () => {
      return createMockResponse(503, SAMPLE_503_BODY);
    };

    const prevKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "dummy-key";
      const result = await checkEnglishWithAI(sentence, {
        fetch: mockFetch,
        retryDelays: [2, 2],
        maxRetries: 1,
        jitter: false,
        candidateModels: ['model-1']
      });

      assert.equal(result.status, 'unavailable', "Status must be 'unavailable'");
      assert.equal(result.hasCorrections, false);
      assert.equal(result.corrections.length, 0);
      assert.ok(result.teacherNote.includes("couldn't complete the full AI check"));
      assert.ok(result.positiveNote.includes("temporarily unavailable"));
      assert.notEqual(result.positiveNote, "Your English looks good.", "Never falsely report good English on failure");
    } finally {
      process.env.GEMINI_API_KEY = prevKey;
    }
  });

  // H. Normal successful Gemini response -> behavior unchanged
  it('Scenario H: Normal successful Gemini response -> behavior unchanged', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return createMockResponse(200, SAMPLE_SUCCESS_BODY);
    };

    const prevKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "dummy-key";
      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        retryDelays: [5, 10, 15],
        jitter: false,
        candidateModels: ['model-1']
      });

      assert.equal(callCount, 1, "Should succeed on 1st attempt with 0 retries");
      assert.equal(result.status, 'live');
      assert.equal(result.hasCorrections, true);
      assert.equal(result.corrections.length, 2);
    } finally {
      process.env.GEMINI_API_KEY = prevKey;
    }
  });
});

describe('5. Safe Diagnostic Logging', () => {
  it('logs retry diagnostics without exposing sensitive keys or user sentences', async () => {
    const logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));

    const sensitiveKey = "AIzaSySecretApiKey123456789";
    const sensitiveSentence = "My super confidential sentence with secret data.";

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount < 2) {
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      return createMockResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ corrections: [], teacherNote: "OK", positiveNote: "Good" }) }]
            }
          }
        ]
      });
    };

    try {
      await callGeminiAPI(sensitiveSentence, sensitiveKey, {
        fetch: mockFetch,
        retryDelays: [5],
        jitter: false,
        candidateModels: ['gemini-flash-test']
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    const allLogsText = logs.join('\n');

    // Diagnostics must include model, status, retry number, category, duration
    assert.ok(allLogsText.includes('gemini-flash-test'), "Must log model");
    assert.ok(allLogsText.includes('503'), "Must log HTTP status 503");
    assert.ok(allLogsText.includes('PROVIDER_UNAVAILABLE_503'), "Must log sanitized error category");
    assert.ok(allLogsText.includes('Retry: 1'), "Must log retry number");
    assert.ok(allLogsText.includes('Total Duration:'), "Must log duration");

    // NEVER log sensitive details
    assert.ok(!allLogsText.includes(sensitiveKey), "Must NEVER log API key");
    assert.ok(!allLogsText.includes(sensitiveSentence), "Must NEVER log user sentence");
  });
});

const SAMPLE_GROQ_SUCCESS_BODY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          corrections: [
            {
              original: "don't",
              startIndex: 4,
              endIndex: 9,
              corrected: "doesn't",
              explanation: "With 'she', use 'doesn't' instead of 'don't'."
            },
            {
              original: "knows",
              startIndex: 10,
              endIndex: 15,
              corrected: "know",
              explanation: "After 'doesn't', use the base verb 'know'."
            }
          ],
          teacherNote: "With 'she', use 'doesn't'. After 'doesn't', use base verb 'know'.",
          positiveNote: "Good effort — 2 small corrections."
        })
      }
    }
  ]
};

describe('6. Secondary Provider: Groq', () => {
  // A. Gemini succeeds → Groq is NOT called.
  it('Scenario A: Gemini succeeds -> Groq is NOT called', async () => {
    let geminiCalled = false;
    let groqCalled = false;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        geminiCalled = true;
        return createMockResponse(200, SAMPLE_SUCCESS_BODY);
      }
      if (url.includes('groq.com')) {
        groqCalled = true;
        return createMockResponse(200, SAMPLE_GROQ_SUCCESS_BODY);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        retryDelays: [2],
        maxRetries: 1,
        candidateModels: ['gemini-flash-1']
      });

      assert.equal(result.status, 'live');
      assert.equal(geminiCalled, true, "Gemini must be called");
      assert.equal(groqCalled, false, "Groq must NOT be called when Gemini succeeds");
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  // B. Gemini fails → Groq succeeds.
  it('Scenario B: Gemini fails -> Groq succeeds', async () => {
    let geminiCallCount = 0;
    let groqCallCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        geminiCallCount++;
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      if (url.includes('groq.com')) {
        groqCallCount++;
        return createMockResponse(200, SAMPLE_GROQ_SUCCESS_BODY);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        retryDelays: [2],
        maxRetries: 1,
        candidateModels: ['gemini-flash-1']
      });

      assert.equal(result.status, 'live', "Result status should be 'live' from Groq");
      assert.ok(geminiCallCount > 0, "Gemini must have been attempted");
      assert.equal(groqCallCount, 1, "Groq must have been called exactly once as secondary fallback");
      assert.equal(result.hasCorrections, true);
      assert.equal(result.corrections.length, 2);
      assert.equal(result.corrections[0].corrected, "doesn't");
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  it('Scenario B3: Gemini 503 with multiple candidate models hands off to Groq after 1 short retry without exhausting all candidate models', async () => {
    const modelCalls = {};
    let groqCallCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        const match = url.match(/models\/([^:]+):generateContent/);
        const model = match ? match[1] : 'unknown';
        modelCalls[model] = (modelCalls[model] || 0) + 1;
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      if (url.includes('groq.com')) {
        groqCallCount++;
        return createMockResponse(200, SAMPLE_GROQ_SUCCESS_BODY);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const start = Date.now();
      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        retryDelays: [5], // fast 5ms retry in test
        candidateModels: ['gemini-candidate-1', 'gemini-candidate-2', 'gemini-candidate-3']
      });
      const duration = Date.now() - start;

      assert.equal(result.status, 'live', "Result status should be 'live' from Groq");
      assert.equal(modelCalls['gemini-candidate-1'], 2, "Active Gemini model should be called exactly twice (1 initial + 1 retry)");
      assert.equal(modelCalls['gemini-candidate-2'], undefined, "Subsequent candidate model 2 must NOT be called when Groq is available");
      assert.equal(modelCalls['gemini-candidate-3'], undefined, "Subsequent candidate model 3 must NOT be called when Groq is available");
      assert.equal(groqCallCount, 1, "Groq should be called immediately as backup");
      assert.ok(duration < 1000, `Handoff should be fast in test, took ${duration}ms`);
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  // B4. Gemini first request times out -> retry delay cannot fit in budget -> immediate Groq
  it('Scenario B4: Gemini timeout with retry delay exceeding remaining budget hands off to Groq without calling candidate model #2', async () => {
    const modelCalls = {};
    let groqCallCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        const match = url.match(/models\/([^:]+):generateContent/);
        const model = match ? match[1] : 'unknown';
        modelCalls[model] = (modelCalls[model] || 0) + 1;
        const timeoutErr = new Error("The operation was aborted due to timeout");
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      }
      if (url.includes('groq.com')) {
        groqCallCount++;
        return createMockResponse(200, SAMPLE_GROQ_SUCCESS_BODY);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const start = Date.now();
      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        maxExecutionTimeMs: 100, // tight 100ms budget
        retryDelays: [250],      // 250ms retry delay exceeds 100ms budget
        jitter: false,
        candidateModels: ['gemini-candidate-1', 'gemini-candidate-2', 'gemini-candidate-3']
      });
      const duration = Date.now() - start;

      assert.equal(result.status, 'live', "Result status should be 'live' from Groq");
      assert.equal(modelCalls['gemini-candidate-1'], 1, "Active Gemini model should only be attempted once because retry delay exceeds budget");
      assert.equal(modelCalls['gemini-candidate-2'], undefined, "Subsequent candidate model 2 must NOT be called when Groq is available");
      assert.equal(modelCalls['gemini-candidate-3'], undefined, "Subsequent candidate model 3 must NOT be called when Groq is available");
      assert.equal(groqCallCount, 1, "Groq should be called immediately as backup");
      assert.ok(duration < 1000, `Handoff should be fast in test, took ${duration}ms`);
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  // B5. Gemini 503 -> retry delay cannot fit in budget -> immediate Groq
  it('Scenario B5: Gemini 503 with retry delay exceeding remaining budget hands off to Groq without calling candidate model #2', async () => {
    const modelCalls = {};
    let groqCallCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        const match = url.match(/models\/([^:]+):generateContent/);
        const model = match ? match[1] : 'unknown';
        modelCalls[model] = (modelCalls[model] || 0) + 1;
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      if (url.includes('groq.com')) {
        groqCallCount++;
        return createMockResponse(200, SAMPLE_GROQ_SUCCESS_BODY);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const start = Date.now();
      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        maxExecutionTimeMs: 100, // tight 100ms budget
        retryDelays: [250],      // 250ms retry delay exceeds 100ms budget
        jitter: false,
        candidateModels: ['gemini-candidate-1', 'gemini-candidate-2', 'gemini-candidate-3']
      });
      const duration = Date.now() - start;

      assert.equal(result.status, 'live', "Result status should be 'live' from Groq");
      assert.equal(modelCalls['gemini-candidate-1'], 1, "Active Gemini model should only be attempted once because retry delay exceeds budget");
      assert.equal(modelCalls['gemini-candidate-2'], undefined, "Subsequent candidate model 2 must NOT be called when Groq is available");
      assert.equal(groqCallCount, 1, "Groq should be called immediately as backup");
      assert.ok(duration < 1000, `Handoff should be fast in test, took ${duration}ms`);
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  // B6. Gemini retry happens on transient timeout but retry also fails -> immediate Groq
  it('Scenario B6: Gemini retry happens on timeout but retry also fails -> hands off to Groq without calling candidate model #2', async () => {
    const modelCalls = {};
    let groqCallCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        const match = url.match(/models\/([^:]+):generateContent/);
        const model = match ? match[1] : 'unknown';
        modelCalls[model] = (modelCalls[model] || 0) + 1;
        const timeoutErr = new Error("The operation was aborted due to timeout");
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      }
      if (url.includes('groq.com')) {
        groqCallCount++;
        return createMockResponse(200, SAMPLE_GROQ_SUCCESS_BODY);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const start = Date.now();
      const result = await checkEnglishWithAI("She don't knows the answer.", {
        fetch: mockFetch,
        retryDelays: [5], // fits in budget
        jitter: false,
        candidateModels: ['gemini-candidate-1', 'gemini-candidate-2', 'gemini-candidate-3']
      });
      const duration = Date.now() - start;

      assert.equal(result.status, 'live', "Result status should be 'live' from Groq");
      assert.equal(modelCalls['gemini-candidate-1'], 2, "Active Gemini model should be retried once");
      assert.equal(modelCalls['gemini-candidate-2'], undefined, "Subsequent candidate model 2 must NOT be called when Groq is available");
      assert.equal(groqCallCount, 1, "Groq should be called immediately as backup");
      assert.ok(duration < 1000, `Handoff should be fast in test, took ${duration}ms`);
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  // C. Gemini fails → Groq fails → existing fallback/unavailable.
  it('Scenario C1: Gemini fails -> Groq fails -> offline fallback correction if offline error exists', async () => {
    const sentence = "I have did this yesterday.";
    let groqCallCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      if (url.includes('groq.com')) {
        groqCallCount++;
        return createMockResponse(500, { error: { message: "Internal server error" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const result = await checkEnglishWithAI(sentence, {
        fetch: mockFetch,
        retryDelays: [2],
        maxRetries: 1,
        candidateModels: ['gemini-flash-1']
      });

      assert.equal(groqCallCount, 1, "Groq should be attempted");
      assert.equal(result.status, 'fallback', "Should fall back to offline grammar rules");
      assert.equal(result.hasCorrections, true);
      assert.equal(result.corrections[0].original, 'did');
      assert.equal(result.corrections[0].corrected, 'done');
      assert.ok(result.notice && result.notice.includes('offline rules'));
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  it('Scenario C2: Gemini fails -> Groq fails -> unavailable for clean sentence (never claims clean)', async () => {
    const sentence = "I went to college today.";

    const mockFetch = async (url) => {
      if (url.includes('googleapis.com')) {
        return createMockResponse(503, SAMPLE_503_BODY);
      }
      if (url.includes('groq.com')) {
        return createMockResponse(429, { error: { message: "Rate limit reached" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGroq = process.env.GROQ_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.GROQ_API_KEY = "test-groq-key";

      const result = await checkEnglishWithAI(sentence, {
        fetch: mockFetch,
        retryDelays: [2],
        maxRetries: 1,
        candidateModels: ['gemini-flash-1']
      });

      assert.equal(result.status, 'unavailable', "Should return unavailable status");
      assert.equal(result.hasCorrections, false);
      assert.equal(result.corrections.length, 0);
      assert.ok(result.teacherNote.includes("couldn't complete the full AI check"));
      assert.notEqual(result.positiveNote, "Your English looks good.", "Never falsely claim good English");
    } finally {
      process.env.GEMINI_API_KEY = prevGemini;
      process.env.GROQ_API_KEY = prevGroq;
    }
  });

  // D. Groq response is normalized correctly.
  it('Scenario D: Groq response is normalized correctly with exact indices and markdown stripping', async () => {
    const rawWrappedJson = "```json\n" + JSON.stringify({
      corrections: [
        {
          original: "don't",
          startIndex: 4,
          endIndex: 9,
          corrected: "doesn't",
          explanation: "With 'she', use 'doesn't'."
        },
        {
          original: "knows",
          startIndex: 10,
          endIndex: 15,
          corrected: "know",
          explanation: "After 'doesn't', use base verb 'know'."
        }
      ],
      teacherNote: "Use doesn't with she.",
      positiveNote: "Good effort — 2 small corrections."
    }) + "\n```";

    const mockFetch = async () => {
      return createMockResponse(200, {
        choices: [{ message: { content: rawWrappedJson } }]
      });
    };

    const result = await callGroqAPI("She don't knows the answer.", "test-key", {
      fetch: mockFetch
    });

    assert.equal(result.originalText, "She don't knows the answer.");
    assert.equal(result.hasCorrections, true);
    assert.equal(result.corrections.length, 2);
    assert.equal(result.corrections[0].original, "don't");
    assert.equal(result.corrections[0].startIndex, 4);
    assert.equal(result.corrections[0].endIndex, 9);
    assert.equal(result.corrections[0].corrected, "doesn't");
    assert.equal(result.corrections[1].original, "knows");
    assert.equal(result.corrections[1].startIndex, 10);
    assert.equal(result.corrections[1].endIndex, 15);
    assert.equal(result.corrections[1].corrected, "know");
  });

  // E. API keys are never included in logs/responses.
  it('Scenario E: Groq API key is never included in logs or responses on error or success', async () => {
    const logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));

    const secretGroqKey = "gsk_test_super_secret_groq_api_key_12345";
    const sensitiveSentence = "Confidential text for groq security test.";

    const mockFetch = async () => {
      return createMockResponse(401, {
        error: { message: `Invalid API key key=${secretGroqKey}` }
      });
    };

    try {
      await assert.rejects(
        callGroqAPI(sensitiveSentence, secretGroqKey, { fetch: mockFetch }),
        /Groq HTTP 401/
      );
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    const allLogsText = logs.join('\n');

    // Required diagnostics format
    assert.ok(allLogsText.includes('provider=groq'), "Must include provider=groq");
    assert.ok(allLogsText.includes('openai/gpt-oss-120b'), "Must include model");
    assert.ok(allLogsText.includes('HTTP status=401'), "Must include HTTP status");
    assert.ok(allLogsText.includes('error category='), "Must include error category");
    assert.ok(allLogsText.includes('duration='), "Must include duration");

    // NEVER leak secrets
    assert.ok(!allLogsText.includes(secretGroqKey), "Must NEVER log Groq API key");
    assert.ok(!allLogsText.includes('Authorization'), "Must NEVER log Authorization header");
    assert.ok(!allLogsText.includes(sensitiveSentence), "Must NEVER log user sentence");
  });
});

describe('7. Gemini Health Check Diagnostics', () => {
  it('reports safe diagnostic information on successful ping without exposing secrets', async () => {
    const mockApiKey = "AIzaSyTestGeminiKey123456789";
    const mockFetch = async () => {
      return createMockResponse(200, {
        candidates: [{ content: { parts: [{ text: "pong" }] } }]
      });
    };

    const health = await checkGeminiHealth({
      apiKey: mockApiKey,
      model: 'gemini-3-flash-preview',
      fetch: mockFetch
    });

    assert.equal(health.configured, true, "Should report configured: true");
    assert.equal(health.model, 'gemini-3-flash-preview', "Should report configured model");
    assert.equal(health.success, true, "Should report success: true");
    assert.equal(health.httpStatus, 200, "Should report httpStatus: 200");
    assert.equal(health.category, 'OK', "Should report category: OK");
    assert.ok(typeof health.durationMs === 'number', "Should report durationMs");

    // Strictly verify secrets are NEVER exposed in health check result
    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes(mockApiKey), "Must NEVER expose Gemini API key in health check");
    assert.ok(!serialized.includes('Authorization'), "Must NEVER expose Authorization header");
    assert.equal(health.apiKey, undefined, "apiKey property must NOT exist on health result");
  });

  it('reports safe error category on timeout or provider error without exposing secrets', async () => {
    const mockApiKey = "AIzaSyTestGeminiKey123456789";
    const mockFetch = async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };

    const health = await checkGeminiHealth({
      apiKey: mockApiKey,
      model: 'gemini-3.6-flash',
      fetch: mockFetch
    });

    assert.equal(health.configured, true, "Should report configured: true");
    assert.equal(health.model, 'gemini-3.6-flash', "Should report model name");
    assert.equal(health.success, false, "Should report success: false");
    assert.equal(health.category, 'TIMEOUT_ERROR', "Should report category: TIMEOUT_ERROR");
    assert.ok(typeof health.durationMs === 'number', "Should report durationMs");

    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes(mockApiKey), "Must NEVER expose Gemini API key in health check on error");
    assert.equal(health.apiKey, undefined, "apiKey property must NOT exist on health result");
  });

  it('reports configured: false when Gemini API key is missing', async () => {
    const health = await checkGeminiHealth({
      apiKey: '',
      model: 'gemini-3-flash-preview'
    });

    assert.equal(health.configured, false, "Should report configured: false");
    assert.equal(health.success, false, "Should report success: false");
    assert.equal(health.category, 'NOT_CONFIGURED', "Should report category: NOT_CONFIGURED");
  });
});

