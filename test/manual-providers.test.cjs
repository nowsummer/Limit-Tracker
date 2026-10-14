'use strict';
// Services without automatic checks: Grok has no usage API, and Gemini is manual
// entry only from 1.6 because Google's Gemini CLI terms forbid third-party
// software from using the Gemini CLI sign-in to reach the services behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CATALOG, migrateLegacyAccount, validateAccount, prepareAccount, manualUsage } = require('../src/accounts.cjs');
const { migrateSavedSettings, SettingsStore } = require('../src/settings.cjs');
const { fetchGrokUsage } = require('../src/providers/grok.cjs');

const NOW = Date.parse('2026-10-04T09:00:00Z');
const savedGemini = () => [
  { id: 'claude', providerId: 'claude', mode: 'default', label: 'Personal', visible: true, trayVisible: true, showFable: false, trayMetric: 'primary', manualWindows: [], recordedAt: null },
  { id: 'gemini', providerId: 'gemini', mode: 'default', label: 'Google 개인', visible: true, trayVisible: false, showFable: false, trayMetric: 'primary', manualWindows: [], recordedAt: null },
  { id: 'google-work', providerId: 'gemini', mode: 'isolated', label: 'Google 회사', visible: false, trayVisible: true, showFable: false, trayMetric: 'primary', manualWindows: [], recordedAt: null },
  { id: 'gemini-manual', providerId: 'gemini', mode: 'manual', label: '직접', visible: true, manualWindows: [{ label: '일간', remainingPercent: 40, resetsAt: '2026-10-05T00:00:00Z' }], recordedAt: '2026-10-04T08:00:00.000Z' }
];
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-manual-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('Grok has honest unsupported automatic state and never treats API limits as weekly quota', async () => {
  const result = await fetchGrokUsage({ now: NOW, env: { XAI_API_KEY: 'test-only-api-key' }, fetchImpl: () => assert.fail('No API request') });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.manualSupported, true);
  assert.deepEqual(result.windows, []);
});

test('Gemini keeps its name but offers manual entry only', () => {
  const gemini = CATALOG.find(provider => provider.id === 'gemini');
  assert.equal(gemini.name, 'Gemini CLI');
  assert.deepEqual(gemini.modes, ['manual']);
  assert.equal(gemini.automatic, false);
  for (const mode of ['default', 'isolated']) {
    assert.throws(() => validateAccount({ id: 'g', providerId: 'gemini', mode, label: 'Gemini', visible: true }));
    assert.throws(() => prepareAccount({ providerId: 'gemini', mode, label: 'Gemini' }));
  }
  const created = prepareAccount({ providerId: 'gemini', mode: 'manual', label: 'Gemini', manualWindows: [{ label: '일간', remainingPercent: 70 }] });
  assert.equal(created.account.mode, 'manual');
  assert.equal(created.account.manualWindows[0].usedPercent, 30);
});

test('migration converts only former automatic Gemini accounts and never mutates its input', () => {
  const [claude, gemini, isolated, manual] = savedGemini();
  const before = structuredClone(gemini);
  const migrated = migrateLegacyAccount(gemini);
  assert.deepEqual(gemini, before);
  assert.deepEqual(migrated, { ...gemini, mode: 'manual', manualWindows: [], recordedAt: null });
  assert.equal(migrateLegacyAccount(isolated).mode, 'manual');
  for (const unchanged of [claude, manual, { ...claude, providerId: 'codex', mode: 'isolated' }, null, 'text', []]) assert.equal(migrateLegacyAccount(unchanged), unchanged);
});

test('saved automatic Gemini accounts load as manual entries with the same id, name, order and visibility', () => {
  const source = { trayMode: 'usage', accounts: savedGemini() };
  const before = structuredClone(source);
  const result = migrateSavedSettings(source);
  assert.deepEqual(source, before);
  assert.equal(result.repaired, false, 'a lossless conversion is not a repair');
  assert.deepEqual(result.accounts.map(account => [account.id, account.providerId, account.mode, account.label, account.visible, account.trayVisible]), [
    ['claude', 'claude', 'default', 'Personal', true, true],
    ['gemini', 'gemini', 'manual', 'Google 개인', true, false],
    ['google-work', 'gemini', 'manual', 'Google 회사', false, true],
    ['gemini-manual', 'gemini', 'manual', '직접', true, true]
  ]);
  assert.deepEqual(result.accounts[1].manualWindows, []);
  assert.equal(result.accounts[3].manualWindows[0].remainingPercent, 40, 'existing manual records are kept');
  // Accounts saved before the trayVisible key existed keep following the main-screen choice.
  const { trayVisible: _ignored, ...withoutTray } = savedGemini()[2];
  assert.equal(migrateSavedSettings({ accounts: [withoutTray] }).accounts[0].trayVisible, false);
});

test('a broken Gemini entry is still skipped and reported, as before', () => {
  const result = migrateSavedSettings({ accounts: [...savedGemini().slice(0, 2), { id: 'bad', providerId: 'gemini', mode: 'default', label: '', visible: true }] });
  assert.deepEqual(result.accounts.map(account => account.id), ['claude', 'gemini']);
  assert.equal(result.repaired, true);
});

test('settings stay readable by 1.4: migrated accounts are saved under the legacy key and loading never writes', t => {
  const dir = fixture(t);
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify({ settings: { refreshSeconds: 120, theme: 'system', accounts: savedGemini() }, preferences: { language: 'ko' }, mobileKey: 'a'.repeat(64) }, null, 2);
  fs.writeFileSync(file, original);
  const store = new SettingsStore(dir);
  assert.equal(store.loadError, null);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'opening the app does not rewrite the file');
  assert.equal(fs.existsSync(`${file}.bak`), false);
  assert.deepEqual(store.value.accounts.filter(account => account.providerId === 'gemini').map(account => account.mode), ['manual', 'manual', 'manual']);
  store.save({ theme: 'dark' });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(written.preferences, 'accounts'), false);
  // 1.4 reads accounts from `settings` and accepts Gemini in manual mode.
  assert.deepEqual(written.settings.accounts.map(account => [account.id, account.providerId, account.mode, account.label, account.visible]), [
    ['claude', 'claude', 'default', 'Personal', true],
    ['gemini', 'gemini', 'manual', 'Google 개인', true],
    ['google-work', 'gemini', 'manual', 'Google 회사', false],
    ['gemini-manual', 'gemini', 'manual', '직접', true]
  ]);
  assert.equal(written.mobileKey, 'a'.repeat(64));
  assert.equal(new SettingsStore(dir).loadError, null);
});

test('an empty Gemini record explains why it is manual; other services keep the generic hint', () => {
  const [, gemini] = migrateSavedSettings({ accounts: savedGemini() }).accounts;
  const usage = manualUsage(gemini);
  assert.equal(usage.status, 'unsupported');
  assert.equal(usage.errorKey, 'account.geminiManualOnly');
  assert.match(usage.error, /Google 약관/);
  const grok = prepareAccount({ providerId: 'grok', mode: 'manual', label: 'Grok' }).account;
  assert.equal(manualUsage(grok).errorKey, 'account.manualEmpty');
  const filled = manualUsage(migrateSavedSettings({ accounts: savedGemini() }).accounts[3]);
  assert.equal(filled.status, 'ok'); assert.equal(filled.errorKey, null);
});

test('no app code reads the Gemini CLI sign-in or calls the services behind it', () => {
  const root = path.join(__dirname, '..', 'src');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
  assert.equal(fs.existsSync(path.join(root, 'providers', 'gemini.cjs')), false);
  const forbidden = [/GOCSPX/, /oauth_creds/, /cloudcode-pa/, /oauth2\.googleapis\.com/, /gemini-cli/i, /GEMINI_CLI_HOME/, /@google\//];
  const hits = [];
  for (const file of walk(root).filter(file => /\.(cjs|js|html)$/.test(file))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) if (pattern.test(text)) hits.push(`${path.relative(root, file)}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
});
