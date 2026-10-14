'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResetReminders } = require('../src/reset-reminders.cjs');
const { visibleProviders } = require('../src/accounts.cjs');

const START = Date.parse('2026-10-04T09:00:00Z');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-reminders-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'reminders.json'); }
function provider(at, overrides = {}) { return { id: 'account-a', name: 'Claude Code', accountLabel: '개인', status: 'ok', stale: false, updatedAt: new Date(START).toISOString(), windows: [{ id: 'five_hour', label: '5시간', usedPercent: overrides.updatedAt ? 0 : 60, resetsAt: new Date(at).toISOString() }], ...overrides }; }

test('reset fires once at due time and remains deduplicated after restart', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000)], true); assert.equal(sent.length, 0);
  now += 1000; assert.equal(reminders.tick(true), false); assert.equal(sent.length, 0);
  reminders.observe([provider(START + 10000, { updatedAt: new Date(now).toISOString() })], true); reminders.tick(true); assert.equal(sent.length, 1);
  const restarted = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  restarted.observe([provider(START + 1000)], true); assert.equal(sent.length, 1);
  const saved = fs.readFileSync(file, 'utf8'); assert.equal(saved.includes('accessToken'), false);
});

test('first startup ignores historical reset timestamps while a known reset notifies after sleep', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START - 1000)], true); assert.equal(sent.length, 0);
  reminders.observe([provider(START + 1000)], true);
  now += 3600000;
  const resumed = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  resumed.tick(true); assert.equal(sent.length, 0);
  resumed.observe([provider(now + 3600000, { updatedAt: new Date(now).toISOString() })], true); assert.equal(sent.length, 1);
});

test('old resets over one day are not replayed after the app was closed', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000)], true);
  now += 2 * 86400000;
  const resumed = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  resumed.tick(true); assert.equal(sent.length, 0);
});

test('notifications disabled at reset are consumed without a burst when enabled again', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000)], false);
  now += 1000; reminders.tick(false); reminders.tick(true); assert.equal(sent.length, 0);
});

test('removed or hidden selected accounts cancel pending reminders', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  const p = provider(START + 1000);
  reminders.observe([p], true);
  reminders.observe(visibleProviders({ providers: [p], settings: { accounts: [{ id: p.id, visible: false }] } }), true);
  now += 1000; reminders.tick(true); assert.equal(sent.length, 0);
});

test('each account has an independent reset schedule even for the same service', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000), provider(START + 2000, { id: 'account-b', accountLabel: '업무' })], true);
  now += 1000; reminders.observe([provider(START + 10000, { updatedAt: new Date(now).toISOString() }), provider(START + 2000, { id: 'account-b', accountLabel: '업무' })], true); assert.deepEqual(sent.map(i => i.providerId), ['account-a']);
  now += 1000; reminders.observe([provider(START + 10000), provider(START + 20000, { id: 'account-b', accountLabel: '업무', updatedAt: new Date(now).toISOString() })], true); assert.deepEqual(sent.map(i => i.providerId), ['account-a', 'account-b']);
});

test('manual corrected reset cancels the old future reminder and schedules the new one', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000, { manual: true })], true);
  reminders.observe([provider(START + 3000, { manual: true })], true);
  now += 1000; reminders.tick(true); assert.equal(sent.length, 0, 'old edited reset must not notify');
  now += 2000; reminders.tick(true); assert.equal(sent.length, 1); assert.equal(sent[0].manual, true);
});

test('stale offline results do not replace a known pending reset schedule', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000)], true);
  reminders.observe([provider(START + 3000, { status: 'error', stale: true })], true);
  now += 1000; reminders.tick(true); assert.equal(sent.length, 0);
  reminders.observe([provider(START + 3000, { updatedAt: new Date(now).toISOString() })], true); assert.equal(sent.length, 1);
});

test('successful removal of a manual limit clears its future reminder', t => {
  const file = fixture(t); let now = START; const sent = [];
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000, { manual: true })], true);
  reminders.observe([provider(START + 1000, { manual: true, windows: [] })], true);
  now += 1000; reminders.tick(true); assert.equal(sent.length, 0);
});

test('unchanged reset observations and idle ticks perform no disk writes across progress updates', t => {
  const file = fixture(t); let writes = 0; let renames = 0;
  const originalWrite = fs.writeFileSync; const originalRename = fs.renameSync;
  t.mock.method(fs, 'writeFileSync', (...args) => { if (args[0] === file + '.tmp') writes++; return originalWrite(...args); });
  t.mock.method(fs, 'renameSync', (...args) => { if (args[1] === file) renames++; return originalRename(...args); });
  const reminders = new ResetReminders({ file, now: () => START, notify: () => {} });
  reminders.observe([provider(START + 1000)], true);
  for (let i = 0; i < 30; i++) {
    const current = provider(START + 1000); current.updatedAt = new Date(START + i).toISOString();
    reminders.observe([current], true); reminders.tick(true);
  }
  assert.equal(writes, 1); assert.equal(renames, 1);
  const restarted = new ResetReminders({ file, now: () => START, notify: () => {} });
  restarted.observe([provider(START + 1000)], true); assert.equal(writes, 1);
});

test('due notification and next reset are persisted together in one observation write', t => {
  const file = fixture(t); let now = START; const sent = []; let writes = 0;
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args) => { if (args[0] === file + '.tmp') writes++; return originalWrite(...args); });
  const reminders = new ResetReminders({ file, now: () => now, notify: item => sent.push(item) });
  reminders.observe([provider(START + 1000)], true); writes = 0;
  now += 2000; reminders.observe([provider(START + 5000, { updatedAt: new Date(now).toISOString() })], true);
  assert.equal(sent.length, 1); assert.equal(writes, 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.filter(item => item.sent).length, 1); assert.equal(saved.filter(item => !item.sent).length, 1);
});

test('failed atomic save remains dirty and is retried without needing another reset change', t => {
  const file = fixture(t); const originalRename = fs.renameSync; let failOnce = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (args[1] === file && failOnce) { failOnce = false; throw new Error('temporary file lock'); }
    return originalRename(...args);
  });
  const reminders = new ResetReminders({ file, now: () => START, notify: () => {} });
  reminders.observe([provider(START + 1000)], true); assert.equal(fs.existsSync(file), false);
  reminders.observe([provider(START + 1000)], true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
  assert.equal(reminders.dirty, false);
});
