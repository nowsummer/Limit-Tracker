'use strict';
// Design preview: renders the real windows with synthetic *automatic* accounts
// (status, plan, login deadline, "usage page" links) instead of manual records.
// No authentication, network or settings of this PC are touched.
// Run: npx electron scripts/preview-ui.cjs [light|dark] [ko|en]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const theme = process.argv.find(arg => arg === 'light' || arg === 'dark') || 'light';
const language = process.argv.find(arg => arg === 'ko' || arg === 'en') || 'ko';
const nearLimit = process.argv.includes('--near-limit');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-preview-'));
// A bare Electron script reports Electron's own version; show the app's.
app.setVersion(require('../package.json').version);
app.setPath('userData', folder); process.argv.push('--hidden');
const now = Date.now();
const at = minutes => new Date(now + minutes * 60000).toISOString();

const claude = require('../src/providers/claude.cjs');
const codex = require('../src/providers/codex.cjs');
const claudeData = {
  personal: [{ kind: 'session', percent: 34, resets_at: at(131) }, { kind: 'weekly_all', percent: 58, resets_at: at(4410) }, { kind: 'weekly_scoped', percent: 41, resets_at: at(4410), scope: { model: { display_name: 'Fable' } } }, { kind: 'weekly_scoped', percent: 92, resets_at: at(2900), scope: { model: { display_name: 'Opus' } } }],
  work: [{ kind: 'session', percent: 12, resets_at: at(46) }, { kind: 'weekly_all', percent: 87, resets_at: at(1500) }, { kind: 'weekly_scoped', percent: 73, resets_at: at(1500), scope: { model: { display_name: 'Fable' } } }],
};
claude.fetchClaudeUsage = async ({ env }) => {
  const isolated = Boolean(env?.CLAUDE_CONFIG_DIR);
  return { id: 'claude', name: 'Claude Code', status: 'ok', plan: 'Max', windows: claude.parseWindows({ limits: claudeData[isolated ? 'work' : 'personal'] }), updatedAt: new Date().toISOString(), error: null, source: '', sourceKey: 'claude.source', unofficial: true, cached: false, stale: false, loginExpiresAt: new Date(now + (isolated ? 2 : 27) * 86400000).toISOString() };
};
codex.fetchCodexUsage = async () => ({ ...codex.normalizeCodexLimits({ rateLimits: { primary: { usedPercent: nearLimit ? 96 : 23, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 9000 }, secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 300000 }, ...(nearLimit ? { credits: { hasCredits: true, balance: '12.5' } } : {}) }, ...(nearLimit ? { rateLimitResetCredits: { availableCount: 2, credits: [{ status: 'available', expiresAt: Math.floor(now / 1000) + 86400 }] } } : {}) }), id: 'codex', name: 'Codex', status: 'ok', plan: 'Plus', updatedAt: new Date().toISOString() });

const accounts = [
  { id: 'claude', providerId: 'claude', label: language === 'en' ? 'Personal' : '개인', mode: 'default', visible: true, trayVisible: true, showFable: true, trayMetric: 'primary' },
  { id: 'claude-work', providerId: 'claude', label: language === 'en' ? 'Work' : '회사', mode: 'isolated', visible: true, trayVisible: true, showFable: true, trayMetric: 'primary' },
  { id: 'codex', providerId: 'codex', label: language === 'en' ? 'Default account' : '기본 계정', mode: 'default', visible: true, trayVisible: true, showFable: false, trayMetric: 'primary' },
];
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: { accounts, trayMode: 'usage', startHidden: true, theme, refreshSeconds: 300, notifications: false, resetNotifications: false }, preferences: { language, autoUpdate: false, claudeNoticeSeen: true } }));
require('../src/main.cjs');

const out = path.resolve(__dirname, '..', 'artifacts', 'preview'); fs.mkdirSync(out, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (win, script) => win.webContents.executeJavaScript(script);
async function waitFor(fn, timeout = 20000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(100); } throw new Error('preview timed out'); }
async function shot(win, name) { await js(win, 'document.fonts.ready'); await delay(400); fs.writeFileSync(path.join(out, `${theme}-${language}${nearLimit ? '-near-limit' : ''}-${name}.png`), (await win.webContents.capturePage()).toPNG()); }

app.whenReady().then(async () => {
  app.emit('activate');
  const main = await waitFor(() => BrowserWindow.getAllWindows().find(win => win.getBounds().width > 500));
  await waitFor(async () => !main.webContents.isLoading() && await js(main, "document.querySelectorAll('.provider-card').length === 3 && !document.querySelector('.provider-card.checking')"));
  await shot(main, 'main');
  await js(main, "document.getElementById('settings-button').click()"); await delay(300); await shot(main, 'settings');
  await js(main, "document.querySelector('[data-focus-key=\"codex-trayVisible\"]').checked = false"); await shot(main, 'settings-switch-off');
  await js(main, "document.querySelector('#login-period-tip .info-tip-button')?.dispatchEvent(new MouseEvent('mouseenter'))"); await delay(150); await shot(main, 'settings-tip');
  await js(main, "document.querySelector('#login-period-tip .info-tip-button')?.dispatchEvent(new MouseEvent('mouseleave')); document.querySelector('[data-focus-key=\"claude-work-settings-edit\"]').click()"); await delay(300); await shot(main, 'account');
  await js(main, "document.getElementById('account-login-row').scrollIntoView({ block: 'center' })"); await delay(100);
  await js(main, "document.querySelector('#account-login-tip .info-tip-button')?.dispatchEvent(new MouseEvent('mouseenter'))"); await delay(150); await shot(main, 'account-tip');
  await js(main, "document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  await js(main, "document.getElementById('help-button').click()"); await delay(300); await shot(main, 'help');
  await js(main, "document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  await js(main, "window.limitTracker.windowAction('show-popup')");
  const popup = await waitFor(() => { const win = BrowserWindow.getAllWindows().find(w => w.getBounds().width < 500); return win && win.isVisible() ? win : null; });
  await waitFor(async () => await js(popup, "document.querySelectorAll('.popup-provider').length === 3"));
  await delay(500); await shot(popup, 'popup');
  if (nearLimit) {
    const assert = require('node:assert/strict');
    const { MobileServer } = require('../src/mobile-server.cjs');
    const state = await js(main, 'window.limitTracker.getState()');
    const server = new MobileServer({ key: 'd'.repeat(64), port: 0, rendererDir: path.resolve(__dirname, '../src/renderer'), widgetPath: path.resolve(__dirname, '../src/widget/LimitTracker.js'), getState: () => state });
    await server.start();
    const phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await phone.loadURL(`http://127.0.0.1:${server.port}/?key=${'d'.repeat(64)}`);
      await waitFor(async () => await js(phone, "document.querySelectorAll('.mobile-provider').length === 3"));
      for (const width of [320, 390]) {
        phone.setContentSize(width, 844); await delay(150);
        assert.equal(await js(phone, 'document.documentElement.scrollWidth > innerWidth'), false, `Mobile overflow at ${width}`);
        assert.equal(await js(phone, "document.querySelectorAll('.after-limit').length"), 1);
        await shot(phone, `iphone-${width}`);
      }
    } finally { phone.destroy(); await server.stop(); }
  }
  console.log(JSON.stringify({ ok: true, out }));
  app.exit(0);
}).catch(error => { console.error(error.stack || error.message); app.exit(1); });
