'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = require('../src/i18n.cjs');

function rendererDictionary() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const sandbox = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] } };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.LimitI18n;
}

function checkDictionary(name, strings) {
  const keys = Object.keys(strings);
  assert.ok(keys.length > 50, `${name} has entries`);
  for (const key of keys) {
    const entry = strings[key];
    assert.ok(Array.isArray(entry) && entry.length === 2, `${name}.${key} is a [ko, en] pair`);
    for (const text of entry) assert.ok(typeof text === 'string' && text.trim(), `${name}.${key} has non-empty text`);
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(entry[0]), placeholders(entry[1]), `${name}.${key} uses the same placeholders in both languages`);
  }
}

test('main-process dictionary pairs Korean and English for every key', () => {
  checkDictionary('main', main.STRINGS);
});

test('renderer dictionary pairs Korean and English for every key', () => {
  const renderer = rendererDictionary();
  checkDictionary('renderer', renderer.STRINGS);
  assert.deepEqual([...renderer.LANGUAGES], ['ko', 'en']);
});

test('language resolution follows the explicit setting, then the system locale', () => {
  assert.equal(main.resolveLanguage('en', 'ko-KR'), 'en');
  assert.equal(main.resolveLanguage('ko', 'en-US'), 'ko');
  assert.equal(main.resolveLanguage('system', 'ko-KR'), 'ko');
  assert.equal(main.resolveLanguage('system', 'ko'), 'ko');
  assert.equal(main.resolveLanguage('system', 'en-GB'), 'en');
  assert.equal(main.resolveLanguage(undefined, ''), 'en');
  assert.equal(main.resolveLanguage('system', 'kok-IN'), 'en', 'Konkani is not Korean');
  const renderer = rendererDictionary();
  assert.equal(renderer.resolve('system', 'ko-KR'), 'ko');
  assert.equal(renderer.resolve('en', 'ko-KR'), 'en');
});

test('t() formats placeholders, falls back to the key, and switches language', () => {
  main.setLanguage('ko');
  assert.equal(main.t('tray.more', { count: 3 }), '외 3개 계정');
  assert.equal(main.t('claude.err.http', { status: 503 }), 'Claude 서버에 연결하지 못했어요. (HTTP 503)');
  assert.equal(main.t('missing.key'), 'missing.key');
  assert.equal(main.t('tray.more', { count: 3 }, 'en'), '+3 more');
  main.setLanguage('en');
  assert.equal(main.getLanguage(), 'en');
  assert.equal(main.t('tray.quit'), 'Quit Limit Tracker');
  assert.equal(main.setLanguage('xx'), 'ko', 'unknown languages fall back to Korean');
  assert.equal(main.format('{a} and {b} and {c}', { a: 1, b: 'two' }), '1 and two and {c}');
});
