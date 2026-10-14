'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, validateSettings, migrateSavedSettings, SettingsStore } = require('../src/settings.cjs');

const accounts = () => [
  { id: 'personal', providerId: 'claude', mode: 'default', label: '개인', visible: true },
  { id: 'hidden', providerId: 'claude', mode: 'isolated', label: '숨김', visible: false },
  { id: 'work', providerId: 'codex', mode: 'isolated', label: '회사', visible: true }
];
const trayIds = settings => settings.accounts.filter(account => account.trayVisible).map(account => account.id);

test('canonical settings accept only usage/app and no longer write the legacy primary setting', () => {
  assert.equal(DEFAULTS.trayMode, 'usage');
  assert.equal(Object.hasOwn(DEFAULTS, 'primaryAccountId'), false);
  assert.deepEqual(validateSettings({ trayMode: 'usage' }), { trayMode: 'usage' });
  assert.deepEqual(validateSettings({ trayMode: 'app' }), { trayMode: 'app' });
  for (const trayMode of ['accounts', 'primary', 'unknown', null]) assert.throws(() => validateSettings({ trayMode }));
  assert.throws(() => validateSettings({ primaryAccountId: 'work' }));
});

test('legacy accounts and app modes preserve only previously visible account icons', () => {
  for (const trayMode of ['accounts', 'app', undefined]) {
    const source = { accounts: accounts(), ...(trayMode ? { trayMode } : {}) };
    const before = structuredClone(source);
    const result = migrateSavedSettings(source);
    assert.equal(result.trayMode, trayMode === 'app' ? 'app' : 'usage');
    assert.deepEqual(trayIds(result), ['personal', 'work']);
    assert.deepEqual(result.accounts.map(account => account.showFable), [false, false, false]);
    assert.deepEqual(source, before);
  }
});

test('legacy primary mode retains the representative and matches previous visible-account fallback', () => {
  for (const [primaryAccountId, expected] of [['work', 'work'], ['hidden', 'personal'], ['removed', 'personal'], [null, 'personal']]) {
    const result = migrateSavedSettings({ trayMode: 'primary', primaryAccountId, accounts: accounts() });
    assert.equal(result.trayMode, 'usage');
    assert.deepEqual(trayIds(result), [expected]);
    assert.equal(Object.hasOwn(result, 'primaryAccountId'), false);
  }
  const hidden = accounts().map(account => ({ ...account, visible: false }));
  assert.deepEqual(trayIds(migrateSavedSettings({ trayMode: 'primary', primaryAccountId: 'work', accounts: hidden })), []);
});

test('canonical independent flags and Fable survive repeated reads and app-mode switching', () => {
  const source = { trayMode: 'usage', accounts: accounts().map(account => ({ ...account, trayVisible: account.id === 'hidden', showFable: account.id === 'personal' })) };
  const first = migrateSavedSettings(source);
  assert.deepEqual(trayIds(first), ['hidden']);
  assert.equal(first.accounts[0].showFable, true);
  assert.deepEqual(migrateSavedSettings(first), first);
  assert.deepEqual(trayIds(migrateSavedSettings({ ...first, trayMode: 'app' })), ['hidden']);
});

test('loading legacy settings is read-only; an explicit save persists canonical flags and the same mobile key', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-v13-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const payload = JSON.stringify({ settings: { trayMode: 'primary', primaryAccountId: 'work', accounts: accounts(), theme: 'dark' }, mobileKey: 'b'.repeat(64) }, null, 2);
  fs.writeFileSync(file, payload);
  const before = fs.statSync(file).mtimeMs;
  const store = new SettingsStore(dir);
  assert.deepEqual(trayIds(store.value), ['work']);
  assert.equal(fs.readFileSync(file, 'utf8'), payload);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  store.save({ notifications: false });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.settings.trayMode, 'usage');
  assert.equal(Object.hasOwn(saved.settings, 'primaryAccountId'), false);
  assert.equal(saved.mobileKey, 'b'.repeat(64));
  assert.equal(saved.settings.theme, 'dark');
  assert.deepEqual(trayIds(saved.settings), ['work']);
  assert.deepEqual(new SettingsStore(dir).value, store.value);
});

test('invalid new options are rejected without rewriting an existing settings file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-v13-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir);
  store.save({ accounts: migrateSavedSettings({ accounts: accounts() }).accounts });
  const before = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.save({ accounts: store.value.accounts.map(account => ({ ...account, trayVisible: 'false' })) }));
  assert.throws(() => store.save({ accounts: store.value.accounts.map(account => ({ ...account, showFable: true })) }));
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});

test('fresh stores do not share mutable default account arrays', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-v13-defaults-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = new SettingsStore(path.join(dir, 'first'));
  const second = new SettingsStore(path.join(dir, 'second'));
  first.value.accounts[0].trayVisible = false;
  first.value.accounts[0].label = 'changed';
  assert.equal(second.value.accounts[0].trayVisible, true);
  assert.equal(second.value.accounts[0].label, '기본 계정');
  assert.equal(fs.existsSync(dir + '/first'), false);
});

test('a non-array accounts value resets only the accounts and keeps every other saved setting', t => {
  for (const broken of [{}, 'x', 7, null]) {
    const migrated = migrateSavedSettings({ refreshSeconds: 300, theme: 'dark', accounts: broken }, { language: 'en', autoUpdate: false });
    assert.equal(migrated.refreshSeconds, 300); assert.equal(migrated.theme, 'dark');
    assert.equal(migrated.language, 'en'); assert.equal(migrated.autoUpdate, false);
    assert.ok(migrated.accounts.length > 0 && migrated.accounts.every(account => typeof account.id === 'string'));
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-object-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ settings: { refreshSeconds: 300, accounts: {} }, preferences: { language: 'en' } }));
  const store = new SettingsStore(directory);
  assert.equal(store.loadError, 'repaired');
  assert.equal(store.value.refreshSeconds, 300); assert.equal(store.value.language, 'en');
  assert.ok(fs.existsSync(path.join(directory, 'settings.json.bak')));
});
