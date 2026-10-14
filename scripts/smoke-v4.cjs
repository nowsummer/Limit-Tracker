'use strict';
// Derived from smoke-v2: isolated synthetic accounts, no real authentication or model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-v4-smoke-'));
app.setPath('userData', folder); process.argv.push('--hidden');
const recordedAt = new Date().toISOString();
const usage = (id, label, usedPercent, durationMinutes) => ({ id, label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: new Date(Date.now() + (durationMinutes === 300 ? 7140000 : 264600000)).toISOString(), durationMinutes });
const accounts = ['claude', 'claude', 'codex'].map((providerId, i) => ({
  id: `qa-${i}`, providerId, label: i === 1 ? '회사 계정 이름이 길어도 화면과 트레이 설정을 모두 확인하는 테스트'.slice(0, 40) : '기본 계정',
  mode: 'manual', visible: true, trayVisible: true, showFable: providerId === 'claude', recordedAt,
  manualWindows: [usage('short', '5시간', [7, 0, 100][i], 300), usage('week', '주간', [11, 95, 68][i], 10080),
    ...(providerId === 'claude' ? [usage('seven_day_fable', 'Fable 주간', [24, 73][i], 10080), usage('seven_day_sonnet', 'Sonnet 주간', [38, 62][i], 10080)] : [])]
}));
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: { accounts, trayMode: 'usage', startHidden: true, theme: 'dark', refreshSeconds: 300, notifications: false, resetNotifications: false }, mobileKey: 'a'.repeat(64) }));
const diagnostics = []; const checks = [];
app.on('web-contents-created', (_event, contents) => { contents.on('console-message', (_event, details) => { if (details.level === 'error') diagnostics.push(details.message); }); });
const runtime = require('../src/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 20000, message = 'UI verification timed out') {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(message);
}
const root = path.resolve('artifacts'); fs.mkdirSync(root, { recursive: true });
const passed = message => { checks.push(message); console.log(`PASS: ${message}`); };
const js = (win, script) => win.webContents.executeJavaScript(script);
const snapshot = win => js(win, 'window.limitTracker.getState()');
const ids = (win, selector) => js(win, `[...document.querySelectorAll(${JSON.stringify(selector)})].map(e => e.dataset.accountId)`);
async function ready(win, selector, count = 3) {
  await waitFor(async () => !win.isDestroyed() && !win.webContents.isLoading() && await js(win, `document.querySelectorAll(${JSON.stringify(selector)}).length === ${count}`));
}
async function capture(win, name) {
  await js(win, 'document.fonts.ready'); await delay(350);
  fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function fits(win, selector, scrollSelector = 'html', count = 3) {
  const sizes = await js(win, `(() => { const root = document.querySelector(${JSON.stringify(scrollSelector)}); return { w: innerWidth, h: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, cards: [...document.querySelectorAll(${JSON.stringify(selector)})].map(e => ({ top:e.getBoundingClientRect().top, bottom:e.getBoundingClientRect().bottom, right:e.getBoundingClientRect().right })) }; })()`);
  assert.equal(sizes.cards.length, count); assert.ok(sizes.scrollWidth <= sizes.w + 1, JSON.stringify(sizes));
  assert.ok(sizes.scrollHeight <= sizes.clientHeight + 1, JSON.stringify(sizes));
  assert.ok(sizes.cards.every(card => card.top >= 0 && card.bottom <= sizes.h + 1 && card.right <= sizes.w + 1), JSON.stringify(sizes));
  return sizes;
}
async function savePatch(win, id, patch) {
  const result = await js(win, `(async () => { const state = await window.limitTracker.getState(); return window.limitTracker.saveAccount({...state.settings.accounts.find(account => account.id === ${JSON.stringify(id)}), ...${JSON.stringify(patch)}}); })()`);
  assert.notEqual(result?.ok, false, result?.error);
  return result;
}
async function openMain() {
  app.emit('activate');
  const win = await waitFor(() => BrowserWindow.getAllWindows().find(window => window.getBounds().width > 500));
  await waitFor(async () => !win.webContents.isLoading() && await js(win, 'typeof window.limitTracker?.getState === "function"'));
  return win;
}
async function openPopup(main, count = 3) {
  await js(main, "window.limitTracker.windowAction('show-popup')");
  const win = await waitFor(() => BrowserWindow.getAllWindows().find(window => window.getBounds().width < 500));
  await ready(win, '.popup-provider', count);
  return win;
}
async function toggleSetting(win, focusKey, checked) {
  await js(win, `(() => { const input = document.querySelector('[data-focus-key="${focusKey}"]'); if (!input) throw new Error('Missing ${focusKey}'); input.checked = ${checked}; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
}
function expiredFixture(state) {
  return { ...state, providers: state.providers.map(provider => ({
    ...provider, manual: provider.providerId !== 'codex', mode: provider.providerId === 'codex' ? 'default' : 'manual', stale: false, status: 'ok',
    windows: provider.windows.map(window => ({ ...window, resetsAt: new Date(Date.now() - 1000).toISOString() }))
  })) };
}
app.whenReady().then(async () => {
  await waitFor(() => runtime.runtimeDiagnostics().trayCount === 3);
  const originalTrays = runtime.runtimeDiagnostics().trayInstances;
  assert.equal(new Set(Object.values(originalTrays).map(entry => entry.guid)).size, 3);
  assert.ok(Object.values(originalTrays).every(entry => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.guid)), 'each native tray must have an account GUID');
  assert.equal(app.getPath('userData'), folder); assert.equal(BrowserWindow.getAllWindows().length, 0);
  passed('isolated tray-only startup creates zero BrowserWindows and three account trays');
  let main = await openMain(); await ready(main, '.provider-card'); await js(main, 'document.fonts.ready');
  assert.equal(await js(main, "document.querySelectorAll('.remaining-ring').length"), 0);
  assert.deepEqual(await js(main, "[...document.querySelectorAll('.overview-windows .usage-window-value')].map(e=>e.textContent)"), ['7%', '11%', '0%', '95%', '100%', '68%']);
  assert.equal(await js(main, "document.querySelectorAll('.provider-bottom .window-summary').length"), 2);
  assert.equal(await js(main, "[...document.querySelectorAll('.provider-bottom .provider-status.manual')].every(e=>e.title.includes('입력') && e.title.includes('자동 갱신되지'))"), true);
  const defaultLayout = await fits(main, '.provider-card'); await capture(main, 'v4-main-dark');
  main.setSize(880, 760); await delay(150); await fits(main, '.provider-card');
  main.setSize(700, 600); await delay(150); const minLayout = await fits(main, '.provider-card'); await capture(main, 'v4-main-min');
  await js(main, "window.limitTracker.setSettings({theme:'light'})"); await capture(main, 'v4-main-light');
  passed('Fable on both Claude accounts remains visible with all three accounts at default, 880x760 and 700x600; zero and full usage stay valid');

  const realState = await snapshot(main);
  const automatic = { ...realState, providers: realState.providers.map(provider => ({ ...provider, mode:'default', manual:false, stale:false, status:'ok' })) };
  main.webContents.send('state:changed', automatic); await delay(100);
  assert.equal(await js(main, "[...document.querySelectorAll('.provider-card')].some(card=>/(?:오전|오후).*확인/.test(card.innerText))"), false);
  assert.equal(await js(main, "document.querySelectorAll('.provider-source').length"), 0);
  await js(main, 'window.cardBefore = document.querySelector(".provider-card")');
  main.webContents.send('state:changed', { ...automatic, refreshing:true, providers:automatic.providers.map(provider => ({...provider, refreshing:true, status:'loading'})) }); await delay(100);
  assert.equal(await js(main, 'window.cardBefore === document.querySelector(".provider-card")'), true);
  assert.equal(await js(main, 'document.querySelector("#refresh-label").textContent'), '새로고침');
  assert.equal(await js(main, 'document.querySelector("#refresh-button").classList.contains("is-refreshing")'), false);
  main.webContents.send('state:changed', { ...automatic, providers:automatic.providers.map((provider, i) => i ? provider : {...provider, stale:true, error:'검증용 연결 지연', lastSuccessAt:new Date(Date.now()-3600000).toISOString()}) }); await delay(100);
  assert.equal(await js(main, "document.querySelector('.provider-status.warning').title.includes('마지막 확인')"), true);
  await capture(main, 'v4-main-stale');
  main.webContents.send('state:changed', realState); await delay(100);
  passed('normal per-account confirmation time is absent; stale/manual provenance remains in badges; background refresh preserves DOM and button');

  main.webContents.send('state:changed', expiredFixture(realState)); await delay(100);
  assert.equal(await js(main, "[...document.querySelectorAll('.provider-card.codex .reset-countdown')].every(node=>node.textContent==='초기화 확인 중')"), true);
  assert.equal(await js(main, "[...document.querySelectorAll('.provider-card.claude .reset-countdown')].every(node=>node.textContent==='기록 갱신 필요')"), true);
  assert.equal(await js(main, "[...document.querySelectorAll('.provider-card .usage-window-value')].every(node=>node.textContent==='—')"), true);
  await fits(main, '.provider-card'); await capture(main, 'v4-main-reset-pending');
  main.webContents.send('state:changed', realState); await delay(100);
  passed('reset boundary hides unconfirmed percentages; automatic confirmation and manual record updates remain distinct at minimum size');

  await js(main, "document.getElementById('settings-button').click()");
  const settingsLayout = await js(main, `(() => { const dialog = document.getElementById('settings-dialog'); return { width:dialog.clientWidth, scrollWidth:dialog.scrollWidth, rows:[...document.querySelectorAll('.account-row')].map(row=>({width:row.clientWidth,scrollWidth:row.scrollWidth,selectionCount:row.querySelectorAll('.account-display-option input').length})) }; })()`);
  assert.ok(settingsLayout.scrollWidth <= settingsLayout.width + 1, JSON.stringify(settingsLayout));
  assert.ok(settingsLayout.rows.every(row => row.scrollWidth <= row.width + 1 && row.selectionCount === 2), JSON.stringify(settingsLayout));
  assert.deepEqual(await js(main, "[...document.querySelectorAll('#tray-mode-setting option')].map(option=>option.value)"), ['usage','app']);
  await capture(main, 'v4-settings');
  await js(main, "document.querySelector('[data-focus-key=\"qa-0-settings-edit\"]').click(); document.getElementById('account-show-fable').checked=false; document.getElementById('save-account').click()");
  await waitFor(async () => (await snapshot(main)).settings.accounts.find(account=>account.id==='qa-0').showFable === false);
  assert.equal(await js(main, "document.querySelectorAll('.provider-bottom .window-summary').length"), 1);
  await js(main, "document.querySelector('[data-focus-key=\"qa-0-settings-edit\"]').click(); document.getElementById('account-show-fable').checked=true; document.getElementById('save-account').click()");
  await waitFor(async () => (await snapshot(main)).settings.accounts.find(account=>account.id==='qa-0').showFable === true);
  await js(main, "document.querySelectorAll('.move-up')[2].click()");
  await waitFor(async () => (await snapshot(main)).settings.accounts[1].id === 'qa-2');
  assert.deepEqual(runtime.runtimeDiagnostics().trayIds, ['qa-0','qa-2','qa-1']);
  for (const id of ['qa-0','qa-1','qa-2']) {
    assert.equal(runtime.runtimeDiagnostics().trayInstances[id].guid, originalTrays[id].guid);
    assert.equal(runtime.runtimeDiagnostics().trayInstances[id].serial, originalTrays[id].serial, 'Fable edits and account reorder must not recreate tray icons');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'settings.json'),'utf8')).settings.accounts.map(account=>account.id), ['qa-0','qa-2','qa-1']);
  passed('long-name settings rows fit, each has separate screen/tray controls; Fable edit and reorder persist through real UI');

  await toggleSetting(main, 'qa-1-visible', false);
  await waitFor(async () => (await snapshot(main)).settings.accounts.find(account=>account.id==='qa-1').visible === false);
  await ready(main, '.provider-card', 2);
  assert.equal(runtime.runtimeDiagnostics().trayCount, 3);
  const hiddenState = await js(main, 'window.limitTracker.refresh()');
  assert.equal(hiddenState.providers.find(provider=>provider.id==='qa-1').windows.length, 4);
  assert.ok(require('../src/accounts.cjs').monitoredProviders(hiddenState).some(provider=>provider.id==='qa-1'));
  await js(main, "document.getElementById('settings-dialog').close(); window.limitTracker.setSettings({theme:'dark'})");
  let popup = await openPopup(main); const popupLayout = await fits(popup, '.popup-provider', '#popup-providers');
  assert.equal(await js(popup, "document.querySelectorAll('.window-summary').length"), 2);
  assert.deepEqual(await ids(popup, '.popup-provider'), ['qa-0','qa-2','qa-1']); await capture(popup, 'v4-popup-dark');
  passed('screen-hidden/tray-selected account stays monitored and appears in 380x540 popup; three accounts plus two Fable limits fit');
  const popupState = await snapshot(popup);
  popup.webContents.send('state:changed', expiredFixture(popupState)); await delay(100);
  assert.equal(await js(popup, "[...document.querySelectorAll('.popup-provider.codex .reset-countdown')].every(node=>node.textContent==='초기화 확인 중')"), true);
  assert.equal(await js(popup, "[...document.querySelectorAll('.popup-provider.claude .reset-countdown')].every(node=>node.textContent==='기록 갱신 필요')"), true);
  await fits(popup, '.popup-provider', '#popup-providers'); await capture(popup, 'v4-popup-reset-pending');
  popup.webContents.send('state:changed', popupState); await delay(100);
  passed('popup pending-reset text and both Fable summaries still fit without scrolling');

  main = await openMain(); await ready(main, '.provider-card', 2);
  await js(main, "document.getElementById('settings-button').click()");
  await toggleSetting(main, 'qa-0-trayVisible', false);
  await waitFor(async () => (await snapshot(main)).settings.accounts.find(account=>account.id==='qa-0').trayVisible === false);
  assert.deepEqual(runtime.runtimeDiagnostics().trayIds, ['qa-2','qa-1']);
  for (const id of ['qa-2','qa-1']) assert.equal(runtime.runtimeDiagnostics().trayInstances[id].serial, originalTrays[id].serial, 'hiding another account must preserve native tray objects');
  assert.deepEqual(await ids(main, '.provider-card'), ['qa-0','qa-2']);
  await js(main, "document.getElementById('settings-dialog').close()");
  popup = await openPopup(main, 2); assert.deepEqual(await ids(popup, '.popup-provider'), ['qa-2','qa-1']);
  main = await openMain();
  await savePatch(main,'qa-1',{visible:true});
  await savePatch(main,'qa-2',{trayVisible:false}); await savePatch(main,'qa-1',{trayVisible:false});
  assert.equal(runtime.runtimeDiagnostics().trayCount, 1);
  assert.equal(runtime.runtimeDiagnostics().trayIds.some(id=>/^qa-/.test(id)), false);
  await js(main, "document.getElementById('settings-button').click()");
  assert.equal(await js(main, "document.getElementById('tray-selection-note').hidden"), false);
  await capture(main,'v4-settings-no-tray'); await js(main, "document.getElementById('settings-dialog').close()");
  popup = await openPopup(main, 0);
  assert.equal(await js(popup, "document.querySelector('.popup-empty-state').textContent.includes('앱 아이콘')"), true);
  main = await openMain(); await js(main, "window.limitTracker.setSettings({trayMode:'app'})");
  popup = await openPopup(main); assert.deepEqual(await ids(popup, '.popup-provider'), ['qa-0','qa-2','qa-1']);
  assert.equal(runtime.runtimeDiagnostics().trayCount, 1);
  main = await openMain();
  for(const id of ['qa-0','qa-2','qa-1']) await savePatch(main,id,{trayVisible:true});
  await js(main, "window.limitTracker.setSettings({trayMode:'usage'})");
  assert.equal(runtime.runtimeDiagnostics().trayCount, 3);
  for (const id of ['qa-0','qa-1','qa-2']) assert.equal(runtime.runtimeDiagnostics().trayInstances[id].guid, originalTrays[id].guid, 'reenabling restores the same account GUID');
  passed('native account GUIDs are unique and stable; reorder/edit/hide preserve unaffected tray objects and reenable restores identity');
  passed('screen/tray selections are independent; zero usage selections show app icon and guidance; app mode popup falls back to screen accounts');

  await js(main, "document.getElementById('add-account-button').click(); document.getElementById('account-provider').value='grok'; document.getElementById('account-provider').dispatchEvent(new Event('change')); document.getElementById('account-label').value='검증 계정'; document.querySelector('.manual-label').value='주간'; document.querySelector('.manual-used').value='27'; document.getElementById('save-account').click()");
  await waitFor(async () => (await snapshot(main)).settings.accounts.length === 4);
  const added = (await snapshot(main)).settings.accounts.find(account=>account.providerId==='grok');
  assert.equal(added.manualWindows[0].usedPercent,27); assert.equal(added.manualWindows[0].remainingPercent,73); assert.equal(added.showFable,false);
  await js(main, `window.limitTracker.removeAccount(${JSON.stringify(added.id)})`); await ready(main,'.provider-card');
  passed('manual usage entry remains used27/remaining73 and non-Claude accounts cannot enable Fable');

  const { MobileServer } = require('../src/mobile-server.cjs');
  let phoneSnapshot = await snapshot(main);
  const phoneServer = new MobileServer({key:'b'.repeat(64),port:0,getState:()=>phoneSnapshot,rendererDir:path.resolve('src/renderer'),widgetPath:path.resolve('src/widget/LimitTracker.js')});
  await phoneServer.start();
  const phone = new BrowserWindow({width:390,height:844,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await phone.loadURL(`http://127.0.0.1:${phoneServer.port}/?key=${'b'.repeat(64)}`); await ready(phone,'.mobile-provider'); await capture(phone,'v4-iphone');
  assert.equal(await js(phone,"document.querySelectorAll('.mobile-fable .window-summary').length"),2);
  assert.equal(await js(phone,"document.querySelectorAll('.mobile-confirmed').length"),0);
  const response = await fetch(`http://127.0.0.1:${phoneServer.port}/api/usage?key=${'b'.repeat(64)}`); const mobileData = await response.json();
  assert.deepEqual(mobileData.providers.map(provider=>provider.id),['qa-0','qa-2','qa-1']);
  assert.equal(mobileData.providers.filter(provider=>provider.showFable).length,2);
  for(const [width,height] of [[375,812],[812,375]]) { phone.setContentSize(width,height); await delay(200); assert.equal(await js(phone,'document.documentElement.scrollWidth > innerWidth'),false,`Mobile overflow at ${width}`); }
  phone.setContentSize(375,812); phone.webContents.setZoomFactor(1.5); await delay(200);
  assert.equal(await js(phone,'document.documentElement.scrollWidth > innerWidth'),false,'150% mobile zoom overflow');
  phoneSnapshot = expiredFixture(phoneSnapshot);
  await js(phone,"document.getElementById('mobile-refresh').click()");
  await waitFor(async () => await js(phone,"document.querySelector('.mobile-provider.codex .reset-countdown')?.textContent==='초기화 확인 중'"));
  assert.equal(await js(phone,"[...document.querySelectorAll('.mobile-provider.claude .reset-countdown')].every(node=>node.textContent==='기록 갱신 필요')"),true);
  assert.equal(await js(phone,'document.documentElement.scrollWidth > innerWidth'),false,'150% pending-reset mobile zoom overflow');
  phone.destroy(); await phoneServer.stop();
  passed('mobile receives Fable settings and shared order; automatic/manual reset wording remains distinct; no repeated confirmation line or horizontal overflow at portrait, landscape, or 150% zoom');

  await js(main,"window.limitTracker.windowAction('close')"); await waitFor(()=>BrowserWindow.getAllWindows().length===0,15000);
  assert.equal(runtime.runtimeDiagnostics().trayCount,3);
  main = await openMain(); await ready(main,'.provider-card');
  assert.deepEqual(await ids(main,'.provider-card'),['qa-0','qa-2','qa-1']);
  assert.equal(await js(main,"document.querySelectorAll('.provider-bottom .window-summary').length"),2);
  passed('hidden windows release after grace period and main recreates with saved order, tray selection, and Fable settings');
  assert.equal(diagnostics.length,0,diagnostics.join('\n'));
  const result = {success:true,checks,defaultLayout,minLayout,popupLayout,settingsLayout,runtime:runtime.runtimeDiagnostics(),consoleErrors:diagnostics};
  fs.writeFileSync(path.join(root,'verification-v4.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result)); app.quit();
}).catch(async error => {
  for(const [index,win] of BrowserWindow.getAllWindows().entries()) { try { if(!win.isDestroyed()) await capture(win,`v4-failure-${index}`); } catch {} }
  fs.writeFileSync(path.join(root,'verification-v4.json'),JSON.stringify({success:false,checks,error:error.stack,consoleErrors:diagnostics,runtime:runtime.runtimeDiagnostics()},null,2));
  console.error(error.stack); app.exit(1);
});
