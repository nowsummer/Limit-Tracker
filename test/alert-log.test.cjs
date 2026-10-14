'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AlertLog } = require('../src/alert-log.cjs');

test('a sign-in alert is remembered across restarts, and a damaged file only means it may repeat', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-alert-log-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'relogin-alerts.json');
  const first = new AlertLog(file);
  assert.equal(first.has('login:claude-work:1'), false);
  first.add('login:claude-work:1');
  assert.equal(new AlertLog(file).has('login:claude-work:1'), true, 'a new run sees it');
  assert.equal(new AlertLog(file).has('login:claude-work:2'), false, 'a new deadline alerts again');
  fs.writeFileSync(file, '{broken');
  assert.equal(new AlertLog(file).has('login:claude-work:1'), false);
  const small = new AlertLog(file, { limit: 2 });
  ['a', 'b', 'c'].forEach(key => small.add(key));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['b', 'c']);
});

test('failed delivery is retried, overlapping polls deliver once, and only success survives restart', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-alert-delivery-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'relogin-alerts.json');
  let now = 1000;
  const log = new AlertLog(file, { now: () => now, retryAfterMs: 60000 });
  const key = 'login:synthetic:123';
  let calls = 0, resolve;
  const send = () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = log.sendOnce(key, send);
  const overlap = log.sendOnce(key, send);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve(false);
  assert.equal(await first, false); await overlap;
  assert.equal(log.has(key), false);
  assert.equal(new AlertLog(file).has(key), false);
  await log.sendOnce(key, send);
  assert.equal(calls, 1, 'no tight retry loop on failed notification delivery');
  now += 60000;
  const retry = log.sendOnce(key, send);
  await Promise.resolve(); resolve(true);
  assert.equal(await retry, true);
  assert.equal(calls, 2);
  assert.equal(new AlertLog(file).has(key), true);
  await log.sendOnce(key, send);
  assert.equal(calls, 2);
});

test('a notification exception does not consume the one-time alert', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-alert-exception-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const log = new AlertLog(path.join(folder, 'alerts.json'));
  await assert.rejects(log.sendOnce('login:test:123', async () => { throw new Error('notification rejected'); }), /notification rejected/);
  assert.equal(log.has('login:test:123'), false);
});
