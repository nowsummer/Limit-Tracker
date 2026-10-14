'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCodexLimits } = require('../src/providers/codex.cjs');
const { ResetReminders } = require('../src/reset-reminders.cjs');
const { singleTooltip, used } = require('../src/presentation.cjs');
const RAW = Date.parse('2026-10-06T01:45:00+09:00');
const READY = RAW + 60000;
const START = RAW - 60000;
const next = RAW + 5 * 3600000;

function provider(at, usedPercent, capturedAt) {
  return { id: 'personal', providerId: 'codex', name: 'Codex', accountLabel: '개인', status: 'ok', stale: false, updatedAt: new Date(capturedAt).toISOString(),
    ...normalizeCodexLimits({ rateLimits: { primary: { usedPercent, resetsAt: at / 1000, windowDurationMins: 300 } } }) };
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-reset-timing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = START;
  const sent = [], file = path.join(directory, 'reminders.json');
  const options = { file, now: () => now, notify: item => sent.push(item) };
  return { file, options, reminders: new ResetReminders(options), sent, clock: value => { now = value; } };
}

test('01:45 Codex boundary is shared as 01:46 without changing percentages or double-adjusting later reads', () => {
  const p = provider(RAW, 100, START);
  assert.equal(p.windows[0].resetsAt, '2026-10-05T16:46:00.000Z');
  assert.equal(p.windows[0].sourceResetsAt, '2026-10-05T16:45:00.000Z');
  assert.equal(p.windows[0].usedPercent, 100);
  assert.match(singleTooltip(p, RAW), /1분 후/);
  assert.equal(used(p.windows[0], READY - 1), 100);
  assert.equal(used(p.windows[0], READY), null, 'passing the advertised availability time alone cannot invent unused quota');
  assert.equal(provider(RAW, 100, RAW + 30000).windows[0].resetsAt, p.windows[0].resetsAt);
});

test('an early next-period response cannot notify before 01:46, but a fresh 01:46 response can', t => {
  const { reminders, clock, sent } = setup(t);
  reminders.observe([provider(RAW, 100, START)], true);
  assert.equal(reminders.nextCheckAt(), READY);
  clock(RAW + 30000);
  reminders.observe([provider(next, 0, RAW + 30000)], true);
  assert.equal(sent.length, 0);
  assert.equal(reminders.nextCheckAt(), READY, 'keep the original pending deadline when upstream advances early');
  clock(READY); reminders.tick(true);
  reminders.observe([provider(next, 0, RAW + 30000)], true);
  assert.equal(sent.length, 0, 'an earlier snapshot cannot confirm availability at 01:46');
  reminders.observe([provider(next, 0, READY)], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].at, READY);
  assert.equal(sent[0].confirmedAt, READY);
});

test('unconfirmed quota stays pending beyond 01:46 and timestamp-only corrections never notify', t => {
  const { reminders, clock, sent } = setup(t);
  reminders.observe([provider(RAW, 100, START)], true);
  for (const offset of [0, 15000, 30000]) {
    clock(READY + offset);
    reminders.observe([provider(RAW + 60000, 100, READY + offset)], true);
    assert.equal(sent.length, 0);
  }
  clock(READY + 45000);
  reminders.observe([provider(next, 2, READY + 45000)], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].confirmedAt, READY + 45000);
  clock(READY + 60000);
  reminders.observe([provider(next, 2, READY + 60000)], true);
  assert.equal(sent.length, 1, 'the corrected deadline must not announce the same replenishment again');
});

test('an early decrease with the old timestamp preserves its baseline until fresh 01:46 confirmation', t => {
  const { reminders, clock, sent } = setup(t);
  reminders.observe([provider(RAW, 100, START)], true);
  clock(RAW + 30000);
  reminders.observe([provider(RAW, 0, RAW + 30000)], true);
  assert.equal(sent.length, 0);
  clock(READY);
  reminders.observe([provider(RAW, 0, RAW + 30000)], true);
  assert.equal(sent.length, 0);
  reminders.observe([provider(RAW, 0, READY)], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].baselineUsed, 100);
});

test('multiple elapsed deadline corrections produce one confirmation for the same period', t => {
  const { reminders, clock, sent } = setup(t);
  reminders.observe([provider(RAW, 100, START)], true);
  clock(READY);
  reminders.observe([provider(RAW + 60000, 100, READY)], true);
  clock(READY + 60000);
  reminders.observe([provider(next, 0, READY + 60000)], true);
  assert.equal(sent.length, 1);
});

test('unknown usage and later reset time alone do not confirm, while a new empty period does', t => {
  const { reminders, clock, sent } = setup(t);
  reminders.observe([provider(RAW, 0, START)], true);
  clock(READY);
  const unknown = provider(next, 0, READY);
  unknown.windows[0].usedPercent = null;
  unknown.windows[0].remainingPercent = null;
  reminders.observe([unknown], true);
  assert.equal(sent.length, 0);
  reminders.observe([provider(next, 0, READY)], true);
  assert.equal(sent.length, 1);
});

test('legacy saved Codex deadlines migrate once, including an early next-period response and restart', t => {
  const { file, options, clock, sent } = setup(t);
  fs.writeFileSync(file, JSON.stringify([{ key: `personal:codex:primary:${RAW}`, providerId: 'personal', windowId: 'codex:primary', name: 'Codex', at: RAW, sent: false, manual: false, baselineUsed: 100 }]));
  clock(RAW + 30000);
  const migrated = new ResetReminders(options);
  migrated.observe([provider(next, 0, RAW + 30000)], true);
  assert.equal(sent.length, 0);
  assert.equal(migrated.nextCheckAt(), READY);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).find(item => item.at === READY);
  assert.equal(stored.resetAdjustmentMs, 60000);
  const restarted = new ResetReminders(options);
  restarted.observe([provider(next, 0, RAW + 30000)], true);
  assert.equal(restarted.nextCheckAt(), READY, 'do not add another minute on restart or re-observation');
  clock(READY);
  restarted.observe([provider(next, 0, READY)], true);
  assert.equal(sent.length, 1);
  new ResetReminders(options).observe([provider(next, 0, READY)], true);
  assert.equal(sent.length, 1, 'confirmed reminders remain deduplicated');
});

test('manual Codex dates are unmodified and manual reminders still fire at the exact entered time', t => {
  const { reminders, clock, sent } = setup(t);
  const p = provider(RAW, 80, START);
  p.manual = true;
  p.windows = [{ id: 'manual', label: '직접 기록', usedPercent: 80, resetsAt: new Date(RAW).toISOString() }];
  reminders.observe([p], true);
  assert.equal(reminders.nextCheckAt(), RAW);
  clock(RAW); reminders.tick(true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].manual, true);
});

test('adjusting a timestamp beyond the JavaScript date range stays unknown', () => {
  const p = provider(8640000000000000, 10, START);
  assert.equal(p.windows[0].resetsAt, null);
});
