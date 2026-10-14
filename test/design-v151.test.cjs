'use strict';
// 1.5.1 design rules: status only when something is wrong, a concrete sign-in
// countdown, and the highest hidden limit surfaced on the collapsed summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = Date.parse('2026-10-07T03:00:00Z');
function fixture(language = 'ko') {
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {};
      const classes = new Set();
      this.classes = classes;
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)), contains: name => classes.has(name), toggle() {} };
    }
    set className(value) { String(value).split(/\s+/).filter(Boolean).forEach(name => this.classes.add(name)); }
    get className() { return [...this.classes].join(' '); }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelectorAll() { return []; }
  }
  const document = { documentElement: new Element('html'), querySelectorAll: () => [], createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) };
  const context = { window: {}, document, Intl, Date: class extends Date { static now() { return NOW; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/common.js'), 'utf8'), context);
  context.window.LimitUI.setLanguage(language);
  return context.window.LimitUI;
}

const future = new Date(NOW + 3 * 3600000).toISOString();
const claude = loginHours => ({
  id: 'claude-work', providerId: 'claude', status: 'ok', mode: 'isolated',
  windows: [{ id: 'five_hour', usedPercent: 12, remainingPercent: 88, resetsAt: future, durationMinutes: 300 }],
  loginExpiresAt: loginHours === null ? null : new Date(NOW + loginHours * 3600000).toISOString(),
});

test('a healthy account shows no status badge; a sign-in deadline within 3 days does', () => {
  const ui = fixture();
  assert.equal(ui.showsStatus(claude(null)), false);
  assert.equal(ui.showsStatus(claude(10 * 24)), false);
  assert.equal(ui.showsStatus(claude(70)), true);
  assert.equal(ui.showsStatus({ ...claude(null), stale: true }), true, 'an older record is an exception');
  assert.equal(ui.showsStatus({ ...claude(null), mode: 'manual', manual: true }), true, 'manual entries stay labelled');
});

test('the sign-in countdown matches "from 3 days before" and the 2-day notification', () => {
  const ui = fixture();
  const label = hours => ui.providerStatus(claude(hours)).label;
  assert.equal(label(71), '로그인 3일 남음');
  assert.equal(label(60), '로그인 3일 남음');
  assert.equal(label(47.9), '로그인 2일 남음');
  assert.equal(label(30), '로그인 1일 남음');
  assert.equal(label(23.5), '로그인 24시간 남음');
  assert.equal(label(0.2), '로그인 1시간 남음');
  assert.equal(label(-1), '지금 다시 로그인');
  assert.equal(ui.providerStatus(claude(30)).relogin, true);
  const en = fixture('en');
  assert.equal(en.providerStatus(claude(47.9)).label, 'Sign in: 2d left');
  assert.equal(en.providerStatus(claude(5)).label, 'Sign in: 5h left');
});

test('the warning badge can start sign-in, and explains the 4-week rule', () => {
  const ui = fixture();
  let clicked = null;
  const badge = ui.statusBadge(claude(30), { onRelogin: button => { clicked = button; } });
  assert.equal(badge.tag, 'button');
  assert.equal(badge.dataset.focusKey, 'claude-work-relogin');
  badge.listeners.click();
  assert.equal(clicked, badge);
  assert.match(badge.title, /4주/);
  assert.equal(ui.statusBadge(claude(30)).tag, 'span', 'without a handler (popup, iPhone) it stays text');
});

test('a collapsed "more limits" shows its highest value only from 80%, and never invents one', () => {
  const ui = fixture();
  const provider = { id: 'p', providerId: 'claude', status: 'ok', windows: [] };
  const window = (id, used, label) => ({ id, label, usedPercent: used, remainingPercent: used === null ? null : 100 - used, resetsAt: future, durationMinutes: 10080 });
  const strong = summary => summary.children.find(child => typeof child === 'object' && child.tag === 'strong');
  const calm = ui.extraSummary([window('seven_day_sonnet', 41, 'Sonnet 주간'), window('seven_day_opus', 79, 'Opus 주간')], provider);
  assert.equal(strong(calm), undefined);
  const warn = ui.extraSummary([window('seven_day_sonnet', 41, 'Sonnet 주간'), window('seven_day_opus', 92, 'Opus 주간'), window('seven_day_haiku', null, 'Haiku 주간')], provider);
  assert.equal(strong(warn).textContent, '92%');
  assert.equal(warn.classes.has('medium'), true);
  assert.match(warn.title, /Opus 주간/);
  const low = ui.extraSummary([window('seven_day_opus', 97, 'Opus 주간')], provider);
  assert.equal(low.classes.has('low'), true);
  const unknown = ui.extraSummary([window('seven_day_haiku', null, 'Haiku 주간')], provider);
  assert.equal(strong(unknown), undefined, 'unknown values are not shown as a number');
  assert.equal(unknown.textContent, '모델별 한도 1개', 'per-model limits, not purchased extra usage');
  const manual = ui.extraSummary([window('c', 85, 'My extra')], { ...provider, mode: 'manual', manual: true });
  assert.equal(manual.textContent, '다른 한도 1개');
  assert.match(warn.attributes['aria-label'], /^모델별 한도 3개 중 최고 92% 사용$/);
});

test('Claude is named for the subscription it measures, not the CLI used to read it', () => {
  const ui = fixture();
  assert.equal(ui.providerName({ providerId: 'claude' }), 'Claude');
  assert.equal(ui.providerName({ providerId: 'codex' }), 'Codex');
});

test('the sign-in explanation reads as short paragraphs in the ⓘ bubble', () => {
  const ui = fixture();
  const tip = ui.infoTip('첫 문단\n둘째 문단\n셋째 문단', '설명');
  const bubble = tip.children.find(child => child.classes.has('info-bubble'));
  assert.deepEqual(bubble.children.map(line => line.textContent), ['첫 문단', '둘째 문단', '셋째 문단']);
});

test('only model-scoped Claude limits are called model limits; anything else is neutral', () => {
  const ui = fixture();
  const window = id => ({ id, label: id, usedPercent: 10, remainingPercent: 90, resetsAt: future, durationMinutes: 10080 });
  const claude = { id: 'p', providerId: 'claude', status: 'ok', windows: [] };
  assert.equal(ui.extraSummary([window('seven_day_surface_design')], claude).textContent, '다른 한도 1개');
  assert.equal(ui.extraSummary([window('seven_day_oauth_apps')], claude).textContent, '다른 한도 1개');
  assert.equal(ui.extraSummary([window('premium:primary')], { id: 'x', providerId: 'codex', status: 'ok', windows: [] }).textContent, '다른 한도 1개');
  assert.equal(ui.extraSummary([window('seven_day_opus')], claude).textContent, '모델별 한도 1개');
});
