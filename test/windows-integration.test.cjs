'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_ID, windowsIdentity, windowAppDetails, notificationRegistration, registerWindowsShortcuts, registerWindowsNotificationIdentity, readWindowsNotificationIdentity, verifyWindowsIdentity } = require('../src/windows-integration.cjs');

test('Windows production, development and verification have separate names, shortcut files and activators', () => {
  const identities = [windowsIdentity({ isPackaged: true }), windowsIdentity({ isPackaged: false }), windowsIdentity({ isPackaged: true, verification: true })];
  assert.equal(identities[0].appId, APP_ID);
  for (const key of ['appId', 'displayName', 'shortcutName', 'toastClsid']) assert.equal(new Set(identities.map(identity => identity[key])).size, 3);
  assert.notEqual(windowsIdentity().appId, APP_ID);
});

test('window properties bind taskbar identity, icon and safely quoted relaunch target together', () => {
  const identity = windowsIdentity({ isPackaged: true });
  const executable = path.resolve("한글 자료's", 'Limit Tracker.exe');
  const iconPath = path.resolve("한글 자료's", 'icon.ico');
  const result = windowAppDetails({ identity, executable, iconPath, args: ['argument with spaces', 'quote"here', 'end\\'] });
  assert.equal(result.appId, APP_ID);
  assert.equal(result.appIconPath, iconPath);
  assert.equal(result.relaunchDisplayName, 'Limit Tracker');
  assert.equal(result.relaunchCommand, `"${executable}" "argument with spaces" "quote\\"here" "end\\\\"`);
  assert.throws(() => windowAppDetails({ identity, executable: 'relative.exe' }));
  assert.throws(() => windowAppDetails({ identity, executable, args: ['bad\nargument'] }));
});

test('shortcuts use only the chosen identity, include current path, and do not overwrite the product desktop shortcut in tests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-windows-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const desktopDir = path.join(directory, 'desktop'); fs.mkdirSync(desktopDir);
  fs.writeFileSync(path.join(desktopDir, 'Limit Tracker.lnk'), 'product marker');
  const writes = [];
  const identity = windowsIdentity({ verification: true });
  const executable = path.join(directory, "새 폴더's", 'electron.exe');
  const iconPath = path.join(directory, 'icon.ico');
  const shortcut = registerWindowsShortcuts({ appData: directory, desktopDir, executable, iconPath, identity, args: [path.join(directory, 'test entry.cjs')], shell: { writeShortcutLink: (...args) => { writes.push(args); return true; } } });
  assert.equal(path.basename(shortcut), identity.shortcutName);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].appUserModelId, identity.appId);
  assert.equal(writes[0][2].target, executable);
  assert.equal(writes[0][2].icon, iconPath);
  assert.equal(writes[0][2].toastActivatorClsid, identity.toastClsid);
  assert.equal(fs.readFileSync(path.join(desktopDir, 'Limit Tracker.lnk'), 'utf8'), 'product marker');
});

test('notification registry registration confines all values to the exact app HKCU identity', async () => {
  const identity = windowsIdentity({ verification: true });
  const iconPath = path.resolve("한글's $icon; folder", 'notification.png');
  const expected = notificationRegistration({ identity, iconPath });
  let script;
  const result = await registerWindowsNotificationIdentity({ identity, iconPath, execute: (program, args, options, callback) => {
    assert.equal(path.basename(program).toLowerCase(), 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const decoded = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8'));
    assert.deepEqual(decoded, [expected.registryPath, expected.displayName, expected.iconPath, expected.toastClsid]);
    assert.match(script, /Registry\]::CurrentUser\.CreateSubKey/);
    assert.doesNotMatch(script, /LocalMachine|Remove-|Delete|CLSID\\/);
    assert.ok(!script.includes(iconPath));
    assert.doesNotMatch(script, /ConvertFrom-Json|ConvertTo-Json/);
    callback(null, [expected.displayName, expected.iconPath, expected.toastClsid].map(value => Buffer.from(value).toString('base64')).join('\r\n') + '\r\n');
  } });
  assert.equal(result.registryPath, `Software\\Classes\\AppUserModelId\\${identity.appId}`);
  assert.equal(result.displayName, identity.displayName);
  assert.equal(result.iconPath, iconPath);
  assert.throws(() => notificationRegistration({ identity: { ...identity, appId: 'other.app' }, iconPath }));
  assert.throws(() => notificationRegistration({ identity: { ...identity, displayName: 'spoofed' }, iconPath }));
});

test('readback is read-only and mismatched/failed registration is not reported as success', async () => {
  const identity = windowsIdentity({ verification: true });
  const missing = await readWindowsNotificationIdentity({ identity, execute: (_program, args, _options, callback) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /OpenSubKey/);
    assert.doesNotMatch(script, /CreateSubKey|SetValue/);
    callback(null, 'null');
  } });
  assert.equal(missing, null);
  const iconPath = path.resolve('icon.png');
  await assert.rejects(registerWindowsNotificationIdentity({ identity, iconPath, execute: (_p, _a, _o, callback) => callback(null, '{}') }), /등록 결과/);
  await assert.rejects(registerWindowsNotificationIdentity({ identity, iconPath, execute: (_p, _a, _o, callback) => callback(null, ['wrong sender', iconPath, `{${identity.toastClsid}}`].map(value => Buffer.from(value).toString('base64')).join('\n')) }), /등록값/);
  await assert.rejects(registerWindowsNotificationIdentity({ identity, iconPath, execute: (_p, _a, _o, callback) => callback(Object.assign(new Error('private diagnostic'), { killed: true })) }), error => error.code === 'WINDOWS_IDENTITY_TIMEOUT' && !error.message.includes('private'));
  await assert.rejects(registerWindowsNotificationIdentity({ identity, iconPath, execute: (_p, _a, _o, callback) => callback(new Error('private arbitrary diagnostic')) }), error => !error.message.includes('private'));
});

test('development verification cannot publish a product-identity toast', async () => {
  let touched = false;
  await assert.rejects(verifyWindowsIdentity({ app: { isPackaged: false }, identity: windowsIdentity({ isPackaged: true }), shell: { writeShortcutLink() { touched = true; } } }), /개발용 Electron/);
  assert.equal(touched, false);
});
