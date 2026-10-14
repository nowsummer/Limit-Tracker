'use strict';
// 1.5.0 Electron verification: isolated synthetic manual accounts, no real
// authentication, no model calls, no update download. Run: npx electron scripts/smoke-v5.cjs
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-v5-smoke-'));
app.setPath('userData', folder); process.argv.push('--hidden');
const recordedAt = new Date().toISOString();
const usage = (id, label, usedPercent, durationMinutes) => ({ id, label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: new Date(Date.now() + (durationMinutes === 300 ? 7140000 : 264600000)).toISOString(), durationMinutes });
const makeAccount = (i, providerId, label, extra = {}) => ({
  id: `qa-${i}`, providerId, label, mode: 'manual', visible: true, trayVisible: true, showFable: providerId === 'claude', trayMetric: 'primary', recordedAt,
  manualWindows: [usage('short', '5h', [7, 0, 100, 40][i], 300), usage('week', 'weekly', [11, 95, 68, 20][i], 10080),
    ...(providerId === 'claude' ? [usage('seven_day_fable', 'Fable weekly', [24, 73][i], 10080), usage('seven_day_sonnet', 'Sonnet weekly', [38, 62][i], 10080)] : [])],
  ...extra,
});
const accounts = [makeAccount(0, 'claude', 'Personal'), makeAccount(1, 'claude', 'Work account with a long name for layout checks'.slice(0, 40)), makeAccount(2, 'codex', 'Default')];
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: { accounts, trayMode: 'usage', startHidden: true, theme: 'dark', refreshSeconds: 300, notifications: false, resetNotifications: false }, preferences: { language: 'ko', autoUpdate: false }, mobileKey: 'a'.repeat(64) }));
const diagnostics = []; const checks = [];
// Electron 44 passes a details object first; older builds passed (event, level, message).
app.on('web-contents-created', (_event, contents) => { contents.on('console-message', details => { if (details?.level === 'error') diagnostics.push(details.message); }); });
const runtime = require('../src/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 20000, message = 'UI verification timed out') {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(message);
}
const root = path.resolve(__dirname, '..', 'artifacts'); fs.mkdirSync(root, { recursive: true });
const passed = message => { checks.push(message); console.log(`PASS: ${message}`); };
const js = (win, script) => win.webContents.executeJavaScript(script);
const snapshot = win => js(win, 'window.limitTracker.getState()');
const ids = (win, selector) => js(win, `[...document.querySelectorAll(${JSON.stringify(selector)})].map(e => e.dataset.accountId)`);
async function ready(win, selector, count = 3) { await waitFor(async () => !win.isDestroyed() && !win.webContents.isLoading() && await js(win, `document.querySelectorAll(${JSON.stringify(selector)}).length === ${count}`)); }
async function capture(win, name) { await js(win, 'document.fonts.ready'); await delay(350); fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
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
function popupWindowOf() { return BrowserWindow.getAllWindows().find(window => window.getBounds().width < 500); }
async function openPopup(main, count = 3) {
  await js(main, "window.limitTracker.windowAction('show-popup')");
  const win = await waitFor(() => { const popup = popupWindowOf(); return popup && popup.isVisible() ? popup : null; });
  await ready(win, '.popup-provider', count);
  await waitFor(() => runtime.runtimeDiagnostics().popupHeight !== null, 5000, 'popup never reported its height');
  await delay(300);
  return win;
}
async function closePopup() { const popup = popupWindowOf(); if (popup && popup.isVisible()) { popup.hide(); await delay(150); } }
async function toggleSetting(win, focusKey, checked) {
  await js(win, `(() => { const input = document.querySelector('[data-focus-key="${focusKey}"]'); if (!input) throw new Error('Missing ${focusKey}'); input.checked = ${checked}; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
}
const hangul = text => /[가-힣]/.test(text);

app.whenReady().then(async () => {
  await waitFor(() => runtime.runtimeDiagnostics().trayCount === 3);
  const originalTrays = runtime.runtimeDiagnostics().trayInstances;
  assert.equal(new Set(Object.values(originalTrays).map(entry => entry.guid)).size, 3);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(runtime.runtimeDiagnostics().updateMode, 'dev');
  passed('tray-only start: zero windows, three account trays with distinct GUIDs, update mode dev');

  let main = await openMain(); await ready(main, '.provider-card'); await js(main, 'document.fonts.ready');
  // Console capture self-test: the error filter must really see renderer errors.
  await js(main, "console.error('smoke-self-test')"); await waitFor(() => diagnostics.includes('smoke-self-test'), 3000, 'console errors are not captured');
  diagnostics.length = 0;
  passed('console error capture works (Electron 44 details object)');
  const bounds = main.getBounds();
  // At fractional display scaling Windows reports 640 DIP as up to 642.
  assert.ok(Math.abs(bounds.width - 640) <= 3, `default width ${bounds.width}`);
  const defaultLayout = await fits(main, '.provider-card'); await capture(main, 'v5-main-default');
  // The window height follows the content: no empty band below the footer.
  const fitGap = await js(main, "innerHeight - document.querySelector('.dashboard').getBoundingClientRect().bottom");
  assert.ok(fitGap >= -1 && fitGap <= 2, `window height fits its content (gap ${fitGap}px)`);
  const fitted = main.getBounds().height;
  await js(main, "document.getElementById('settings-button').click()"); await waitFor(() => main.getBounds().height >= Math.min(600, screen.getDisplayMatching(main.getBounds()).workArea.height), 4000, 'an open sheet gets room');
  await js(main, "document.getElementById('settings-dialog').close()"); await waitFor(() => Math.abs(main.getBounds().height - fitted) <= 2, 4000, 'closing the sheet returns to the fitted height');
  main.setSize(600, 600); await delay(200); const minLayout = await fits(main, '.provider-card'); await capture(main, 'v5-main-min');
  assert.equal(await js(main, "getComputedStyle(document.querySelector('.provider-card')).gridTemplateColumns.split(' ').length"), 2, 'two-column cards at minimum width');
  main.setSize(880, 760); await delay(200); await fits(main, '.provider-card');
  main.setSize(640, 620); await delay(150);
  passed(`main window opens at 640 px and ${fitted} px high (fitted to its content, taller only while a sheet is open); three accounts plus two Fable rows fit at 640, 600x600 and 880x760 without scrolling`);

  // Pin icon: outlined and tilted when off, filled and upright when on.
  const pinOff = await js(main, "(() => { const b = document.getElementById('pin-button'); return { pressed: b.getAttribute('aria-pressed'), fill: getComputedStyle(b.querySelector('.pin-head')).fill, transform: getComputedStyle(b.querySelector('svg')).transform }; })()");
  await js(main, "document.getElementById('pin-button').click()");
  await waitFor(async () => (await snapshot(main)).settings.alwaysOnTop === true);
  await waitFor(async () => await js(main, "document.getElementById('pin-button').getAttribute('aria-pressed')") === 'true');
  await delay(250);
  const pinOn = await js(main, "(() => { const b = document.getElementById('pin-button'); return { pressed: b.getAttribute('aria-pressed'), fill: getComputedStyle(b.querySelector('.pin-head')).fill, transform: getComputedStyle(b.querySelector('svg')).transform, title: b.title }; })()");
  assert.equal(pinOff.pressed, 'false'); assert.equal(pinOff.fill, 'none'); assert.notEqual(pinOff.transform, 'none');
  assert.equal(pinOn.pressed, 'true'); assert.notEqual(pinOn.fill, 'none'); assert.equal(pinOn.transform, 'none');
  assert.equal(main.isAlwaysOnTop(), true);
  await capture(main, 'v5-main-pinned');
  await js(main, "document.getElementById('pin-button').click()"); await waitFor(async () => (await snapshot(main)).settings.alwaysOnTop === false);
  passed('always-on-top pin toggles an outlined/tilted pin into a filled upright one and sets the window flag');

  // About section.
  await js(main, "document.getElementById('settings-button').click()");
  const about = await js(main, "(() => ({ text: document.querySelector('.about-card').innerText, version: document.getElementById('about-version').textContent, contact: document.getElementById('contact-button').dataset.external, update: document.getElementById('update-status').textContent, checkVisible: !document.getElementById('update-check-button').hidden }))()");
  assert.match(about.text, /Jaeha Lee/); assert.match(about.text, /limittracker\.app@gmail\.com/); assert.ok(about.version.includes(app.getVersion()), about.version); assert.equal(about.contact, 'contact');
  assert.ok(about.update.length > 0); assert.equal(about.checkVisible, true);
  await js(main, "document.querySelector('.about-card').scrollIntoView()"); await capture(main, 'v5-settings-about');
  const settingsLayout = await js(main, `(() => { const dialog = document.getElementById('settings-dialog'); return { width:dialog.clientWidth, scrollWidth:dialog.scrollWidth }; })()`);
  assert.ok(settingsLayout.scrollWidth <= settingsLayout.width + 1, JSON.stringify(settingsLayout));
  passed('settings show the overview, author Jaeha Lee, the dedicated support contact, the running version and the update controls without overflow');

  // Account order: drag the ≡ handle with a real mouse, then move it back with the keyboard.
  await js(main, "document.querySelector('#account-list .account-row').scrollIntoView({ block: 'center' })"); await delay(150);
  const handles = await js(main, "[...document.querySelectorAll('.drag-handle')].map(h => { const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: h.closest('.account-row').dataset.accountId }; })");
  assert.equal(handles.length, 3, 'one drag handle per account');
  const orderBefore = handles.map(handle => handle.id);
  const pitch = handles[1].y - handles[0].y;
  const send = event => main.webContents.sendInputEvent(event);
  send({ type: 'mouseMove', x: handles[0].x, y: handles[0].y });
  send({ type: 'mouseDown', x: handles[0].x, y: handles[0].y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 12; step++) { send({ type: 'mouseMove', x: handles[0].x, y: handles[0].y + Math.round(pitch * 1.5 * step / 12), button: 'left', modifiers: ['leftButtonDown'] }); await delay(16); }
  send({ type: 'mouseUp', x: handles[0].x, y: handles[0].y + Math.round(pitch * 1.5), button: 'left', clickCount: 1 });
  const dragged = await waitFor(async () => { const ids = (await snapshot(main)).settings.accounts.map(account => account.id); return ids[1] === orderBefore[0] ? ids : null; }, 5000, 'dragging the first account down one row did not reorder it');
  assert.deepEqual(dragged, [orderBefore[1], orderBefore[0], orderBefore[2]]);
  // A mouse drop leaves no keyboard focus ring; a keyboard user focuses the handle and uses the arrows.
  assert.notEqual(await js(main, 'document.activeElement?.dataset?.focusKey || ""'), `${orderBefore[0]}-order`, 'no focus ring is left on the dropped handle');
  await js(main, `document.querySelector('[data-focus-key="${orderBefore[0]}-order"]').focus()`);
  send({ type: 'keyDown', keyCode: 'Up' }); send({ type: 'keyUp', keyCode: 'Up' });
  await waitFor(async () => { const ids = (await snapshot(main)).settings.accounts.map(account => account.id); return ids[0] === orderBefore[0] ? ids : null; }, 5000, 'the up arrow key did not move the account back');
  assert.equal(await js(main, "document.querySelectorAll('.account-row[style*=\"transform\"]').length"), 0, 'no row is left displaced');
  assert.equal(await js(main, "document.getElementById('account-list').classList.contains('is-sorting')"), false, 'the list leaves its sorting state after a drop');
  // Escape during a drag cancels it: the sheet stays open and the order is unchanged.
  const handlesAgain = await js(main, "[...document.querySelectorAll('.drag-handle')].map(h => { const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })");
  send({ type: 'mouseMove', x: handlesAgain[0].x, y: handlesAgain[0].y });
  send({ type: 'mouseDown', x: handlesAgain[0].x, y: handlesAgain[0].y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step++) { send({ type: 'mouseMove', x: handlesAgain[0].x, y: handlesAgain[0].y + Math.round(pitch * 1.5 * step / 8), button: 'left', modifiers: ['leftButtonDown'] }); await delay(16); }
  send({ type: 'keyDown', keyCode: 'Escape', modifiers: ['leftButtonDown'] }); send({ type: 'keyUp', keyCode: 'Escape', modifiers: ['leftButtonDown'] });
  await delay(150);
  send({ type: 'mouseUp', x: handlesAgain[0].x, y: handlesAgain[0].y + Math.round(pitch * 1.5), button: 'left', clickCount: 1 });
  await delay(400);
  assert.equal(await js(main, "document.getElementById('settings-dialog').open"), true, 'Escape cancels the drag, not the sheet');
  assert.deepEqual((await snapshot(main)).settings.accounts.map(account => account.id), orderBefore, 'a cancelled drag saves nothing');
  assert.equal(await js(main, "document.querySelectorAll('.account-row[style*=\"translate\"]').length"), 0, 'no row is left displaced after cancel');
  passed('settings: dragging an account’s ≡ handle reorders it, ↑/↓ on the focused handle does the same, and Escape cancels a drag');

  // Fable tray metric: the account editor offers it only with Fable shown.
  await js(main, "document.querySelector('[data-focus-key=\"qa-0-settings-edit\"]').click()");
  assert.equal(await js(main, "document.getElementById('account-tray-metric-row').hidden"), false);
  await js(main, "document.getElementById('account-show-fable').checked = false; document.getElementById('account-show-fable').dispatchEvent(new Event('change'))");
  assert.equal(await js(main, "document.getElementById('account-tray-metric-row').hidden"), true);
  await js(main, "document.getElementById('account-show-fable').checked = true; document.getElementById('account-show-fable').dispatchEvent(new Event('change')); document.getElementById('account-tray-metric').value = 'fable'"); await capture(main, 'v5-account-fable-metric');
  const iconBefore = runtime.runtimeDiagnostics().trayInstances['qa-0'].iconKey;
  await js(main, "document.getElementById('save-account').click()");
  await waitFor(async () => (await snapshot(main)).settings.accounts.find(account => account.id === 'qa-0').trayMetric === 'fable');
  await waitFor(() => runtime.runtimeDiagnostics().trayInstances['qa-0'].iconKey !== iconBefore);
  assert.match(runtime.runtimeDiagnostics().trayInstances['qa-0'].iconKey, /^claude:24:/);
  assert.match(runtime.runtimeDiagnostics().trayInstances['qa-0'].tooltip.split('\n')[1], /^Fable 24%/);
  assert.equal(runtime.runtimeDiagnostics().trayInstances['qa-0'].serial, originalTrays['qa-0'].serial, 'changing the metric keeps the native tray object');
  await savePatch(main, 'qa-0', { trayMetric: 'primary' });
  await waitFor(() => /^claude:7:/.test(runtime.runtimeDiagnostics().trayInstances['qa-0'].iconKey));
  passed('Fable-shown Claude accounts can drive the tray number with Fable usage (24) or the current limit (7) without recreating the icon');

  // Manual percent with float error no longer locks the form.
  await js(main, "document.getElementById('settings-dialog').close()");
  await savePatch(main, 'qa-2', { manualWindows: [{ label: '5h', usedPercent: 12.3, remainingPercent: 87.7, durationMinutes: 300 }, { label: 'weekly', usedPercent: 68, remainingPercent: 32, durationMinutes: 10080 }] });
  await js(main, "document.querySelector('[data-focus-key=\"qa-2-usage\"]').click()");
  assert.equal(await js(main, "document.querySelector('.manual-used').value"), '12.3');
  await js(main, "document.getElementById('account-label').value = 'Default'; document.getElementById('save-account').click()");
  await waitFor(async () => !(await js(main, "document.getElementById('account-dialog').open")));
  passed('a manual 12.3% entry round-trips as 12.3 and the edit form saves');

  // An open editor must merge unchanged fields from newer tray/menu changes.
  const preciseReset = new Date(Date.now() + 7200045).toISOString();
  await savePatch(main, 'qa-2', { manualWindows: [{ label: '5h', usedPercent: 12.3, remainingPercent: 87.7, durationMinutes: 300, resetsAt: preciseReset }] });
  const recordedBeforeEdit = (await snapshot(main)).settings.accounts.find(a => a.id === 'qa-2').recordedAt;
  await js(main, "document.querySelector('[data-focus-key=\"qa-2-usage\"]').click()");
  await savePatch(main, 'qa-2', { trayVisible: false });
  await delay(100);
  await js(main, "document.getElementById('account-label').value = 'Renamed'; document.getElementById('save-account').click()");
  await waitFor(async () => !(await js(main, "document.getElementById('account-dialog').open")));
  const merged = (await snapshot(main)).settings.accounts.find(a => a.id === 'qa-2');
  assert.equal(merged.trayVisible, false, 'renaming must preserve the newer tray setting');
  assert.equal(merged.manualWindows[0].resetsAt, preciseReset, 'renaming must preserve seconds and milliseconds');
  assert.equal(merged.recordedAt, recordedBeforeEdit, 'renaming does not claim a new usage reading');
  await savePatch(main, 'qa-2', { label: 'Default', trayVisible: true });
  passed('an open editor preserves concurrent tray changes and unchanged manual deadlines to the millisecond');

  // Popup height follows the number of tray accounts (1, 2, 3) and stops at three.
  const heights = {};
  for (const count of [1, 2, 3]) {
    for (const [index, id] of ['qa-0', 'qa-1', 'qa-2'].entries()) await savePatch(main, id, { trayVisible: index < count });
    let popup = await openPopup(main, count);
    await waitFor(() => { const b = popupWindowOf().getBounds(); return Math.abs(b.height - runtime.runtimeDiagnostics().popupHeight) <= 2 ? b : null; }, 5000, 'popup did not resize');
    heights[count] = popupWindowOf().getBounds().height;
    await fits(popup, '.popup-provider', '#popup-providers', count);
    await capture(popup, `v5-popup-${count}`);
    await closePopup();
  }
  assert.ok(heights[1] < heights[2] && heights[2] < heights[3], JSON.stringify(heights));
  main = await openMain();
  const { id: _unused, ...fourth } = makeAccount(3, 'gemini', 'Fourth');
  const extra = await js(main, `window.limitTracker.saveAccount(${JSON.stringify(fourth)})`);
  assert.notEqual(extra?.ok, false, extra?.error);
  const fourthId = extra.account.id;
  let popup = await openPopup(main, 4);
  await delay(300);
  const four = popupWindowOf().getBounds().height;
  assert.ok(Math.abs(four - heights[3]) <= 4, `four accounts keep the three-account height: ${four} vs ${heights[3]}`);
  const scroll = await js(popup, "(() => { const c = document.getElementById('popup-providers'); return { scrollable: c.scrollHeight > c.clientHeight + 4, hint: c.classList.contains('has-more') }; })()");
  assert.equal(scroll.scrollable, true); assert.equal(scroll.hint, true);
  await capture(popup, 'v5-popup-4-scroll');
  await closePopup();
  main = await openMain();
  await js(main, `window.limitTracker.removeAccount(${JSON.stringify(fourthId)})`);
  passed(`popup height grows with 1/2/3 tray accounts (${heights[1]}/${heights[2]}/${heights[3]} px) and a fourth account scrolls inside the three-account height`);

  // English.
  await js(main, "window.limitTracker.setSettings({ language: 'en' })");
  await waitFor(async () => await js(main, "document.documentElement.lang") === 'en');
  await delay(200);
  const englishText = await js(main, "document.body.innerText");
  const strayKorean = englishText.split('\n').filter(line => hangul(line));
  assert.deepEqual(strayKorean, [], `Korean left in English UI: ${strayKorean.join(' | ')}`);
  assert.match(englishText, /Usage/);
  // The refresh button is a glyph: its name lives in the accessible label and tooltip.
  assert.deepEqual(await js(main, "(() => { const b = document.getElementById('refresh-button'); return [b.getAttribute('aria-label'), b.title]; })()"), ['Refresh', 'Refresh now (Ctrl+R)']);
  await capture(main, 'v5-main-english');
  await js(main, "document.getElementById('settings-button').click()"); await delay(150);
  const englishSettings = await js(main, "document.getElementById('settings-dialog').innerText");
  assert.deepEqual(englishSettings.split('\n').filter(line => hangul(line) && !/한국어/.test(line)), []);
  assert.match(englishSettings, /Made by/); assert.match(englishSettings, /Language/);
  await capture(main, 'v5-settings-english'); await js(main, "document.getElementById('settings-dialog').close()");
  const englishTooltip = runtime.runtimeDiagnostics().trayInstances['qa-0'].tooltip;
  assert.ok(!hangul(englishTooltip), englishTooltip);
  assert.ok(runtime.trayMenuTemplate().every(label => !hangul(label || '')), runtime.trayMenuTemplate().join(' | '));
  for (const id of ['qa-0', 'qa-1', 'qa-2']) await savePatch(main, id, { trayVisible: true });
  popup = await openPopup(main, 3);
  const popupText = await js(popup, 'document.body.innerText');
  assert.ok(!hangul(popupText), popupText);
  await capture(popup, 'v5-popup-english'); await closePopup();
  main = await openMain();
  await js(main, "window.limitTracker.setSettings({ language: 'ko' })");
  await waitFor(async () => await js(main, "document.documentElement.lang") === 'ko');
  assert.match(await js(main, "document.getElementById('dashboard-title').textContent"), /사용률/);
  passed('English switches the window, settings, popup, tray tooltip and tray menu with no Korean left; Korean switches back');

  // Window release and recreation keep everything.
  await js(main, "window.limitTracker.windowAction('close')"); await waitFor(() => BrowserWindow.getAllWindows().filter(w => w.getBounds().width > 500).length === 0, 15000);
  main = await openMain(); await ready(main, '.provider-card');
  assert.deepEqual(await ids(main, '.provider-card'), ['qa-0', 'qa-1', 'qa-2']);
  passed('hidden main window is released after its grace period and recreated with saved settings');

  // Mobile page in English with the iPhone server.
  const { MobileServer } = require('../src/mobile-server.cjs');
  await js(main, "window.limitTracker.setSettings({ language: 'en' })");
  const phoneSnapshot = await snapshot(main);
  const phoneServer = new MobileServer({ key: 'b'.repeat(64), port: 0, getState: () => phoneSnapshot, rendererDir: path.resolve(__dirname, '..', 'src', 'renderer'), widgetPath: path.resolve(__dirname, '..', 'src', 'widget', 'LimitTracker.js') });
  await phoneServer.start();
  const phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await phone.loadURL(`http://127.0.0.1:${phoneServer.port}/?key=${'b'.repeat(64)}`); await ready(phone, '.mobile-provider');
  await waitFor(async () => await js(phone, 'document.documentElement.lang') === 'en');
  const phoneText = await js(phone, 'document.body.innerText');
  assert.ok(!hangul(phoneText), phoneText.split('\n').filter(hangul).join(' | '));
  for (const [width, height] of [[375, 812], [812, 375]]) { phone.setContentSize(width, height); await delay(200); assert.equal(await js(phone, 'document.documentElement.scrollWidth > innerWidth'), false, `Mobile overflow at ${width}`); }
  await capture(phone, 'v5-iphone-english');
  phone.destroy(); await phoneServer.stop();
  await js(main, "window.limitTracker.setSettings({ language: 'ko' })");
  passed('iPhone page follows the PC language (English) without horizontal overflow');

  assert.deepEqual(diagnostics, [], diagnostics.join('\n'));
  const result = { success: true, checks, defaultLayout, minLayout, popupHeights: { ...heights, 4: four }, settingsLayout, runtime: runtime.runtimeDiagnostics(), consoleErrors: diagnostics };
  fs.writeFileSync(path.join(root, 'verification-v5.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ success: true, checks: checks.length, popupHeights: result.popupHeights })); app.quit();
}).catch(async error => {
  for (const [index, win] of BrowserWindow.getAllWindows().entries()) { try { if (!win.isDestroyed()) await capture(win, `v5-failure-${index}`); } catch {} }
  fs.writeFileSync(path.join(root, 'verification-v5.json'), JSON.stringify({ success: false, checks, error: error.stack, consoleErrors: diagnostics, runtime: runtime.runtimeDiagnostics() }, null, 2));
  console.error(error.stack); app.exit(1);
});
