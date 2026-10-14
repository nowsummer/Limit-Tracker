'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultAccounts, validateAccount, validateAccounts, prepareAccount, accountEnvironment, reorderAccounts, visibleProviders, trayProviders, monitoredProviders } = require('../src/accounts.cjs');
const { migrateSavedSettings } = require('../src/settings.cjs');

const account = (id, overrides = {}) => ({ id, providerId: 'claude', mode: 'isolated', label: id, visible: true, ...overrides });
const ids = providers => providers.map(provider => provider.id);

test('new accounts independently default to a visible tray icon and hidden Fable detail', () => {
  for (const entry of defaultAccounts()) {
    assert.equal(entry.visible, true);
    assert.equal(entry.trayVisible, true);
    assert.equal(entry.showFable, false);
  }
  const { account: created } = prepareAccount({ providerId: 'claude', mode: 'isolated', label: '트레이만', visible: false });
  assert.equal(created.visible, false);
  assert.equal(created.trayVisible, true);
  assert.equal(created.showFable, false);
});

test('editing display options and reordering preserves identity, auth directory, Fable and manual timestamp', () => {
  const before = validateAccount(account('work', { trayVisible: false, showFable: true }));
  const environment = accountEnvironment(before, 'C:\\Synthetic Limit Tracker', { PATH: 'fixture' });
  const changed = prepareAccount({ id: 'work', visible: false, label: '회사' }, [before]).account;
  assert.equal(changed.trayVisible, false);
  assert.equal(changed.showFable, true);
  assert.deepEqual(accountEnvironment(changed, 'C:\\Synthetic Limit Tracker', { PATH: 'fixture' }), environment);
  const manual = validateAccount(account('manual', { mode: 'manual', showFable: true, trayVisible: true, recordedAt: '2026-10-05T00:00:00.000Z', manualWindows: [{ label: '주간', usedPercent: 30 }] }));
  const edited = prepareAccount({ id: manual.id, trayVisible: false }, [manual]).account;
  assert.equal(edited.recordedAt, manual.recordedAt);
  assert.deepEqual(edited.manualWindows, manual.manualWindows);
  const original = [changed, edited];
  const ordered = reorderAccounts(original, ['manual', 'work']);
  assert.equal(ordered[0], edited);
  assert.equal(ordered[1], changed);
  assert.equal(ordered[0].showFable, true);
});

test('display options reject coercion and non-Claude Fable while sparse account/window arrays are invalid', () => {
  for (const value of [null, undefined, 0, 1, 'true', {}, []]) {
    assert.throws(() => validateAccount(account('a', { trayVisible: value })), /트레이/);
    assert.throws(() => validateAccount(account('a', { showFable: value })), /Fable/);
  }
  assert.throws(() => validateAccount(account('a', { providerId: 'codex', showFable: true })), /Claude/);
  assert.equal(validateAccount(account('a', { providerId: 'codex', showFable: false })).showFable, false);
  assert.throws(() => validateAccounts(Array(1)));
  assert.throws(() => validateAccount(account('a', { mode: 'manual', manualWindows: Array(1) })));
});

test('main, tray and monitored selection are independent, ordered and exclude removed accounts', () => {
  const accounts = [
    account('main', { trayVisible: false }),
    account('tray', { visible: false, trayVisible: true }),
    account('both', { trayVisible: true }),
    account('hidden', { visible: false, trayVisible: false })
  ];
  const providers = accounts.map(entry => ({ id: entry.id, visible: entry.visible, trayVisible: entry.trayVisible }));
  providers.push({ id: 'removed', visible: true, trayVisible: true });
  const state = { providers, settings: { accounts } };
  assert.deepEqual(ids(visibleProviders(state)), ['main', 'both']);
  assert.deepEqual(ids(trayProviders(state)), ['tray', 'both']);
  assert.deepEqual(ids(monitoredProviders(state)), ['main', 'tray', 'both']);
  assert.deepEqual(trayProviders({ ...state, settings: { accounts: [] } }), []);
  assert.deepEqual(monitoredProviders({ ...state, settings: { accounts: [] } }), []);
});

test('current account choices override stale provider metadata for tray-only monitoring', () => {
  const providers = [{ id: 'a', visible: false, trayVisible: false }, { id: 'b', visible: true, trayVisible: true }];
  const state = { providers, settings: { accounts: [account('a', { visible: false, trayVisible: true }), account('b', { visible: false, trayVisible: false })] } };
  assert.deepEqual(ids(trayProviders(state)), ['a']);
  assert.deepEqual(ids(monitoredProviders(state)), ['a']);
  assert.deepEqual(ids(trayProviders({ providers: [{ id: 'legacy' }, { id: 'hidden', visible: false }] })), ['legacy']);
});

test('migration preserves account order and isolated authentication paths exactly', () => {
  const before = [account('second', { visible: false }), account('first', { providerId: 'codex' })];
  const after = migrateSavedSettings({ trayMode: 'accounts', accounts: before }).accounts;
  assert.deepEqual(ids(after), ['second', 'first']);
  for (let i = 0; i < before.length; i++) assert.deepEqual(accountEnvironment(after[i], 'C:\\Synthetic Limit Tracker', {}), accountEnvironment(before[i], 'C:\\Synthetic Limit Tracker', {}));
});
