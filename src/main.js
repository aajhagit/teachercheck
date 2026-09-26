import { SAMPLE_PRESETS } from './data/grammarEngine.js';

// DOM Elements
const sentenceInput = document.getElementById('sentenceInput');
const checkBtn = document.getElementById('checkBtn');
const tryAnotherBtn = document.getElementById('tryAnotherBtn');
const copyCorrectedBtn = document.getElementById('copyCorrectedBtn');
const copyBtnText = document.getElementById('copyBtnText');

const editorMode = document.getElementById('editorMode');
const correctionMode = document.getElementById('correctionMode');
const inputActions = document.getElementById('inputActions');
const resultActions = document.getElementById('resultActions');

const charCounter = document.getElementById('charCounter');
const charCount = document.getElementById('charCount');
const restoreContainer = document.getElementById('restoreContainer');
const restoreBtn = document.getElementById('restoreBtn');

const correctionSentence = document.getElementById('correctionSentence');
const teacherNoteBox = document.getElementById('teacherNoteBox');
const teacherNoteContent = document.getElementById('teacherNoteContent');
const teacherPositiveStamp = document.getElementById('teacherPositiveStamp');
const teacherNoteNotice = document.getElementById('teacherNoteNotice');

const teacherPerfectBox = document.getElementById('teacherPerfectBox');
const teacherPerfectContent = document.getElementById('teacherPerfectContent');
const teacherPerfectTitle = document.getElementById('teacherPerfectTitle');

const teacherUnavailableBox = document.getElementById('teacherUnavailableBox');
const teacherUnavailableContent = document.getElementById('teacherUnavailableContent');

const errorBanner = document.getElementById('errorBanner');
const errorMessage = document.getElementById('errorMessage');

const presetsList = document.getElementById('presetsList');
const currentDateValue = document.getElementById('currentDateValue');
const clickToEditBadge = document.getElementById('clickToEditBadge');
const editSentenceBtn = document.getElementById('editSentenceBtn');

// Landing View & Routing Elements
const landingView = document.getElementById('landingView');
const appView = document.getElementById('appView');
const heroCtaBtn = document.getElementById('heroCtaBtn');
const navCtaBtn = document.getElementById('navCtaBtn');
const sectionCtaBtn = document.getElementById('sectionCtaBtn');
const backToLandingBtn = document.getElementById('backToLandingBtn');
const landingBrand = document.getElementById('landingBrand');
const appBrand = document.getElementById('appBrand');

// Placeholder Modals
const infoModal = document.getElementById('infoModal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalOkBtn = document.getElementById('modalOkBtn');
const linkPrivacy = document.getElementById('linkPrivacy');
const linkTerms = document.getElementById('linkTerms');
const linkContact = document.getElementById('linkContact');

const MAX_CHARS = 500;
const DRAFT_KEY = 'teachercheck_user_draft';

let lastAnalysisResult = null;
let isChecking = false;
let lastClearedText = '';
let restoreTimeout = null;

// Initialize App
function init() {
  setNotebookDate();
  loadSavedDraft();
  updateCharacterCount();
  autoResizeTextarea();
  renderPresets();
  attachEventListeners();
  handleRoute();
}

function loadSavedDraft() {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved && saved.trim()) {
      sentenceInput.value = saved;
    }
  } catch {
    // LocalStorage unavailable
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, sentenceInput.value);
  } catch {
    // LocalStorage unavailable
  }
}

function updateCharacterCount() {
  if (!sentenceInput || !charCount || !charCounter) return;
  const len = sentenceInput.value.length;
  charCount.textContent = len;
  if (len >= MAX_CHARS) {
    charCounter.className = 'char-counter at-limit';
  } else if (len >= 450) {
    charCounter.className = 'char-counter near-limit';
  } else {
    charCounter.className = 'char-counter';
  }
}

function autoResizeTextarea() {
  if (!sentenceInput) return;
  sentenceInput.style.height = 'auto';
  const newHeight = Math.max(159, sentenceInput.scrollHeight);
  sentenceInput.style.height = `${newHeight}px`;
}

function showRestoreHint() {
  if (!restoreContainer) return;
  if (restoreTimeout) clearTimeout(restoreTimeout);
  restoreContainer.classList.remove('hidden');
  restoreTimeout = setTimeout(() => {
    hideRestoreHint();
  }, 7000);
}

function hideRestoreHint() {
  if (!restoreContainer) return;
  restoreContainer.classList.add('hidden');
  if (restoreTimeout) {
    clearTimeout(restoreTimeout);
    restoreTimeout = null;
  }
}

function setNotebookDate() {
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  const today = new Date().toLocaleDateString('en-US', options);
  if (currentDateValue) {
    currentDateValue.textContent = today;
  }
}

function renderPresets() {
  if (!presetsList) return;
  presetsList.innerHTML = '';

  SAMPLE_PRESETS.forEach(preset => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'preset-chip';
    chip.textContent = `"${preset.sentence}"`;
    chip.title = `${preset.title}: ${preset.mistakeWord || 'Casual test'}`;

    chip.addEventListener('click', () => {
      sentenceInput.value = preset.sentence;
      saveDraft();
      updateCharacterCount();
      autoResizeTextarea();
      hideRestoreHint();
      clearError();
      if (editorMode.classList.contains('hidden')) {
        switchToEditor();
      }
      sentenceInput.focus();
    });

    presetsList.appendChild(chip);
  });
}

function attachEventListeners() {
  checkBtn.addEventListener('click', handleCheck);

  // Click directly inside the correction sentence to place caret and edit
  if (correctionSentence) {
    correctionSentence.addEventListener('click', handleCorrectionSentenceClick);
  }

  // Edit badge affordance
  if (clickToEditBadge) {
    clickToEditBadge.addEventListener('click', handleEditButtonClick);
  }

  // Edit sentence button in result actions
  if (editSentenceBtn) {
    editSentenceBtn.addEventListener('click', handleEditButtonClick);
  }

  // "Try another sentence" button clears current sentence safely
  tryAnotherBtn.addEventListener('click', () => {
    const prev = sentenceInput.value;
    if (prev && prev.trim()) {
      lastClearedText = prev;
      showRestoreHint();
    }
    sentenceInput.value = '';
    saveDraft();
    updateCharacterCount();
    autoResizeTextarea();
    clearError();
    switchToEditor();
    sentenceInput.focus();
  });

  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      if (lastClearedText) {
        sentenceInput.value = lastClearedText;
        saveDraft();
        updateCharacterCount();
        autoResizeTextarea();
        hideRestoreHint();
        sentenceInput.focus();
      }
    });
  }

  copyCorrectedBtn.addEventListener('click', handleCopyCorrected);

  // Command/Ctrl + Enter in textarea triggers check
  sentenceInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleCheck();
    }
  });

  sentenceInput.addEventListener('input', () => {
    clearError();
    updateCharacterCount();
    autoResizeTextarea();
    saveDraft();
    hideRestoreHint();
  });

  window.addEventListener('resize', () => {
    if (!correctionMode.classList.contains('hidden')) {
      adjustCorrectionClearance();
    }
  });

  // Landing Page CTA & Routing Listeners
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showAppView(true);
    });
  }

  if (navCtaBtn) {
    navCtaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showAppView(true);
    });
  }

  if (sectionCtaBtn) {
    sectionCtaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showAppView(true);
    });
  }

  if (backToLandingBtn) {
    backToLandingBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showLandingView(true);
    });
  }

  if (landingBrand) {
    landingBrand.addEventListener('click', (e) => {
      e.preventDefault();
      showLandingView(true);
    });
  }

  if (appBrand) {
    appBrand.addEventListener('click', (e) => {
      e.preventDefault();
      showLandingView(true);
    });
  }

  window.addEventListener('popstate', () => {
    handleRoute();
  });

  // Modal Listeners
  if (linkPrivacy) {
    linkPrivacy.addEventListener('click', () => {
      openModal(
        "Privacy Policy",
        "<p><strong>Your words stay yours.</strong> TeacherCheck does not sell your sentences, collect personal identifying data, or train public AI models on your private writing.</p><p style='margin-top: 12px;'>Text submitted for grammar checking is processed securely through encrypted API requests and is never stored permanently on our servers.</p>"
      );
    });
  }

  if (linkTerms) {
    linkTerms.addEventListener('click', () => {
      openModal(
        "Terms of Service",
        "<p>TeacherCheck is an educational grammar tool designed to help you catch genuine English mistakes while preserving your authentic voice and casual expressions.</p><p style='margin-top: 12px;'>Use it freely for personal, academic, or professional drafts. Grammar and tone recommendations are provided as learning guidance.</p>"
      );
    });
  }

  if (linkContact) {
    linkContact.addEventListener('click', () => {
      openModal(
        "Contact TeacherCheck",
        "<p>Have a question, feedback, or a unique grammar suggestion for the teacher?</p><p style='margin-top: 12px;'>Reach us directly at <strong>hello@teachercheck.app</strong>. We read and appreciate every note from writers and learners.</p>"
      );
    });
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeModal);
  }

  if (modalOkBtn) {
    modalOkBtn.addEventListener('click', closeModal);
  }

  if (infoModal) {
    infoModal.addEventListener('click', (e) => {
      if (e.target === infoModal) {
        closeModal();
      }
    });
  }
}

/**
 * Navigation View Handlers
 */
function showAppView(push = true) {
  if (landingView) landingView.classList.add('hidden');
  if (appView) appView.classList.remove('hidden');
  if (push && window.location.pathname !== '/app') {
    try {
      window.history.pushState({ view: 'app' }, '', '/app');
    } catch {}
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  autoResizeTextarea();
  if (sentenceInput) {
    sentenceInput.focus();
  }
}

function showLandingView(push = true) {
  if (appView) appView.classList.add('hidden');
  if (landingView) landingView.classList.remove('hidden');
  if (push && window.location.pathname !== '/') {
    try {
      window.history.pushState({ view: 'landing' }, '', '/');
    } catch {}
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleRoute() {
  const path = window.location.pathname;
  const hash = window.location.hash;
  const search = window.location.search;

  if (path === '/app' || hash === '#app' || search.includes('app=1')) {
    showAppView(false);
  } else {
    showLandingView(false);
  }
}

function openModal(title, content) {
  if (!infoModal || !modalTitle || !modalBody) return;
  modalTitle.textContent = title;
  modalBody.innerHTML = content;
  infoModal.classList.remove('hidden');
}

function closeModal() {
  if (infoModal) {
    infoModal.classList.add('hidden');
  }
}

function handleEditButtonClick() {
  switchToEditor();
  sentenceInput.focus();
  // Place cursor at the end of the preserved sentence
  const len = sentenceInput.value.length;
  sentenceInput.setSelectionRange(len, len);
}

function handleCorrectionSentenceClick(e) {
  const fullText = sentenceInput.value;
  const targetOffset = getCaretOffsetFromClick(correctionSentence, e, fullText);

  switchToEditor();
  sentenceInput.focus();
  sentenceInput.setSelectionRange(targetOffset, targetOffset);
}

/**
 * Calculates character offset in original text based on user's click in annotated view
 */
function getCaretOffsetFromClick(container, event, fullText) {
  let range;
  let targetNode;
  let offsetInNode = 0;

  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      targetNode = range.startContainer;
      offsetInNode = range.startOffset;
    }
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (pos) {
      targetNode = pos.offsetNode;
      offsetInNode = pos.offset;
    }
  }

  if (!targetNode || !container.contains(targetNode)) {
    return fullText.length;
  }

  let totalChars = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let currentNode;

  while ((currentNode = walker.nextNode())) {
    const isTeacherAnnotation = currentNode.parentElement?.closest('.correction-above');

    if (currentNode === targetNode) {
      if (isTeacherAnnotation) {
        const token = isTeacherAnnotation.closest('.correction-token');
        const mistakeWord = token?.querySelector('.mistake-word');
        if (mistakeWord) {
          const mText = mistakeWord.textContent;
          const mIdx = fullText.indexOf(mText);
          return mIdx !== -1 ? mIdx : totalChars;
        }
      }
      return Math.min(totalChars + offsetInNode, fullText.length);
    }

    if (!isTeacherAnnotation) {
      totalChars += currentNode.textContent.length;
    }
  }

  return Math.min(totalChars, fullText.length);
}

async function handleCheck() {
  if (isChecking) return;

  const text = sentenceInput.value.trim();
  if (!text) {
    showError("Please write something in the notebook before checking.");
    sentenceInput.focus();
    return;
  }

  if (text.length > MAX_CHARS) {
    showError(`Please keep your sentence under ${MAX_CHARS} characters.`);
    sentenceInput.focus();
    return;
  }

  isChecking = true;
  clearError();
  setLoadingState(true);

  try {
    const response = await fetch('/api/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      if (response.status === 429) {
        throw new Error(errData.error || "Too many check requests. Please wait a moment before trying again.");
      }
      if (response.status === 413) {
        throw new Error(errData.error || "Your sentence is too long. Please keep it under 600 characters.");
      }
      throw new Error(errData.error || "The teacher couldn't connect right now. Please try again.");
    }

    const result = await response.json();
    lastAnalysisResult = result;

    // Synthesize realistic subtle pen scribble sound
    playSoftPenSound();

    renderCorrectionView(result);
    switchToCorrection();
    requestAnimationFrame(() => {
      adjustCorrectionClearance();
      if (document.fonts?.ready) {
        document.fonts.ready.then(() => {
          adjustCorrectionClearance();
        });
      }
    });
  } catch (err) {
    console.error('[TeacherCheck Error]', err);
    showError(err.message || "The teacher couldn't connect right now. Please try again.");
  } finally {
    setLoadingState(false);
    isChecking = false;
  }
}

function setLoadingState(isLoading) {
  if (isLoading) {
    checkBtn.disabled = true;
    checkBtn.classList.add('is-loading');
    checkBtn.innerHTML = `
      <span class="pen-loading-icon">✎</span>
      Teacher is checking...
    `;
    sentenceInput.disabled = true;
  } else {
    checkBtn.disabled = false;
    checkBtn.classList.remove('is-loading');
    checkBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Check My English
    `;
    sentenceInput.disabled = false;
  }
}

function showError(msg) {
  if (errorBanner && errorMessage) {
    errorMessage.textContent = msg;
    errorBanner.classList.remove('hidden');
  }
}

function clearError() {
  if (errorBanner) {
    errorBanner.classList.add('hidden');
  }
}

/**
 * Builds tokenized layout supporting multiple corrections across any sentence,
 * strictly preserving original words, personality, slang, contractions, and emojis.
 */
function renderCorrectionView(data) {
  correctionSentence.innerHTML = '';
  teacherNoteBox.classList.add('hidden');
  teacherPerfectBox.classList.add('hidden');
  if (teacherUnavailableBox) teacherUnavailableBox.classList.add('hidden');
  if (teacherNoteNotice) teacherNoteNotice.classList.add('hidden');

  const rawText = data.originalText;
  const corrections = Array.isArray(data.corrections) ? data.corrections : [];

  // If live AI failed and offline rules could not verify the sentence
  if (data.status === 'unavailable') {
    correctionSentence.appendChild(document.createTextNode(rawText));
    if (teacherUnavailableBox) {
      if (teacherUnavailableContent) {
        teacherUnavailableContent.textContent = data.teacherNote || data.error || "TeacherCheck couldn't complete the full AI check right now. Please try again in a moment.";
      }
      teacherUnavailableBox.classList.remove('hidden');
    }
    return;
  }

  if (corrections.length > 0) {
    let cursor = 0;
    let lastTokenEnd = -1;

    corrections.forEach((c, index) => {
      let sIdx = typeof c.startIndex === 'number' ? c.startIndex : rawText.indexOf(c.original, cursor);
      let eIdx = typeof c.endIndex === 'number' ? c.endIndex : sIdx + c.original.length;

      // Bounds validation
      if (sIdx < cursor) sIdx = cursor;
      if (eIdx > rawText.length) eIdx = rawText.length;
      if (sIdx >= eIdx) return;

      let sliceStart = sIdx;
      let sliceEnd = eIdx;

      // Separate any leading punctuation or whitespace so only the actual word is struck through
      while (sliceStart < sliceEnd && /[\s([{"'“‘]/.test(rawText[sliceStart])) {
        sliceStart++;
      }
      // Separate any trailing punctuation or whitespace so trailing punctuation stays intact in base text
      while (sliceEnd > sliceStart && /[\s.,!?;:)"'”’\]}]/.test(rawText[sliceEnd - 1])) {
        sliceEnd--;
      }

      if (sliceStart >= sliceEnd) {
        sliceStart = sIdx;
        sliceEnd = eIdx;
      }

      // 1. Preserved text preceding the mistake (exact spaces, words, punctuation)
      if (sliceStart > cursor) {
        const textBefore = rawText.substring(cursor, sliceStart);
        correctionSentence.appendChild(document.createTextNode(textBefore));
      }

      // 2. Cleaned mistake word and correction word
      const cleanOrigWord = rawText.substring(sliceStart, sliceEnd);
      let corrWord = c.corrected;
      if (/[.,!?;:)"'\]}]+$/.test(corrWord) && !/[.,!?;:)"'\]}]+$/.test(cleanOrigWord)) {
        corrWord = corrWord.replace(/[.,!?;:)"'\]}]+$/, '');
      }

      // 3. Correction token
      const tokenContainer = document.createElement('span');
      tokenContainer.className = 'correction-token';

      const correctionAbove = document.createElement('span');
      correctionAbove.className = 'correction-above';
      correctionAbove.textContent = corrWord;

      const mistakeWord = document.createElement('span');
      mistakeWord.className = 'mistake-word';
      mistakeWord.textContent = cleanOrigWord;

      tokenContainer.appendChild(correctionAbove);
      tokenContainer.appendChild(mistakeWord);
      correctionSentence.appendChild(tokenContainer);

      lastTokenEnd = sliceEnd;
      cursor = sliceEnd;
    });

    // 4. Trailing preserved text (exact punctuation, spaces, remaining sentence)
    if (cursor < rawText.length) {
      correctionSentence.appendChild(document.createTextNode(rawText.substring(cursor)));
    }

    // 5. Teacher's Note Section (explains all corrections)
    teacherNoteContent.textContent = data.teacherNote || 
      corrections.map(c => c.explanation).filter(Boolean).join(' ');

    // 6. Positive Note (tailored to count)
    teacherPositiveStamp.textContent = data.positiveNote || 
      (corrections.length === 1 ? "Good sentence — just one correction." : `Good effort — ${corrections.length} small corrections.`);
    
    // 7. If result came from offline fallback rules, show subtle notice badge
    if (data.status === 'fallback' && teacherNoteNotice) {
      teacherNoteNotice.textContent = data.notice || "✎ AI checking is temporarily unavailable. These corrections were found by offline rules.";
      teacherNoteNotice.classList.remove('hidden');
    }

    teacherNoteBox.classList.remove('hidden');

  } else {
    // Zero mistakes found: verified clean English or casual slang preserved!
    correctionSentence.appendChild(document.createTextNode(rawText));

    if (teacherPerfectTitle) {
      teacherPerfectTitle.textContent = "✓ Your English looks good.";
    }
    
    teacherPerfectContent.textContent = data.positiveNote || data.teacherNote || "Your casual tone is fine.";
    teacherPerfectBox.classList.remove('hidden');
  }
}

/**
 * Positions each .correction-above relative to the actual rendered .mistake-word geometry,
 * keeps replacement words directly above incorrect words with a small natural gap,
 * applies minimum vertical staggering only for adjacent collisions,
 * and clamps within notebook margins on narrow screens.
 */
function adjustCorrectionClearance() {
  const tokens = Array.from(correctionSentence.querySelectorAll('.correction-token'));
  if (!tokens.length) return;

  const containerRect = correctionSentence.getBoundingClientRect();
  const minLeft = containerRect.left + 2;
  const maxRight = containerRect.right - 2;

  // Small natural gap between top of mistake word and bottom of correction text
  const naturalGap = 2;

  // Pass 1: Set base vertical position relative to rendered .mistake-word geometry and reset state
  tokens.forEach(token => {
    const above = token.querySelector('.correction-above');
    const mistakeWord = token.querySelector('.mistake-word');
    if (!above || !mistakeWord) return;

    token.classList.remove('stagger-up');
    above.style.transform = 'translateX(-50%) rotate(-2deg)';

    const tokenRect = token.getBoundingClientRect();
    const wordRect = mistakeWord.getBoundingClientRect();

    // Position .correction-above bottom directly above .mistake-word top with natural gap
    const baseBottom = Math.round(tokenRect.bottom - wordRect.top + naturalGap);
    above.style.bottom = `${baseBottom}px`;
  });

  // Pass 2: Measure adjacent horizontal boxes on the same line and apply minimum vertical stagger if overlapping
  for (let i = 0; i < tokens.length - 1; i++) {
    const curr = tokens[i];
    const next = tokens[i + 1];
    const currAbove = curr.querySelector('.correction-above');
    const nextAbove = next.querySelector('.correction-above');
    const currWord = curr.querySelector('.mistake-word');
    const nextWord = next.querySelector('.mistake-word');
    if (!currAbove || !nextAbove || !currWord || !nextWord) continue;

    const currWordRect = currWord.getBoundingClientRect();
    const nextWordRect = nextWord.getBoundingClientRect();

    // Only stagger if rendered on the exact same line
    const isSameLine = Math.abs(currWordRect.top - nextWordRect.top) < 18;
    if (isSameLine) {
      const currRect = currAbove.getBoundingClientRect();
      const nextRect = nextAbove.getBoundingClientRect();

      // Check if horizontal bounding boxes overlap or touch (require at least 4px clearance)
      const horizontalOverlap = currRect.right >= (nextRect.left - 4);
      if (horizontalOverlap) {
        if (!next.classList.contains('stagger-up') && !curr.classList.contains('stagger-up')) {
          next.classList.add('stagger-up');
          const nextTokenRect = next.getBoundingClientRect();
          const staggerOffset = 11; // Minimum vertical stagger to eliminate collision without escaping the row
          const staggeredBottom = Math.round(nextTokenRect.bottom - nextWordRect.top + naturalGap + staggerOffset);
          nextAbove.style.bottom = `${staggeredBottom}px`;
          nextAbove.style.transform = 'translateX(-50%) rotate(-1deg)';
        }
      }
    }
  }

  // Pass 3: Clamp horizontal edges to prevent clipping against notebook borders
  tokens.forEach(token => {
    const above = token.querySelector('.correction-above');
    if (!above) return;

    const isStaggered = token.classList.contains('stagger-up');
    const baseRotate = isStaggered ? -1 : -2;

    const rect = above.getBoundingClientRect();
    if (rect.left < minLeft) {
      const shiftX = Math.round(minLeft - rect.left);
      above.style.transform = `translateX(calc(-50% + ${shiftX}px)) rotate(${baseRotate}deg)`;
    } else if (rect.right > maxRight) {
      const shiftX = Math.round(rect.right - maxRight);
      above.style.transform = `translateX(calc(-50% - ${shiftX}px)) rotate(${baseRotate}deg)`;
    }
  });
}

function switchToCorrection() {
  editorMode.classList.add('hidden');
  correctionMode.classList.remove('hidden');

  inputActions.classList.add('hidden');
  resultActions.classList.remove('hidden');
  resultActions.style.display = 'flex';
}

function switchToEditor() {
  correctionMode.classList.add('hidden');
  editorMode.classList.remove('hidden');

  resultActions.classList.add('hidden');
  resultActions.style.display = 'none';
  inputActions.classList.remove('hidden');

  autoResizeTextarea();
}

/**
 * Reconstructs the sentence by replacing only the actual mistake words with teacher corrections,
 * perfectly preserving all punctuation, emojis, capitalization, and surrounding phrasing.
 */
function getCorrectedSentenceText() {
  if (!lastAnalysisResult) return sentenceInput.value;
  const rawText = lastAnalysisResult.originalText || sentenceInput.value;
  const corrections = Array.isArray(lastAnalysisResult.corrections) ? lastAnalysisResult.corrections : [];

  if (corrections.length === 0) {
    return rawText;
  }

  // Sort corrections by startIndex descending so replacements from right to left preserve left indices
  const sorted = [...corrections].sort((a, b) => (b.startIndex ?? 0) - (a.startIndex ?? 0));
  let textToCopy = rawText;

  for (const c of sorted) {
    if (typeof c.startIndex === 'number' && typeof c.endIndex === 'number' && c.corrected) {
      const before = textToCopy.substring(0, c.startIndex);
      const after = textToCopy.substring(c.endIndex);
      textToCopy = before + c.corrected + after;
    } else if (c.original && c.corrected) {
      const escaped = c.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      textToCopy = textToCopy.replace(new RegExp(`\\b${escaped}\\b`, 'i'), c.corrected);
    }
  }

  return textToCopy;
}

async function handleCopyCorrected() {
  const textToCopy = getCorrectedSentenceText();

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(textToCopy);
    } else {
      throw new Error('Clipboard API unavailable');
    }
  } catch {
    const tempInput = document.createElement('textarea');
    tempInput.value = textToCopy;
    tempInput.style.position = 'fixed';
    tempInput.style.opacity = '0';
    document.body.appendChild(tempInput);
    tempInput.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      console.warn('Fallback copy failed', e);
    }
    document.body.removeChild(tempInput);
  }

  if (copyCorrectedBtn) {
    copyCorrectedBtn.classList.add('is-copied');
    copyCorrectedBtn.title = "Copied to clipboard!";
  }
  if (copyBtnText) {
    copyBtnText.textContent = "Copied!";
  }

  setTimeout(() => {
    if (copyCorrectedBtn) {
      copyCorrectedBtn.classList.remove('is-copied');
      copyCorrectedBtn.title = "Copy corrected version";
    }
    if (copyBtnText) {
      copyBtnText.textContent = "Copy";
    }
  }, 1800);
}

/**
 * Web Audio API gentle pen scribble sound
 */
function playSoftPenSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const bufferSize = ctx.sampleRate * 0.15;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.08;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400;
    filter.Q.value = 3.0;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0.04, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);

    noise.start();
  } catch {
    // Non-critical audio enhancement
  }
}

// Start app
init();
