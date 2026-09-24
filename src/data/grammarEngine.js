/**
 * TeacherCheck Grammar & Mistake Correction Engine
 * 
 * Philosophy: "Your words. Your personality. Just fix the English."
 * Keeps original sentence intact, identifies the specific mistake tokens,
 * and attaches the correction directly above the mistake with pedagogical teacher notes.
 */

export const SAMPLE_PRESETS = [
  {
    id: "she-dont-knows",
    title: "Double mistake",
    sentence: "She don't knows the answer.",
    mistakeWord: "don't knows",
    correctedWord: "doesn't know",
    note: "With 'she', use 'doesn't' instead of 'don't'. After 'doesn't', use the base verb 'know'.",
    positiveNote: "Good effort — 2 small corrections."
  },
  {
    id: "have-did",
    title: "Past participle",
    sentence: "I have did this yesterday.",
    mistakeWord: "did",
    correctedWord: "done",
    note: "After 'have', use the past participle 'done', not 'did'.",
    positiveNote: "Good sentence — just one correction."
  },
  {
    id: "market-buyed",
    title: "Multiple past tense",
    sentence: "Yesterday I goes to the market and buyed some vegetables.",
    mistakeWord: "goes / buyed",
    correctedWord: "went / bought",
    note: "For completed past actions, use 'went' and 'bought'.",
    positiveNote: "Good effort — 2 small corrections."
  },
  {
    id: "college-today",
    title: "Correct English",
    sentence: "I went to college today.",
    mistakeWord: "",
    correctedWord: "",
    note: "Your English looks good. Natural phrasing!",
    positiveNote: "Clean and correct!"
  },
  {
    id: "casual-slang",
    title: "Casual slang",
    sentence: "Bro I finally fixed this shit 😂",
    mistakeWord: "",
    correctedWord: "",
    note: "Casual slang and tone are fully preserved.",
    positiveNote: "Your casual tone is fine."
  }
];

/**
 * Intelligent rule-based corrector for mock corrections
 */
export function analyzeSentence(input) {
  if (!input || !input.trim()) {
    return null;
  }

  const rawText = input.trim();
  const lower = rawText.toLowerCase();

  // 1. Direct match with preset samples
  for (const preset of SAMPLE_PRESETS) {
    if (preset.sentence.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "") ===
        lower.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")) {
      return buildCorrectionResult(rawText, [{
        original: preset.mistakeWord,
        replacement: preset.correctedWord,
        note: preset.note,
        positiveNote: preset.positiveNote
      }]);
    }
  }

  // 2. Comprehensive rule checks
  const rules = [
    {
      regex: /\b(have|has|had)\s+(did)\b/i,
      errorWord: "did",
      correction: "done",
      note: "After 'have' / 'has' / 'had', use the past participle 'done', not 'did'.",
      positive: "Good sentence — just one correction."
    },
    {
      regex: /\b(have|has|had)\s+(went)\b/i,
      errorWord: "went",
      correction: "gone",
      note: "After 'have', use the past participle 'gone', not the past simple 'went'.",
      positive: "Clear message — just adjust the participle."
    },
    {
      regex: /\b(have|has|had)\s+(saw)\b/i,
      errorWord: "saw",
      correction: "seen",
      note: "Use 'seen' with 'have' / 'has', not 'saw'.",
      positive: "Very good — just switch to the participle 'seen'."
    },
    {
      regex: /\b(have|has|had)\s+(ate)\b/i,
      errorWord: "ate",
      correction: "eaten",
      note: "Use the past participle 'eaten' after 'have', not 'ate'.",
      positive: "Almost perfect — just remember the participle form."
    },
    {
      regex: /\b(he|she|it)\s+(don't|dont)\b/i,
      errorWord: (m) => m[2],
      correction: "doesn't",
      note: "With 'he', 'she', or 'it', use 'doesn't' instead of 'don't'.",
      positive: "Good phrasing — watch out for third-person agreement."
    },
    {
      regex: /\b(he|she)\s+(go)\b/i,
      errorWord: "go",
      correction: "goes",
      note: "Third-person singular takes '-es' in present simple: 'goes'.",
      positive: "Good sentence — just add '-es' to the verb."
    },
    {
      regex: /\b(he|she)\s+(want)\b/i,
      errorWord: "want",
      correction: "wants",
      note: "Add an 's' for third-person singular in present tense: 'wants'.",
      positive: "Nice sentence — just one verb ending fix."
    },
    {
      regex: /\b(he|she)\s+(say)\b/i,
      errorWord: "say",
      correction: "says",
      note: "Third-person singular in present tense takes 'says'.",
      positive: "Great sentence — just need 'says'."
    },
    {
      regex: /\b(more\s+better)\b/i,
      errorWord: "more better",
      correction: "better",
      note: "'Better' is already comparative. You don't need 'more'.",
      positive: "Great point — simply use 'better'."
    },
    {
      regex: /\b(more\s+taller)\b/i,
      errorWord: "more taller",
      correction: "taller",
      note: "Use 'taller' without 'more'.",
      positive: "Nice sentence — just one double comparative fix."
    },
    {
      regex: /\b(more\s+faster)\b/i,
      errorWord: "more faster",
      correction: "faster",
      note: "'Faster' already means more fast. Drop the word 'more'.",
      positive: "Understood clearly — just drop 'more'."
    },
    {
      regex: /\b(looking\s+forward\s+to)\s+(meet)\b/i,
      errorWord: "meet",
      correction: "meeting",
      note: "The expression is 'looking forward to + [verb]-ing' ('meeting').",
      positive: "Polite and natural — just use the '-ing' form."
    },
    {
      regex: /\b(looking\s+forward\s+to)\s+(see)\b/i,
      errorWord: "see",
      correction: "seeing",
      note: "'Looking forward to' is followed by a gerund: 'seeing'.",
      positive: "Warm message — just needs the '-ing' ending."
    },
    {
      regex: /\b(there\s+is)\s+(many|several|a lot of people|people|three|two|four|five)\b/i,
      errorWord: "is",
      correction: "are",
      note: "Use 'there are' with plural subjects.",
      positive: "Good observation — just match the verb to the plural subject."
    },
    {
      regex: /\b(advices)\b/i,
      errorWord: "advices",
      correction: "advice",
      note: "'Advice' is an uncountable noun in English; it has no plural 's'.",
      positive: "Expressive sentence — 'advice' is uncountable."
    },
    {
      regex: /\b(informations)\b/i,
      errorWord: "informations",
      correction: "information",
      note: "'Information' is uncountable. Use 'information' or 'pieces of information'.",
      positive: "Clear message — remember 'information' has no plural form."
    },
    {
      regex: /\b(i\s+am\s+agree)\b/i,
      errorWord: "am agree",
      correction: "agree",
      note: "'Agree' is a verb on its own. Say 'I agree', not 'I am agree'.",
      positive: "Direct and clear — just say 'I agree'."
    },
    {
      regex: /\b(i\s+didn't\s+knew)\b/i,
      errorWord: "knew",
      correction: "know",
      note: "After 'didn't', always use the base form of the verb ('know').",
      positive: "Good sentence — just use the base verb after 'didn't'."
    },
    {
      regex: /\b(i\s+didn't\s+saw)\b/i,
      errorWord: "saw",
      correction: "see",
      note: "After 'didn't', use the base form ('see'), not the past form ('saw').",
      positive: "Clear sentence — remember base form after 'didn't'."
    }
  ];

  const matchedErrors = [];

  for (const rule of rules) {
    const match = rawText.match(rule.regex);
    if (match) {
      const errWord = typeof rule.errorWord === 'function' ? rule.errorWord(match) : rule.errorWord;
      matchedErrors.push({
        original: errWord,
        replacement: rule.correction,
        note: rule.note,
        positiveNote: rule.positive
      });
      break; // Single error focus keeps it clean like a real teacher
    }
  }

  if (matchedErrors.length > 0) {
    return buildCorrectionResult(rawText, matchedErrors);
  }

  // 3. Fallback: If no mistake was found, it is correct!
  return {
    originalText: rawText,
    hasCorrections: false,
    tokens: [{ text: rawText, isMistake: false }],
    note: "No grammatical errors found. Your phrasing is natural and well-structured.",
    positiveNote: "Excellent writing — clean and correct!"
  };
}

/**
 * Builds tokenized representation preserving original sentence spacing and punctuation
 */
function buildCorrectionResult(rawText, errors) {
  const error = errors[0];
  const target = error.original;
  
  // Find position of the target word (case-insensitive)
  const regex = new RegExp(`\\b${escapeRegExp(target)}\\b`, 'i');
  const match = rawText.match(regex);

  if (!match) {
    // Substring fallback
    const idx = rawText.toLowerCase().indexOf(target.toLowerCase());
    if (idx === -1) {
      return {
        originalText: rawText,
        hasCorrections: false,
        tokens: [{ text: rawText, isMistake: false }],
        note: "Sentence looks good.",
        positiveNote: "Nicely done!"
      };
    }

    const before = rawText.substring(0, idx);
    const mistakeText = rawText.substring(idx, idx + target.length);
    const after = rawText.substring(idx + target.length);

    return {
      originalText: rawText,
      hasCorrections: true,
      tokens: [
        { text: before, isMistake: false },
        { 
          text: mistakeText, 
          isMistake: true, 
          correction: error.replacement,
          note: error.note 
        },
        { text: after, isMistake: false }
      ],
      note: error.note,
      positiveNote: error.positiveNote || "Good sentence — just one correction."
    };
  }

  const startIdx = match.index;
  const endIdx = startIdx + match[0].length;

  const before = rawText.substring(0, startIdx);
  const mistakeText = rawText.substring(startIdx, endIdx);
  const after = rawText.substring(endIdx);

  return {
    originalText: rawText,
    hasCorrections: true,
    tokens: [
      { text: before, isMistake: false },
      { 
        text: mistakeText, 
        isMistake: true, 
        correction: error.replacement,
        note: error.note 
      },
      { text: after, isMistake: false }
    ],
    note: error.note,
    positiveNote: error.positiveNote || "Good sentence — just one correction."
  };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
