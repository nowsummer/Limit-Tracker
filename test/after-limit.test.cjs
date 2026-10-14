'use strict';
// 1.5.3: Codex usage resets and credits — read from the same rate-limit reply,
// shown only near a limit, never invented, never with ids or service text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeCodexLimits } = require('../src/providers/codex.cjs');
const { publicSnapshot } = require('../src/mobile-server.cjs');

const NOW = Date.parse('2026-10-08T03:00:00Z');
const seconds = ms => Math.floor(ms / 1000);
const limits = (used, extra = {}) => ({
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 300, resetsAt: seconds(NOW + 3600000) }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: seconds(NOW + 5 * 86400000) }, credits: extra.credits ?? null } },
  rateLimitResetCredits: extra.resets ?? null,
});

test('banked resets: the count is authoritative, the earliest live expiry is kept, ids and titles never leave', () => {
  const resets = { availableCount: 2, credits: [
    { id: 'secret-id-1', resetType: 'codexRateLimits', status: 'available', grantedAt: seconds(NOW - 86400000), expiresAt: seconds(NOW + 9 * 86400000), title: 'Bonus reset', description: 'English text' },
    { id: 'secret-id-2', resetType: 'codexRateLimits', status: 'available', grantedAt: seconds(NOW - 86400000), expiresAt: seconds(NOW + 3 * 86400000), title: 'Bonus reset', description: 'English text' },
    { id: 'secret-id-3', resetType: 'codexRateLimits', status: 'redeemed', grantedAt: seconds(NOW - 86400000), expiresAt: seconds(NOW + 86400000), title: 'x', description: 'y' },
  ] };
  const result = normalizeCodexLimits(limits(90, { resets }), null, NOW);
  assert.deepEqual(result.afterLimit, { resets: 2, resetsExpireAt: new Date(seconds(NOW + 3 * 86400000) * 1000).toISOString(), creditBalance: null, unlimitedCredits: false });
  assert.ok(!/secret-id|Bonus reset|English text/.test(JSON.stringify(result)));
});

test('count only, all listed resets expired, and nothing available are handled without guessing', () => {
  assert.deepEqual(normalizeCodexLimits(limits(90, { resets: { availableCount: 1, credits: null } }), null, NOW).afterLimit, { resets: 1, resetsExpireAt: null, creditBalance: null, unlimitedCredits: false });
  const expired = { availableCount: 1, credits: [{ id: 'a', status: 'available', expiresAt: seconds(NOW - 60000) }] };
  assert.equal(normalizeCodexLimits(limits(90, { resets: expired }), null, NOW).afterLimit, undefined);
  assert.equal(normalizeCodexLimits(limits(90, { resets: { availableCount: 0, credits: [] } }), null, NOW).afterLimit, undefined);
  assert.equal(normalizeCodexLimits(limits(90), null, NOW).afterLimit, undefined, 'an older CLI without the fields shows nothing');
});

test('credits: only a positive plain balance or unlimited; anything else is unknown', () => {
  const of = credits => normalizeCodexLimits(limits(90, { credits }), null, NOW).afterLimit;
  assert.deepEqual(of({ hasCredits: true, unlimited: false, balance: '125.5' }), { resets: null, resetsExpireAt: null, creditBalance: '125.5', unlimitedCredits: false });
  assert.deepEqual(of({ hasCredits: false, unlimited: true, balance: null }), { resets: null, resetsExpireAt: null, creditBalance: null, unlimitedCredits: true });
  for (const credits of [{ hasCredits: false, unlimited: false, balance: '0' }, { hasCredits: true, unlimited: false, balance: '0' }, { hasCredits: true, unlimited: false, balance: '-3' }, { hasCredits: true, unlimited: false, balance: '1e9' }, { hasCredits: true, unlimited: false, balance: 12 }]) {
    assert.equal(of(credits), undefined, JSON.stringify(credits));
  }
});

test('inconsistent reset details never overpromise resets; workspace credits remain visible', () => {
  const of = resets => normalizeCodexLimits(limits(90, { resets, credits: { hasCredits: true, balance: '12' } }), null, NOW).afterLimit;
  for (const credits of [[], [
    { status: 'available', expiresAt: seconds(NOW - 60000) },
    { status: 'available', expiresAt: seconds(NOW + 86400000) },
  ], [{ status: 'redeemed', expiresAt: seconds(NOW + 86400000) }]]) {
    assert.equal(of({ availableCount: 2, credits }).resets, null, 'wait for a consistent server read instead of claiming the old total');
    assert.equal(of({ availableCount: 2, credits }).creditBalance, '12');
  }
  assert.equal(of({ availableCount: 3, credits: [{ status: 'available', expiresAt: seconds(NOW + 86400000) }] }).resets, 3, 'a capped list of live details does not replace the authoritative count');
});

function ui(language = 'ko') {
  const element = tag => {
    const node = { tag, children: [], attributes: {}, dataset: {}, style: {}, title: '', textContent: '', classList: { add() {}, contains() { return false; }, toggle() {} }, append(...items) { this.children.push(...items); }, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {}, querySelectorAll() { return []; }, replaceChildren() {} };
    return node;
  };
  const document = { documentElement: element('html'), querySelectorAll: () => [], createElement: element, createElementNS: (_ns, tag) => element(tag) };
  const context = { window: {}, document, Intl, Date: class extends Date { static now() { return NOW; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/common.js'), 'utf8'), context);
  context.window.LimitUI.setLanguage(language);
  return context.window.LimitUI;
}
const provider = (used, afterLimit, extra = {}) => ({ id: 'codex', providerId: 'codex', status: 'ok', stale: false, ...normalizeCodexLimits(limits(used), null, NOW), afterLimit, ...extra });

test('the line appears only from 80% of a limit, on a fresh Codex reading', () => {
  const view = ui();
  const info = { resets: 1, resetsExpireAt: new Date(NOW + 3 * 86400000).toISOString(), creditBalance: null, unlimitedCredits: false };
  assert.equal(view.afterLimitInfo(provider(79, info)), null, 'calm cards stay as they are');
  assert.equal(view.afterLimitInfo(provider(80, info)).text, '사용량 재설정 1회');
  assert.match(view.afterLimitInfo(provider(95, info)).title, /^사용 기한 /);
  assert.equal(view.afterLimitInfo(provider(95, info, { stale: true })), null, 'an older reading does not promise anything');
  assert.equal(view.afterLimitInfo(provider(95, info, { status: 'error' })), null);
  assert.equal(view.afterLimitInfo({ ...provider(95, info), providerId: 'claude', id: 'claude' }), null, 'Claude reports no balance or resets');
  assert.equal(view.afterLimitInfo(provider(95, { resets: 3, resetsExpireAt: null, creditBalance: '1250', unlimitedCredits: false })).text, '사용량 재설정 3회 · 1,250크레딧');
  assert.equal(view.afterLimitInfo(provider(95, { resets: null, resetsExpireAt: null, creditBalance: '0.0004', unlimitedCredits: false })).text, '0.0004크레딧');
  assert.equal(view.afterLimitLine(provider(95, { resets: 3, resetsExpireAt: new Date(NOW + 86400000).toISOString(), creditBalance: null, unlimitedCredits: false })).title.startsWith('사용량 재설정 3회 · 가장 빠른 사용 기한 '), true, 'hover shows the whole line');
  assert.equal(view.afterLimitInfo(provider(95, { resets: null, resetsExpireAt: null, creditBalance: null, unlimitedCredits: true })).text, '크레딧 무제한');
  assert.equal(view.afterLimitInfo(provider(95, { resets: null, resetsExpireAt: null, creditBalance: '0.001', unlimitedCredits: false })).text, '0.001크레딧', 'a small balance is not shown as 0');
  assert.equal(view.afterLimitInfo(provider(95, { resets: 1, resetsExpireAt: new Date(NOW - 1000).toISOString(), creditBalance: null, unlimitedCredits: false })), null, 'a reset past its use-by is not offered');
  assert.equal(view.afterLimitInfo(provider(95, { resets: 1, resetsExpireAt: new Date(NOW).toISOString(), creditBalance: null, unlimitedCredits: false })), null, 'exactly at the use-by it is gone');
  const en = ui('en');
  assert.equal(en.afterLimitInfo(provider(95, { resets: 2, resetsExpireAt: new Date(NOW + 86400000).toISOString(), creditBalance: null, unlimitedCredits: false })).text, '2 usage resets');
  assert.equal(en.afterLimitInfo(provider(95, info)).text, '1 usage reset');
  assert.equal(en.afterLimitInfo(provider(95, { resets: null, resetsExpireAt: null, creditBalance: '1', unlimitedCredits: false })).text, '1 credit');
  assert.equal(en.afterLimitInfo(provider(95, { resets: null, resetsExpireAt: null, creditBalance: '12.3456789', unlimitedCredits: false })).text, '12.35 credits');
});

test('a reset line already on screen drops the reset at its use-by and keeps the credits', () => {
  const view = ui();
  const soon = new Date(NOW + 60000).toISOString();
  const line = view.afterLimitLine(provider(95, { resets: 1, resetsExpireAt: soon, creditBalance: '12', unlimitedCredits: false }));
  assert.equal(line.textContent, '사용량 재설정 1회 · 12크레딧');
  assert.equal(line.dataset.resetsExpire, soon);
  assert.equal(line.dataset.afterExpiry, '12크레딧');
  const onlyReset = view.afterLimitLine(provider(95, { resets: 2, resetsExpireAt: soon, creditBalance: null, unlimitedCredits: false }));
  assert.equal(onlyReset.dataset.afterExpiry, '', 'nothing left: the line goes away');
});

test('the phone gets only the cleaned count, expiry and balance', () => {
  const snapshot = publicSnapshot({ providers: [{ ...provider(95, { resets: 1, resetsExpireAt: '2026-10-11T00:00:00.000Z', creditBalance: '12', unlimitedCredits: false, id: 'secret', title: 'x' }), accountLabel: 'A', name: 'Codex' }] });
  assert.deepEqual(snapshot.providers[0].afterLimit, { resets: 1, resetsExpireAt: '2026-10-11T00:00:00.000Z', creditBalance: '12', unlimitedCredits: false });
  assert.equal(publicSnapshot({ providers: [{ ...provider(95, { resets: 0, creditBalance: 'abc' }), name: 'Codex' }] }).providers[0].afterLimit, null);
});
