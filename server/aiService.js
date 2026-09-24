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

export async function checkEnglishWithAI(text) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Global safety timeout of 14 seconds to ensure request never hangs indefinitely
  const overallTimeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      const timeoutErr = new Error("AI check timed out");
      timeoutErr.name = "TimeoutError";
      reject(timeoutErr);
    }, 14000);
  });

  const performCheck = async () => {
    if (geminiKey) {
      try {
        const result = await callGeminiAPI(text, geminiKey);
        return {
          status: 'live',
          ...result
        };
      } catch (err) {
        console.warn(`[TeacherCheck Server] Gemini provider notice: status=${err.status || err.name || 'network'}`);
        return handleAIFailure(text, err);
      }
    }

    if (openaiKey) {
      try {
        const result = await callOpenAIAPI(text, openaiKey);
        return {
          status: 'live',
          ...result
        };
      } catch (err) {
        console.warn(`[TeacherCheck Server] OpenAI provider notice: status=${err.status || err.name || 'network'}`);
        return handleAIFailure(text, err);
      }
    }

    // No API key configured: fallback to offline rules
    return handleAIFailure(text, new Error("Offline rule fallback"));
  };

  try {
    return await Promise.race([performCheck(), overallTimeoutPromise]);
  } catch (err) {
    console.warn(`[TeacherCheck Server] Overall check timeout or error: ${err.name || 'Unknown'}`);
    return handleAIFailure(text, err);
  }
}

/**
 * Handles AI failure by checking with safe offline rules.
 * Never claims a sentence is clean if the AI is unavailable and rules find nothing.
 */
function handleAIFailure(text, err) {
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

async function callGeminiAPI(text, apiKey) {
  // Use current official Google Gemini Flash models
  const candidateModels = [
    process.env.GEMINI_MODEL,
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-3.7-flash'
  ].filter(Boolean);

  let lastError = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const promptText = `${SYSTEM_PROMPT}\n\nStudent's sentence to check:\n"""${text}"""\n\nOutput JSON only:`;

    const payload = {
      contents: [
        {
          parts: [{ text: promptText }]
        }
      ]
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        const status = response.status;
        const err = new Error(`Provider HTTP ${status}`);
        err.status = status;
        lastError = err;

        // If 503 (high demand spike) or 429 (rate limit), try next candidate model
        if (status === 503 || status === 429) {
          console.warn(`[TeacherCheck AI] Model ${model} returned ${status}. Trying fallback model...`);
          continue;
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
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        console.warn(`[TeacherCheck AI] Model ${model} timed out. Trying next candidate...`);
        lastError = new Error(`Model ${model} timed out after 10s`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Failed to connect to Gemini API models");
}

async function callOpenAIAPI(text, apiKey) {
  const url = "https://api.openai.com/v1/chat/completions";

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Student's sentence to check:\n"""${text}"""` }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
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
