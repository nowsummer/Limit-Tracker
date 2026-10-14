'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageService } = require('../src/usage-service.cjs');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const good = (remaining = 50) => ({ status: 'ok', windows: [{ id: 'primary', remainingPercent: remaining, usedPercent: 100 - remaining }], updatedAt: '2026-10-04T09:00:00.000Z', error: null });
const drain = () => new Promise(resolve => setImmediate(resolve));

test('fast accounts publish immediately while another account is still loading', async () => {
  const slow = deferred();
  const service = new UsageService([{ id: 'slow', name: 'Slow', fetch: () => slow.promise }, { id: 'fast', name: 'Fast', fetch: async () => good(70) }]);
  const pending = service.refresh({ force: true }); await drain();
  assert.equal(service.providers.find(p => p.id === 'fast').windows[0].remainingPercent, 70);
  assert.equal(service.providers.find(p => p.id === 'fast').refreshing, false);
  assert.equal(service.providers.find(p => p.id === 'slow').refreshing, true);
  assert.equal(service.refreshing, true);
  slow.resolve(good(30)); await pending; assert.equal(service.refreshing, false);
});

test('manual refresh bypasses the general throttle but still shares in-flight work', async () => {
  let calls = 0; let now = 1000;
  const service = new UsageService([{ id: 'a', name: 'AI', fetch: async () => { calls++; return good(); } }], { now: () => now });
  await service.refresh(); now += 1; await service.refresh(); assert.equal(calls, 1);
  await service.refresh({ force: true }); assert.equal(calls, 2);
  const slow = deferred(); service.configure([{ id: 'a', name: 'AI', fetch: () => slow.promise }]);
  const first = service.refresh({ force: true }); const second = service.refresh({ force: true }); assert.equal(first, second);
  slow.resolve(good()); await first;
});

test('an edited account configuration discards stale generation responses and finishes the new account list', async () => {
  const old = deferred(); const fresh = deferred();
  const service = new UsageService([{ id: 'removed', name: 'Old', fetch: () => old.promise }]);
  const pending = service.refresh({ force: true });
  service.configure([{ id: 'new', name: 'New', metadata: { providerId: 'claude', accountLabel: '업무' }, fetch: () => fresh.promise }]);
  old.resolve(good(1)); await drain();
  assert.deepEqual(service.providers.map(p => p.id), ['new']); assert.equal(service.providers[0].windows.length, 0);
  fresh.resolve(good(92)); await pending;
  assert.equal(service.providers[0].windows[0].remainingPercent, 92);
  assert.equal(service.providers[0].accountLabel, '업무');
});

test('provider-specific server cooldown survives forced refresh and does not block other accounts', async () => {
  let now = 100000; let blocked = 0; let healthy = 0;
  const service = new UsageService([
    { id: 'a', name: 'A', fetch: async () => { blocked++; return { ...good(), status: 'error', windows: [], retryAt: new Date(120000).toISOString() }; } },
    { id: 'b', name: 'B', fetch: async () => { healthy++; return good(); } },
  ], { now: () => now });
  await service.refresh({ force: true }); now += 1000; await service.refresh({ force: true });
  assert.equal(blocked, 1); assert.equal(healthy, 2); assert.equal(service.providers[0].refreshing, false);
  now = 120001; await service.refresh({ force: true }); assert.equal(blocked, 2);
});

test('multiple accounts keep their own identity even if provider fetchers return the same provider ID', async () => {
  const service = new UsageService([
    { id: 'personal', name: 'Claude Code', metadata: { providerId: 'claude', accountLabel: '개인' }, fetch: async () => ({ ...good(80), id: 'claude' }) },
    { id: 'work', name: 'Claude Code', metadata: { providerId: 'claude', accountLabel: '업무' }, fetch: async () => ({ ...good(20), id: 'claude' }) },
  ]);
  await service.refresh(); assert.deepEqual(service.providers.map(p => [p.id, p.windows[0].remainingPercent]), [['personal', 80], ['work', 20]]);
});

test('one malformed provider does not block other accounts or expose internal exception text', async () => {
  const service = new UsageService([{ id: 'bad', name: 'Bad', fetch: async () => { throw new Error('private-token'); } }, { id: 'good', name: 'Good', fetch: async () => good() }]);
  await service.refresh(); assert.equal(service.providers[0].status, 'error'); assert.equal(service.providers[1].status, 'ok');
  assert.equal(JSON.stringify(service.snapshot()).includes('private-token'), false);
});

test('network fan-out is bounded for twenty accounts and every account completes', async () => {
  let active = 0; let peak = 0; let done = 0;
  const service = new UsageService(Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `AI ${i}`, fetch: async () => { active++; peak = Math.max(peak, active); await drain(); active--; done++; return good(); } })));
  await service.refresh(); assert.ok(peak <= 4); assert.equal(done, 20); assert.equal(service.providers.every(p => !p.refreshing), true);
});

test('removing all accounts during a refresh finishes cleanly without resurrecting removed accounts', async () => {
  const slow = deferred(); const service = new UsageService([{ id: 'a', name: 'AI', fetch: () => slow.promise }]);
  const pending = service.refresh(); service.configure([]); slow.resolve(good()); await pending;
  assert.deepEqual(service.providers, []); assert.equal(service.refreshing, false); assert.equal(service.pending, null);
});
