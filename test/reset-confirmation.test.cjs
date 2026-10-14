'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResetReminders } = require('../src/reset-reminders.cjs');
const START = Date.parse('2026-10-05T09:00:00Z');
const DUE = START + 60000;
function p(at, capturedAt, used = 80, options = {}) {
  return { id: 'codex-personal', name: 'Codex', accountLabel: '개인', status: 'ok', stale: false, refreshing: false, updatedAt: new Date(capturedAt).toISOString(), windows: [{ id: 'codex:primary', label: '5시간', usedPercent: used, remainingPercent: 100 - used, resetsAt: at === null ? null : new Date(at).toISOString() }], ...options };
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-reset-confirm-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'reminders.json'); let clock = START; const sent = [];
  const options = { file, now: () => clock, notify: item => sent.push(item) };
  return { reminders: new ResetReminders(options), options, sent, file, setNow: value => { clock = value; } };
}

test('a cached snapshot cannot replace a verified reset baseline or cancel its schedule', t => {
  const { reminders, sent, setNow } = setup(t);
  reminders.observe([p(DUE, START, 90)], true);
  setNow(START + 30000);
  reminders.observe([p(DUE, START + 10000, 10, { cached: true })], true);
  assert.equal([...reminders.items.values()][0].baselineUsed, 90);
  reminders.observe([p(DUE + 3600000, START + 10000, 10, { cached: true })], true);
  assert.equal(reminders.nextCheckAt(), DUE, 'cache cannot move the verified deadline');
  setNow(DUE + 1000);
  reminders.observe([p(DUE + 3600000, DUE + 1000, 30)], true);
  assert.equal(sent.length, 1, '90 to 30 confirms a reset even if a cache once reported 10');
});

test('a rejected reset toast stays pending across restart and retries without another server confirmation', async t => {
  const { options, file, setNow } = setup(t);
  let attempts = 0;
  const notify = async () => ++attempts > 1;
  const reminders = new ResetReminders({ ...options, notify });
  reminders.observe([p(DUE, START, 90)], true);
  setNow(DUE + 1000);
  reminders.observe([p(DUE + 3600000, DUE + 1000, 5)], true);
  await new Promise(resolve => setImmediate(resolve));
  const failed = JSON.parse(fs.readFileSync(file, 'utf8')).find(item => item.at === DUE);
  assert.equal(failed.sent, false, 'an OS rejection is not a delivered alert');
  assert.equal(failed.confirmedAt, DUE + 1000, 'the reset itself stays confirmed');
  reminders.tick(true);
  assert.equal(attempts, 1, 'retry has a cooldown');
  setNow(DUE + 61000);
  const restarted = new ResetReminders({ ...options, notify });
  restarted.tick(true); restarted.tick(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2, 'overlapping ticks deliver once');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).find(item => item.at === DUE).sent, true);
  new ResetReminders({ ...options, notify }).tick(true);
  assert.equal(attempts, 2, 'accepted delivery survives restart');
});

test('manual notification rejection retries, and disabling alerts consumes the retry', async t => {
  const { options, setNow } = setup(t);
  let attempts = 0;
  const reminders = new ResetReminders({ ...options, notify: () => { attempts++; return Promise.reject(new Error('OS unavailable')); } });
  reminders.observe([p(DUE, START, 80, { manual: true })], true);
  setNow(DUE); reminders.tick(true); reminders.tick(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(reminders.nextCheckAt(), DUE + 60000);
  reminders.tick(false); setNow(DUE + 60000); reminders.tick(true);
  assert.equal(attempts, 1, 'reenabling must not replay a disabled notification');
});

test('an asynchronous notification cannot restore a removed account schedule', async t => {
  const { options, setNow, file } = setup(t);
  let accept;
  const reminders = new ResetReminders({ ...options, notify: () => new Promise(resolve => { accept = resolve; }) });
  reminders.observe([p(DUE, START, 80, { manual: true })], true);
  setNow(DUE); reminders.tick(true);
  reminders.observe([], true);
  accept(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reminders.items.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  assert.equal(reminders.pendingDeliveries.size, 0);
});

test('Codex reset delayed by one minute never notifies early at scheduled time or intermediate retries', t => {
  const { reminders, sent, setNow } = setup(t);
  reminders.observe([p(DUE, START)], true); assert.equal(reminders.nextCheckAt(), DUE);
  setNow(DUE - 1); reminders.tick(true); assert.equal(sent.length, 0);
  for (const after of [0, 15000, 30000, 45000]) {
    setNow(DUE + after); reminders.tick(true);
    reminders.observe([p(DUE, DUE + after)], true);
    assert.equal(sent.length, 0, `must not notify before actual server reset at +${after}ms`);
    assert.equal(reminders.hasPendingDue(), true);
  }
  setNow(DUE + 60000);
  reminders.observe([p(DUE + 5 * 3600000, DUE + 60000, 0)], true);
  assert.equal(sent.length, 1); assert.equal(sent[0].confirmedAt, DUE + 60000);
  assert.equal(reminders.hasPendingDue(), false);
});

test('clock alone, stale data, refreshing data and pre-deadline snapshots cannot confirm a reset', t => {
  const { reminders, sent, setNow } = setup(t);
  reminders.observe([p(DUE, START)], true); setNow(DUE + 1000);
  reminders.tick(true);
  reminders.observe([p(DUE + 3600000, START, 0)], true);
  reminders.observe([p(DUE + 3600000, DUE + 1000, 0, { stale: true })], true);
  reminders.observe([p(DUE + 3600000, DUE + 1000, 0, { refreshing: true })], true);
  reminders.observe([p(DUE + 3600000, DUE + 1000, 0, { status: 'error' })], true);
  assert.equal(sent.length, 0);
});

test('a fresh used-percent decrease confirms reset even while the server retains its old reset timestamp', t => {
  const { reminders, sent, setNow } = setup(t);
  reminders.observe([p(DUE, START, 70)], true);
  setNow(START + 1000); reminders.observe([p(DUE, START + 1000, 85)], true);
  setNow(DUE); reminders.observe([p(DUE, DUE, 85)], true); assert.equal(sent.length, 0);
  setNow(DUE + 15000); reminders.observe([p(DUE, DUE + 15000, 3)], true);
  assert.equal(sent.length, 1); assert.equal(sent[0].baselineUsed, 85);
});

test('pending baseline persists through restart and confirmed reset is never replayed', t => {
  const { reminders, sent, setNow, options, file } = setup(t);
  reminders.observe([p(DUE, START)], true); setNow(DUE + 15000);
  const restarted = new ResetReminders(options);
  restarted.tick(true); assert.equal(sent.length, 0);
  restarted.observe([p(DUE, DUE + 15000, 0)], true); assert.equal(sent.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].baselineUsed, 80);
  const again = new ResetReminders(options);
  again.observe([p(DUE, DUE + 15000, 0)], true); again.tick(true); assert.equal(sent.length, 1);
});

test('manual reminders fire on recorded time and do not claim automatic server confirmation', t => {
  const { reminders, sent, setNow } = setup(t);
  reminders.observe([p(DUE, START, 80, { manual: true })], true);
  setNow(DUE); assert.equal(reminders.tick(true), true);
  assert.equal(sent.length, 1); assert.equal(sent[0].manual, true); assert.equal(sent[0].confirmedAt, undefined);
});

test('old persisted schedules without a used baseline require reset timestamp advancement', t => {
  const { sent, setNow, options, file } = setup(t);
  fs.writeFileSync(file, JSON.stringify([{ key: `codex-personal:codex:primary:${DUE}`, providerId: 'codex-personal', name: 'Codex', label: '5시간', at: DUE, sent: false, manual: false }]));
  const restored = new ResetReminders(options); setNow(DUE + 1000);
  restored.observe([p(DUE, DUE + 1000, 0)], true); assert.equal(sent.length, 0);
  restored.observe([p(DUE + 3600000, DUE + 1000, 0)], true); assert.equal(sent.length, 1);
});

test('an overdue unconfirmed account does not obscure another account upcoming reset boundary', t => {
  const { reminders, sent, setNow } = setup(t);
  const later = DUE + 150000;
  reminders.observe([p(DUE, START), p(later, START, 30, { id: 'codex-work' })], true);
  setNow(DUE + 140000); reminders.tick(true);
  assert.equal(reminders.nextCheckAt(), DUE, 'keep the overdue account pending confirmation');
  assert.equal(reminders.nextFutureCheckAt(), later, 'the upcoming account must remain separately schedulable');
  assert.equal(reminders.hasPendingDue(), true); assert.equal(sent.length, 0);
  setNow(later);
  assert.equal(reminders.nextFutureCheckAt(), null, 'the method returns only strictly future unsent schedules');
  reminders.observe([p(DUE, later), p(later + 3600000, later, 0, { id: 'codex-work' })], true);
  assert.deepEqual(sent.map(item => item.providerId), ['codex-work']);
  assert.equal(reminders.nextCheckAt(), DUE);
  assert.equal(reminders.nextFutureCheckAt(), later + 3600000);
});

test('a cached reading used while the server is unreachable neither confirms nor retires a reset', t => {
  const { reminders, sent, setNow } = setup(t);
  reminders.observe([p(DUE, START)], true); setNow(DUE + 60000);
  reminders.observe([p(DUE + 5 * 3600000, DUE + 60000, 0, { cached: true })], true);
  assert.equal(sent.length, 0, 'cache alone is not a confirmation');
  assert.equal(reminders.hasPendingDue(), true, 'and the schedule waits for a real response');
  reminders.observe([p(DUE + 5 * 3600000, DUE + 60000, 0)], true);
  assert.equal(sent.length, 1);
});
