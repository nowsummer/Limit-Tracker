'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageService } = require('../src/usage-service.cjs');
const result = usedPercent => ({ status: 'ok', windows: [{ id: 'primary', usedPercent, remainingPercent: 100 - usedPercent }], updatedAt: '2026-10-05T09:00:00.000Z' });
const descriptor = (id, visible, fetch) => ({ id, name: 'Codex', metadata: { providerId: 'codex', visible }, fetch });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('hidden accounts cause zero provider calls even on forced refresh and retain their cached data', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return result(70); };
  const service = new UsageService([descriptor('a', true, fetch)]);
  await service.refresh({ force: true }); assert.equal(calls, 1);
  service.configure([descriptor('a', false, fetch)]);
  await service.refresh({ force: true }); await service.refresh({ force: true });
  assert.equal(calls, 1); assert.equal(service.providers[0].visible, false);
  assert.equal(service.providers[0].windows[0].usedPercent, 70); assert.equal(service.providers[0].refreshing, false);
});

test('showing a hidden account starts its first read and exposes the result under the same account ID', async () => {
  let calls = 0; const fetch = async () => { calls++; return result(25); };
  const service = new UsageService([descriptor('a', false, fetch)]);
  await service.refresh({ force: true }); assert.equal(calls, 0);
  service.configure([descriptor('a', true, fetch)]);
  await service.refresh({ force: true }); assert.equal(calls, 1);
  assert.equal(service.providers[0].id, 'a'); assert.equal(service.providers[0].windows[0].usedPercent, 25);
});

test('only visible accounts consume work slots and returned results retain reordered selected order', async () => {
  const called = []; const fetch = id => async () => { called.push(id); return result(10); };
  const descriptors = [descriptor('c', true, fetch('c')), descriptor('hidden', false, fetch('hidden')), descriptor('a', true, fetch('a'))];
  const service = new UsageService(descriptors); await service.refresh({ force: true });
  assert.deepEqual(called.sort(), ['a', 'c']); assert.deepEqual(service.providers.map(p => p.id), ['c', 'hidden', 'a']);
});

test('hiding an account mid-flight discards its old response and does not leave a permanent refreshing state', async () => {
  const old = deferred(); let calls = 0;
  const fetch = () => { calls++; return old.promise; };
  const service = new UsageService([descriptor('a', true, fetch)]);
  const pending = service.refresh({ force: true });
  service.configure([descriptor('a', false, fetch)]);
  old.resolve(result(80)); await pending;
  assert.equal(calls, 1); assert.equal(service.providers[0].windows.length, 0);
  assert.equal(service.providers[0].refreshing, false); assert.equal(service.refreshing, false);
});

test('showing a cooled-down account does not bypass server retry-after', async () => {
  let now = 100000; let calls = 0;
  const fetch = async () => { calls++; return { status: 'error', windows: [], retryAt: new Date(130000).toISOString(), updatedAt: new Date(now).toISOString() }; };
  const service = new UsageService([descriptor('a', true, fetch)], { now: () => now });
  await service.refresh({ force: true }); service.configure([descriptor('a', false, fetch)]);
  await service.refresh({ force: true }); service.configure([descriptor('a', true, fetch)]);
  await service.refresh({ force: true }); assert.equal(calls, 1);
  now = 130001; await service.refresh({ force: true }); assert.equal(calls, 2);
});
