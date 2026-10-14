'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageService, mergeProvider } = require('../src/usage-service.cjs');
const { validateSettings, SettingsStore } = require('../src/settings.cjs');
const { MobileServer, publicSnapshot } = require('../src/mobile-server.cjs');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const http = require('node:http');
const good = { id: 'claude', name: 'Claude Code', status: 'ok', plan: 'Max', windows: [{ id: 'primary', label: '5시간', usedPercent: 38, remainingPercent: 62, resetsAt: '2030-01-01T00:00:00.000Z', durationMinutes: 300 }], updatedAt: '2026-10-04T00:00:00Z', source: 'test', error: null };
test('network failure preserves last successful usage visibly stale, logout clears it', () => {
  const current = mergeProvider({ windows: [] }, good);
  const next = mergeProvider(current, { ...good, status: 'error', windows: [], updatedAt: '2026-10-04T00:01:00Z', error: 'offline' });
  assert.equal(next.windows[0].remainingPercent, 62); assert.equal(next.stale, true); assert.equal(next.lastSuccessAt, good.updatedAt);
  const loggedOut = mergeProvider(next, { ...good, status: 'disconnected', windows: [] });
  assert.equal(loggedOut.windows.length, 0); assert.equal(loggedOut.stale, false);
});
test('concurrent refreshes share requests and failure does not block the other provider', async () => {
  let count = 0, resolve; const promise = new Promise(r => { resolve = r; });
  const service = new UsageService([async () => { count++; await promise; return good; }, async () => { throw new Error('private raw output'); }]);
  const first = service.refresh({ force: true }); const second = service.refresh({ force: true }); assert.equal(first, second);
  resolve(); await first; assert.equal(count, 1); assert.equal(service.providers[0].status, 'ok'); assert.equal(service.providers[1].status, 'error'); assert.ok(!service.providers[1].error.includes('private')); assert.equal(service.refreshing, false);
});
test('official cached snapshots keep stale flags and capture time', () => {
  const result = mergeProvider({ windows: [] }, { ...good, cached: true, stale: true });
  assert.equal(result.stale, true); assert.equal(result.lastSuccessAt, good.updatedAt);
});
test('provider retry-after cooldown is respected across repeated forced resume', async () => {
  let now = 100000, count = 0;
  const service = new UsageService([async () => { count++; return count === 1 ? good : { ...good, status: 'error', windows: [], retryAt: new Date(200000).toISOString() }; }, async () => good], { now: () => now });
  await service.refresh({ force: true }); now = 110000; await service.refresh({ force: true }); assert.equal(count, 2);
  now = 150000; await service.refresh({ force: true }); now = 170000; await service.refresh({ force: true }); assert.equal(count, 2);
  now = 210000; await service.refresh({ force: true }); assert.equal(count, 3);
});
test('settings reject unknown fields and round-trip a local secret without exposing it as settings', () => {
  assert.throws(() => validateSettings({ refreshSeconds: 1 })); assert.throws(() => validateSettings({ mobileKey: 'x' })); assert.throws(() => validateSettings({ notifications: 'yes' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-')); try { const store = new SettingsStore(dir); assert.equal(store.mobileKeyIsNew, true); store.save({ theme: 'dark' }); assert.equal(store.mobileKeyIsNew, false); const next = new SettingsStore(dir); assert.equal(next.value.theme, 'dark'); assert.equal(next.mobileKey, store.mobileKey); assert.equal(next.mobileKeyIsNew, false); assert.equal(next.value.mobileKey, undefined); } finally { fs.rmSync(dir, { recursive: true }); }
});
test('LAN usage API requires the key, denies mutations/host spoofing, and excludes private metadata', async () => {
  const server = new MobileServer({ key: 'a'.repeat(64), port: 0, getState: () => ({ providers: [{ ...good, credential: 'secret' }], lastUpdated: good.updatedAt, appVersion: '1.0.0', settings: { private: true } }) });
  await server.start(); try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(base + '/api/usage')).status, 401);
    assert.equal((await fetch(base + '/api/usage?key=' + encodeURIComponent('가'.repeat(64)))).status, 401);
    assert.equal((await fetch(base + '/api/usage?key=' + 'a'.repeat(64), { method: 'POST' })).status, 405);
    const spoofStatus = await new Promise((resolve, reject) => { const req = http.get(base + '/api/usage?key=' + 'a'.repeat(64), { headers: { Host: 'hostile.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.equal(spoofStatus, 403);
    const response = await fetch(base + '/api/usage?key=' + 'a'.repeat(64)); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.providers[0].windows[0].remainingPercent, 62); assert.equal(body.settings, undefined); assert.equal(body.providers[0].credential, undefined); assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally { await server.stop(); }
});

test('emptying mobileKey revokes the iPhone URL: a new key is made and marked for saving', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ settings: { theme: 'dark' }, preferences: {}, mobileKey: '' }, null, 2));
    const store = new SettingsStore(dir);
    assert.match(store.mobileKey, /^[a-f0-9]{64}$/);
    assert.equal(store.mobileKeyIsNew, true, 'startup saves it, so the new URL stays the same after a restart');
    assert.equal(store.value.theme, 'dark', 'other settings are untouched');
    store.save({});
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mobileKey, store.mobileKey);
    assert.equal(new SettingsStore(dir).mobileKey, store.mobileKey);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
