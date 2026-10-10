import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Google Analytics 4 — Event Tracking & Privacy Safety', () => {
  const mainJsPath = path.join(ROOT_DIR, 'src', 'main.js');
  const mainJsContent = fs.readFileSync(mainJsPath, 'utf8');

  test('main.js contains grammar_check_completed gtag event call', () => {
    assert.match(
      mainJsContent,
      /window\.gtag\(\s*['"]event['"]\s*,\s*['"]grammar_check_completed['"]/,
      'Must contain gtag call for grammar_check_completed'
    );
  });

  test('grammar_check_completed event is fired strictly in the successful branch of handleCheck', () => {
    const handleCheckSnippet = mainJsContent.substring(
      mainJsContent.indexOf('async function handleCheck()'),
      mainJsContent.indexOf('function setLoadingState(')
    );

    assert.ok(handleCheckSnippet.includes('response.json()'), 'Must be after parsing json');
    const jsonIndex = handleCheckSnippet.indexOf('await response.json()');
    const eventIndex = handleCheckSnippet.indexOf('grammar_check_completed');
    const catchIndex = handleCheckSnippet.indexOf('} catch (err) {');

    assert.ok(jsonIndex < eventIndex, 'Event must fire after response.json() is resolved');
    assert.ok(eventIndex < catchIndex, 'Event must fire inside try block before catch');
  });

  test('grammar_check_completed payload contains only safe aggregates and NO user text or PII', () => {
    // Extract the event payload object code
    const eventRegex = /window\.gtag\(\s*['"]event['"]\s*,\s*['"]grammar_check_completed['"]\s*,\s*({[\s\S]*?})\s*\)/;
    const match = mainJsContent.match(eventRegex);
    assert.ok(match, 'grammar_check_completed event call must have a payload object');

    const payloadCode = match[1];

    // Assert only safe metrics are present
    assert.match(payloadCode, /has_corrections:/);
    assert.match(payloadCode, /correction_count:/);

    // Assert forbidden data fields are absent from analytics payload
    const forbiddenFields = [
      'text',
      'sentence',
      'originalText',
      'corrected',
      'mistake',
      'teacherNote',
      'explanation',
      'email',
      'name',
      'user',
      'draft',
      'response'
    ];

    for (const field of forbiddenFields) {
      const fieldRegex = new RegExp(`\\b${field}\\s*:`);
      assert.ok(
        !fieldRegex.test(payloadCode),
        `Analytics payload must NOT contain field "${field}"`
      );
    }
  });

  test('No raw user sentences or personal inputs are sent anywhere to gtag in main.js', () => {
    // Check all occurrences of gtag('event'...) across main.js
    const allGtagEvents = mainJsContent.match(/window\.gtag\(\s*['"]event['"][\s\S]*?\);/g) || [];

    for (const call of allGtagEvents) {
      assert.ok(!call.includes('sentenceInput.value'), 'Must not send sentenceInput.value to gtag');
      assert.ok(!call.includes('originalText'), 'Must not send originalText to gtag');
      assert.ok(!call.includes('teacherNote'), 'Must not send teacherNote to gtag');
      assert.ok(!call.includes('lastClearedText'), 'Must not send lastClearedText to gtag');
    }
  });
});
