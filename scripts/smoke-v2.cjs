'use strict';
// Deterministic UI verification: no real authentication or model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-v2-smoke-'));
app.setPath('userData', folder); process.argv.push('--hidden');
const accounts = ['claude', 'claude', 'codex'].map((providerId, i) => ({ id: `qa-${i}`, providerId, label: i === 1 ? '회사 계정' : '기본 계정', mode: 'manual', visible: true, recordedAt: new Date().toISOString(), manualWindows: [{ id: 'short', label: '5시간', usedPercent: [7, 0, 100][i], remainingPercent: [93, 100, 0][i], resetsAt: new Date(Date.now() + 7140000).toISOString(), durationMinutes: 300 }, { id: 'week', label: '주간', usedPercent: [11, 95, 68][i], remainingPercent: [89, 5, 32][i], resetsAt: new Date(Date.now() + 264600000).toISOString(), durationMinutes: 10080 }] }));
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: { accounts, startHidden: true, theme: 'dark', refreshSeconds: 300, notifications: false, resetNotifications: false }, mobileKey: 'a'.repeat(64) }));
const runtime = require('../src/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 20000) { const start = Date.now(); while (Date.now() - start < timeout) { const v = await fn(); if (v) return v; await delay(100); } throw new Error('UI verification timed out'); }
const root = path.resolve('artifacts'); fs.mkdirSync(root, { recursive: true });
const diagnostics = []; const checks = [];
app.on('web-contents-created', (_event, contents) => { contents.on('console-message', (_event, details) => { if (details.level === 'error') diagnostics.push(details.message); }); });
async function capture(win, name) { await win.webContents.executeJavaScript('document.fonts.ready'); await delay(650); fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function ready(win, selector) { await waitFor(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript(`document.querySelectorAll('${selector}').length === 3`)); }
async function fits(win, selector, scrollSelector = 'html') {
  const sizes = await win.webContents.executeJavaScript(`(() => { const root = document.querySelector('${scrollSelector}'); return { w: innerWidth, h: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, cards: [...document.querySelectorAll('${selector}')].map(e => ({ top:e.getBoundingClientRect().top, bottom:e.getBoundingClientRect().bottom, right:e.getBoundingClientRect().right })) }; })()`);
  assert.equal(sizes.cards.length, 3); assert.ok(sizes.scrollWidth <= sizes.w, JSON.stringify(sizes)); assert.ok(sizes.scrollHeight <= sizes.clientHeight + 1, JSON.stringify(sizes)); assert.ok(sizes.cards.every(c => c.top >= 0 && c.bottom <= sizes.h && c.right <= sizes.w), JSON.stringify(sizes)); return sizes;
}
app.whenReady().then(async () => {
  await waitFor(() => runtime.runtimeDiagnostics().trayCount === 3);
  assert.equal(BrowserWindow.getAllWindows().length, 0); checks.push('tray-only startup creates zero BrowserWindows; three native account trays');
  app.emit('activate');
  let main = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.getBounds().width > 500)); await ready(main, '.provider-card');
  await main.webContents.executeJavaScript('document.fonts.ready');
  assert.equal(await main.webContents.executeJavaScript("document.querySelectorAll('.remaining-ring').length"), 0);
  assert.deepEqual(await main.webContents.executeJavaScript("[...document.querySelectorAll('.usage-window-value')].map(e=>e.textContent)"), ['7%', '11%', '0%', '95%', '100%', '68%']);
  await fits(main, '.provider-card'); await capture(main, 'v2-main-dark');
  main.setSize(880, 760); await delay(150); await fits(main, '.provider-card');
  main.setSize(700, 600); await delay(150); const minLayout = await fits(main, '.provider-card'); await capture(main, 'v2-main-min');
  await main.webContents.executeJavaScript("window.limitTracker.setSettings({theme:'light'})"); await capture(main, 'v2-main-light');
  checks.push('three accounts fit main at 880x760 and 700x600, light/dark; 0/100 used displayed correctly');
  const snapshot = await main.webContents.executeJavaScript('window.limitTracker.getState()');
  await main.webContents.executeJavaScript('window.cardBefore = document.querySelector(".provider-card")');
  main.webContents.send('state:changed', { ...snapshot, refreshing: true, providers: snapshot.providers.map(p => ({ ...p, refreshing: true })) }); await delay(100);
  assert.equal(await main.webContents.executeJavaScript('window.cardBefore === document.querySelector(".provider-card")'), true);
  assert.equal(await main.webContents.executeJavaScript('document.querySelector("#refresh-label").textContent'), '새로고침');
  checks.push('background refresh preserves card DOM and stable refresh label');
  main.webContents.send('state:changed', snapshot);
  await main.webContents.executeJavaScript("document.getElementById('settings-button').click()"); await capture(main, 'v2-settings');
  await main.webContents.executeJavaScript("document.querySelectorAll('.move-up')[2].click()");
  await waitFor(async () => (await main.webContents.executeJavaScript('window.limitTracker.getState()')).settings.accounts[1].id === 'qa-2');
  assert.deepEqual(runtime.runtimeDiagnostics().trayIds, ['qa-0', 'qa-2', 'qa-1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'settings.json'), 'utf8')).settings.accounts.map(a => a.id), ['qa-0', 'qa-2', 'qa-1']);
  await main.webContents.executeJavaScript("document.getElementById('settings-dialog').close(); window.limitTracker.setSettings({trayMode:'primary',primaryAccountId:'qa-2'})");
  assert.deepEqual(runtime.runtimeDiagnostics().trayIds, ['qa-2']);
  await main.webContents.executeJavaScript("window.limitTracker.setSettings({trayMode:'app'})"); assert.equal(runtime.runtimeDiagnostics().trayCount, 1);
  await main.webContents.executeJavaScript("window.limitTracker.setSettings({trayMode:'accounts',theme:'dark'})"); assert.equal(runtime.runtimeDiagnostics().trayCount, 3);
  await main.webContents.executeJavaScript("window.limitTracker.windowAction('show-popup'); window.limitTracker.windowAction('show-main')"); await delay(500);
  assert.equal(runtime.runtimeDiagnostics().popupLoaded, false); checks.push('double-click cancels an unready popup without stealing main focus');
  await main.webContents.executeJavaScript("window.limitTracker.windowAction('show-popup')");
  const popup = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.getBounds().width < 500)); await ready(popup, '.popup-provider');
  const popupLayout = await fits(popup, '.popup-provider', '#popup-providers'); await capture(popup, 'v2-popup-dark');
  assert.deepEqual(await popup.webContents.executeJavaScript("[...document.querySelectorAll('.popup-provider')].map(e=>e.dataset.accountId)"), ['qa-0', 'qa-2', 'qa-1']);
  checks.push('real reorder button saves order; primary/app/account trays; popup 380x540 fits three accounts in same order');
  await popup.webContents.executeJavaScript("window.limitTracker.windowAction('show-main')");
  await main.webContents.executeJavaScript("document.getElementById('add-account-button').click(); document.getElementById('account-provider').value='grok'; document.getElementById('account-provider').dispatchEvent(new Event('change')); document.getElementById('account-label').value='검증 계정'; document.querySelector('.manual-label').value='주간'; document.querySelector('.manual-used').value='27'; document.getElementById('save-account').click()");
  await waitFor(async () => (await main.webContents.executeJavaScript('window.limitTracker.getState()')).settings.accounts.length === 4);
  const added = (await main.webContents.executeJavaScript('window.limitTracker.getState()')).settings.accounts.find(a=>a.providerId==='grok');
  assert.equal(added.manualWindows[0].usedPercent, 27); assert.equal(added.manualWindows[0].remainingPercent, 73);
  await main.webContents.executeJavaScript(`window.limitTracker.removeAccount(${JSON.stringify(added.id)})`); checks.push('manual used input serializes used27/remaining73; account removal');
  const { MobileServer } = require('../src/mobile-server.cjs');
  let phoneSnapshot = await main.webContents.executeJavaScript('window.limitTracker.getState()');
  const phoneServer = new MobileServer({ key: 'b'.repeat(64), port: 0, getState: () => phoneSnapshot, rendererDir: path.resolve('src/renderer'), widgetPath: path.resolve('src/widget/LimitTracker.js') });
  await phoneServer.start();
  const phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { sandbox:true, contextIsolation:true, nodeIntegration:false } });
  await phone.loadURL(`http://127.0.0.1:${phoneServer.port}/?key=${'b'.repeat(64)}`); await ready(phone, '.mobile-provider'); await capture(phone, 'v2-iphone');
  assert.equal(await phone.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false);
  assert.ok((await phone.webContents.executeJavaScript('document.body.innerText')).includes('사용'));
  const response = await fetch(`http://127.0.0.1:${phoneServer.port}/api/usage?key=${'b'.repeat(64)}`); const mobileData = await response.json(); assert.deepEqual(mobileData.providers.map(p => p.id), ['qa-0', 'qa-2', 'qa-1']);
  for (const [width, height] of [[375,812],[812,375]]) {
    phone.setContentSize(width,height); await delay(200);
    assert.equal(await phone.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false, `Mobile overflow at ${width}`);
  }
  phone.setContentSize(375,812); phone.webContents.setZoomFactor(1.5); await delay(200);
  assert.equal(await phone.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false, '150% mobile zoom overflow');
  checks.push('mobile 375px portrait, landscape and 150% zoom no horizontal overflow');
  phone.destroy(); await phoneServer.stop(); checks.push('mobile renderer no horizontal overflow; shared account order');
  await main.webContents.executeJavaScript("window.limitTracker.windowAction('close')"); await waitFor(() => BrowserWindow.getAllWindows().length === 0, 15000);
  assert.equal(runtime.runtimeDiagnostics().trayCount, 3); checks.push('all hidden windows released after grace period; tray stays active');
  app.emit('activate'); main = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.getBounds().width > 500)); await ready(main, '.provider-card');
  assert.deepEqual(await main.webContents.executeJavaScript("[...document.querySelectorAll('.provider-card')].map(e=>e.dataset.accountId)"), ['qa-0','qa-2','qa-1']); checks.push('released main recreated with persisted account order');
  assert.equal(diagnostics.length, 0, diagnostics.join('\n'));
  const result = { success:true, checks, minLayout, popupLayout, runtime:runtime.runtimeDiagnostics(), consoleErrors:diagnostics };
  fs.writeFileSync(path.join(root,'verification-v2.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result)); app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
