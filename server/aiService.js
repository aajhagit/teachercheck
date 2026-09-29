import 'dotenv/config';

/**
 * AI-powered Grammar & Correction Service for TeacherCheck
 * 
 * PRODUCT PHILOSOPHY:
 * "Your words. Your personality. Just fix the English."
 */

const SYSTEM_PROMPT = `You are TeacherCheck, an expert school teacher correcting a student's notebook with a red pen.

PRODUCT PHILOSOPHY:
"Your words. Your personality. Just fix the English."

CORE RULES:
1. You are NOT an AI rewriting tool. NEVER rewrite the sentence or polish the student's writing style.
2. The student's personality, slang, informal expressions, contractions, colloquialisms, and emojis MUST BE FULLY PRESERVED.
   - "Bro I finally fixed this shit 😂" -> NO grammatical errors. Return 0 corrections.
   - "I went to college today." -> NO grammatical errors. Return 0 corrections.
3. CRITICAL: Identify ALL genuine, objective English mistakes in the sentence, NOT just the first one.
   If a sentence contains multiple mistakes, you MUST return EVERY mistake as an independent correction item.
   - Example 1: In "She don't knows the answer.", there are TWO independent mistakes:
     * "don't" -> "doesn't"
     * "knows" -> "know"
   - Example 2: In "Yesterday I goes to the market and buyed some vegetables.", there are TWO independent mistakes:
     * "goes" -> "went"
     * "buyed" -> "bought"
   - Example 3: In "I have did this yesterday.", there is ONE mistake:
     * "did" -> "done"
4. For EVERY correction, identify:
   - "original": the exact substring from the input sentence that is incorrect.
   - "startIndex": 0-based character start index in the input sentence.
   - "endIndex": 0-based character end index in the input sentence.
   - "corrected": the minimal replacement word or phrase.
   - "explanation": a concise teacher explanation of the specific grammar rule.
5. Order corrections by their startIndex from left to right.
6. "teacherNote": A friendly teacher explanation covering ALL corrections in the sentence.
   - Example for "She don't knows the answer.": "With 'she', use 'doesn't' instead of 'don't'. After 'doesn't', use the base verb 'know', not 'knows'."
7. "positiveNote":
   - If 0 corrections: "Your English looks good." (and note "Your casual tone is fine." if casual/slang).
   - If 1 correction: "Good sentence — just one correction."
   - If multiple corrections: "Good effort — just a few small corrections." or "Good sentence — 2 corrections." (NEVER say "just one correction" when there are multiple corrections).

OUTPUT STRICT JSON ONLY:
{
  "corrections": [
    {
      "original": "don't",
      "startIndex": 4,
      "endIndex": 9,
      "corrected": "doesn't",
      "explanation": "With 'she', use 'doesn't' instead of 'don't'."
    }
  ],
  "teacherNote": "Overall teacher explanation covering all corrections",
  "positiveNote": "Encouraging remark"
}`;

export const DEFAULT_RETRY_DELAYS = [2000, 5000, 10000];

/**
 * Calculates exponential backoff delay with bounded jitter.
 * Suggested delays:
 * - retry 1: ~2 seconds
 * - retry 2: ~5 seconds
 * - retry 3: ~10 seconds
 */
export function calculateRetryDelay(retryIndex, options = {}) {
  const delays = options.retryDelays || DEFAULT_RETRY_DELAYS;
  const base = delays[retryIndex] ?? delays[delays.length - 1];
  if (options.jitter === false) {
    return base;
  }
  // Bounded jitter: +/- 15% around base (e.g. 2000ms -> 1700ms - 2300ms)
  const jitterRange = 0.15;
  const jitterFactor = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(50, Math.round(base * (1 + jitterFactor)));
}

/**
 * Cancellable sleep that guarantees all timers are cleaned up immediately
 * if an abort signal is fired or when the timeout completes.
 */
export function cancellableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason || new Error("Operation aborted"));
    }

    let timer = null;
    let onAbort = null;

    onAbort = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      reject(signal?.reason || new Error("Operation aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      timer = null;
      resolve();
    }, ms);
  });
}

/**
 * Classifies Gemini provider errors to determine retryability and fallback behavior.
 */
export function classifyGeminiError({ status, providerStatus, message, err }) {
  // 1. Permanent client / authentication errors: never retry, do not try other models
  if (status === 400 || providerStatus === 'INVALID_ARGUMENT') {
    return {
      category: 'INVALID_REQUEST_400',
      isTransient: false,
      shouldRetry: false,
      shouldTryNextModel: false
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    providerStatus === 'UNAUTHENTICATED' ||
    providerStatus === 'PERMISSION_DENIED'
  ) {
    return {
      category: 'AUTHENTICATION_PERMISSION_ERROR',
      isTransient: false,
      shouldRetry: false,
      shouldTryNextModel: false
    };
  }

  // 2. Rate limit / Quota errors (429): preserve existing behavior (switch candidate model immediately, no backoff retry)
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
    return {
      category: 'RATE_LIMIT_429',
      isTransient: false,
      shouldRetry: false,
      shouldTryNextModel: true
    };
  }

  // 3. Model not found (404): try next candidate model without backoff retry
  if (status === 404 || providerStatus === 'NOT_FOUND') {
    return {
      category: 'MODEL_NOT_FOUND_404',
      isTransient: false,
      shouldRetry: false,
      shouldTryNextModel: true
    };
  }

  // 4. Gemini 503 / UNAVAILABLE / high demand spike: transient, retry with backoff
  const is503 =
    status === 503 ||
    providerStatus === 'UNAVAILABLE' ||
    (typeof message === 'string' &&
      /high demand|spikes in demand|temporarily unavailable|unavailable/i.test(message));
  if (is503) {
    return {
      category: 'PROVIDER_UNAVAILABLE_503',
      isTransient: true,
      shouldRetry: true,
      shouldTryNextModel: true
    };
  }

  // 5. Transient provider 500 / 502 / 504 errors: retry with backoff
  if (status === 500 || status === 502 || status === 504 || providerStatus === 'INTERNAL') {
    return {
      category: `PROVIDER_SERVER_ERROR_${status || '5XX'}`,
      isTransient: true,
      shouldRetry: true,
      shouldTryNextModel: true
    };
  }

  // 6. Network timeouts / connection reset / fetch failures: transient, retry with backoff
  if (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return {
        category: 'TIMEOUT_ERROR',
        isTransient: true,
        shouldRetry: true,
        shouldTryNextModel: true
      };
    }
    const isNetwork =
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'EPIPE' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      (err instanceof TypeError &&
        typeof err.message === 'string' &&
        err.message.toLowerCase().includes('fetch failed'));
    if (isNetwork) {
      return {
        category: 'NETWORK_ERROR',
        isTransient: true,
        shouldRetry: true,
        shouldTryNextModel: true
      };
    }
  }

  return {
    category: `UNKNOWN_ERROR_${status || 'OTHER'}`,
    isTransient: false,
    shouldRetry: false,
    shouldTryNextModel: false
  };
}

export async function checkEnglishWithAI(text, options = {}) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const abortController = new AbortController();
  const overallTimeoutMs = options.overallTimeoutMs || 35000;

  let overallTimeoutId;
  const overallTimeoutPromise = new Promise((_, reject) => {
    overallTimeoutId = setTimeout(() => {
      const timeoutErr = new Error("AI check timed out");
      timeoutErr.name = "TimeoutError";
      abortController.abort(timeoutErr);
      reject(timeoutErr);
    }, overallTimeoutMs);
  });

  const performCheck = async () => {
    let lastError = null;
    const hasBackupProvider = options.hasBackupProvider !== undefined
      ? Boolean(options.hasBackupProvider)
      : Boolean(groqKey || openaiKey);

    if (geminiKey) {
      try {
        const result = await callGeminiAPI(text, geminiKey, {
          hasBackupProvider,
          maxRetries: hasBackupProvider ? 1 : 3,
          retryDelays: hasBackupProvider ? [2000] : DEFAULT_RETRY_DELAYS,
          maxExecutionTimeMs: hasBackupProvider ? 8000 : 30000,
          providerTimeoutMs: hasBackupProvider ? 6000 : 30000,
          ...options,
          signal: abortController.signal
        });
        return {
          status: 'live',
          ...result
        };
      } catch (err) {
        lastError = err;
        console.warn(`[TeacherCheck Server] Gemini provider notice: status=${err.status || err.name || 'network'}`);
      }
    }

    if (groqKey) {
      try {
        const result = await callGroqAPI(text, groqKey, {
          ...options,
          signal: abortController.signal
        });
        return {
          status: 'live',
          ...result
        };
      } catch (err) {
        lastError = err;
        console.warn(`[TeacherCheck Server] Groq provider notice: status=${err.status || err.name || 'network'}`);
      }
    }

    if (openaiKey) {
      try {
        const result = await callOpenAIAPI(text, openaiKey, {
          ...options,
          signal: abortController.signal
        });
        return {
          status: 'live',
          ...result
        };
      } catch (err) {
        lastError = err;
        console.warn(`[TeacherCheck Server] OpenAI provider notice: status=${err.status || err.name || 'network'}`);
      }
    }

    // No live provider succeeded: fallback to safe offline rules
    return handleAIFailure(text, lastError || new Error("Offline rule fallback"));
  };

  try {
    return await Promise.race([performCheck(), overallTimeoutPromise]);
  } catch (err) {
    console.warn(`[TeacherCheck Server] Overall check timeout or error: ${err.name || 'Unknown'}`);
    return handleAIFailure(text, err);
  } finally {
    clearTimeout(overallTimeoutId);
  }
}

/**
 * Handles AI failure by checking with safe offline rules.
 * Never claims a sentence is clean if the AI is unavailable and rules find nothing.
 */
export function handleAIFailure(text, err) {
  const fallbackResult = fallbackRuleCheck(text);
  
  if (fallbackResult.hasCorrections) {
    return {
      status: 'fallback',
      notice: 'AI checking is temporarily unavailable. These corrections were found by offline rules.',
      ...fallbackResult
    };
  }

  // If live AI failed and offline rules found 0 errors, DO NOT tell the user their English is good!
  return {
    status: 'unavailable',
    originalText: text,
    hasCorrections: false,
    corrections: [],
    teacherNote: "TeacherCheck couldn't complete the full AI check right now. Please try again in a moment.",
    positiveNote: "AI checking is temporarily unavailable.",
    error: "AI checking is temporarily unavailable. Try again shortly."
  };
}

export async function callGeminiAPI(text, apiKey, options = {}) {
  const envModelPresent = Boolean(process.env.GEMINI_MODEL);
  console.log(`[TeacherCheck Diagnostics] process.env.GEMINI_MODEL present: ${envModelPresent}${envModelPresent ? `, value: ${process.env.GEMINI_MODEL}` : ''}`);

  const hasBackupProvider = Boolean(options.hasBackupProvider);

  // Use configured Gemini model or candidate Flash models.
  // When a backup provider exists, only try the active Gemini model; do not move to other candidate models.
  const allCandidateModels = options.candidateModels || [
    ...new Set([
      process.env.GEMINI_MODEL,
      'gemini-3-flash-preview',
      'gemini-3.5-flash',
      'gemini-3.7-flash'
    ].filter(Boolean))
  ];
  const candidateModels = hasBackupProvider ? [allCandidateModels[0]] : allCandidateModels;

  const maxRetriesPerModel = options.maxRetries ?? (hasBackupProvider ? 1 : 3);
  const retryDelays = options.retryDelays || (hasBackupProvider ? [2000] : DEFAULT_RETRY_DELAYS);
  const maxExecutionTimeMs = options.maxExecutionTimeMs || (hasBackupProvider ? 8000 : 30000);
  const providerTimeoutMs = options.providerTimeoutMs || (hasBackupProvider ? 6000 : 30000);
  const fetchFn = options.geminiFetch || options.fetch || fetch;
  const signal = options.signal;

  const startTime = Date.now();
  let lastError = null;

  for (let modelIndex = 0; modelIndex < candidateModels.length; modelIndex++) {
    const model = candidateModels[modelIndex];
    console.log(`[TeacherCheck Diagnostics] Calling Gemini model: ${model} | Total Duration: ${Date.now() - startTime}ms`);

    let lastHttpStatus = null;
    let lastCategory = null;

    for (let retryCount = 0; retryCount <= maxRetriesPerModel; retryCount++) {
      if (signal?.aborted) {
        throw signal.reason || new Error("Operation aborted");
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= maxExecutionTimeMs) {
        console.warn(
          `[TeacherCheck Diagnostics] Provider time budget reached (${elapsed}ms >= ${maxExecutionTimeMs}ms) | Model: ${model}`
        );
        if (hasBackupProvider) {
          console.log(
            `[TeacherCheck Diagnostics] Fast-failing Gemini to backup provider on time budget reached | Model: ${model} | Total Duration: ${Date.now() - startTime}ms`
          );
          throw lastError || new Error(`Provider time budget reached on ${model}`);
        }
        break;
      }

      if (retryCount > 0) {
        const delayMs = calculateRetryDelay(retryCount - 1, {
          retryDelays,
          jitter: options.jitter
        });

        if (Date.now() - startTime + delayMs >= maxExecutionTimeMs) {
          console.warn(
            `[TeacherCheck Diagnostics] Skipping retry delay exceeding time budget | Model: ${model} | Retry: ${retryCount} | Delay: ${delayMs}ms | Total Duration: ${Date.now() - startTime}ms`
          );
          if (hasBackupProvider) {
            console.log(
              `[TeacherCheck Diagnostics] Fast-failing Gemini to backup provider when retry exceeds time budget | Model: ${model} | Total Duration: ${Date.now() - startTime}ms`
            );
            throw lastError || new Error(`Retry delay exceeds time budget on ${model}`);
          }
          break;
        }

        console.warn(
          `[TeacherCheck Diagnostics] Retry scheduled | Model: ${model} | HTTP Status: ${lastHttpStatus || 'network'} | Retry: ${retryCount}/${maxRetriesPerModel} | Category: ${lastCategory} | Delay: ${delayMs}ms | Total Duration: ${Date.now() - startTime}ms`
        );

        await cancellableSleep(delayMs, signal);

        console.log(
          `[TeacherCheck Diagnostics] Retry attempt | Model: ${model} | Retry: ${retryCount}/${maxRetriesPerModel} | Total Duration: ${Date.now() - startTime}ms`
        );
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const promptText = `${SYSTEM_PROMPT}\n\nStudent's sentence to check:\n"""${text}"""\n\nOutput JSON only:`;
      const payload = {
        contents: [
          {
            parts: [{ text: promptText }]
          }
        ]
      };

      let response;
      try {
        const fetchSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(providerTimeoutMs)])
          : AbortSignal.timeout(providerTimeoutMs);

        response = await fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(payload),
          signal: fetchSignal
        });
      } catch (err) {
        if (signal?.aborted) {
          throw signal.reason || err;
        }

        const classified = classifyGeminiError({ err });
        console.warn(
          `[TeacherCheck Diagnostics] Model: ${model} | HTTP Status: network | Retry: ${retryCount}/${maxRetriesPerModel} | Category: ${classified.category} | Message: ${err.message || 'Network error'} | Total Duration: ${Date.now() - startTime}ms`
        );

        lastError = new Error(`Model ${model} network error: ${err.message}`);
        lastError.status = 'network';
        lastError.category = classified.category;

        if (classified.shouldRetry && retryCount < maxRetriesPerModel) {
          lastHttpStatus = 'network';
          lastCategory = classified.category;
          continue;
        }

        if (hasBackupProvider) {
          console.log(
            `[TeacherCheck Diagnostics] Fast-failing Gemini to backup provider on network error | Model: ${model} | Total Duration: ${Date.now() - startTime}ms`
          );
          throw lastError;
        }

        break;
      }

      if (!response.ok) {
        const status = response.status;
        let providerCode = null;
        let providerStatus = null;
        let sanitizedErrorMessage = 'Unknown error';

        try {
          const errData = await response.json();
          if (errData && errData.error) {
            providerCode = errData.error.code || null;
            providerStatus = errData.error.status || null;
            if (typeof errData.error.message === 'string') {
              sanitizedErrorMessage = errData.error.message
                .split('\n')[0]
                .substring(0, 200)
                .replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
            }
          }
        } catch {
          // Ignore JSON parse failures on error responses
        }

        const classified = classifyGeminiError({
          status,
          providerStatus,
          message: sanitizedErrorMessage
        });

        console.warn(
          `[TeacherCheck Diagnostics] Model: ${model} | HTTP Status: ${status} | Retry: ${retryCount}/${maxRetriesPerModel} | Provider Code/Status: ${providerCode || 'none'}/${providerStatus || 'none'} | Category: ${classified.category} | Message: ${sanitizedErrorMessage} | Total Duration: ${Date.now() - startTime}ms`
        );

        const err = new Error(`Provider HTTP ${status}: ${sanitizedErrorMessage}`);
        err.status = status;
        err.providerStatus = providerStatus;
        err.category = classified.category;
        lastError = err;

        // 1. Permanent error (400, 401, 403, invalid key): immediately throw to stop all attempts
        if (!classified.shouldRetry && !classified.shouldTryNextModel) {
          throw err;
        }

        // 2. Non-retryable on this model (429 rate limit or 404 not found): skip to next candidate model
        if (!classified.shouldRetry && classified.shouldTryNextModel) {
          if (hasBackupProvider) {
            console.log(
              `[TeacherCheck Diagnostics] Fast-failing Gemini to backup provider on ${classified.category} | Model: ${model} | Total Duration: ${Date.now() - startTime}ms`
            );
            throw err;
          }
          break;
        }

        // 3. Transient error (503, 500, 502, 504): retry if retry attempts remain
        if (classified.shouldRetry) {
          if (retryCount < maxRetriesPerModel) {
            lastHttpStatus = status;
            lastCategory = classified.category;
            continue;
          }
          console.warn(
            `[TeacherCheck Diagnostics] All retries exhausted | Model: ${model} | HTTP Status: ${status} | Retries: ${retryCount}/${maxRetriesPerModel} | Category: ${classified.category} | Total Duration: ${Date.now() - startTime}ms`
          );
          if (hasBackupProvider) {
            console.log(
              `[TeacherCheck Diagnostics] Fast-failing Gemini to backup provider on ${classified.category} | Model: ${model} | Total Duration: ${Date.now() - startTime}ms`
            );
            throw err;
          }
          break;
        }

        throw err;
      }

      const data = await response.json();
      const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJson) {
        throw new Error("No response content received from Gemini API");
      }

      // Clean markdown code blocks if model wrapped JSON in ```json ... ```
      let cleanedJson = rawJson.trim();
      if (cleanedJson.startsWith("```json")) {
        cleanedJson = cleanedJson.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleanedJson.startsWith("```")) {
        cleanedJson = cleanedJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }

      const parsed = JSON.parse(cleanedJson);
      return normalizeCorrectionResponse(text, parsed);
    }

    if (hasBackupProvider) {
      console.log(
        `[TeacherCheck Diagnostics] Fast-failing Gemini to backup provider after active model attempt | Model: ${model} | Total Duration: ${Date.now() - startTime}ms`
      );
      throw lastError || new Error(`Gemini active model ${model} failed`);
    }

    if (modelIndex < candidateModels.length - 1) {
      console.log(
        `[TeacherCheck Diagnostics] Moving to next model candidate | Previous: ${model} | Next: ${candidateModels[modelIndex + 1]} | Total Duration: ${Date.now() - startTime}ms`
      );
    }
  }

  throw lastError || new Error("Failed to connect to Gemini API models");
}

/**
 * Non-invasive diagnostic health check for Gemini API.
 * Never exposes secrets, authorization headers, or user sentences.
 * Used for verification, diagnostics, and testing.
 */
export async function checkGeminiHealth(options = {}) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  const model = options.model || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  const fetchFn = options.fetch || fetch;
  const timeoutMs = options.timeoutMs || 6000;

  const isConfigured = Boolean(apiKey);
  if (!isConfigured) {
    return {
      configured: false,
      model,
      success: false,
      httpStatus: null,
      category: 'NOT_CONFIGURED',
      durationMs: 0
    };
  }

  const startTime = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = {
    contents: [
      {
        parts: [{ text: "ping" }]
      }
    ]
  };

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal
    });

    const durationMs = Date.now() - startTime;
    if (response.ok) {
      return {
        configured: true,
        model,
        success: true,
        httpStatus: response.status,
        category: 'OK',
        durationMs
      };
    }

    let providerStatus = null;
    let sanitizedErrorMessage = 'Unknown error';
    try {
      const errData = await response.json();
      if (errData?.error) {
        providerStatus = errData.error.status || null;
        if (typeof errData.error.message === 'string') {
          sanitizedErrorMessage = errData.error.message
            .split('\n')[0]
            .substring(0, 200)
            .replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
        }
      }
    } catch {}

    const classified = classifyGeminiError({
      status: response.status,
      providerStatus,
      message: sanitizedErrorMessage
    });

    return {
      configured: true,
      model,
      success: false,
      httpStatus: response.status,
      providerStatus,
      category: classified.category,
      durationMs
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const classified = classifyGeminiError({ err });
    return {
      configured: true,
      model,
      success: false,
      httpStatus: null,
      category: classified.category,
      durationMs
    };
  }
}

/**
 * Classifies Groq provider errors into clean diagnostic categories.
 */
export function classifyGroqError({ status, message, err }) {
  if (status === 400) {
    return { category: 'BAD_REQUEST_400' };
  }
  if (status === 401 || status === 403) {
    return { category: 'AUTH_PERMISSION_ERROR' };
  }
  if (status === 429) {
    return { category: 'RATE_LIMIT_429' };
  }
  if (status === 503) {
    return { category: 'PROVIDER_UNAVAILABLE_503' };
  }
  if (status >= 500 && status < 600) {
    return { category: `PROVIDER_SERVER_ERROR_${status}` };
  }
  if (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { category: 'TIMEOUT_ERROR' };
    }
    return { category: 'NETWORK_ERROR' };
  }
  return { category: `UNKNOWN_ERROR_${status || 'OTHER'}` };
}

/**
 * Secondary AI provider: Groq (OpenAI-compatible endpoint)
 * Uses model: openai/gpt-oss-120b
 */
export async function callGroqAPI(text, apiKey, options = {}) {
  const model = options.model || process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const url = options.url || process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions";
  const signal = options.signal;
  const timeoutMs = options.groqTimeoutMs || options.providerTimeoutMs || 10000;
  const fetchFn = options.groqFetch || options.fetch || fetch;
  const startTime = Date.now();

  console.log(`[TeacherCheck Diagnostics] Calling Groq model: ${model} | Total Duration: ${Date.now() - startTime}ms`);

  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Student's sentence to check:\n"""${text}"""` }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };

  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: fetchSignal
    });
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason || err;
    }
    const classified = classifyGroqError({ err });
    const duration = Date.now() - startTime;
    console.warn(`[TeacherCheck Diagnostics] provider=groq | model=${model} | HTTP status=network | error category=${classified.category} | duration=${duration}ms`);
    const error = new Error(`Groq network error: ${err.message || 'Fetch failed'}`);
    error.status = 'network';
    error.category = classified.category;
    throw error;
  }

  if (!response.ok) {
    const status = response.status;
    let sanitizedErrorMessage = 'Unknown error';

    try {
      const errData = await response.json();
      if (errData && errData.error && typeof errData.error.message === 'string') {
        sanitizedErrorMessage = errData.error.message
          .split('\n')[0]
          .substring(0, 200)
          .replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
      }
    } catch {
      // Ignore JSON parse error on non-JSON response
    }

    const classified = classifyGroqError({ status, message: sanitizedErrorMessage });
    const duration = Date.now() - startTime;
    console.warn(`[TeacherCheck Diagnostics] provider=groq | model=${model} | HTTP status=${status} | error category=${classified.category} | duration=${duration}ms`);

    const err = new Error(`Groq HTTP ${status}: ${sanitizedErrorMessage}`);
    err.status = status;
    err.category = classified.category;
    throw err;
  }

  const duration = Date.now() - startTime;
  console.log(`[TeacherCheck Diagnostics] provider=groq | model=${model} | HTTP status=200 | duration=${duration}ms`);

  const data = await response.json();
  const rawJson = data.choices?.[0]?.message?.content;
  if (!rawJson) {
    throw new Error("No response content received from Groq API");
  }

  let cleanedJson = rawJson.trim();
  if (cleanedJson.startsWith("```json")) {
    cleanedJson = cleanedJson.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleanedJson.startsWith("```")) {
    cleanedJson = cleanedJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(cleanedJson);
  return normalizeCorrectionResponse(text, parsed);
}

async function callOpenAIAPI(text, apiKey, options = {}) {
  const url = "https://api.openai.com/v1/chat/completions";
  const signal = options.signal;
  const timeoutMs = options.providerTimeoutMs || 10000;
  const fetchFn = options.fetch || fetch;

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Student's sentence to check:\n"""${text}"""` }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };

  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: fetchSignal
  });

  if (!response.ok) {
    const status = response.status;
    const err = new Error(`OpenAI HTTP ${status}`);
    err.status = status;
    throw err;
  }

  const data = await response.json();
  const rawJson = data.choices?.[0]?.message?.content;
  if (!rawJson) {
    throw new Error("No response content from OpenAI");
  }

  const parsed = JSON.parse(rawJson);
  return normalizeCorrectionResponse(text, parsed);
}

/**
 * Validates, locates, and sorts all corrections with accurate character indices
 */
function normalizeCorrectionResponse(originalText, parsed) {
  const rawCorrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
  const normalized = [];

  let searchCursor = 0;

  for (const c of rawCorrections) {
    if (!c.original || !c.corrected) continue;

    let orig = c.original;
    let sIdx = c.startIndex;
    let eIdx = c.endIndex;

    // Check if provided start/end indices exactly match
    let matchFound = false;
    if (typeof sIdx === 'number' && typeof eIdx === 'number' && sIdx >= 0 && eIdx <= originalText.length && sIdx < eIdx) {
      const slice = originalText.substring(sIdx, eIdx);
      if (slice.toLowerCase() === orig.toLowerCase()) {
        orig = slice;
        matchFound = true;
      }
    }

    // If indices missing or mismatched, search in original text after searchCursor
    if (!matchFound) {
      const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reg = new RegExp(`\\b${escaped}\\b`, 'i');
      
      const searchSub = originalText.substring(searchCursor);
      const match = searchSub.match(reg);

      if (match && typeof match.index === 'number') {
        sIdx = searchCursor + match.index;
        eIdx = sIdx + match[0].length;
        orig = originalText.substring(sIdx, eIdx);
        matchFound = true;
      } else {
        // Fallback search from beginning of entire string
        const globalMatch = originalText.match(reg);
        if (globalMatch && typeof globalMatch.index === 'number') {
          sIdx = globalMatch.index;
          eIdx = sIdx + globalMatch[0].length;
          orig = originalText.substring(sIdx, eIdx);
          matchFound = true;
        }
      }
    }

    if (matchFound) {
      // Trim accidental leading/trailing whitespace
      while (orig.startsWith(' ') || orig.startsWith('\t')) {
        orig = orig.substring(1);
        sIdx++;
      }
      while (orig.endsWith(' ') || orig.endsWith('\t')) {
        orig = orig.substring(0, orig.length - 1);
        eIdx--;
      }

      normalized.push({
        original: orig,
        startIndex: sIdx,
        endIndex: eIdx,
        corrected: c.corrected.trim(),
        explanation: c.explanation || ""
      });

      searchCursor = Math.max(searchCursor, eIdx);
    }
  }

  // Sort by startIndex
  normalized.sort((a, b) => a.startIndex - b.startIndex);

  // Filter overlapping ranges (keep the first if conflict)
  const nonOverlapping = [];
  let lastEnd = 0;
  for (const item of normalized) {
    if (item.startIndex >= lastEnd) {
      nonOverlapping.push(item);
      lastEnd = item.endIndex;
    }
  }

  const hasCorrections = nonOverlapping.length > 0;

  // Teacher Note
  let teacherNote = parsed.teacherNote;
  if (!teacherNote || (nonOverlapping.length > 1 && !teacherNote.includes(nonOverlapping[1].corrected))) {
    if (!hasCorrections) {
      teacherNote = "No grammatical errors found. Your phrasing is natural.";
    } else {
      teacherNote = nonOverlapping.map(c => c.explanation).filter(Boolean).join(" ");
    }
  }

  // Positive Note
  let positiveNote = parsed.positiveNote;
  if (!positiveNote || (nonOverlapping.length > 1 && positiveNote.toLowerCase().includes("one correction"))) {
    if (!hasCorrections) {
      const lower = originalText.toLowerCase();
      if (lower.includes("bro") || lower.includes("shit") || lower.includes("gonna")) {
        positiveNote = "Your casual tone is fine.";
      } else {
        positiveNote = "Your English looks good.";
      }
    } else if (nonOverlapping.length === 1) {
      positiveNote = "Good sentence — just one correction.";
    } else {
      positiveNote = `Good effort — ${nonOverlapping.length} small corrections.`;
    }
  }

  return {
    originalText,
    hasCorrections,
    corrections: nonOverlapping,
    teacherNote,
    positiveNote
  };
}

const DIDNT_VERBS = {
  went: 'go', saw: 'see', ate: 'eat', did: 'do', came: 'come',
  took: 'take', had: 'have', wrote: 'write', ran: 'run',
  bought: 'buy', broke: 'break', spoke: 'speak', got: 'get',
  knew: 'know', thought: 'think'
};

const HAVE_PAST_PARTICIPLES = {
  ate: 'eaten', did: 'done', went: 'gone', saw: 'seen',
  wrote: 'written', took: 'taken', spoke: 'spoken', broke: 'broken',
  ran: 'run', knew: 'known', drank: 'drunk', gave: 'given'
};

const UNAMBIGUOUS_SPELLINGS = {
  definately: 'definitely', definatly: 'definitely', recieved: 'received',
  seperate: 'separate', untill: 'until', occured: 'occurred',
  truely: 'truly', tommorrow: 'tomorrow', goverment: 'government',
  alot: 'a lot', beleive: 'believe', acheive: 'achieve',
  wierd: 'weird', freind: 'friend'
};

/**
 * Multi-rule fallback engine for offline or rate-limited environments.
 * Identifies ALL errors in a sentence with accurate start/end indices.
 */
export function fallbackRuleCheck(text) {
  const rawText = text.trim();
  const lower = rawText.toLowerCase();

  // Known casual phrases with slang/emojis that should NEVER be corrected
  if (lower.includes("bro") && lower.includes("shit")) {
    return {
      originalText: rawText,
      hasCorrections: false,
      corrections: [],
      teacherNote: "Your English looks good.",
      positiveNote: "Your casual tone is fine."
    };
  }

  const rules = [
    // 1. didn't + past verb -> base verb (e.g. didn't went -> didn't go)
    {
      regex: /\b(didn't|didnt)\s+(went|saw|ate|did|came|took|had|wrote|ran|bought|broke|spoke|got|knew|thought)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        const orig = m[2];
        const target = DIDNT_VERBS[orig.toLowerCase()] || 'base verb';
        return {
          original: orig,
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + orig.length,
          corrected: target,
          explanation: `After '${m[1]}', use the base verb '${target}', not '${orig}'.`
        };
      }
    },
    // 2. have/has/had + past simple -> past participle (e.g. have ate -> have eaten)
    {
      regex: /\b(have|has|had)\s+(ate|did|went|saw|wrote|took|spoke|broke|ran|knew|drank|gave)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        const orig = m[2];
        const target = HAVE_PAST_PARTICIPLES[orig.toLowerCase()] || orig;
        return {
          original: orig,
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + orig.length,
          corrected: target,
          explanation: `After '${m[1]}', use the past participle '${target}', not '${orig}'.`
        };
      }
    },
    // 3. Plural existentials (e.g. there is many people -> there are many people)
    {
      regex: /\b(there)\s+(is)\s+(many|several|few|a\s+lot\s+of|two|three|four|five|people)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        return {
          original: m[2],
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + m[2].length,
          corrected: 'are',
          explanation: `With plural subjects like '${m[3]}', use 'are' instead of 'is'.`
        };
      }
    },
    // 4. Past plural existentials (there was many people -> were)
    {
      regex: /\b(there)\s+(was)\s+(many|several|few|two|three|four|five|people)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        return {
          original: m[2],
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + m[2].length,
          corrected: 'were',
          explanation: `With plural subjects like '${m[3]}', use 'were' instead of 'was'.`
        };
      }
    },
    // 5. he/she/it don't -> doesn't
    {
      regex: /\b(he|she|it)\s+(don't|dont)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        return {
          original: m[2],
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + m[2].length,
          corrected: "doesn't",
          explanation: `With '${m[1]}', use "doesn't" instead of '${m[2]}'.`
        };
      }
    },
    // 6. don't/doesn't/didn't + knows/wants/goes -> base verb
    {
      regex: /\b(don't|dont|doesn't|doesnt|didn't|didnt)\s+(knows|wants|goes|likes|needs)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        const orig = m[2];
        const base = orig.endsWith('es') ? orig.slice(0, -2) : orig.slice(0, -1);
        return {
          original: orig,
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + orig.length,
          corrected: base,
          explanation: `After '${m[1]}', use the base verb '${base}', not '${orig}'.`
        };
      }
    },
    // 7. he/she + go -> goes
    {
      regex: /\b(he|she)\s+(go)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        return {
          original: m[2],
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + m[2].length,
          corrected: 'goes',
          explanation: `In present simple, '${m[1]}' requires 'goes'.`
        };
      }
    },
    // 8. he/she/it + want/like/need/know -> adds 's' (e.g. he want -> he wants)
    {
      regex: /\b(he|she|it)\s+(want|like|need|know)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        const orig = m[2];
        const corrected = orig + 's';
        return {
          original: orig,
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + orig.length,
          corrected: corrected,
          explanation: `In present simple, '${m[1]}' requires '${corrected}'.`
        };
      }
    },
    // 9. Past context + goes -> went
    {
      regex: /\b(yesterday|last week|ago)\b.*?\b(goes)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        return {
          original: m[2],
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + m[2].length,
          corrected: 'went',
          explanation: "For completed past actions, use the past simple 'went'."
        };
      }
    },
    // 10. buyed -> bought
    {
      regex: /\b(buyed)\b/gi,
      extract: (m, matchIdx) => ({
        original: m[1],
        startIndex: matchIdx,
        endIndex: matchIdx + m[1].length,
        corrected: 'bought',
        explanation: "'Buy' is irregular: the past tense is 'bought', not 'buyed'."
      })
    },
    // 11. more taller -> taller
    {
      regex: /\b(more\s+taller)\b/gi,
      extract: (m, matchIdx) => ({
        original: m[1],
        startIndex: matchIdx,
        endIndex: matchIdx + m[1].length,
        corrected: "taller",
        explanation: "'Taller' is already comparative. Drop 'more'."
      })
    },
    // 12. looking forward to meet -> meeting
    {
      regex: /\b(looking\s+forward\s+to)\s+(meet)\b/gi,
      extract: (m, matchIdx) => {
        const fullMatch = m[0];
        const offset = fullMatch.indexOf(m[2]);
        return {
          original: m[2],
          startIndex: matchIdx + offset,
          endIndex: matchIdx + offset + m[2].length,
          corrected: "meeting",
          explanation: "In 'look forward to', 'to' is a preposition, so use 'meeting'."
        };
      }
    },
    // 13. High-confidence unambiguous spelling errors
    {
      regex: /\b(definately|definatly|recieved|seperate|untill|occured|truely|tommorrow|goverment|alot|beleive|acheive|wierd|freind)\b/gi,
      extract: (m, matchIdx) => {
        const orig = m[1];
        const corrected = UNAMBIGUOUS_SPELLINGS[orig.toLowerCase()] || orig;
        return {
          original: orig,
          startIndex: matchIdx,
          endIndex: matchIdx + orig.length,
          corrected: corrected,
          explanation: `Spelling: '${corrected}', not '${orig}'.`
        };
      }
    }
  ];

  const found = [];

  for (const rule of rules) {
    let match;
    while ((match = rule.regex.exec(rawText)) !== null) {
      const item = rule.extract(match, match.index);
      found.push(item);
    }
  }

  // Sort and deduplicate overlaps
  found.sort((a, b) => a.startIndex - b.startIndex);
  const nonOverlapping = [];
  let lastEnd = 0;
  for (const item of found) {
    if (item.startIndex >= lastEnd) {
      nonOverlapping.push(item);
      lastEnd = item.endIndex;
    }
  }

  if (nonOverlapping.length > 0) {
    const explanations = nonOverlapping.map(c => c.explanation);
    const teacherNote = explanations.join(" ");
    const positiveNote = nonOverlapping.length === 1 
      ? "Good sentence — just one correction." 
      : `Good effort — ${nonOverlapping.length} small corrections.`;

    return {
      originalText: rawText,
      hasCorrections: true,
      corrections: nonOverlapping,
      teacherNote,
      positiveNote
    };
  }

  return {
    originalText: rawText,
    hasCorrections: false,
    corrections: [],
    teacherNote: "No obvious grammatical errors found by basic rules.",
    positiveNote: "Clear and natural phrasing."
  };
}
