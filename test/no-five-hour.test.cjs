'use strict';
// Accounts without a 5-hour limit (Claude Ultra since late 2026, per the user): the server sends
// weekly rows only. The overall weekly limit must lead everywhere (tray number, cards), and the
// card must not invent an empty "Weekly limit — No limit data" slot next to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseWindows } = require('../src/providers/claude.cjs');
const { trayWindow, compactSummary } = require('../src/presentation.cjs');

const soon = days => new Date(Date.now() + days * 86400000).toISOString();
// The order the rows arrive in is the server's; a model row may come first.
const ultraRows = [
  { kind: 'weekly_scoped', percent: 92, resets_at: soon(2), scope: { model: { display_name: 'Opus' } } },
  { kind: 'weekly_all', percent: 30, resets_at: soon(5) },
  { kind: 'weekly_scoped', percent: 11, resets_at: soon(5), scope: { model: { display_name: 'Fable' } } },
];
const claude = (rows, extra = {}) => ({ id: 'work', providerId: 'claude', status: 'ok', accountLabel: '회사 계정', windows: parseWindows({ limits: rows }), ...extra });

function rendererUi() {
  const context = { window: {}, navigator: {}, Intl, Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/common.js'), 'utf8'), context);
  return context.window.LimitUI;
}
// Arrays made inside the vm context are rebuilt here so deepEqual compares values, not realms.
const ids = list => [...list].map(window => window?.id ?? null);

test('without a 5-hour limit the tray number is the overall weekly limit, not a model limit sent first', () => {
  const p = claude(ultraRows, { showFable: true });
  assert.equal(trayWindow(p).id, 'seven_day');
  const summary = compactSummary(p);
  assert.match(summary, /30%/);
  assert.doesNotMatch(summary, /92%/);
});

test('without a 5-hour limit the card shows overall weekly, then Fable weekly, and no empty slot', () => {
  const view = rendererUi().overviewWindows(claude(ultraRows, { showFable: true }));
  assert.deepEqual(ids(view.meters), ['seven_day', 'seven_day_fable']);
  assert.deepEqual(ids(view.fable), [], 'Fable is not listed twice');
  assert.deepEqual(ids(view.extra), ['seven_day_opus'], 'Opus stays under model limits');
});

test('without a 5-hour limit and Fable hidden, the next weekly limit fills the second slot', () => {
  const view = rendererUi().overviewWindows(claude(ultraRows, { showFable: false }));
  assert.deepEqual(ids(view.meters), ['seven_day', 'seven_day_opus']);
  assert.deepEqual(ids(view.extra), []);
});

test('a weekly-only account shows one meter, never a placeholder', () => {
  const view = rendererUi().overviewWindows(claude([{ kind: 'weekly_all', percent: 30, resets_at: soon(5) }]));
  assert.deepEqual(ids(view.meters), ['seven_day']);
});

test('accounts with a 5-hour limit are unchanged, including the placeholder when the weekly row is missing', () => {
  const ui = rendererUi();
  const max = claude([{ kind: 'session', percent: 34, resets_at: soon(0.1) }, ...ultraRows], { showFable: true });
  const view = ui.overviewWindows(max);
  assert.deepEqual(ids(view.meters), ['five_hour', 'seven_day']);
  assert.deepEqual(ids(view.fable), ['seven_day_fable']);
  assert.deepEqual(ids(view.extra), ['seven_day_opus']);
  assert.equal(trayWindow(max).id, 'five_hour');
  const noWeekly = ui.overviewWindows(claude([{ kind: 'session', percent: 34, resets_at: soon(0.1) }]));
  assert.deepEqual(ids(noWeekly.meters), ['five_hour', null], 'a missing weekly limit is still shown as missing');
});

test('Codex keeps its 5-hour and weekly order', () => {
  const codex = { id: 'codex', providerId: 'codex', status: 'ok', windows: [
    { id: 'secondary', label: '주간', usedPercent: 100, durationMinutes: 10080, resetsAt: soon(1) },
    { id: 'primary', label: '5시간', usedPercent: 0, durationMinutes: 300, resetsAt: soon(0.2) },
  ] };
  assert.deepEqual(ids(rendererUi().overviewWindows(codex).meters), ['primary', 'secondary']);
});

test('the tray tooltip does not call a model limit "weekly" when the weekly limit leads', () => {
  const { singleTooltip } = require('../src/presentation.cjs');
  const surface = [{ kind: 'weekly_all', percent: 30, resets_at: soon(5) }, { kind: 'weekly_scoped', percent: 70, resets_at: soon(5), scope: { surface: { display_name: 'Claude Design' } } }];
  const p = claude(surface);
  assert.doesNotMatch(compactSummary(p), /70%/);
  assert.equal(singleTooltip(p).split('\n').filter(line => /70%/.test(line)).length, 0);
});

test('without a 5-hour limit, a shown Fable takes the second slot before any other weekly row', () => {
  const rows = [{ kind: 'weekly_all', percent: 30, resets_at: soon(5) }, { kind: 'weekly_scoped', percent: 70, resets_at: soon(5), scope: { surface: { display_name: 'Claude Design' } } }, { kind: 'weekly_scoped', percent: 11, resets_at: soon(5), scope: { model: { display_name: 'Fable' } } }];
  const view = rendererUi().overviewWindows(claude(rows, { showFable: true }));
  assert.equal(ids(view.meters)[1], 'seven_day_fable');
});

test('manual records keep their old layout (5-hour entry plus the weekly slot)', () => {
  const ui = rendererUi();
  const manual = { id: 'm', providerId: 'claude', mode: 'manual', manual: true, status: 'ok', windows: [{ id: 'manual-0', label: '5시간', usedPercent: 40, durationMinutes: null, resetsAt: soon(0.1) }] };
  assert.deepEqual(ids(ui.overviewWindows(manual).meters), ['manual-0', null]);
  const two = { ...manual, windows: [...manual.windows, { id: 'manual-1', label: '주간', usedPercent: 20, durationMinutes: null, resetsAt: soon(3) }] };
  assert.deepEqual(ids(ui.overviewWindows(two).meters), ['manual-0', 'manual-1']);
  assert.match(compactSummary(two), /40% \/ 20%/);
});
