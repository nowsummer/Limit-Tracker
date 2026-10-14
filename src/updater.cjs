'use strict';
// Update checks and installs.
// - installed (NSIS): electron-updater checks GitHub and downloads a new installer
//   in the background, but it is installed ONLY when the user asks ('Restart now to
//   apply'). Nothing installs on a timer, at start or on quit, so a bad release can
//   never reach a PC unattended (1.6.0 user decision).
// - dev / win-unpacked / older single-file copies: check only, and offer the
//   download page.
const { EventEmitter } = require('node:events');

const FEED = Object.freeze({ owner: 'nowsummer', repo: 'Limit-Tracker' });
const CHECK_INTERVAL_MS = 6 * 3600000;
const FIRST_CHECK_DELAY_MS = 90000;

function releaseBase(feed = FEED) { return `https://github.com/${feed.owner}/${feed.repo}`; }
function releasePage(feed = FEED) { return `${releaseBase(feed)}/releases/latest`; }
function releasesPage(feed = FEED) { return `${releaseBase(feed)}/releases`; }
function latestYamlUrl(feed = FEED, name = 'latest.yml') { return `${releaseBase(feed)}/releases/latest/download/${name}`; }

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || null };
}

/** Semantic comparison: negative when a < b, zero when equal, positive when a > b. */
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return NaN;
  for (let i = 0; i < 3; i++) if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Reads the top-level scalars electron-builder (and our release script) write. */
function parseLatestYaml(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^(version|path|releaseDate|releaseName|sha512|size):\s*(.+?)\s*$/.exec(line);
    if (match) result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  if (result.size !== undefined) result.size = Number(result.size);
  return parseVersion(result.version) ? result : null;
}

class UpdateManager extends EventEmitter {
  constructor({ currentVersion, mode = 'dev', feed = FEED, autoUpdater = null, launchInstaller = null, quitForUpdate = null, fetchImpl = globalThis.fetch, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, log = () => {} } = {}) {
    super();
    if (!parseVersion(currentVersion)) throw new TypeError('currentVersion must be semantic');
    if (!['installed', 'dev'].includes(mode)) throw new TypeError('Unknown update mode');
    Object.assign(this, { currentVersion, mode, feed, autoUpdater: mode === 'installed' ? autoUpdater : null, launchInstaller, quitForUpdate, fetchImpl, now, setTimeoutImpl, clearTimeoutImpl, log });
    this.enabled = true; this.timer = null; this.pending = null; this.checkedAt = null;
    this.status = this.mode === 'installed' && !this.autoUpdater ? 'unsupported' : 'idle';
    this.latestVersion = null; this.percent = null; this.error = null; this.downloadedVersion = null; this.manual = false; this.quitting = false;
    this.announced = new Set();
    if (this.autoUpdater) this.bindAutoUpdater();
  }

  /** True when this copy can replace itself (the installed program). */
  get selfUpdating() { return !!this.autoUpdater; }

  bindAutoUpdater() {
    const updater = this.autoUpdater;
    updater.autoDownload = this.enabled;
    // Never install on quit: only the user's click installs (see install()).
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    updater.on('checking-for-update', () => this.update({ status: 'checking', error: null }));
    updater.on('update-available', info => this.update({ status: updater.autoDownload ? 'downloading' : 'available', latestVersion: info?.version || null, percent: 0, error: null }));
    // A release pulled after it was downloaded is no longer offered.
    updater.on('update-not-available', info => this.update({ status: 'up-to-date', latestVersion: info?.version || this.currentVersion, downloadedVersion: null, error: null }));
    updater.on('download-progress', progress => this.update({ status: 'downloading', percent: Number.isFinite(progress?.percent) ? Math.round(progress.percent) : null }));
    updater.on('update-downloaded', info => this.downloaded(info?.version || this.latestVersion));
    updater.on('error', error => this.update({ status: 'error', error: this.describeError(error) }));
  }

  downloaded(version) {
    this.update({ status: 'downloaded', latestVersion: version, downloadedVersion: version, percent: 100, error: null });
    // Tell the user once; the update waits for their click.
    if (!this.announced.has(`downloaded:${version}`)) { this.announced.add(`downloaded:${version}`); this.emit('downloaded', { version }); }
  }

  describeError(error) {
    const message = String(error?.message || error || '');
    if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|net::|fetch failed|network|abort|socket/i.test(message)) return 'network';
    if (/\b404\b|not found|no published|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(message)) return 'no-release';
    // Windows (Smart App Control / application control) refused to start the installer.
    if ((error?.code === 'UNKNOWN' && /^spawn/i.test(String(error?.syscall || message))) || /Application Control policy|has blocked this file/i.test(message)) {
      this.log(`updater blocked: ${error?.code || ''} ${message.slice(0, 300)}`);
      return 'blocked';
    }
    if (/checksum|sha512|integrity/i.test(message)) return 'integrity';
    if (/EACCES|EPERM|read-only|not writable/i.test(message)) return 'permission';
    this.log(`updater error: ${message.slice(0, 300)}`);
    return 'failed';
  }

  update(patch) {
    Object.assign(this, patch);
    this.emit('change', this.state());
  }

  state() {
    return {
      mode: this.mode, enabled: this.enabled, status: this.status, currentVersion: this.currentVersion, latestVersion: this.latestVersion,
      downloadedVersion: this.downloadedVersion, percent: this.percent, error: this.error, checkedAt: this.checkedAt,
      // Release notes of the version waiting to be installed, not whatever is latest by now.
      releaseUrl: this.status === 'downloaded' && parseVersion(this.downloadedVersion) ? `${releaseBase(this.feed)}/releases/tag/v${this.downloadedVersion}` : releasePage(this.feed),
      releasesUrl: releasesPage(this.feed), selfUpdating: this.selfUpdating,
      canInstall: this.status === 'downloaded' && this.selfUpdating,
      canDownload: this.status === 'available' && this.selfUpdating,
    };
  }

  /** Automatic checking and background download; installing always waits for the user. */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.autoUpdater) this.autoUpdater.autoDownload = this.enabled;
    if (this.enabled) this.start(); else this.stop();
    this.emit('change', this.state());
  }

  start() {
    this.stop();
    if (!this.enabled || this.status === 'unsupported') return;
    // stop() starts a new generation, so a check still running from before cannot reschedule.
    const generation = this.generation;
    const active = () => this.enabled && generation === this.generation;
    const tick = async () => {
      if (!active()) return;
      try { await this.check({ manual: false }); } catch { /* Reported through state. */ }
      if (!active()) return;
      this.timer = this.setTimeoutImpl(tick, CHECK_INTERVAL_MS); this.timer.unref?.();
    };
    this.timer = this.setTimeoutImpl(tick, FIRST_CHECK_DELAY_MS); this.timer.unref?.();
  }

  stop() { this.generation = (this.generation || 0) + 1; if (this.timer) { this.clearTimeoutImpl(this.timer); this.timer = null; } }

  async check({ manual = false } = {}) {
    if (this.pending) return this.pending;
    if (this.status === 'unsupported') return this.state();
    this.manual = manual;
    // Run the body after `pending` is assigned, so an early return cannot leave
    // a settled promise stuck in `pending`.
    this.pending = Promise.resolve().then(async () => {
      try {
        if (this.autoUpdater) {
          // A download waiting for the user's click is still checked: a newer release
          // replaces it, a pulled one is withdrawn, and a failed check keeps it.
          const held = this.status === 'downloaded' ? { status: 'downloaded', downloadedVersion: this.downloadedVersion, latestVersion: this.latestVersion, percent: 100, error: this.error === 'blocked' ? 'blocked' : null } : null;
          this.autoUpdater.autoDownload = this.enabled || manual;
          try { await this.autoUpdater.checkForUpdates(); }
          catch (error) { if (held) { this.update(held); return this.state(); } throw error; }
          if (held && !['downloaded', 'downloading', 'available', 'up-to-date'].includes(this.status)) this.update(held);
        } else {
          await this.checkFeed('latest.yml');
        }
      } catch (error) {
        this.update({ status: 'error', error: this.describeError(error) });
      } finally {
        this.checkedAt = new Date(this.now()).toISOString(); this.manual = false; this.pending = null; this.emit('change', this.state());
      }
      return this.state();
    });
    return this.pending;
  }

  async checkFeed(name) {
    this.update({ status: 'checking', error: null });
    if (typeof this.fetchImpl !== 'function') throw new Error('network unavailable');
    const controller = new AbortController();
    const timer = this.setTimeoutImpl(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(latestYamlUrl(this.feed, name), { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { Accept: 'text/plain, application/x-yaml, */*', 'User-Agent': `limit-tracker/${this.currentVersion}` } });
      if (response.status === 404) { this.update({ status: 'error', error: 'no-release' }); return null; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = parseLatestYaml(await response.text());
      if (!info) throw new Error('Unreadable release feed');
      const newer = compareVersions(info.version, this.currentVersion) > 0;
      this.update({ status: newer ? 'available' : 'up-to-date', latestVersion: info.version, error: null });
      if (newer && !this.announced.has(`available:${info.version}`)) { this.announced.add(`available:${info.version}`); this.emit('available', { version: info.version, releaseUrl: releasePage(this.feed), selfUpdating: this.selfUpdating }); }
      return info;
    } finally { this.clearTimeoutImpl(timer); }
  }

  async download() {
    if (this.status !== 'available' || !this.selfUpdating) return this.state();
    try {
      this.update({ status: 'downloading', percent: 0, error: null });
      await this.autoUpdater.downloadUpdate();
    } catch (error) { this.update({ status: 'error', error: this.describeError(error) }); }
    return this.state();
  }

  /** Called only from the user's 'Restart now to apply'. */
  async install() {
    if (!this.selfUpdating || this.status !== 'downloaded' || this.quitting) return false;
    this.quitting = true;
    this.emit('installing', { version: this.downloadedVersion });
    try {
      const file = this.autoUpdater.installerPath;
      if (!file) throw new Error('No downloaded installer');
      if (typeof this.launchInstaller === 'function') {
        // Start the installer first and quit only once it is running: if Windows
        // blocks it (a brand-new unsigned file under Smart App Control), the app
        // keeps running instead of disappearing, and the user can try again.
        await this.launchInstaller(file, ['--updated', '/S', '--force-run']);
        if (typeof this.quitForUpdate === 'function') this.quitForUpdate();
      } else this.autoUpdater.quitAndInstall(true, true);
      return true;
    } catch (error) {
      // Nothing was replaced: keep running and let the user retry.
      this.quitting = false;
      const reason = this.describeError(error);
      // A refused start leaves the download good: keep it installable (and the button).
      if (reason === 'blocked') this.update({ status: 'downloaded', error: 'blocked' });
      else this.update({ status: 'error', error: reason });
      this.emit('install-failed', { error: reason });
      return false;
    }
  }

  dispose() { this.stop(); }
}

module.exports = { UpdateManager, FEED, compareVersions, parseVersion, parseLatestYaml, releasePage, releasesPage, latestYamlUrl, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS };
