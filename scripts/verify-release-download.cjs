'use strict';
// Opt-in, read-only release check using the real Windows updater and public GitHub.
// Downloads into a fresh temporary profile; never launches or installs the file.
// Run: electron scripts/verify-release-download.cjs <older-version> <published-version>
const { app } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { UpdateManager, parseVersion, compareVersions, FEED } = require('../src/updater.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const [from, target] = process.argv.slice(2);
assert.ok(parseVersion(from) && parseVersion(target) && compareVersions(target, from) > 0, 'Pass an older version and the published target version.');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-release-check-'));
app.setPath('userData', temporary);
const config = path.join(temporary, 'app-update.yml');
fs.writeFileSync(config, yaml.dump({ provider: 'github', ...FEED, updaterCacheDirName: 'isolated-updater' }));
const digest = (file, algorithm, encoding = 'hex') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
let manager;
const watchdog = setTimeout(() => { console.error('Release download verification timed out'); app.exit(1); }, 180000);
app.whenReady().then(async () => {
  const response = await fetch(`https://api.github.com/repos/${FEED.owner}/${FEED.repo}/releases/tags/v${target}`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const release = await response.json();
  assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  const name = `Limit-Tracker-${target}.exe`;
  for (const expected of [name, name + '.blockmap', 'latest.yml', 'portable.yml']) {
    assert.ok(release.assets.some(asset => asset.name === expected && asset.state === 'uploaded'), `Missing published asset: ${expected}`);
  }
  const texts = {};
  for (const name of ['latest.yml', 'portable.yml']) {
    const response = await fetch(release.assets.find(asset => asset.name === name).browser_download_url, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); texts[name] = yaml.load(await response.text());
    assert.equal(texts[name].version, target);
  }
  let quitHandlers = 0, installCalls = 0;
  const adapter = {
    version: from, name: 'Limit Tracker verification', isPackaged: true,
    appUpdateConfigPath: config, userDataPath: temporary, baseCachePath: temporary,
    whenReady: () => app.whenReady(),
    onQuit() { quitHandlers++; throw new Error('Verification must not arm installation on quit'); },
    quit() { throw new Error('Verification must not request quit for installation'); },
    relaunch() { throw new Error('Verification must not relaunch'); },
  };
  const auto = new NsisUpdater(null, adapter);
  auto.httpExecutor = new ElectronHttpExecutor((_info, callback) => callback());
  auto.logger = null;
  auto.disableDifferentialDownload = true;
  auto.install = () => { installCalls++; throw new Error('Verification must not install'); };
  manager = new UpdateManager({ currentVersion: from, mode: 'installed', autoUpdater: auto, launchInstaller: async () => { installCalls++; throw new Error('Verification must not launch'); } });
  manager.setEnabled(false);
  const downloaded = new Promise((resolve, reject) => { auto.once('update-downloaded', resolve); auto.once('error', reject); });
  await Promise.all([manager.check({ manual: true }), downloaded]);
  assert.equal(manager.state().status, 'downloaded');
  assert.equal(manager.state().downloadedVersion, target);
  assert.equal(auto.autoInstallOnAppQuit, false);
  assert.equal(quitHandlers, 0); assert.equal(installCalls, 0);
  const file = auto.installerPath;
  assert.ok(path.resolve(file).startsWith(path.resolve(temporary) + path.sep));
  const sha256 = digest(file, 'sha256');
  const sha512 = digest(file, 'sha512', 'base64');
  const local = path.join(root, 'dist', name);
  assert.equal(sha256, digest(local, 'sha256'), 'GitHub installer differs from the archived local build');
  for (const info of Object.values(texts)) { assert.equal(info.path, name); assert.equal(info.sha512, sha512); }
  assert.equal(texts['latest.yml'].files.find(item => item.url === name).size, fs.statSync(file).size);
  const asset = release.assets.find(asset => asset.name === name);
  assert.equal(asset.size, fs.statSync(file).size);
  if (asset.digest) assert.equal(asset.digest, `sha256:${sha256}`);
  const result = { checkedAt: new Date().toISOString(), from, target, release: release.html_url, status: manager.state().status, bytes: fs.statSync(file).size, sha256, metadataMatched: true, isolatedProfile: true, installCalls, quitHandlers };
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', `release-download-${target}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  manager.dispose(); clearTimeout(watchdog); app.exit(0);
}).catch(error => { manager?.dispose(); clearTimeout(watchdog); console.error(error.stack); app.exit(1); });
