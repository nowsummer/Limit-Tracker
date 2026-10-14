'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager, compareVersions, parseLatestYaml, latestYamlUrl, releasePage, FEED } = require('../src/updater.cjs');

const NOW = Date.parse('2026-10-07T00:00:00Z');
function fakeTimers() {
  const queue = [];
  let id = 0;
  return {
    setTimeoutImpl: (fn, ms) => { const timer = { id: ++id, fn, ms, unref() { return this; } }; queue.push(timer); return timer; },
    clearTimeoutImpl: timer => { const index = queue.indexOf(timer); if (index >= 0) queue.splice(index, 1); },
    async runNext(filter = () => true) { const index = queue.findIndex(filter); if (index < 0) return null; const [timer] = queue.splice(index, 1); await timer.fn(); return timer; },
    queue,
  };
}
function textResponse(status, body) { return { status, ok: status >= 200 && status < 300, text: async () => body }; }
class FakeAutoUpdater extends EventEmitter {
  constructor() { super(); this.autoDownload = true; this.checks = 0; this.downloads = 0; this.installs = []; }
  async checkForUpdates() { this.checks++; this.emit('checking-for-update'); }
  async downloadUpdate() { this.downloads++; }
  quitAndInstall(silent, force) { this.installs.push([silent, force]); }
}

test('version comparison handles numeric and prerelease ordering', () => {
  assert.ok(compareVersions('1.5.0', '1.4.0') > 0);
  assert.ok(compareVersions('1.4.10', '1.4.9') > 0);
  assert.equal(compareVersions('v1.4.0', '1.4.0'), 0);
  assert.ok(compareVersions('1.5.0-beta.1', '1.5.0') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.ok(Number.isNaN(compareVersions('latest', '1.0.0')));
  assert.ok(Number.isNaN(compareVersions('1.5.0 extra', '1.0.0')));
});

test('latest.yml parsing reads the electron-builder scalars and rejects garbage', () => {
  const info = parseLatestYaml('version: 1.6.0\nfiles:\n  - url: Limit-Tracker-Setup-1.6.0.exe\n    sha512: abc\npath: Limit-Tracker-Setup-1.6.0.exe\nsha512: abc\nsize: 1234\nreleaseDate: \'2026-10-08T00:00:00.000Z\'\n');
  assert.equal(info.version, '1.6.0'); assert.equal(info.path, 'Limit-Tracker-Setup-1.6.0.exe'); assert.equal(info.releaseDate, '2026-10-08T00:00:00.000Z'); assert.equal(info.size, 1234);
  assert.equal(parseLatestYaml('<html>not yaml</html>'), null);
  assert.equal(parseLatestYaml(''), null);
});

test('feed URLs point at the public GitHub release of the configured repository', () => {
  assert.equal(latestYamlUrl(), `https://github.com/${FEED.owner}/${FEED.repo}/releases/latest/download/latest.yml`);
  assert.equal(releasePage({ owner: 'a', repo: 'b' }), 'https://github.com/a/b/releases/latest');
});

test('a copy without a self-update engine checks the feed and offers the download page', async () => {
  const requests = [];
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'dev', fetchImpl: async (url, init) => { requests.push({ url, init }); return textResponse(200, 'version: 1.6.0\npath: Limit-Tracker-Setup-1.6.0.exe\n'); }, now: () => NOW, ...fakeTimers() });
  const events = [];
  manager.on('available', event => events.push(event));
  const state = await manager.check({ manual: true });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, latestYamlUrl()); assert.equal(requests[0].init.redirect, 'follow');
  assert.equal(state.status, 'available'); assert.equal(state.latestVersion, '1.6.0'); assert.equal(state.canInstall, false); assert.equal(state.canDownload, false); assert.equal(state.selfUpdating, false);
  assert.deepEqual(events, [{ version: '1.6.0', releaseUrl: releasePage(), selfUpdating: false }]);
  assert.equal(state.checkedAt, new Date(NOW).toISOString());
  await manager.check({ manual: true });
  assert.equal(events.length, 1, 'the same version is announced once');
});

test('a feed without any published release and network failures are distinct, non-fatal states', async () => {
  const timers = fakeTimers();
  const missing = new UpdateManager({ currentVersion: '1.5.0', mode: 'dev', fetchImpl: async () => textResponse(404, 'Not Found'), now: () => NOW, ...timers });
  assert.equal((await missing.check()).error, 'no-release');
  const offline = new UpdateManager({ currentVersion: '1.5.0', mode: 'dev', fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: () => NOW, ...timers });
  const state = await offline.check();
  assert.equal(state.status, 'error'); assert.equal(state.error, 'network');
  const same = new UpdateManager({ currentVersion: '1.5.0', mode: 'dev', fetchImpl: async () => textResponse(200, 'version: 1.5.0\n'), now: () => NOW, ...timers });
  assert.equal((await same.check()).status, 'up-to-date');
});

test('installed copies download in the background and never install by themselves', async () => {
  const timers = fakeTimers();
  const auto = new FakeAutoUpdater();
  auto.installerPath = 'C:/cache/Limit-Tracker-1.6.0.exe';
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, now: () => NOW, ...timers });
  assert.equal(auto.autoInstallOnAppQuit, false, 'nothing installs on quit'); assert.equal(auto.allowPrerelease, false); assert.equal(auto.disableWebInstaller, true); assert.equal(auto.allowDowngrade, false);
  const downloaded = [];
  manager.on('downloaded', event => downloaded.push(event));
  const checking = manager.check();
  await Promise.resolve();
  auto.emit('update-available', { version: '1.6.0' });
  assert.equal(manager.state().status, 'downloading');
  auto.emit('download-progress', { percent: 42.4 });
  assert.equal(manager.state().percent, 42);
  auto.emit('update-downloaded', { version: '1.6.0' });
  await checking;
  assert.equal(auto.checks, 1);
  assert.deepEqual(downloaded, [{ version: '1.6.0' }], 'the user is told once');
  assert.equal(manager.state().status, 'downloaded'); assert.equal(manager.state().canInstall, true);
  assert.equal(timers.queue.length, 0, 'no install is scheduled');
  assert.deepEqual(auto.installs, []);
  assert.equal(await manager.install(), true, 'the user click installs');
  assert.deepEqual(auto.installs, [[true, true]]);
  assert.equal(await manager.install(), false, 'a second install request is ignored while quitting');
});

test('manual checks download even when automatic updates are off; start/stop manage the schedule', async () => {
  const timers = fakeTimers();
  const auto = new FakeAutoUpdater();
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, now: () => NOW, ...timers });
  manager.setEnabled(false);
  assert.equal(auto.autoDownload, false); assert.equal(timers.queue.length, 0);
  const checking = manager.check({ manual: true });
  await Promise.resolve();
  assert.equal(auto.autoDownload, true, 'a manual check downloads even when background updates are disabled');
  auto.emit('update-available', { version: '1.6.0' });
  await checking;
  assert.equal(manager.state().status, 'downloading');
  auto.emit('update-downloaded', { version: '1.6.0' });
  assert.equal(timers.queue.length, 0, 'no automatic restart while automatic updates are off');
  manager.setEnabled(true);
  assert.equal(timers.queue.length, 1, 'enabling schedules only the next check, never an install');
  manager.dispose();
  assert.equal(timers.queue.length, 0);
});

test('electron-updater errors are classified without leaking raw messages', () => {
  const auto = new FakeAutoUpdater();
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, ...fakeTimers() });
  for (const [message, expected] of [['net::ERR_INTERNET_DISCONNECTED', 'network'], ['HttpError: 404 ... ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'no-release'], ['sha512 checksum mismatch for secret-path', 'integrity'], ['EPERM: operation not permitted', 'permission'], ['strange', 'failed']]) {
    auto.emit('error', new Error(message));
    assert.equal(manager.state().error, expected);
  }
});

test('an installed copy without an updater instance reports unsupported and never throws', async () => {
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: null, ...fakeTimers() });
  assert.equal(manager.state().status, 'unsupported');
  assert.equal((await manager.check({ manual: true })).status, 'unsupported');
  manager.start(); assert.equal(manager.timer, null);
});

test('a download waiting for a click is still checked: kept on failure, replaced or withdrawn by the release feed', async () => {
  const auto = new FakeAutoUpdater();
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, ...fakeTimers() });
  auto.emit('update-downloaded', { version: '1.6.0' });
  assert.equal(manager.state().releaseUrl, 'https://github.com/nowsummer/Limit-Tracker/releases/tag/v1.6.0', 'notes of the version that will be installed');
  await manager.check({ manual: true });
  assert.equal(auto.checks, 1, 'the feed is asked again');
  assert.equal(manager.pending, null);
  assert.equal(manager.state().status, 'downloaded', 'a check without news keeps the waiting download');
  auto.checkForUpdates = async function () { this.checks++; this.emit('checking-for-update'); const error = new Error('net::ERR_INTERNET_DISCONNECTED'); this.emit('error', error); throw error; };
  await manager.check({ manual: true });
  assert.equal(manager.state().status, 'downloaded', 'a network failure keeps the install button');
  assert.equal(manager.state().canInstall, true);
  auto.checkForUpdates = async function () { this.checks++; this.emit('checking-for-update'); this.emit('update-available', { version: '1.6.1' }); this.emit('update-downloaded', { version: '1.6.1' }); };
  await manager.check({ manual: true });
  assert.equal(manager.state().downloadedVersion, '1.6.1', 'a newer release replaces the waiting one');
  assert.match(manager.state().releaseUrl, /\/tag\/v1\.6\.1$/);
  auto.checkForUpdates = async function () { this.checks++; this.emit('checking-for-update'); this.emit('update-not-available', { version: '1.5.0' }); };
  await manager.check({ manual: true });
  assert.equal(manager.state().status, 'up-to-date', 'a pulled release is no longer offered');
  assert.equal(manager.state().canInstall, false);
  assert.equal(manager.state().downloadedVersion, null);
  assert.equal(auto.checks, 4);
});

test('the installer starts only when asked, before quitting; a Windows block keeps the app running for another try', async () => {
  const timers = fakeTimers();
  const auto = new FakeAutoUpdater();
  auto.installerPath = 'C:/cache/Limit-Tracker-1.6.0.exe';
  const launches = [];
  let quits = 0;
  let block = true;
  const launchInstaller = async (file, args) => {
    launches.push([file, args]);
    if (block) throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' });
  };
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, launchInstaller, quitForUpdate: () => { quits++; }, now: () => NOW, ...timers });
  const failed = [];
  manager.on('install-failed', event => failed.push(event));
  manager.setEnabled(true);
  auto.emit('update-downloaded', { version: '1.6.0' });
  // Let the background schedule run a few rounds (it reschedules checks forever).
  for (let round = 0; round < 4 && timers.queue.length; round++) await timers.runNext();
  assert.ok(timers.queue.every(timer => timer.ms === 6 * 3600000), 'only the next check is ever scheduled');
  assert.equal(launches.length, 0, 'nothing starts by itself, whatever the timers do');
  assert.equal(await manager.install(), false);
  assert.deepEqual(launches[0], [auto.installerPath, ['--updated', '/S', '--force-run']]);
  assert.equal(quits, 0, 'a blocked installer never closes the app');
  assert.deepEqual(auto.installs, [], 'electron-updater is not asked to quit and install');
  assert.equal(manager.state().error, 'blocked');
  assert.deepEqual(failed, [{ error: 'blocked' }]);
  assert.equal(manager.state().status, 'downloaded', 'the download stays installable');
  assert.equal(manager.state().canInstall, true, 'the restart button stays');
  assert.equal(auto.autoInstallOnAppQuit, false, 'quitting never retries it');
  block = false;
  assert.equal(await manager.install(), true);
  assert.equal(launches.length, 2);
  assert.equal(quits, 1, 'the app quits once the installer is running');
});

test('a missing installer path is a failure, not a silent success', async () => {
  const auto = new FakeAutoUpdater();
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, launchInstaller: async () => {}, quitForUpdate: () => {}, ...fakeTimers() });
  auto.emit('update-downloaded', { version: '1.6.0' });
  assert.equal(await manager.install(), false);
  assert.equal(manager.quitting, false, 'a later install is still possible');
  assert.equal(manager.state().status, 'error');
});

test('only a refused installer start counts as a Windows block', () => {
  const auto = new FakeAutoUpdater();
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, ...fakeTimers() });
  assert.equal(manager.describeError(Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN', syscall: 'spawn' })), 'blocked');
  assert.equal(manager.describeError(new Error('An Application Control policy has blocked this file.')), 'blocked');
  assert.equal(manager.describeError(Object.assign(new Error('UNKNOWN: unknown error, open'), { code: 'UNKNOWN', syscall: 'open' })), 'failed');
});

test('nothing is ever installed on quit, whatever the setting', () => {
  const auto = new FakeAutoUpdater();
  auto.addQuitHandler = function () { this.quitHandlers = (this.quitHandlers || 0) + 1; };
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, ...fakeTimers() });
  for (const enabled of [false, true, false, true]) {
    manager.setEnabled(enabled);
    auto.emit('update-downloaded', { version: '1.6.0' });
    assert.equal(auto.autoInstallOnAppQuit, false);
  }
  assert.equal(auto.quitHandlers, undefined, 'the quit-install handler is never armed');
  manager.dispose();
});

test('turning automatic updates off while a check is running stops the schedule', async () => {
  const timers = fakeTimers();
  const auto = new FakeAutoUpdater();
  let release;
  auto.checkForUpdates = () => new Promise(resolve => { release = resolve; });
  const manager = new UpdateManager({ currentVersion: '1.5.0', mode: 'installed', autoUpdater: auto, ...timers });
  manager.setEnabled(true);
  const first = timers.runNext(timer => timer.ms === 90000);
  await Promise.resolve(); await Promise.resolve();
  manager.setEnabled(false);
  release(); await first;
  assert.equal(timers.queue.length, 0, 'nothing is scheduled after turning it off');
  manager.setEnabled(true);
  assert.equal(timers.queue.filter(timer => timer.ms === 90000).length, 1, 'turning it on again starts exactly one schedule');
  manager.dispose();
});
