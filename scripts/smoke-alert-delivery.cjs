'use strict';
// Full main-process notification path with synthetic usage and simulated OS toasts.
// No user credentials, real notifications, clipboard, or updater operations.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-alert-smoke-'));
app.setPath('userData', folder); process.argv.push('--hidden');
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: {
  accounts: [{ id: 'synthetic', providerId: 'claude', label: 'Synthetic', mode: 'default', visible: true, trayVisible: true }],
  startHidden: true, notifications: false, resetNotifications: false,
}, preferences: { autoUpdate: false } }));
const expires = Date.now() + 12 * 3600000;
let used = 20, resetsAt = Date.now() + 3600000;
require('../src/providers/claude.cjs').fetchClaudeUsage = async () => ({
  id: 'claude', status: 'ok', updatedAt: new Date().toISOString(), loginExpiresAt: new Date(expires).toISOString(),
  windows: [{ id: 'five_hour', label: '5시간', labelKey: 'window.fiveHour', usedPercent: used, remainingPercent: 100 - used, durationMinutes: 300, resetsAt: new Date(resetsAt).toISOString() }],
});
require('../src/providers/claude.cjs').findClaudeExecutable = async () => { await new Promise(resolve => setTimeout(resolve, 60)); return process.execPath; };
let loginLaunches = 0, loginChild;
require('../src/login.cjs').launchLoginProcess = async () => {
  loginLaunches++;
  await new Promise(resolve => setTimeout(resolve, 60));
  loginChild = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  return loginChild;
};
const { ResetReminders } = require('../src/reset-reminders.cjs');
require('../src/reset-reminders.cjs').ResetReminders = class extends ResetReminders {
  constructor(options) { super({ ...options, retryAfterMs: 0 }); }
};
const { AlertLog } = require('../src/alert-log.cjs');
let log;
require('../src/alert-log.cjs').AlertLog = class extends AlertLog {
  constructor(file, options = {}) { super(file, { ...options, retryAfterMs: 0 }); if (file?.endsWith('relogin-alerts.json')) log = this; }
};
let attempts = 0, failNext = true;
const notices = [];
class TestNotification extends EventEmitter {
  constructor(options) { super(); notices.push(options); }
  static isSupported() { return true; }
  show() { ++attempts; const accepted = !failNext; failNext = false; setImmediate(() => { this.emit(accepted ? 'show' : 'failed'); if (accepted) this.emit('close'); }); }
}
const source = path.resolve(__dirname, '../src/main.cjs');
const main = new Module(source, module);
main.filename = source; main.paths = Module._nodeModulePaths(path.dirname(source));
const normalRequire = main.require.bind(main);
main.require = name => name === 'electron' ? new Proxy(electron, { get: (target, key) => key === 'Notification' ? TestNotification : target[key] }) : normalRequire(name);
main._compile(fs.readFileSync(source, 'utf8'), source);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { const start = Date.now(); while (Date.now() - start < 20000) { const value = await fn(); if (value) return value; await delay(30); } throw new Error('Alert smoke timed out'); }
app.whenReady().then(async () => {
  await waitFor(() => attempts === 1 && log && log.pending.size === 0);
  const key = `login:synthetic:${expires}`;
  assert.equal(log.has(key), false, 'failed delivery must not consume the deadline');
  assert.equal(new AlertLog(log.file).has(key), false, 'failure must not survive restart as sent');
  app.emit('activate');
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0]);
  await waitFor(async () => !win.webContents.isLoading() && win.webContents.executeJavaScript('!!window.limitTracker'));
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  await waitFor(() => attempts === 2 && log.pending.size === 0);
  assert.equal(new AlertLog(log.file).has(key), true, 'successful retry is persisted');
  await win.webContents.executeJavaScript('Promise.all([window.limitTracker.refresh(), window.limitTracker.refresh()])');
  assert.equal(attempts, 2, 'later polls must not repeat the accepted toast');
  await win.webContents.executeJavaScript("window.limitTracker.setSettings({ notifications: true, language: 'en' })");
  used = 79; await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  used = 81; failNext = true;
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  await waitFor(() => attempts === 3); await delay(30);
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  await waitFor(() => attempts === 4); await delay(30);
  assert.doesNotMatch(notices[3].body, /[가-힣]/, 'usage notification follows the selected language');
  assert.match(notices[3].body, /81/);
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  assert.equal(attempts, 4, 'successful threshold warning is not repeated');

  used = 90; resetsAt = Date.now() + 1200;
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  await win.webContents.executeJavaScript('window.limitTracker.setSettings({ resetNotifications: true })');
  await delay(Math.max(0, resetsAt - Date.now()) + 50);
  used = 5; resetsAt = Date.now() + 3600000; failNext = true;
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  await waitFor(() => attempts === 5); await delay(30);
  const saved = () => JSON.parse(fs.readFileSync(path.join(folder, 'reset-reminders.json'), 'utf8'));
  assert.ok(saved().some(item => item.confirmedAt && !item.sent), 'failed reset alert remains retryable on disk');
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  await waitFor(() => attempts === 6); await delay(30);
  assert.ok(saved().some(item => item.confirmedAt && item.sent), 'accepted reset alert is persisted');
  await win.webContents.executeJavaScript('window.limitTracker.refresh()');
  assert.equal(attempts, 6, 'successful reset warning is not repeated');

  await win.webContents.executeJavaScript("Promise.all([window.limitTracker.openExternal('login', 'synthetic'), window.limitTracker.openExternal('login', 'synthetic')])");
  assert.equal(loginLaunches, 1, 'simultaneous login requests share discovery and launch');
  await win.webContents.executeJavaScript("window.limitTracker.openExternal('login', 'synthetic')");
  assert.equal(loginLaunches, 1, 'an already-open login is reused');
  loginChild.exitCode = 0; loginChild.emit('exit', 0);
  await win.webContents.executeJavaScript("window.limitTracker.openExternal('login', 'synthetic')");
  assert.equal(loginLaunches, 2, 'a finished login permits another attempt');
  const report = { success: true, attempts, failedAttemptPersisted: false, successfulAttemptPersisted: true, duplicateDelivery: false, usageDeliveryRetried: true, resetDeliveryRetried: true, englishUsageNotification: true, concurrentLoginCoalesced: true, actualWindowsToasts: 0, actualLoginProcesses: 0, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.resolve(__dirname, '../artifacts/alert-delivery-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
