'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageService } = require('../src/usage-service.cjs');
const { publicSnapshot } = require('../src/mobile-server.cjs');
const { primaryWindow, singleTooltip, trayTooltip, resetRemaining } = require('../src/presentation.cjs');

const NOW = Date.parse('2026-10-05T09:00:00Z');
const at = minutes => new Date(NOW + minutes * 60000).toISOString();
const quota = (id, usedPercent, minutes, label, durationMinutes) => ({ id, label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: at(minutes), durationMinutes });
const current = () => quota('five_hour', 20, 90, '5시간', 300);
const weekly = () => quota('seven_day', 45, 3 * 1440 + 120, '주간', 10080);
const fable = () => quota('seven_day_fable', 0, 2 * 1440, 'Fable 주간', 10080);
const account = (id, overrides = {}) => ({ id, providerId: 'claude', name: 'Claude Code', accountLabel: id, status: 'ok', visible: true, trayVisible: true, showFable: false, windows: [current(), weekly(), fable()], updatedAt: new Date(NOW).toISOString(), ...overrides });
const good = () => ({ status: 'ok', windows: [current()], updatedAt: new Date(NOW).toISOString() });

test('v1.3 refresh includes main-only and tray-only accounts while fully hidden accounts never query', async () => {
  const calls = [];
  let release;
  const pendingFetch = new Promise(resolve => { release = resolve; });
  const choices = [
    ['main', true, false], ['tray', false, true], ['both', true, true], ['hidden', false, false]
  ];
  const service = new UsageService(choices.map(([id, visible, trayVisible]) => ({
    id, name: id, metadata: { visible, trayVisible },
    fetch: async () => { calls.push(id); await pendingFetch; return good(); }
  })), { now: () => NOW });
  const refresh = service.refresh({ force: true });
  assert.deepEqual(calls, ['main', 'tray', 'both']);
  assert.deepEqual(service.providers.map(p => [p.id, p.refreshing]), [['main', true], ['tray', true], ['both', true], ['hidden', false]]);
  release();
  await refresh;
  assert.equal(service.providers.find(p => p.id === 'tray').windows[0].usedPercent, 20);
  assert.equal(service.providers.find(p => p.id === 'hidden').windows.length, 0);
  assert.ok(service.providers.every(p => p.refreshing === false));
  await service.refresh({ force: true });
  assert.equal(calls.filter(id => id === 'hidden').length, 0);
  assert.equal(calls.filter(id => id === 'tray').length, 2);
});

test('v1.3 changing an account from fully hidden to tray-only starts querying without main visibility', async () => {
  let calls = 0;
  const descriptor = trayVisible => ({ id: 'tray', name: 'Claude', metadata: { visible: false, trayVisible }, fetch: async () => { calls++; return good(); } });
  const service = new UsageService([descriptor(false)], { now: () => NOW });
  await service.refresh({ force: true });
  assert.equal(calls, 0);
  assert.equal(service.pending, null);
  service.configure([descriptor(true)]);
  await service.refresh({ force: true });
  assert.equal(calls, 1);
  assert.equal(service.providers[0].visible, false);
  assert.equal(service.providers[0].trayVisible, true);
  service.configure([descriptor(false)]);
  await service.refresh({ force: true });
  assert.equal(calls, 1);
  assert.equal(service.providers[0].refreshing, false);
});

test('v1.3 tray-only accounts still honor server retry-after during a forced refresh', async () => {
  let calls = 0, now = NOW;
  const service = new UsageService([{ id: 'tray', name: 'Claude', metadata: { visible: false, trayVisible: true }, fetch: async () => {
    calls++;
    return { ...good(), status: 'error', windows: [], retryAt: at(5) };
  } }], { now: () => now });
  await service.refresh({ force: true });
  now += 60000;
  await service.refresh({ force: true });
  assert.equal(calls, 1);
  assert.equal(service.providers[0].refreshing, false);
  now = NOW + 5 * 60000;
  await service.refresh({ force: true });
  assert.equal(calls, 2);
});

test('v1.3 public snapshot excludes tray-only accounts and Fable unless enabled per visible account', () => {
  const providers = [
    account('main', { trayVisible: false }),
    account('tray', { visible: false }),
    account('fable', { showFable: true }),
    account('hidden', { visible: false, trayVisible: false })
  ];
  const snapshot = publicSnapshot({ providers, settings: { accounts: providers.map(p => ({ id: p.id, visible: p.visible, trayVisible: p.trayVisible, showFable: p.showFable })) } });
  assert.deepEqual(snapshot.providers.map(p => p.id), ['main', 'fable']);
  assert.deepEqual(snapshot.providers[0].windows.map(w => w.id), ['five_hour', 'seven_day']);
  assert.equal(snapshot.providers[0].showFable, false);
  assert.equal(snapshot.providers[1].showFable, true);
  assert.deepEqual(snapshot.providers[1].windows[2], fable());
});

test('v1.3 Fable filtering recognizes labels and IDs and keeps unknown, expired, and private data honest', () => {
  const windows = [
    current(),
    { ...fable(), id: 'opaque_model_31', usedPercent: null, remainingPercent: null },
    { ...fable(), label: '모델 주간', resetsAt: at(-1), credential: 'fixture-private' }
  ];
  const hidden = publicSnapshot({ providers: [account('work', { windows })] }).providers[0];
  assert.deepEqual(hidden.windows.map(w => w.id), ['five_hour']);
  const shown = publicSnapshot({ providers: [account('work', { windows, showFable: true, credential: 'fixture-private' })] }).providers[0];
  assert.equal(shown.windows.length, 3);
  assert.equal(shown.windows[1].usedPercent, null);
  assert.equal(shown.windows[1].remainingPercent, null);
  assert.equal(shown.windows[2].resetsAt, at(-1));
  assert.ok(!JSON.stringify(shown).includes('fixture-private'));
  const absent = publicSnapshot({ providers: [account('work', { windows: [current()], showFable: true })] }).providers[0];
  assert.equal(absent.windows.length, 1);
});

test('v1.3 reset countdown rounds future seconds up and labels passed resets without claiming completion', () => {
  for (const [minutes, expected] of [[1 / 60, '1분 후'], [59, '59분 후'], [60, '1시간 0분 후'], [90, '1시간 30분 후'], [1440, '1일 0시간 후'], [3 * 1440 + 120, '3일 2시간 후'], [0, '갱신 대기'], [-1, '갱신 대기']]) {
    assert.equal(resetRemaining({ resetsAt: at(minutes) }, NOW), expected);
  }
  for (const window of [null, {}, { resetsAt: null }, { resetsAt: 'invalid' }]) assert.equal(resetRemaining(window, NOW), '');
});

test('v1.3 single-account tooltip shows used percentages and reset time with optional Fable', () => {
  const p = account('개인', { windows: [fable(), weekly(), current()] });
  const normal = singleTooltip(p, NOW);
  assert.match(normal, /5시간 20% 사용 · 1시간 30분 후/);
  assert.match(normal, /주간 45% 사용 · 3일 2시간 후/);
  assert.doesNotMatch(normal, /Fable/);
  const enabled = singleTooltip({ ...p, showFable: true }, NOW);
  assert.match(enabled, /Fable 0% 사용 · 2일 0시간 후/);
  assert.equal(primaryWindow(p).id, 'five_hour');
  const absent = singleTooltip({ ...p, windows: [current()], showFable: true }, NOW);
  assert.doesNotMatch(absent, /Fable/);
});

test('v1.3 single-account tooltip preserves expired, missing reset, manual, and stale states', () => {
  const windows = [{ ...current(), resetsAt: at(0) }, { ...weekly(), resetsAt: null }];
  const expired = singleTooltip(account('개인', { windows, stale: true }), NOW);
  assert.match(expired, /이전 기록/);
  assert.match(expired, /5시간 — 사용 · 갱신 대기/);
  assert.match(expired, /주간 45% 사용 · 초기화 미제공/);
  assert.doesNotMatch(expired, /5시간 0%/);
  assert.match(singleTooltip(account('직접', { manual: true }), NOW), /직접 입력/);
});

test('v1.3 single and multi-account tooltips respect UTF-16 budgets with full reset rows', () => {
  const providers = Array.from({ length: 20 }, (_, index) => account(`work-${index}`, {
    providerId: 'custom', name: '🧑‍💻'.repeat(30), accountLabel: '😀'.repeat(30), showFable: true, stale: true
  }));
  for (const p of providers) {
    const tooltip = singleTooltip(p, NOW);
    assert.ok(tooltip.length <= 127, `single tooltip has ${tooltip.length} UTF-16 units`);
    assert.equal(tooltip.isWellFormed(), true);
  }
  const tooltip = trayTooltip(providers, NOW), rows = tooltip.split('\n');
  assert.ok(tooltip.length <= 127, `multi tooltip has ${tooltip.length} UTF-16 units`);
  assert.equal(tooltip.isWellFormed(), true);
  const omitted = Number(/^외 (\d+)개 계정$/.exec(rows.at(-1))?.[1]);
  assert.equal(rows.length - 2 + omitted, providers.length);
  for (const row of rows.slice(1, -1)) assert.match(row, /20% \/ 45% 이전 · 1시간 30분 후$/);
});

test('v1.3 truncating a quota label cannot split an emoji surrogate pair', () => {
  const p = account('개인', { windows: [{ ...current(), label: '123456789😀초기화' }] });
  const tooltip = singleTooltip(p, NOW);
  assert.equal(tooltip.isWellFormed(), true);
  assert.match(tooltip, /20% 사용 · 1시간 30분 후$/);
});
