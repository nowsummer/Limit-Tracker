'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageAlerts } = require('../src/usage-alerts.cjs');
const START = Date.parse('2026-10-08T00:00:00Z');
const provider = (used, overrides = {}) => ({ id: 'synthetic', status: 'ok', windows: [{ id: 'session', usedPercent: used, resetsAt: new Date(START + 3600000).toISOString() }], ...overrides });

test('usage warning retries after failed delivery even though the threshold was already crossed', async () => {
  let now = START, attempts = 0;
  const alerts = new UsageAlerts({ now: () => now, notify: async () => ++attempts > 1 });
  await alerts.observe([provider(79)], true);
  await alerts.observe([provider(82)], true);
  assert.equal(attempts, 1);
  await alerts.observe([provider(84)], true);
  assert.equal(attempts, 1, 'failed delivery has a cooldown');
  now += 60000;
  await Promise.all([alerts.observe([provider(84)], true), alerts.observe([provider(84)], true)]);
  assert.equal(attempts, 2);
  await alerts.observe([provider(90)], true);
  assert.equal(attempts, 2, 'accepted warning is not repeated');
  await alerts.observe([provider(96)], true);
  assert.equal(attempts, 3, 'the later 95% crossing still has its own warning');
});

test('cached data cannot create warnings, and network failure does not erase the verified baseline', async () => {
  const seen = [];
  const alerts = new UsageAlerts({ now: () => START, notify: info => { seen.push(info.percent); return true; } });
  await alerts.observe([provider(75)], true);
  await alerts.observe([provider(99, { cached: true })], true);
  await alerts.observe([provider(75, { status: 'error', stale: true })], true);
  assert.deepEqual(seen, []);
  await alerts.observe([provider(81)], true);
  assert.deepEqual(seen, [81]);
});

test('disabling alerts or reaching reset cancels a failed warning without replay', async () => {
  let now = START, attempts = 0;
  const alerts = new UsageAlerts({ now: () => now, notify: () => { attempts++; return false; } });
  await alerts.observe([provider(79)], true);
  await alerts.observe([provider(82)], true);
  await alerts.observe([provider(82)], false);
  now += 60000;
  await alerts.observe([provider(82)], true);
  assert.equal(attempts, 1);
  await alerts.observe([provider(96)], true);
  assert.equal(attempts, 2);
  now = START + 3600000;
  await alerts.observe([provider(96)], true);
  assert.equal(attempts, 2);
  assert.equal(alerts.pending.size, 0);
});
