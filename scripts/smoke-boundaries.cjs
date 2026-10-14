'use strict';
// Empty and maximum-size account lists, using an isolated profile and manual data.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-boundary-smoke-'));
app.setPath('userData', folder); process.argv.push('--hidden');
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: { accounts: [], notifications: false, resetNotifications: false, startHidden: true }, preferences: { autoUpdate: false } }));
const runtime = require('../src/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { const start = Date.now(); while (Date.now() - start < 15000) { if (await fn()) return; await delay(50); } throw new Error('Boundary smoke timed out'); }
const js = (win, code) => win.webContents.executeJavaScript(code);
const artifact = file => path.resolve(__dirname, '../artifacts', file);
const errors = [];
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_event, details) => { if (details?.level === 'error') errors.push(details.message); }));
app.whenReady().then(async () => {
  app.emit('activate');
  await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getBounds().width > 500));
  const main = BrowserWindow.getAllWindows().find(win => win.getBounds().width > 500);
  await waitFor(async () => !main.webContents.isLoading() && await js(main, '!!window.limitTracker'));
  await waitFor(async () => (await js(main, 'window.limitTracker.getState()')).settings.accounts.length === 0);
  assert.equal(runtime.runtimeDiagnostics().trayCount, 1, 'empty list keeps an app tray to reopen settings');
  assert.equal(await js(main, "document.querySelectorAll('.provider-card').length"), 0);
  const accounts = Array.from({ length: 20 }, (_, index) => ({
    id: `boundary-${index}`, providerId: 'custom', mode: 'manual', visible: true, trayVisible: index < 4,
    label: `${String(index).padStart(2, '0')} ${'긴 계정 이름 '.repeat(4)}`.slice(0, 40),
    manualWindows: Array.from({ length: 8 }, (_, w) => ({ label: `${w} ${'긴 한도 이름 '.repeat(4)}`.slice(0, 40), usedPercent: w === 0 ? 0 : w === 7 ? 100 : w * 12.3, resetsAt: w % 2 ? null : new Date(Date.now() + 7200000).toISOString(), durationMinutes: w === 0 ? 300 : w === 1 ? 10080 : null })),
  }));
  const result = await js(main, `window.limitTracker.setSettings({accounts:${JSON.stringify(accounts)}})`);
  assert.notEqual(result?.ok, false);
  await waitFor(async () => await js(main, "document.querySelectorAll('.provider-card').length === 20"));
  main.setBounds({ width: 600 });
  const measurements = [];
  for (const theme of ['light', 'dark']) {
    await js(main, `window.limitTracker.setSettings({theme:'${theme}'})`); await delay(200);
    const size = await js(main, '({width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight})');
    assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
    assert.ok(main.getBounds().height <= screen.getDisplayMatching(main.getBounds()).workArea.height + 2);
    assert.ok(size.scrollHeight > size.height, '20 accounts remain reachable by scrolling');
    measurements.push({ theme, ...size });
    fs.writeFileSync(artifact(`boundary-${theme}.png`), (await main.webContents.capturePage()).toPNG());
  }
  const rejected = await js(main, `window.limitTracker.setSettings({accounts:${JSON.stringify([...accounts, { ...accounts[0], id: 'overflow' }])}}).then(() => false, () => true)`);
  assert.equal(rejected, true, '21st account is rejected without losing the existing 20');
  assert.equal((await js(main, 'window.limitTracker.getState()')).settings.accounts.length, 20);
  await js(main, "document.getElementById('settings-button').click()");
  await waitFor(async () => await js(main, "document.querySelectorAll('.account-row').length === 20"));
  const settingsSize = await js(main, "(() => { const c = document.querySelector('#settings-dialog .sheet-content'); return {scroll:c.scrollHeight,height:c.clientHeight,width:c.clientWidth,scrollWidth:c.scrollWidth}; })()");
  assert.ok(settingsSize.scroll > settingsSize.height);
  assert.ok(settingsSize.scrollWidth <= settingsSize.width + 1);
  await js(main, "document.getElementById('settings-dialog').close(); window.limitTracker.windowAction('show-popup')");
  await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getBounds().width < 500));
  const popup = BrowserWindow.getAllWindows().find(win => win.getBounds().width < 500);
  await waitFor(async () => !popup.webContents.isLoading() && await js(popup, "document.querySelectorAll('.popup-provider').length === 4"));
  await js(popup, "document.querySelector('details').open = true"); await delay(300);
  const popupSize = await js(popup, "(() => { const c = document.getElementById('popup-providers'); return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,scroll:c.scrollHeight,client:c.clientHeight}; })()");
  assert.ok(popupSize.scrollWidth <= popupSize.width + 1);
  assert.ok(popupSize.scroll > popupSize.client);
  assert.ok(popup.getBounds().height <= screen.getDisplayMatching(popup.getBounds()).workArea.height + 2);
  assert.deepEqual(errors, []);
  const report = { success: true, accountCounts: [0, 20], rejectedCount: 21, limitsPerAccount: 8, measurements, settingsSize, popupSize, errors };
  fs.writeFileSync(artifact('boundary-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
