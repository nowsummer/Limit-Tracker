'use strict';
// Regression tests for the 1.5.0 review findings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageService, MAX_RETRY_WAIT_MS } = require('../src/usage-service.cjs');
const { SettingsStore, migrateSavedSettings, LEGACY_DEFAULTS } = require('../src/settings.cjs');
const { validateAccount, prepareAccount, accountEnvironment } = require('../src/accounts.cjs');
const { ResetReminders } = require('../src/reset-reminders.cjs');
const { MobileServer } = require('../src/mobile-server.cjs');
const { trayWindow, singleTooltip } = require('../src/presentation.cjs');

const NOW = Date.parse('2026-10-07T03:00:00Z');
test('valid JSON with a non-object settings root is backed up before repair', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-shape-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  for (const raw of ['null', 'false', '123', '"damaged"']) {
    fs.writeFileSync(file, raw);
    const store = new SettingsStore(directory);
    assert.equal(store.loadError, 'corrupt');
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), raw);
    store.save({ theme: 'dark' });
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), raw);
  }
});
const window = (id, used, overrides = {}) => ({ id, label: id, usedPercent: used, remainingPercent: 100 - used, resetsAt: new Date(NOW + 3600000).toISOString(), durationMinutes: 300, ...overrides });

test('a throwing UI listener cannot wedge refreshes', async () => {
  const errors = [];
  const service = new UsageService([{ id: 'a', name: 'A', metadata: { visible: true }, fetch: async () => ({ status: 'ok', windows: [window('w', 10)], updatedAt: new Date().toISOString() }) }], { onListenerError: error => errors.push(error) });
  let throwing = true;
  service.on('change', () => { if (throwing) throw new Error('tray icon write failed'); });
  await service.refresh({ force: true });
  assert.equal(service.pending, null);
  assert.equal(service.refreshing, false);
  assert.ok(errors.length > 0);
  throwing = false;
  const snapshot = await service.refresh({ force: true });
  assert.equal(snapshot.providers[0].windows[0].usedPercent, 10);
});

test('a hostile Retry-After cannot silence an account for more than thirty minutes', async () => {
  let now = NOW;
  const service = new UsageService([{ id: 'a', name: 'A', metadata: { visible: true }, fetch: async () => ({ status: 'error', windows: [], retryAt: new Date(now + 86400000).toISOString(), updatedAt: new Date(now).toISOString() }) }], { now: () => now });
  await service.refresh({ force: true });
  assert.equal(service.retryAfter('a'), NOW + MAX_RETRY_WAIT_MS);
});

test('settings with an unknown key or one broken account keep everything else', t => {
  const accounts = [
    { id: 'personal', providerId: 'claude', mode: 'isolated', label: '개인', visible: true },
    { id: 'broken', providerId: 'nope', mode: 'default', label: 'x', visible: true },
    { id: 'work', providerId: 'codex', mode: 'default', label: '회사', visible: true },
  ];
  const migrated = migrateSavedSettings({ theme: 'dark', futureOption: 1, accounts });
  assert.equal(migrated.theme, 'dark');
  assert.deepEqual(migrated.accounts.map(account => account.id), ['personal', 'work']);
  assert.equal(migrated.repaired, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-v15-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.stringify({ settings: { theme: 'dark', futureOption: 1, accounts }, mobileKey: 'c'.repeat(64) });
  fs.writeFileSync(path.join(dir, 'settings.json'), raw);
  const store = new SettingsStore(dir);
  assert.equal(store.mobileKey, 'c'.repeat(64), 'the iPhone pairing survives');
  assert.equal(store.mobileKeyIsNew, false);
  assert.equal(store.value.theme, 'dark');
  assert.equal(store.loadError, 'repaired');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8'), raw, 'the original bytes are kept before any save');
});

test('new preferences are stored beside the 1.4-compatible settings block', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-settings-v15-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir);
  store.save({ language: 'en', autoUpdate: false, theme: 'light' });
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.deepEqual(Object.keys(saved.settings).sort(), Object.keys(LEGACY_DEFAULTS).sort(), 'only keys 1.4 understands live in settings');
  assert.deepEqual(saved.preferences, { language: 'en', autoUpdate: false, claudeNoticeSeen: false });
  const reloaded = new SettingsStore(dir);
  assert.equal(reloaded.value.language, 'en');
  assert.equal(reloaded.value.autoUpdate, false);
  assert.equal(reloaded.value.theme, 'light');
  assert.equal(reloaded.loadError, null);
});

test('manual usage keeps one decimal and labels are clipped by code point', () => {
  const account = validateAccount({ id: 'grok', providerId: 'grok', mode: 'manual', label: 'Grok', visible: true, manualWindows: [{ label: `${'a'.repeat(39)}😀😀`, usedPercent: 12.3, remainingPercent: 87.7 }] });
  assert.equal(account.manualWindows[0].usedPercent, 12.3);
  assert.equal(account.manualWindows[0].remainingPercent, 87.7);
  assert.equal(account.manualWindows[0].label.isWellFormed(), true);
  assert.equal([...account.manualWindows[0].label].length, 40);
});

test('the Fable tray metric is kept only for Claude accounts and drives the tray number', () => {
  const claude = prepareAccount({ providerId: 'claude', mode: 'isolated', label: 'Fable', showFable: true, trayMetric: 'fable' }).account;
  assert.equal(claude.trayMetric, 'fable');
  const codex = prepareAccount({ providerId: 'codex', mode: 'isolated', label: 'Codex', trayMetric: 'fable' }).account;
  assert.equal(codex.trayMetric, 'primary');
  assert.throws(() => validateAccount({ ...claude, trayMetric: 'other' }));
  const provider = { id: 'c', providerId: 'claude', accountLabel: '개인', showFable: true, trayMetric: 'fable', status: 'ok', windows: [window('five_hour', 12), window('seven_day', 40, { durationMinutes: 10080 }), window('seven_day_fable', 77, { label: 'Fable 주간', durationMinutes: 10080 })] };
  assert.equal(trayWindow(provider).id, 'seven_day_fable');
  assert.equal(trayWindow({ ...provider, trayMetric: 'primary' }).id, 'five_hour');
  assert.equal(trayWindow({ ...provider, showFable: false }).id, 'five_hour', 'hidden Fable never drives the icon');
  assert.equal(trayWindow({ ...provider, windows: provider.windows.slice(0, 2) }).id, 'five_hour', 'missing Fable falls back to the current limit');
  assert.match(singleTooltip(provider, NOW).split('\n')[1], /^Fable 77%/);
});

test('isolated environments replace case-variant Windows variables', () => {
  const env = accountEnvironment({ id: 'work', providerId: 'claude', mode: 'isolated' }, 'C:\\Data', { Claude_Config_Dir: 'D:\\other', Anthropic_Api_Key: 'secret', Path: 'C:\\bin' });
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join('C:\\Data', 'accounts', 'work', 'claude'));
  assert.equal(Object.keys(env).filter(key => key.toUpperCase() === 'CLAUDE_CONFIG_DIR').length, 1);
  assert.equal(Object.keys(env).some(key => key.toUpperCase() === 'ANTHROPIC_API_KEY'), false);
  assert.equal(env.Path, 'C:\\bin');
});

test('due reminders that can never be confirmed are retired instead of forcing refreshes for a day', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-reminders-v15-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = NOW;
  const sent = [];
  const reminders = new ResetReminders({ file: path.join(dir, 'r.json'), now: () => now, notify: item => sent.push(item) });
  const at = NOW + 3600000;
  const provider = (status, windows, captured = now) => ({ id: 'p', providerId: 'claude', name: 'Claude', status, stale: false, updatedAt: new Date(captured).toISOString(), windows });
  reminders.observe([provider('ok', [window('five_hour', 0, { resetsAt: new Date(at).toISOString() })])], true);
  now = at + 1000;
  assert.equal(reminders.hasPendingDue(), true);
  // Baseline 0, the next period already in use: not a confirmable drop.
  reminders.observe([provider('ok', [window('five_hour', 12, { resetsAt: new Date(at + 5 * 3600000).toISOString() })])], true);
  assert.equal(reminders.hasPendingDue(), false);
  assert.equal(sent.length, 0);
  // A logged-out account retires its due schedule as well.
  const second = new ResetReminders({ file: path.join(dir, 'r2.json'), now: () => now, notify: item => sent.push(item) });
  now = NOW;
  second.observe([provider('ok', [window('five_hour', 90, { resetsAt: new Date(at).toISOString() })])], true);
  now = at + 1000;
  second.observe([provider('disconnected', [])], true);
  assert.equal(second.hasPendingDue(), false);
  assert.equal(sent.length, 0);
});

test('the iPhone server serializes start/stop and survives accept errors', async () => {
  const errors = [];
  const server = new MobileServer({ key: 'd'.repeat(64), port: 0, getState: () => ({ providers: [] }), rendererDir: __dirname, widgetPath: __filename, onError: error => errors.push(error) });
  const starting = server.start();
  const stopping = server.stop();
  await Promise.all([starting, stopping]);
  assert.equal(server.info().enabled, false, 'a stop issued during start leaves the port closed');
  await server.start();
  assert.equal(server.info().enabled, true);
  server.server.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }));
  assert.equal(errors.length, 1, 'accept errors are reported, not thrown');
  await server.stop();
});

test('Fable is a Claude-only limit: other services keep a limit named Fable, and a Fable-only Claude account still shows it', () => {
  const vm = require('node:vm');
  const custom = { id: 'x', providerId: 'custom', status: 'ok', windows: [window('manual-0', 33, { label: 'Fable' })] };
  assert.equal(trayWindow(custom).id, 'manual-0', 'tray uses the custom limit even though it is called Fable');
  const context = { window: {}, navigator: {}, Intl, Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/common.js'), 'utf8'), context);
  const ui = context.window.LimitUI;
  assert.equal(ui.primaryWindow(custom).id, 'manual-0');
  const fableOnly = { id: 'c', providerId: 'claude', showFable: true, status: 'ok', windows: [window('seven_day_fable', 40, { label: 'Fable weekly', durationMinutes: 10080 })] };
  const view = ui.overviewWindows(fableOnly);
  assert.equal(view.primary, null);
  assert.equal(view.fable.length, 1);
});
