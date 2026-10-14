'use strict';
// Every static HTML fallback must match the Korean catalog, and every catalog entry is a [ko, en] pair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('HTML fallback text matches the catalog and every key has both languages', () => {
  const context = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8'), context);
  const STRINGS = context.window.LimitI18n.STRINGS;
  const norm = value => String(value).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\u2060/g, '').replace(/[\s\u00a0]+/g, ' ').trim();
  const problems = [];
  for (const file of ['index.html', 'mobile.html', 'popup.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
    for (const [, key, text] of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
      if (!norm(text)) continue;
      if (!STRINGS[key]) problems.push(`${file}: unknown key ${key}`);
      else if (norm(STRINGS[key][0]) !== norm(text)) problems.push(`${file}: ${key}: "${norm(text)}" ≠ "${norm(STRINGS[key][0])}"`);
    }
  }
  for (const [key, value] of Object.entries(STRINGS)) if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== 'string' || !item)) problems.push(`catalog: ${key}`);
  assert.deepEqual(problems, []);
});
