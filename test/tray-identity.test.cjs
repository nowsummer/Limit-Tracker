'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trayGuid } = require('../src/tray-identity.cjs');
const base = { appId: 'local.limittracker.desktop', executable: 'C:\\Apps\\Limit Tracker.exe', userData: 'C:\\Users\\Example\\AppData\\Roaming\\Limit Tracker', accountId: 'claude-personal' };
test('tray identity is stable across relaunches and each account/app icon has its own UUID', () => {
  const first = trayGuid(base);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, trayGuid({ ...base }));
  const ids = ['claude-personal', 'claude-work', 'codex', '__app', null].map(accountId => trayGuid({ ...base, accountId }));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(first, trayGuid({ ...base, label: 'renamed', usedPercent: 75, order: 99 }));
});
test('tray UUID normalizes Windows path spelling but isolates unsigned moves and test profiles', () => {
  assert.equal(trayGuid(base), trayGuid({ ...base, executable: 'c:/APPS/./Limit Tracker.exe', userData: base.userData + '\\' }));
  for (const patch of [{ executable: 'D:\\Apps\\Limit Tracker.exe' }, { userData: 'C:\\Tests\\isolated' }, { appId: base.appId + '.development' }]) assert.notEqual(trayGuid(base), trayGuid({ ...base, ...patch }));
  assert.throws(() => trayGuid({ ...base, executable: 'relative.exe' }));
  assert.throws(() => trayGuid({ ...base, accountId: '' }));
});
