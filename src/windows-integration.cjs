'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { t } = require('./i18n.cjs');
const APP_ID = 'local.limittracker.desktop';
const TOAST_CLSID = '793c47db-07dc-4a89-99dd-44b5e64f77ec';
const IDENTITIES = Object.freeze({
  production: Object.freeze({ appId: APP_ID, displayName: 'Limit Tracker', shortcutName: 'Limit Tracker.lnk', toastClsid: TOAST_CLSID }),
  development: Object.freeze({ appId: `${APP_ID}.development`, displayName: 'Limit Tracker Development', shortcutName: 'Limit Tracker Development.lnk', toastClsid: 'e1c79210-a08e-4863-a31e-8612541c7df2' }),
  verification: Object.freeze({ appId: `${APP_ID}.verification`, displayName: 'Limit Tracker Verification', shortcutName: 'Limit Tracker Verification.lnk', toastClsid: '948bc9fd-f646-4c93-98f5-442f3ebd44e9' })
});
function windowsIdentity({ isPackaged = false, verification = false } = {}) { return IDENTITIES[verification ? 'verification' : isPackaged ? 'production' : 'development']; }
function checkedIdentity(identity) {
  const known = Object.values(IDENTITIES).find(item => item.appId === identity?.appId);
  if (!known || Object.keys(known).some(key => identity[key] !== known[key])) throw new Error(t('windows.badIdentity'));
  return known;
}
function absoluteFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n"]/.test(value)) throw new Error(t('windows.badPath'));
  return value;
}
function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error(t('windows.badArgument'));
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function windowAppDetails({ identity, executable, iconPath = executable, args = [] }) {
  const info = checkedIdentity(identity);
  if (!Array.isArray(args)) throw new Error(t('windows.badArgument'));
  return { appId: info.appId, appIconPath: absoluteFile(iconPath), appIconIndex: 0, relaunchCommand: [absoluteFile(executable), ...args].map(quoteWindowsArgument).join(' '), relaunchDisplayName: info.displayName };
}
// Electron registers this shortcut's toast activator while the app is running.
// https://www.electronjs.org/docs/latest/tutorial/notifications
// Development MUST also use a different app.setName(): Electron 44's
// EnsureShortcut chooses <application name>.lnk and may rewrite its target.
function sameFile(a, b) { return typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function registerWindowsShortcuts({ appData, desktopDir, executable, iconPath = executable, shell, identity = IDENTITIES.production, args = [] }) {
  const info = checkedIdentity(identity);
  const details = { target: absoluteFile(executable), cwd: path.dirname(executable), description: t('windows.shortcutDescription'), icon: absoluteFile(iconPath), iconIndex: 0, appUserModelId: info.appId, toastActivatorClsid: info.toastClsid, args: args.map(quoteWindowsArgument).join(' ') };
  const directory = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(directory, { recursive: true });
  const startMenu = path.join(directory, info.shortcutName);
  if (!shell.writeShortcutLink(startMenu, 'create', details)) throw new Error(t('windows.shortcutFailed'));
  // A desktop shortcut belongs to the user: only refresh the toast identity and
  // icon of one that already starts this executable, never its target or arguments.
  const desktop = path.join(desktopDir, info.shortcutName);
  if (fs.existsSync(desktop)) {
    let current = null;
    try { current = shell.readShortcutLink?.(desktop); } catch { current = null; }
    if (current && sameFile(current.target, executable) && !shell.writeShortcutLink(desktop, 'update', { icon: details.icon, iconIndex: 0, appUserModelId: info.appId, toastActivatorClsid: info.toastClsid })) throw new Error(t('windows.desktopFailed'));
  }
  return startMenu;
}
// Microsoft WindowsAppSDK RegisterAssets and Toolkit ToastNotificationManagerCompat
// register these values under HKCU, separately from the toast's content icon.
// https://github.com/microsoft/WindowsAppSDK/blob/main/dev/AppNotifications/AppNotificationUtility.cpp
function notificationRegistration({ identity, iconPath }) {
  const info = checkedIdentity(identity);
  return { registryPath: `Software\\Classes\\AppUserModelId\\${info.appId}`, appId: info.appId, displayName: info.displayName, iconPath: absoluteFile(iconPath), toastClsid: `{${info.toastClsid}}` };
}
function runRegistry({ identity, iconPath, write, execute = execFile, env = process.env }) {
  const info = checkedIdentity(identity);
  const registration = write ? notificationRegistration({ identity: info, iconPath }) : { registryPath: `Software\\Classes\\AppUserModelId\\${info.appId}` };
  // Values travel only as base64 data. Avoid JSON cmdlets: their first-use
  // PowerShell module initialization can delay a tiny registry operation by
  // many seconds. The .NET registry/encoding calls do not load those modules.
  const encoded = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`;
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $key=$null; try { ` +
    (write ? `$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${encoded(registration.registryPath)}); $key.SetValue('DisplayName',${encoded(registration.displayName)},[Microsoft.Win32.RegistryValueKind]::String); $key.SetValue('IconUri',${encoded(registration.iconPath)},[Microsoft.Win32.RegistryValueKind]::String); $key.SetValue('CustomActivator',${encoded(registration.toastClsid)},[Microsoft.Win32.RegistryValueKind]::String); ` : `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${encoded(registration.registryPath)},$false); `) +
    `if ($null -eq $key) { [Console]::Write('null') } else { ` + ['DisplayName', 'IconUri', 'CustomActivator'].map(name => `[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$key.GetValue('${name}'))));`).join(' ') +
    ` } } finally { if ($null -ne $key) { $key.Dispose() } }`;
  const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) {
        const failure = new Error(write ? t('windows.registerFailed') : t('windows.readFailed'));
        failure.code = error.killed ? 'WINDOWS_IDENTITY_TIMEOUT' : 'WINDOWS_IDENTITY_REGISTRY_FAILED';
        return reject(failure);
      }
      try {
        const output = stdout.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/\n$/, '');
        if (output === 'null') return resolve(null);
        const lines = output.split('\n');
        if (lines.length !== 3 || lines.some(line => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(line))) throw new Error('Invalid registry readback');
        const [displayName, iconPath, toastClsid] = lines.map(line => Buffer.from(line, 'base64').toString('utf8'));
        resolve({ registryPath: registration.registryPath, displayName, iconPath, toastClsid });
      }
      catch { reject(new Error(t('windows.readbackFailed'))); }
    });
  });
}
async function registerWindowsNotificationIdentity(options) {
  const expected = notificationRegistration(options);
  const actual = await runRegistry({ ...options, write: true });
  if (!actual || ['registryPath', 'displayName', 'iconPath', 'toastClsid'].some(key => actual[key] !== expected[key])) throw new Error(t('windows.mismatch'));
  return { ...actual, appId: expected.appId };
}
function readWindowsNotificationIdentity(options) { return runRegistry({ ...options, write: false }); }
async function verifyWindowsIdentity({ app, shell, Notification, identity, executable, iconPath, notificationIconPath, appData, desktopDir, args = [], holdMs = 5000 }) {
  const info = checkedIdentity(identity);
  if (!app.isPackaged && info.appId === APP_ID) throw new Error(t('windows.devVerify'));
  if (path.resolve(app.getPath('exe')).toLowerCase() !== path.resolve(executable).toLowerCase()) throw new Error(t('windows.exeMismatch'));
  if (app.getName() !== info.displayName) throw new Error(t('windows.nameMismatch'));
  const shortcut = registerWindowsShortcuts({ appData, desktopDir, executable, iconPath, shell, identity: info, args });
  const registration = await registerWindowsNotificationIdentity({ identity: info, iconPath: notificationIconPath });
  const read = shell.readShortcutLink(shortcut);
  if (path.resolve(read.target).toLowerCase() !== path.resolve(executable).toLowerCase() || read.appUserModelId !== info.appId || read.icon !== iconPath || read.toastActivatorClsid.toLowerCase().replace(/[{}]/g, '') !== info.toastClsid) throw new Error(t('windows.shortcutMismatch'));
  const notificationAccepted = Notification.isSupported() && await new Promise(resolve => {
    const note = new Notification({ title: '알림 표시 확인', body: `${info.displayName}의 발신자 이름과 아이콘을 확인하는 테스트 알림입니다.`, icon: notificationIconPath });
    const timer = setTimeout(() => resolve(false), 12000);
    note.once('show', () => { clearTimeout(timer); setTimeout(() => { note.close(); resolve(true); }, holdMs); });
    note.once('failed', () => { clearTimeout(timer); resolve(false); });
    note.show();
  });
  // Electron's 'show' means WinRT accepted Show(), not proof of the visible
  // sender line. Keep the visual observation explicitly separate.
  return { appId: info.appId, expectedSender: info.displayName, executable, packaged: app.isPackaged, shortcut, shortcutRegistered: true, notificationRegistration: registration, notificationAccepted, senderVisualVerified: false };
}
module.exports = { APP_ID, TOAST_CLSID, windowsIdentity, windowAppDetails, notificationRegistration, registerWindowsShortcuts, registerWindowsNotificationIdentity, readWindowsNotificationIdentity, verifyWindowsIdentity };
