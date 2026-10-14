'use strict';
// node scripts/verify-windows.cjs [absolute packaged exe]
//   verifies the real packaged process through its dedicated, no-account mode.
// electron scripts/verify-windows.cjs
//   runs a separate Verification identity; never registers production as Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { APP_ID, windowsIdentity, verifyWindowsIdentity } = require('../src/windows-integration.cjs');
const project = path.resolve(__dirname, '..');

function cleanupTemporary(directory) {
  // This exact directory was created by this invocation, not discovered by glob.
  try {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved).toLowerCase() === fs.realpathSync(os.tmpdir()).toLowerCase()) fs.rmSync(resolved, { recursive: true, force: true });
  } catch { /* Windows may keep a Chromium cache file open until process exit. */ }
}

async function verifyPackaged() {
  const executable = path.resolve(process.argv[2] || path.join(project, 'dist', 'win-unpacked', 'Limit Tracker.exe'));
  assert.ok(fs.existsSync(executable), 'Build the packaged executable before verification.');
  assert.notEqual(path.basename(executable).toLowerCase(), 'electron.exe', 'A development Electron executable is not a packaged-product check.');
  const report = path.join(project, 'artifacts', 'windows-identity-packaged.json');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-windows-package-check-'));
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.rmSync(report, { force: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [`--verify-windows-identity=${report}`, `--user-data-dir=${temporary}`], { env, windowsHide: true, shell: false, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged identity verification timed out.')); }, 120000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Packaged verification exited with ${code}.`)); });
    });
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(result.packaged, true);
    assert.equal(result.appId, APP_ID);
    assert.equal(path.resolve(result.executable).toLowerCase(), executable.toLowerCase());
    assert.equal(result.expectedSender, 'Limit Tracker');
    assert.equal(result.shortcutRegistered, true);
    assert.equal(result.notificationAccepted, true);
    assert.equal(result.notificationRegistration.displayName, 'Limit Tracker');
    console.log(JSON.stringify({ ...result, report }));
  } finally { cleanupTemporary(temporary); }
}

function verifyDevelopment() {
  const { app, shell, Notification } = require('electron');
  const identity = windowsIdentity({ verification: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-windows-check-'));
  app.setName(identity.displayName);
  app.setPath('userData', temporary);
  app.setAppUserModelId(identity.appId);
  app.whenReady().then(async () => {
    const assetDirectory = path.join(app.getPath('appData'), identity.displayName);
    fs.mkdirSync(assetDirectory, { recursive: true });
    const iconPath = path.join(assetDirectory, 'verification-icon.ico');
    const notificationIconPath = path.join(assetDirectory, 'verification-icon.png');
    fs.copyFileSync(path.join(project, 'assets', 'icon.ico'), iconPath);
    fs.copyFileSync(path.join(project, 'assets', 'icon.png'), notificationIconPath);
    const result = await verifyWindowsIdentity({ app, shell, Notification, identity, executable: app.getPath('exe'), iconPath, notificationIconPath, appData: app.getPath('appData'), desktopDir: app.getPath('desktop'), args: [__filename] });
    console.log(JSON.stringify(result));
    app.exit(result.notificationAccepted ? 0 : 1);
  }).catch(error => { console.error(error.message); app.exit(1); });
  process.on('exit', () => cleanupTemporary(temporary));
}

if (process.versions.electron) verifyDevelopment();
else verifyPackaged().catch(error => { console.error(error.message); process.exitCode = 1; });
