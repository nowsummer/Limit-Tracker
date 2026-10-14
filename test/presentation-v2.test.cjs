'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { used, primaryWindow, compactSummary, trayTooltip, singleTooltip } = require('../src/presentation.cjs');
const NOW = Date.parse('2026-10-05T09:00:00Z');
const FUTURE = new Date(NOW + 3600000).toISOString();
const quota = (value, overrides = {}) => ({ id: 'primary', label: '5시간', durationMinutes: 300, usedPercent: value, remainingPercent: 100 - value, resetsAt: FUTURE, ...overrides });
const account = (id, providerId, accountLabel, usedValue = 80) => ({ id, providerId, name: providerId, accountLabel, status: 'ok', windows: [quota(usedValue), quota(50, { id: 'weekly', label: '주간', durationMinutes: 10080 })] });

test('used presentation preserves real zero and full usage, with remaining-only backward compatibility', () => {
  assert.equal(used(quota(0), NOW), 0); assert.equal(used(quota(100), NOW), 100);
  assert.equal(used({ remainingPercent: 25 }, NOW), 75);
  assert.equal(used({ remainingPercent: 100 }, NOW), 0);
  assert.equal(used({ remainingPercent: 0 }, NOW), 100);
  assert.equal(used({ usedPercent: 20, remainingPercent: 20 }, NOW), 20, 'authoritative used value takes precedence');
});

test('expired or unknown quota never appears as replenished zero usage', () => {
  for (const window of [null, {}, { usedPercent: null }, { usedPercent: NaN }, { usedPercent: Infinity }, { usedPercent: '80' }, { usedPercent: -1 }, { usedPercent: 101 }, { remainingPercent: -1 }]) assert.equal(used(window, NOW), null);
  assert.equal(used(quota(0, { resetsAt: new Date(NOW).toISOString() }), NOW), null);
  assert.equal(used(quota(80, { resetsAt: new Date(NOW - 1).toISOString() }), NOW), null);
  assert.equal(used(quota(80, { resetsAt: null }), NOW), 80, 'unknown reset time does not erase an otherwise valid usage observation');
  const summary = compactSummary({ ...account('a', 'codex', '개인'), windows: [quota(80, { resetsAt: new Date(NOW).toISOString() })] }, NOW);
  assert.match(summary, /—/); assert.doesNotMatch(summary, /0%/);
});

test('primary selection finds short-term quota regardless of server window order and compact output uses USED', () => {
  const p = account('a', 'codex', '개인'); p.windows.reverse();
  assert.equal(primaryWindow(p).durationMinutes, 300);
  assert.equal(compactSummary(p, NOW), 'Codex 개인 · 80% / 50%');
  assert.doesNotMatch(compactSummary(p, NOW), /20%/);
  assert.match(compactSummary({ ...p, stale: true }, NOW), / 이전$/);
  assert.match(compactSummary({ ...p, manual: true }, NOW), / 기록$/);
});

test('three ordinary accounts fit the tray tooltip in selected order with a clear used header', () => {
  const providers = [account('work', 'codex', '업무'), account('personal', 'claude', '개인'), account('other', 'codex', '다른 계정')];
  const tooltip = trayTooltip(providers, NOW); const rows = tooltip.split('\n');
  assert.equal(rows[0], '사용률 · 단기 / 주간'); assert.equal(rows.length, 4);
  assert.match(rows[1], /^Codex 업무/); assert.match(rows[2], /^Claude 개인/); assert.match(rows[3], /^Codex 다른/);
  assert.ok(tooltip.length <= 127); assert.doesNotMatch(tooltip, /외 \d+개/);
});

test('tray UTF-16 budget omits whole rows and preserves emoji surrogate pairs', () => {
  const providers = Array.from({ length: 20 }, (_, index) => account(`a-${index}`, index % 2 ? 'claude' : 'codex', '😀'.repeat(20), 100));
  const tooltip = trayTooltip(providers, NOW); const rows = tooltip.split('\n');
  assert.ok(tooltip.length <= 127, `Windows counts UTF-16 code units: ${tooltip.length}`);
  assert.equal(tooltip.isWellFormed(), true);
  const omitted = Number(/^외 (\d+)개 계정$/.exec(rows.at(-1))?.[1]);
  assert.equal(omitted + rows.length - 2, providers.length);
  for (const row of rows.slice(1, -1)) assert.match(row, /· 100% \/ 50% · 1시간 0분 후$/, 'no partial account or reset row is shown');
});

test('tooltip cannot overflow even when a custom service name alone exceeds the Windows limit', () => {
  const p = { ...account('custom', 'custom', '개인'), name: '긴 서비스 이름'.repeat(100) };
  const tooltip = singleTooltip(p, NOW); assert.ok(tooltip.length <= 127); assert.equal(tooltip.isWellFormed(), true);
  assert.match(trayTooltip([], NOW), /표시할 계정/);
});

test('disconnected and loading accounts show a state label rather than a fabricated usage percentage', () => {
  assert.match(compactSummary({ ...account('a', 'claude', '개인'), status: 'disconnected', windows: [] }, NOW), /로그인 필요/);
  assert.match(compactSummary({ ...account('a', 'claude', '개인'), status: 'loading', windows: [] }, NOW), /연결 중/);
});
