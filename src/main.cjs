'use strict';
const { spawn } = require('node:child_process');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, screen, powerMonitor, Notification, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const i18n = require('./i18n.cjs');
const { t } = i18n;
const { SettingsStore } = require('./settings.cjs');
const { UsageService } = require('./usage-service.cjs');
const { MobileServer } = require('./mobile-server.cjs');
const { iconPng, trayGaugePng, trayGaugeIco } = require('./icons.cjs');
const { used, trayWindow, compactSummary, trayTooltip, singleTooltip } = require('./presentation.cjs');
const { fetchClaudeUsage, findClaudeExecutable } = require('./providers/claude.cjs');
const { fetchCodexUsage, findCodexExecutable } = require('./providers/codex.cjs');
const { fetchGrokUsage } = require('./providers/grok.cjs');
const { CATALOG, localizedCatalog, prepareAccount, reorderAccounts, accountEnvironment, manualUsage, visibleProviders, trayProviders, monitoredProviders } = require('./accounts.cjs');
const { launchLoginProcess } = require('./login.cjs');
const { ResetReminders } = require('./reset-reminders.cjs');
const { AlertLog } = require('./alert-log.cjs');
const { UsageAlerts } = require('./usage-alerts.cjs');
const { trayGuid } = require('./tray-identity.cjs');
const { UpdateManager, releasePage, releasesPage } = require('./updater.cjs');
const { windowsIdentity, windowAppDetails, registerWindowsShortcuts, registerWindowsNotificationIdentity, verifyWindowsIdentity } = require('./windows-integration.cjs');
const identity = windowsIdentity({ isPackaged: app.isPackaged });
app.setName(identity.displayName);
app.setAppUserModelId(identity.appId);
const CONTACT_EMAIL = 'limittracker.app@gmail.com';
// The default window is narrow enough to feel light and still keeps the two-column
// account cards (the single-column layout starts below 591 px).
// The height follows the content (renderer reports it); 620 is only the first guess.
const RELOGIN_ALERT_MS = 86400000;
const MAIN_SIZE = Object.freeze({ width: 640, height: 620, minWidth: 600, minHeight: 260 });
const POPUP_WIDTH = 380;
const POPUP_MIN_HEIGHT = 180;
const identityReport = process.argv.find(arg => arg.startsWith('--verify-windows-identity='))?.slice('--verify-windows-identity='.length);
let windowsIconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
let notificationIconPath = path.join(__dirname, '..', 'assets', 'icon.png');
let windowsIdentityReady = Promise.resolve(true);
let mainWindow, popupWindow, settings, usage, mobile, poll, reminders, resetTimer, quitting = false, loginTimer, updater;
let mainBounds, mainContentHeight = null, popupWanted = false, popupAnchor = null, popupHeight = null, popupHiddenAt = 0, popupHiddenAnchor = null, popupShowTimer = null;
let mainWidth = MAIN_SIZE.width;
let resetDueSince = 0, resetLastAttempt = 0, resetChecking = false;
const trays = new Map();
let traySerial = 0;
const iconCache = new Map();
const loginProcesses = new Map();
const loginLaunches = new Map();
const activeNotifications = new Set();
const rendererDir = path.join(__dirname, 'renderer');
let reloginAlerts = null;
let updateAlerts = null;
let usageAlerts = null;

/** Small rotating diagnostic log in the app data folder. Never receives tokens. */
function log(level, message) {
  try {
    const directory = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'main.log');
    try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* No log yet. */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${String(message).replace(/[\r\n]+/g, ' | ').slice(0, 2000)}\n`);
  } catch { /* Logging must never break the app. */ }
}
process.on('uncaughtException', error => log('error', `uncaught ${error?.stack || error}`));
process.on('unhandledRejection', error => log('error', `unhandled ${error?.stack || error}`));
function background(promise, label) { Promise.resolve(promise).catch(error => log('warn', `${label}: ${error?.message || error}`)); }

if (identityReport && app.isPackaged) {
  app.whenReady().then(async () => {
    if (!path.isAbsolute(identityReport)) throw new Error('Verification report path must be absolute');
    await prepareWindowsIdentity();
    const result = await verifyWindowsIdentity({ app, shell, Notification, identity, executable: app.getPath('exe'), iconPath: windowsIconPath, notificationIconPath, appData: app.getPath('appData'), desktopDir: app.getPath('desktop') });
    fs.writeFileSync(identityReport, JSON.stringify(result, null, 2));
    app.exit(result.notificationAccepted ? 0 : 1);
  }).catch(error => {
    // This branch never reads account data. Preserve a bounded diagnostic for
    // packaged shell-registration failures instead of silently exiting.
    try { if (path.isAbsolute(identityReport)) fs.writeFileSync(identityReport, JSON.stringify({ packaged: app.isPackaged, appId: identity.appId, expectedSender: identity.displayName, executable: app.getPath('exe'), error: String(error?.message || 'Windows identity verification failed').slice(0, 500), code: typeof error?.code === 'string' ? error.code : null, notificationAccepted: false, senderVisualVerified: false }, null, 2)); } catch {}
    app.exit(1);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(start).catch(error => {
    log('error', `startup ${error?.stack || error}`);
    try { dialog.showErrorBox('Limit Tracker', `${t('error.startup')}\n\n${String(error?.message || error).slice(0, 500)}`); } catch { /* No dialog available. */ }
    app.quit();
  });
}

/** Provider messages carry translation keys; render them in the current language. */
function localizeProvider(p) {
  const out = { ...p };
  if (p.providerId === 'custom') out.name = t('catalog.custom.name');
  if (p.errorKey) out.error = t(p.errorKey, p.errorParams || undefined);
  if (p.warningKey) out.warning = t(p.warningKey, p.warningParams || undefined);
  if (p.sourceKey) out.source = t(p.sourceKey);
  if (p.planKey) out.plan = t(p.planKey);
  if (Array.isArray(p.windows)) out.windows = p.windows.map(w => {
    if (!w.labelKey) return w;
    const text = t(w.labelKey, w.labelParams || undefined);
    return { ...w, label: w.labelPrefix ? `${w.labelPrefix} · ${text}` : text };
  });
  return out;
}
function state() {
  const snapshot = usage.snapshot();
  return { ...snapshot, providers: snapshot.providers.map(localizeProvider), settings: settings.value, catalog: localizedCatalog(), mobile: mobile.info(), appVersion: app.getVersion(), language: i18n.getLanguage(), update: updater ? updater.state() : null, contact: CONTACT_EMAIL, author: 'Jaeha Lee' };
}
function providerDescriptors() {
  return settings.value.accounts.map(account => {
    const provider = CATALOG.find(p => p.id === account.providerId);
    const env = accountEnvironment(account, app.getPath('userData'));
    const fetchers = {
      claude: () => fetchClaudeUsage({ env, wslScan: account.mode !== 'isolated', statusCachePath: account.mode === 'default' ? path.join(app.getPath('userData'), 'claude-status.json') : undefined }),
      codex: () => fetchCodexUsage({ env }),
      grok: () => fetchGrokUsage()
    };
    const name = account.providerId === 'custom' ? t('catalog.custom.name') : provider.name;
    // Gemini has no fetcher (manual entry only); anything without one shows its manual record.
    const fetcher = account.mode !== 'manual' && Object.hasOwn(fetchers, account.providerId) ? fetchers[account.providerId] : async () => manualUsage(account);
    return { id: account.id, name, metadata: { providerId: account.providerId, accountLabel: account.label, mode: account.mode, manual: account.mode === 'manual', visible: account.visible, trayVisible: account.trayVisible, showFable: account.showFable, trayMetric: account.trayMetric }, fetch: fetcher };
  });
}
function broadcast() {
  const snapshot = state();
  for (const w of [mainWindow, popupWindow]) if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized()) w.webContents.send('state:changed', snapshot);
  try { updateTray(snapshot); } catch (error) { log('error', `tray ${error?.stack || error}`); }
}
function secureWindow(options) {
  const icon = nativeImage.createFromPath(windowsIconPath);
  const win = new BrowserWindow({ ...options, icon, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: true } });
  win.setIcon(icon);
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  win.webContents.on('zoom-changed', () => win.webContents.setZoomFactor(1));
  if (process.platform === 'win32') win.setAppDetails(windowAppDetails({ identity, executable: app.getPath('exe'), iconPath: windowsIconPath, args: app.isPackaged ? [] : [path.join(__dirname, '..')] }));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.on('render-process-gone', (_event, details) => log('error', `renderer gone ${details?.reason}`));
  return win;
}
function releaseWhenHidden(win, delay) {
  let timer;
  win.on('hide', () => { clearTimeout(timer); timer = setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.destroy(); }, delay); timer.unref(); });
  win.on('show', () => { clearTimeout(timer); broadcast(); });
  win.on('restore', broadcast);
  win.on('closed', () => clearTimeout(timer));
}
/** Saved bounds are reused only while they still overlap a connected display. */
function restorableBounds(bounds) {
  if (!bounds) return {};
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.max(MAIN_SIZE.minWidth, Math.min(bounds.width, area.width));
  const height = Math.max(MAIN_SIZE.minHeight, Math.min(bounds.height, area.height));
  const visible = bounds.x < area.x + area.width - 80 && bounds.x + bounds.width > area.x + 80 && bounds.y >= area.y - 8 && bounds.y < area.y + area.height - 80;
  return visible ? { x: bounds.x, y: bounds.y, width, height } : { width, height };
}
function showMain() {
  if (!settings || quitting) return;
  cancelPopup();
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); return; }
  const restored = restorableBounds(mainBounds);
  if (mainContentHeight) restored.height = Math.max(MAIN_SIZE.minHeight, mainContentHeight);
  const win = secureWindow({ width: MAIN_SIZE.width, height: MAIN_SIZE.height, ...restored, minWidth: MAIN_SIZE.minWidth, minHeight: MAIN_SIZE.minHeight, frame: false, show: false, backgroundColor: '#20232e', title: 'Limit Tracker', autoHideMenuBar: true, alwaysOnTop: settings.value.alwaysOnTop });
  mainWindow = win; releaseWhenHidden(win, 10000);
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
  // Remember where the user put the window (not where a tall sheet lifted it) and the
  // width they chose: the measured width grows by DPI rounding each time it is recreated.
  win.on('hide', () => { const bounds = win.getNormalBounds(); mainBounds = { ...bounds, width: mainWidth, y: Number.isFinite(win.limitHomeY) ? win.limitHomeY : bounds.y }; });
  win.on('resized', () => { if (!win.isMaximized() && !win.isFullScreen()) mainWidth = win.getBounds().width; });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // Show once the renderer has measured itself, so the window never jumps in size.
  win.once('ready-to-show', () => { win.limitReady = true; if (win.limitSized) revealMain(win); else win.limitRevealTimer = setTimeout(() => revealMain(win), 700); });
  for (const event of ['restore', 'unmaximize', 'leave-full-screen']) win.on(event, () => { if (mainContentHeight) fitMain(win, mainContentHeight); });
  win.on('moved', () => { win.limitHomeY = null; });
  win.loadFile(path.join(rendererDir, 'index.html'));
}
function revealMain(win) {
  clearTimeout(win.limitRevealTimer); win.limitRevealTimer = null;
  if (!quitting && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); }
}
/** The main window renderer measured its content: fit the height to it (within the screen). */
function fitMain(win, height) {
  if (!Number.isFinite(height) || height < 200 || height > 4000) throw new Error(t('error.badArgument'));
  mainContentHeight = Math.ceil(height);
  if (!win || win.isDestroyed()) return;
  if (!win.isMinimized() && !win.isMaximized() && !win.isFullScreen()) {
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const h = Math.max(MAIN_SIZE.minHeight, Math.min(mainContentHeight, area.height));
    // Remember where the user put the window when a taller sheet had to lift it,
    // and return there when it shrinks again.
    const home = Number.isFinite(win.limitHomeY) ? win.limitHomeY : bounds.y;
    const y = Math.max(area.y, Math.min(home, area.y + area.height - h));
    win.limitHomeY = y < home ? home : null;
    // Only the height (and, near the screen bottom, the top edge) changes; passing the
    // width back would let DPI rounding creep it by a pixel or two each time.
    if (h !== bounds.height || y !== bounds.y) { const keep = win.limitHomeY; win.setBounds(y !== bounds.y ? { y, height: h } : { height: h }); win.limitHomeY = keep; }
  }
  win.limitSized = true;
  if (win.limitReady && !win.isVisible() && win.limitRevealTimer) revealMain(win);
}
function cancelPopup() {
  popupWanted = false; clearTimeout(popupShowTimer);
  if (popupWindow && !popupWindow.isDestroyed()) { if (popupWindow.isVisible()) popupWindow.hide(); else popupWindow.destroy(); }
}
function defaultAnchor() { return trays.values().next().value?.tray; }
function togglePopup(anchor = defaultAnchor()) {
  if (!anchor || quitting) return;
  if (popupWanted || popupWindow?.isVisible()) { cancelPopup(); return; }
  // Clicking the tray icon first blurs (and hides) the popup; that click was a dismissal.
  if (Date.now() - popupHiddenAt < 350 && popupHiddenAnchor === anchor) { popupHiddenAt = 0; return; }
  popupWanted = true; popupAnchor = anchor;
  if (!popupWindow || popupWindow.isDestroyed()) {
    const win = secureWindow({ width: POPUP_WIDTH, height: popupHeight || 540, frame: false, show: false, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#20232e', title: 'Limit Tracker' });
    popupWindow = win; releaseWhenHidden(win, 3000);
    win.on('hide', () => { popupWanted = false; });
    win.on('blur', () => { if (!win.isDestroyed() && win.isVisible()) { popupHiddenAt = Date.now(); popupHiddenAnchor = popupAnchor; win.hide(); } });
    win.on('closed', () => { if (popupWindow === win) popupWindow = null; });
    // The renderer reports its content height before the first show; fall back
    // to the previous height if that report does not arrive.
    win.once('ready-to-show', () => { clearTimeout(popupShowTimer); popupShowTimer = setTimeout(() => { if (!win.isDestroyed() && popupWanted && !win.isVisible()) showPopupAt(win, popupAnchor); }, 1200); });
    win.loadFile(path.join(rendererDir, 'popup.html')); return;
  }
  showPopupAt(popupWindow, anchor);
}
function popupBounds(anchor, height) {
  const bounds = anchor.getBounds();
  const area = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }).workArea;
  const h = Math.round(Math.max(POPUP_MIN_HEIGHT, Math.min(height, area.height - 16)));
  const x = Math.round(Math.max(area.x + 8, Math.min(bounds.x + bounds.width / 2 - POPUP_WIDTH / 2, area.x + area.width - POPUP_WIDTH - 8)));
  const above = bounds.y - h - 8;
  const y = Math.round(Math.max(area.y + 8, Math.min(above >= area.y ? above : bounds.y + bounds.height + 8, area.y + area.height - h - 8)));
  return { x, y, width: POPUP_WIDTH, height: h };
}
function showPopupAt(win, anchor) {
  clearTimeout(popupShowTimer);
  if (!anchor || anchor.isDestroyed() || !popupWanted) { if (!win.isVisible()) win.destroy(); return; }
  win.setBounds(popupBounds(anchor, popupHeight || win.getBounds().height));
  win.show(); win.focus(); broadcast();
}
/** The popup renderer measured its content; fit the window to it (max three accounts). */
function resizePopup(win, height) {
  if (!Number.isFinite(height) || height < 100 || height > 4000) throw new Error(t('error.badArgument'));
  popupHeight = Math.ceil(height);
  if (!win || win.isDestroyed() || !popupAnchor || popupAnchor.isDestroyed()) return;
  if (win.isVisible()) {
    const next = popupBounds(popupAnchor, popupHeight); const current = win.getBounds();
    if (next.height !== current.height || next.y !== current.y || next.x !== current.x) win.setBounds(next);
  } else if (popupWanted) showPopupAt(win, popupAnchor);
}
function writeTrayIcon(directory, filename, rounded, dark, providerId) {
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, trayGaugeIco(rounded, { dark, providerId }));
  return nativeImage.createFromPath(filename);
}
function trayImage(provider) {
  const value = provider ? used(trayWindow(provider)) : null;
  const rounded = value === null ? null : Math.round(value);
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const key = provider ? `${provider.providerId}:${rounded}:${dark}` : 'app';
  if (!iconCache.has(key)) {
    let image = null;
    if (process.platform === 'win32') {
      // Electron's PNG GetHICON uses AsBitmap (1x), ignoring added DPI reps.
      // A real ICO path lets LoadImage select the exact system icon pixel size.
      if (!provider) image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.ico'));
      else {
        const directory = path.join(app.getPath('userData'), 'cache', 'tray-v4');
        try { image = writeTrayIcon(directory, path.join(directory, `${provider.providerId}-${rounded ?? 'unknown'}-${dark ? 'dark' : 'light'}.ico`), rounded, dark, provider.providerId); }
        catch (error) { log('warn', `tray cache ${error?.code || error?.message}`); image = null; }
      }
    }
    if (!image || image.isEmpty()) {
      // No disk cache (or not Windows): build the icon in memory instead of failing.
      image = nativeImage.createEmpty();
      for (const size of [16, 20, 24, 28, 32, 36, 40, 48]) image.addRepresentation({ scaleFactor: size / 16, buffer: provider ? trayGaugePng(size, rounded, { dark, providerId: provider.providerId }) : iconPng(size) });
    }
    if (iconCache.size >= 32) iconCache.delete(iconCache.keys().next().value);
    iconCache.set(key, image);
  }
  return { key, image: iconCache.get(key) };
}
function updateTray(snapshot) {
  const providers = trayProviders(snapshot);
  const selected = settings.value.trayMode === 'app' || !providers.length ? [null] : providers;
  const keys = selected.map(p => p?.id || '__app');
  // Keep each native icon alive independently. Reordering rows or hiding one
  // account must not recreate the other icons and undo the user's shell layout.
  const wanted = new Set(keys);
  for (const [key, entry] of trays) if (!wanted.has(key)) { entry.tray.destroy(); trays.delete(key); }
  for (const provider of selected) {
    const key = provider?.id || '__app';
    if (!trays.has(key)) {
      const icon = trayImage(provider);
      const guid = process.platform === 'win32' ? trayGuid({ appId: identity.appId, executable: app.getPath('exe'), userData: app.getPath('userData'), accountId: provider?.id || null }) : undefined;
      const tray = guid ? new Tray(icon.image, guid) : new Tray(icon.image);
      const entry = { tray, iconKey: icon.key, tooltip: '', serial: ++traySerial };
      trays.set(key, entry);
      tray.on('click', () => togglePopup(tray)); tray.on('double-click', showMain);
      tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
      // Countdown text is refreshed on hover; no background one-second timer.
      tray.on('mouse-enter', () => { if (!quitting) updateTray(state()); });
    }
  }
  if (JSON.stringify([...trays.keys()]) !== JSON.stringify(keys)) {
    const ordered = keys.map(key => [key, trays.get(key)]);
    trays.clear();
    for (const [key, entry] of ordered) trays.set(key, entry);
  }
  for (const provider of selected) {
    const entry = trays.get(provider?.id || '__app'); const icon = trayImage(provider);
    if (entry.iconKey !== icon.key) { entry.tray.setImage(icon.image); entry.iconKey = icon.key; }
    const tooltip = provider ? singleTooltip(provider) : trayTooltip(settings.value.trayMode === 'app' ? visibleProviders(snapshot) : providers);
    if (tooltip !== entry.tooltip) { entry.tray.setToolTip(tooltip); entry.tooltip = tooltip; }
  }
}
function trayMenu() {
  const snapshot = state(); const providers = settings.value.trayMode === 'app' ? visibleProviders(snapshot) : trayProviders(snapshot);
  const update = updater?.state();
  const updateItem = update?.canInstall
    ? { label: t('tray.installUpdate', { version: update.downloadedVersion }), click: () => background(updater.install(), 'update install') }
    : { label: t('tray.checkUpdates'), enabled: !!updater && update?.status !== 'checking' && update?.status !== 'downloading', click: () => background(updater.check({ manual: true }), 'update check') };
  return Menu.buildFromTemplate([
    { label: t('tray.open'), click: showMain }, { type: 'separator' },
    { label: t('tray.header'), enabled: false },
    ...providers.map(p => ({ label: compactSummary(p), enabled: false })), { type: 'separator' },
    { label: t('tray.accounts'), submenu: settings.value.accounts.length ? settings.value.accounts.map(a => ({ label: `${a.providerId === 'custom' ? t('catalog.custom.name') : CATALOG.find(p => p.id === a.providerId).name} · ${a.label}`, type: 'checkbox', checked: a.trayVisible, click: item => saveAccount({ id: a.id, trayVisible: item.checked }) })) : [{ label: t('tray.addAccount'), click: showMain }] },
    { label: snapshot.refreshing ? t('tray.checking') : t('tray.refresh'), enabled: !snapshot.refreshing, click: () => background(usage.refresh({ force: true }), 'refresh') },
    { label: t('tray.alwaysOnTop'), type: 'checkbox', checked: settings.value.alwaysOnTop, click: item => background(changeSettings({ alwaysOnTop: item.checked }), 'always on top') },
    updateItem,
    { type: 'separator' }, { label: t('tray.quit'), click: () => { quitting = true; app.quit(); } }
  ]);
}
function checkNotifications(snapshot) {
  if (usageAlerts) background(usageAlerts.observe(reminderProviders(snapshot), settings.value.notifications), 'usage notification');
  // Warn once, one day before a renewable login reaches the service's final expiry (the
  // card already shows the time left from three days before). Remembered across restarts.
  for (const p of reminderProviders(snapshot)) {
    const ends = Date.parse(p.loginExpiresAt);
    if (p.status !== 'ok' || !Number.isFinite(ends) || ends - Date.now() > RELOGIN_ALERT_MS || ends <= Date.now()) continue;
    const key = `login:${p.id}:${ends}`;
    if (!reloginAlerts || reloginAlerts.has(key)) continue;
    const date = new Date(ends).toLocaleString(i18n.getLanguage() === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    background(reloginAlerts.sendOnce(key, () => notify(t('notify.reloginTitle', { name: p.name, account: p.accountLabel || t('notify.account') }), t('notify.reloginBody', { time: date }))), 'relogin notification');
  }
}
async function notify(title, body) {
  if (!Notification.isSupported() || quitting) return false;
  // Wait for sender registration, but still show the toast if it failed (for
  // example under PowerShell Constrained Language Mode).
  await windowsIdentityReady;
  if (quitting) return false;
  return new Promise(resolve => {
    const note = new Notification({ title, body, icon: notificationIconPath });
    activeNotifications.add(note);
    const timeout = setTimeout(() => {
      activeNotifications.delete(note);
      try { note.close(); } catch { /* Already closed or unavailable. */ }
      resolve(false);
    }, 8000); timeout.unref();
    note.once('show', () => {
      clearTimeout(timeout);
      resolve(true);
    });
    note.once('failed', () => { clearTimeout(timeout); activeNotifications.delete(note); resolve(false); });
    note.once('close', () => activeNotifications.delete(note));
    note.on('click', showMain);
    try { note.show(); }
    catch { clearTimeout(timeout); activeNotifications.delete(note); resolve(false); }
  });
}
function reminderProviders(snapshot = state()) { return monitoredProviders({ ...snapshot, settings: settings.value }).map(p => ({ ...p, windows: p.windows.filter(w => p.showFable || p.providerId !== 'claude' || !/fable/i.test(w.id + w.label)) })); }
function updateReminders() { reminders?.observe(reminderProviders(), settings.value.resetNotifications); scheduleResetCheck(); }
function scheduleResetCheck() {
  clearTimeout(resetTimer);
  if (!reminders || !settings.value.resetNotifications || resetChecking || quitting) return;
  const at = reminders.nextCheckAt(); if (at === null) { resetDueSince = 0; return; }
  const now = Date.now(); let target = at;
  if (at <= now) {
    if (!resetDueSince) resetDueSince = now;
    // Recheck closely around the boundary, then return to the normal poll rate.
    // The server's Retry-After remains enforced by UsageService even when forced.
    const gap = now - resetDueSince < 120000 ? 15000 : settings.value.refreshSeconds * 1000;
    target = Math.max(now + 1000, resetLastAttempt + gap);
    const nextFuture = reminders.nextFutureCheckAt();
    if (nextFuture !== null) target = Math.min(target, nextFuture);
  } else resetDueSince = 0;
  resetTimer = setTimeout(async () => {
    resetChecking = true; resetLastAttempt = Date.now();
    try {
      reminders.tick(settings.value.resetNotifications);
      if (reminders.hasPendingDue()) await usage.refresh({ force: true });
      updateReminders(); broadcast();
    } catch (error) { log('warn', `reset check ${error?.message || error}`); }
    finally { resetChecking = false; scheduleResetCheck(); }
  }, Math.max(1000, Math.min(target - now, 2147483647)));
  resetTimer.unref();
}
function schedule() { clearInterval(poll); poll = setInterval(() => background(usage.refresh(), 'poll'), settings.value.refreshSeconds * 1000); poll.unref(); }
function applyLanguage() {
  const before = i18n.getLanguage();
  i18n.setLanguage(i18n.resolveLanguage(settings.value.language, app.getLocale()));
  if (before !== i18n.getLanguage()) {
    // Provider names of custom accounts and every tooltip follow the language.
    for (const entry of trays.values()) entry.tooltip = '';
  }
}
function applyLoginItem() {
  try {
    if (!app.isPackaged) return;
    const exe = app.getPath('exe');
    app.setLoginItemSettings({ openAtLogin: settings.value.launchAtLogin, path: exe, args: settings.value.startHidden ? ['--hidden'] : [] });
  } catch (error) { log('warn', `login item ${error?.message || error}`); }
}
async function changeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(t('settings.badFormat'));
  const old = { ...settings.value };
  settings.save(patch); // Validation errors propagate with their own message.
  if (Object.hasOwn(patch, 'mobileEnabled') && old.mobileEnabled !== settings.value.mobileEnabled) {
    try { if (settings.value.mobileEnabled) await mobile.start(); else await mobile.stop(); }
    catch (error) {
      log('warn', `mobile ${error?.code || error?.message}`);
      settings.save({ mobileEnabled: false });
      try { await mobile.stop(); } catch { /* Already stopped. */ }
      broadcast();
      throw new Error(t('error.mobileApply'));
    }
  }
  if (old.launchAtLogin !== settings.value.launchAtLogin || old.startHidden !== settings.value.startHidden) applyLoginItem();
  if (patch.accounts) { usage.configure(providerDescriptors()); background(usage.refresh({ force: true }), 'refresh'); }
  // Names and messages are translated when state is sent, so no refetch is needed.
  if (old.language !== settings.value.language) applyLanguage();
  if (old.autoUpdate !== settings.value.autoUpdate) updater?.setEnabled(settings.value.autoUpdate);
  mainWindow?.setAlwaysOnTop(settings.value.alwaysOnTop);
  nativeTheme.themeSource = settings.value.theme;
  if (old.refreshSeconds !== settings.value.refreshSeconds) schedule();
  updateReminders(); broadcast();
  return state();
}
function saveAccount(input) {
  try { const prepared = prepareAccount(input, settings.value.accounts); settings.save({ accounts: prepared.accounts }); usage.configure(providerDescriptors()); background(usage.refresh({ force: true }), 'refresh'); updateReminders(); broadcast(); return { ok: true, account: prepared.account, state: state() }; }
  catch (error) { return { ok: false, error: error.message || t('error.accountSave') }; }
}
function removeAccount(id) {
  if (typeof id !== 'string' || !settings.value.accounts.some(a => a.id === id)) return { ok: false, error: t('error.accountNotFound') };
  try { settings.save({ accounts: settings.value.accounts.filter(a => a.id !== id) }); usage.configure(providerDescriptors()); background(usage.refresh({ force: true }), 'refresh'); updateReminders(); broadcast(); return { ok: true, state: state() }; }
  catch { return { ok: false, error: t('error.accountListSave') }; }
}
function changeAccountOrder(ids) {
  try {
    const accounts = reorderAccounts(settings.value.accounts, ids);
    settings.save({ accounts }); usage.reorder(accounts.map(a => a.id));
    return { ok: true, state: state() };
  } catch (error) { return { ok: false, error: error.message || t('error.accountOrderSave') }; }
}
function registerIpc() {
  const allowedFiles = new Set(['index.html', 'popup.html']);
  const senderFile = event => {
    // Only our top-level packaged renderer can use privileged operations.
    const sender = event.senderFrame;
    if (!sender || sender !== event.sender.mainFrame || !sender.url.startsWith('file:')) return null;
    const file = path.basename(new URL(sender.url).pathname);
    return allowedFiles.has(file) ? file : null;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    if (!senderFile(event)) throw new Error(t('error.ipcDenied'));
    return fn(event, ...args);
  });
  handle('state:get', () => state()); handle('usage:refresh', async () => { await usage.refresh({ force: true }); return state(); });
  handle('settings:set', (_event, patch) => changeSettings(patch));
  handle('account:save', (_event, input) => saveAccount(input));
  handle('account:remove', (_event, id) => removeAccount(id));
  handle('account:reorder', (_event, ids) => changeAccountOrder(ids));
  handle('notification:test', async () => ({ ok: await notify(t('notify.testTitle'), t('notify.testBody')) }));
  handle('main:size', (event, height) => {
    if (senderFile(event) !== 'index.html') throw new Error(t('error.ipcDenied'));
    fitMain(BrowserWindow.fromWebContents(event.sender), height); return true;
  });
  handle('popup:size', (event, height) => {
    if (senderFile(event) !== 'popup.html') throw new Error(t('error.ipcDenied'));
    resizePopup(BrowserWindow.fromWebContents(event.sender), height); return true;
  });
  handle('update:check', async () => { if (!updater) throw new Error(t('error.updateUnavailable')); await updater.check({ manual: true }); return state(); });
  handle('update:download', async () => { if (!updater) throw new Error(t('error.updateUnavailable')); await updater.download(); return state(); });
  handle('update:install', async () => { if (!updater) throw new Error(t('error.updateUnavailable')); return { ok: await updater.install() }; });
  handle('window:action', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (action === 'close') window.hide(); else if (action === 'minimize') window.minimize(); else if (action === 'show-main') showMain(); else if (action === 'show-popup') togglePopup(); else if (action === 'toggle-pin') return changeSettings({ alwaysOnTop: !settings.value.alwaysOnTop }); else throw new Error(t('error.unsupportedAction')); return state();
  });
  handle('mobile:copy', () => { const url = mobile.info().url; if (!url) throw new Error(t('error.mobileOff')); clipboard.writeText(url); return true; });
  handle('external:open', async (_event, action, accountId) => {
    const links = { 'claude-usage': 'https://claude.ai/settings/usage', 'codex-usage': 'https://chatgpt.com/codex/settings/usage', 'gemini-usage': CATALOG.find(p => p.id === 'gemini')?.usageUrl, scriptable: 'https://scriptable.app/', contact: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Limit Tracker ${app.getVersion()}`)}`, release: updater?.state().releaseUrl || releasePage(), releases: releasesPage() };
    if (Object.hasOwn(links, action)) { await shell.openExternal(links[action]); return true; }
    if (action === 'claude-login' || action === 'codex-login') { await launchLogin(action === 'claude-login' ? 'claude' : 'codex'); return true; }
    if (action === 'login' || action === 'usage') {
      const account = settings.value.accounts.find(a => a.id === accountId);
      if (!account) throw new Error(t('error.accountNotFound'));
      if (action === 'login') { await launchLogin(account.id); return { ok: true, message: t('login.opened') }; }
      const link = CATALOG.find(p => p.id === account.providerId)?.usageUrl;
      if (!link) throw new Error(t('error.noUsagePage'));
      await shell.openExternal(link); return { ok: true };
    }
    throw new Error(t('error.unsupportedLink'));
  });
}
async function launchLogin(accountId) {
  if (loginLaunches.has(accountId)) return loginLaunches.get(accountId);
  const pending = Promise.resolve().then(() => launchLoginOnce(accountId));
  loginLaunches.set(accountId, pending);
  try { return await pending; }
  finally { loginLaunches.delete(accountId); }
}
async function launchLoginOnce(accountId) {
  const account = settings.value.accounts.find(a => a.id === accountId);
  if (!account || account.mode === 'manual') throw new Error(t('error.manualLogin'));
  if (loginProcesses.has(accountId)) return;
  const provider = account.providerId;
  // Only Claude Code and Codex have a sign-in; Gemini is manual entry only.
  const find = { claude: findClaudeExecutable, codex: findCodexExecutable }[provider];
  if (!find) throw new Error(t('error.manualLogin'));
  let executable;
  try { executable = await find(); } catch {}
  if (!executable) throw new Error(t('error.cliMissing', { name: ({ claude: 'Claude Code', codex: 'Codex' })[provider] }));
  if (!settings.value.accounts.some(item => item.id === accountId)) throw new Error(t('error.accountNotFound'));
  const child = await launchLoginProcess({ executable, account, userData: app.getPath('userData') });
  loginProcesses.set(accountId, child);
  const exited = () => { loginProcesses.delete(accountId); if (!quitting) background(usage.refresh({ force: true }), 'refresh'); };
  child.once('exit', exited);
  if (child.exitCode !== null || child.signalCode != null) { child.removeListener('exit', exited); exited(); }
  clearInterval(loginTimer); let checks = 0;
  loginTimer = setInterval(() => { background(usage.refresh({ force: true }), 'refresh'); if (++checks >= 40) { clearInterval(loginTimer); loginTimer = null; } }, 15000); loginTimer.unref();
}
async function prepareWindowsIdentity() {
  if (app.isPackaged && process.platform === 'win32') {
    // Keep sender assets outside ASAR and outside a temporary verification profile.
    const directory = path.join(app.getPath('appData'), identity.displayName);
    fs.mkdirSync(directory, { recursive: true });
    windowsIconPath = path.join(directory, `app-icon-${app.getVersion()}.ico`);
    notificationIconPath = path.join(directory, `app-icon-${app.getVersion()}.png`);
    for (const [source, destination] of [['icon.ico', windowsIconPath], ['icon.png', notificationIconPath]]) fs.copyFileSync(path.join(__dirname, '..', 'assets', source), destination);
    registerWindowsShortcuts({ appData: app.getPath('appData'), desktopDir: app.getPath('desktop'), executable: app.getPath('exe'), iconPath: windowsIconPath, shell, identity });
    await registerWindowsNotificationIdentity({ identity, iconPath: notificationIconPath });
  }
}
/** installed = the program set up by "Limit Tracker.exe" (has an uninstaller); dev = anything else. */
function updateMode() {
  if (!app.isPackaged) return 'dev';
  const directory = path.dirname(app.getPath('exe'));
  return fs.existsSync(path.join(directory, `Uninstall ${identity.displayName}.exe`)) ? 'installed' : 'dev';
}
function createUpdater() {
  const mode = updateMode();
  let autoUpdater = null;
  if (mode === 'installed') {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.logger = { info: message => log('info', `updater ${message}`), warn: message => log('warn', `updater ${message}`), error: message => log('error', `updater ${message}`), debug() {} };
    } catch (error) { log('error', `updater load ${error?.message || error}`); autoUpdater = null; }
  }
  // The installer is launched by us (not by electron-updater) so a refused start
  // is noticed before the app quits.
  const launchInstaller = (file, args) => new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }); } catch (error) { reject(error); return; }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  const quitForUpdate = () => { quitting = true; setTimeout(() => app.quit(), 150); };
  updater = new UpdateManager({ currentVersion: app.getVersion(), mode, autoUpdater, launchInstaller, quitForUpdate, log: message => log('warn', message) });
  updater.on('change', () => { if (!quitting) broadcast(); });
  // Tell the user once per version, not at every start while the update waits for a click.
  updater.on('downloaded', ({ version }) => {
    updateAlerts ||= new AlertLog(path.join(app.getPath('userData'), 'update-alerts.json'));
    background(updateAlerts.sendOnce(`update:${version}`, () => notify(t('notify.updateDownloadedTitle', { version }), t('notify.updateDownloadedBody'))), 'update notification');
  });
  updater.on('available', ({ version, selfUpdating }) => { if (!selfUpdating) background(notify(t('notify.updateAvailableTitle', { version }), t('notify.updateAvailableBody')), 'update notification'); });
  // The app is marked as quitting only by the real quit (before-quit); a failed
  // install keeps everything working.
  updater.on('installing', ({ version }) => log('info', `installing update ${version}`));
  updater.on('install-failed', ({ error }) => { log('warn', `update install failed: ${error}`); broadcast(); });
  updater.setEnabled(settings.value.autoUpdate);
}
async function start() {
  // No default menu: its View accelerators (reload, zoom, devtools) do not belong in this app.
  Menu.setApplicationMenu(null);
  // First-run defaults (such as the default account name) follow the Windows language.
  i18n.setLanguage(i18n.resolveLanguage('system', app.getLocale()));
  settings = new SettingsStore(app.getPath('userData'));
  if (settings.loadError) log('warn', `settings ${settings.loadError}; original kept as settings.json.bak`);
  applyLanguage();
  // Cold shell registration must not hold up the dashboard or initial usage.
  // Notifications alone await it, so they cannot race with sender registration.
  windowsIdentityReady = prepareWindowsIdentity().then(() => true, error => { log('warn', `windows identity ${error?.code || error?.message}`); return false; });
  usage = new UsageService(providerDescriptors(), { onListenerError: error => log('error', `ui update ${error?.stack || error}`) });
  mobile = new MobileServer({ key: settings.mobileKey, getState: state, rendererDir, widgetPath: path.join(__dirname, 'widget', 'LimitTracker.js'), onError: error => log('warn', `mobile server ${error?.code || error?.message}`) });
  reloginAlerts = new AlertLog(path.join(app.getPath('userData'), 'relogin-alerts.json'));
  usageAlerts = new UsageAlerts({ notify: ({ provider, window, percent }) => {
    const current = localizeProvider(provider);
    const label = current.windows.find(item => item.id === window.id)?.label || window.label;
    return notify(
      t('notify.usageTitle', { name: current.name, account: current.accountLabel || t('notify.account'), percent }),
      t('notify.usageBody', { label, percent })
    );
  } });
  reminders = new ResetReminders({ file: path.join(app.getPath('userData'), 'reset-reminders.json'), notify: item => {
    const current = state().providers.find(p => p.id === item.providerId);
    const label = current?.windows.find(w => w.id === item.windowId)?.label || item.label;
    const values = { name: current?.name || item.name, account: current?.accountLabel || item.accountLabel || t('notify.account'), label };
    return notify(t(item.manual ? 'notify.resetTitleManual' : 'notify.resetTitleAuto', values), t(item.manual ? 'notify.resetBodyManual' : 'notify.resetBodyAuto', values));
  } });
  nativeTheme.themeSource = settings.value.theme;
  if (settings.value.launchAtLogin) applyLoginItem();
  registerIpc();
  usage.on('change', snapshot => {
    try { broadcast(); checkNotifications(snapshot); updateReminders(); }
    catch (error) { log('error', `change ${error?.stack || error}`); }
  });
  nativeTheme.on('updated', () => { if (!quitting) { try { updateTray(state()); } catch (error) { log('warn', `theme ${error?.message}`); } } });
  powerMonitor.on('resume', () => { resetLastAttempt = 0; updateReminders(); background(usage.refresh({ force: true }), 'resume'); });
  powerMonitor.on('unlock-screen', () => background(usage.refresh(), 'unlock'));
  if (settings.value.mobileEnabled) { try { await mobile.start(); } catch (error) { log('warn', `mobile ${error?.code || error?.message}`); settings.save({ mobileEnabled: false }); } }
  // Persist only local preferences and the phone connection key; never authentication tokens.
  // A settings file that could not be read cleanly is never overwritten here.
  if (!fs.existsSync(settings.file) || (settings.mobileKeyIsNew && !settings.loadError)) settings.save({});
  createUpdater();
  broadcast(); schedule();
  // Automatic update restarts (`--updated`) stay in the tray like `--hidden`.
  if (!settings.value.startHidden && !process.argv.includes('--hidden') && !process.argv.includes('--updated')) showMain();
  log('info', `started ${app.getVersion()} (${updater.mode})`);
  await usage.refresh({ force: true });
}
app.on('window-all-closed', () => {});
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true; clearInterval(poll); clearInterval(loginTimer); clearTimeout(resetTimer); clearTimeout(popupShowTimer); updater?.dispose(); background(mobile?.stop(), 'mobile stop'); for (const entry of trays.values()) entry.tray.destroy(); trays.clear(); });
// Used by local verification scripts, never exposed through the renderer bridge.
module.exports.runtimeDiagnostics = () => ({ trayCount: trays.size, trayIds: [...trays.keys()], trayInstances: Object.fromEntries([...trays].map(([key, entry]) => [key, { serial: entry.serial, guid: entry.tray.getGUID(), bounds: entry.tray.getBounds(), iconKey: entry.iconKey, tooltip: entry.tooltip }])), trayScaleFactors: [...trays.values()].map(entry => iconCache.get(entry.iconKey)?.getScaleFactors() || []), cachedImages: iconCache.size, mainLoaded: !!mainWindow, popupLoaded: !!popupWindow, popupBounds: popupWindow && !popupWindow.isDestroyed() ? popupWindow.getBounds() : null, popupHeight, updateMode: updater?.mode || null, language: i18n.getLanguage() });
module.exports.trayMenuTemplate = () => trayMenu().items.map(item => item.label);
