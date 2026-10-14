'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { t } = require('../i18n.cjs');
const { envGet } = require('../accounts.cjs');
const { refreshClaudeCredentials, CLI_VERSION } = require('./claude-auth.cjs');

const runFile = promisify(execFile);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MAX_JSON_BYTES = 1024 * 1024;
// Renew slightly before the stored expiry so a poll never races the deadline.
const EXPIRY_MARGIN_MS = 60000;
const WINDOW_DEFINITIONS = [
  ['five_hour', 'window.fiveHour', 300],
  ['seven_day', 'window.weekly', 10080],
  ['seven_day_sonnet', 'window.sonnetWeekly', 10080],
  ['seven_day_opus', 'window.opusWeekly', 10080],
  ['seven_day_oauth_apps', 'window.appsWeekly', 10080],
];
// Refresh failures that mean the saved login itself is gone.
const LOGIN_LOST = new Set(['invalid_grant', 'refresh_expired', 'no_refresh_token', 'no_login']);

function isoDate(value) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString() : null;
}

/** Provider messages carry a translation key; `error` keeps the Korean text. */
function message(key, params) { return { error: t(key, params, 'ko'), errorKey: key, errorParams: params || null }; }

function makeResult(now, overrides = {}) {
  return {
    id: 'claude', name: 'Claude', status: 'disconnected', plan: null,
    windows: [], updatedAt: isoDate(now), error: null, errorKey: null, errorParams: null,
    source: t('claude.source', null, 'ko'), sourceKey: 'claude.source',
    ...overrides,
  };
}

function percentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

function scopeName(scope) {
  const value = scope?.model?.display_name ?? scope?.surface?.display_name;
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

function windowRecord(id, labelKey, labelParams, usedPercent, resetsAt, durationMinutes) {
  return { id, label: t(labelKey, labelParams, 'ko'), labelKey, ...(labelParams ? { labelParams } : {}), usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), resetsAt, durationMinutes };
}

function parseLimitRows(rows) {
  const windows = new Map();
  for (const row of rows.slice(0, 100)) {
    const usedPercent = percentage(row?.percent);
    if (usedPercent === null) continue;
    let id, labelKey, labelParams = null, durationMinutes;
    if (row.kind === 'session') [id, labelKey, durationMinutes] = ['five_hour', 'window.fiveHour', 300];
    else if (row.kind === 'weekly_all') [id, labelKey, durationMinutes] = ['seven_day', 'window.weekly', 10080];
    else if (row.kind === 'weekly_scoped') {
      const name = scopeName(row.scope);
      if (!name) continue;
      // The server sends scoped rows, not a seven_day_fable property. Keep a
      // stable app window ID so account preferences and reset reminders agree.
      const key = name.toLowerCase().replace(/^claude\s+/, '');
      const scopeId = /^[a-z][a-z0-9 -]{0,40}$/.test(key)
        ? key.replace(/[ -]+/g, '_')
        : `model_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
      id = row.scope?.model ? `seven_day_${scopeId}` : `seven_day_surface_${scopeId}`;
      labelKey = 'window.scopedWeekly'; labelParams = { name };
      durationMinutes = 10080;
    } else continue;
    if (windows.has(id)) continue;
    const resetsAt = typeof row.resets_at === 'string' ? isoDate(row.resets_at) : null;
    windows.set(id, windowRecord(id, labelKey, labelParams, usedPercent, resetsAt, durationMinutes));
  }
  return [...windows.values()];
}

function parseWindows(data, { official = false, now = Date.now() } = {}) {
  // A present array is the current response, including an explicitly empty one.
  // Do not revive deprecated flat buckets that disagree with the server's rows.
  if (!official && Array.isArray(data?.limits)) return parseLimitRows(data.limits);
  const windows = [];
  for (const [id, labelKey, durationMinutes] of WINDOW_DEFINITIONS) {
    const window = data?.[id];
    const usedPercent = percentage(window?.[official ? 'used_percentage' : 'utilization']);
    if (usedPercent === null) continue;
    const resetsAt = official
      ? (typeof window.resets_at === 'number' ? isoDate(window.resets_at * 1000) : null)
      : (typeof window.resets_at === 'string' ? isoDate(window.resets_at) : null);
    // A stored snapshot cannot establish a new quota after its window has reset.
    if (official && resetsAt && Date.parse(resetsAt) <= now) continue;
    windows.push(windowRecord(id, labelKey, null, usedPercent, resetsAt, durationMinutes));
  }
  return windows;
}

function expired(oauth, now, margin = 0) { return typeof oauth?.expiresAt === 'number' && oauth.expiresAt <= now + margin; }
const credentialRetryDelay = () => new Promise(resolve => setTimeout(resolve, 125));

async function readJson(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('INVALID_JSON_FILE');
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function planName(oauth) {
  const type = oauth?.subscriptionType;
  if (typeof type !== 'string') return null;
  const known = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise', free: 'Claude Free' };
  if (type === 'max' && typeof oauth.rateLimitTier === 'string') {
    if (oauth.rateLimitTier.includes('20x')) return 'Claude Max 20x';
    if (oauth.rateLimitTier.includes('5x')) return 'Claude Max 5x';
  }
  return known[type] || 'Claude';
}

/** Finds the native installer's claude.exe first, then npm's claude.cmd shim. */
async function findClaudeExecutable({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const separator = platform === 'win32' ? ';' : path.delimiter;
  const directories = [path.join(home, '.local', 'bin'), ...(envGet(env, 'PATH') || '').split(separator).filter(Boolean)];
  const appData = envGet(env, 'APPDATA');
  if (platform === 'win32' && appData) directories.push(path.join(appData, 'npm'));
  for (const directory of directories) {
    for (const name of names) {
      const filePath = path.join(directory.replace(/^"|"$/g, ''), name);
      try { if ((await fs.stat(filePath)).isFile()) return filePath; } catch { /* Missing candidate. */ }
    }
  }
  return null;
}

function configDirectoryFor({ home, env }) { return envGet(env, 'CLAUDE_CONFIG_DIR') || path.join(home, '.claude'); }

async function findCredentials({ home, env, platform, wslScan, execFileImpl }) {
  const configDirectory = configDirectoryFor({ home, env });
  let invalidFile = false;
  let hasApiKey = Boolean(envGet(env, 'ANTHROPIC_API_KEY') || envGet(env, 'ANTHROPIC_AUTH_TOKEN'));
  try {
    const credentials = await readJson(path.join(configDirectory, '.credentials.json'));
    // MCP OAuth tokens are never Claude subscription tokens.
    if (typeof credentials?.claudeAiOauth?.accessToken === 'string' && credentials.claudeAiOauth.accessToken.trim()) {
      return { oauth: credentials.claudeAiOauth, location: 'local', configDirectory, hasApiKey, refreshable: true };
    }
    hasApiKey ||= Boolean(credentials?.anthropicApiKey || credentials?.apiKey);
  } catch (error) {
    invalidFile = error?.code !== 'ENOENT';
  }
  // A long-lived token from `claude setup-token` is a valid subscription login.
  const envToken = envGet(env, 'CLAUDE_CODE_OAUTH_TOKEN');
  if (!invalidFile && typeof envToken === 'string' && envToken.trim()) {
    return { oauth: { accessToken: envToken.trim() }, location: 'environment', configDirectory, hasApiKey, refreshable: false };
  }
  if (platform === 'win32' && wslScan && !invalidFile) {
    try {
      // Read only already-running distributions; never start or install WSL.
      const list = await execFileImpl('wsl.exe', ['--list', '--running', '--quiet'], {
        encoding: 'buffer', timeout: 2500, windowsHide: true, maxBuffer: 64 * 1024,
      });
      const buffer = Buffer.isBuffer(list.stdout) ? list.stdout : Buffer.from(list.stdout || '');
      const listing = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8');
      for (const distro of listing.replace(/\u0000/g, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 8)) {
        try {
          const result = await execFileImpl('wsl.exe', ['--distribution', distro, '--exec', 'sh', '-c', 'cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"'], {
            encoding: 'utf8', timeout: 2500, windowsHide: true, maxBuffer: MAX_JSON_BYTES,
          });
          const credentials = JSON.parse(result.stdout);
          if (typeof credentials?.claudeAiOauth?.accessToken === 'string' && credentials.claudeAiOauth.accessToken.trim()) {
            return { oauth: credentials.claudeAiOauth, location: `wsl:${distro}`, distro, hasApiKey, refreshable: false };
          }
        } catch { /* Never surface subprocess output; it may contain credentials. */ }
      }
    } catch { /* WSL is absent or has no running distribution. */ }
  }
  return { oauth: null, hasApiKey, invalidFile, configDirectory };
}

function locationLabel(credentials) {
  if (credentials.location?.startsWith('wsl:')) return t('claude.locationWsl', { distro: credentials.distro }, 'ko');
  return t('claude.locationLocal', null, 'ko');
}

async function readStatusCache(statusCachePath, now) {
  if (!statusCachePath) return null;
  try {
    const cache = await readJson(statusCachePath);
    const capturedAt = typeof cache.capturedAt === 'string' ? isoDate(cache.capturedAt) : null;
    if (!capturedAt || Date.parse(capturedAt) > now + 60000) return null;
    const windows = parseWindows(cache.rate_limits, { official: true, now });
    if (!windows.length) return null;
    return makeResult(now, {
      status: 'ok', windows, updatedAt: capturedAt, source: t('claude.statusSource', null, 'ko'), sourceKey: 'claude.statusSource',
      cached: true, stale: now - Date.parse(capturedAt) > 5 * 60000,
    });
  } catch { return null; }
}

/**
 * Reads the persisted Claude Code login and the subscription usage. When the
 * short-lived access token has expired (for example after the PC was off), it
 * renews the login exactly as the official CLI does — under the CLI's own lock,
 * writing the rotated tokens back to the same file — so the user stays signed
 * in until they log out themselves. Remote (WSL) and environment logins are
 * never rotated from here.
 */
async function fetchClaudeUsage({
  now = Date.now(), fetchImpl = globalThis.fetch, home = os.homedir(), env = process.env,
  platform = process.platform, timeoutMs = 10000, statusCachePath = null,
  wslScan = true, execFileImpl = runFile, credentialRetryDelayImpl = credentialRetryDelay,
  refreshImpl = refreshClaudeCredentials, allowRefresh = true,
} = {}) {
  const fallback = async (result) => {
    const cached = await readStatusCache(statusCachePath, now);
    return cached ? { ...cached, warning: result.error, warningKey: result.errorKey, warningParams: result.errorParams, retryAt: result.retryAt } : result;
  };
  const credentialOptions = { home, env, platform, wslScan, execFileImpl };
  let credentials = await findCredentials(credentialOptions);
  if (credentials.invalidFile || expired(credentials.oauth, now)) {
    // The official CLI can be replacing this file right as we read it. A single
    // bounded reread avoids declaring logout while another process saves a token.
    await credentialRetryDelayImpl();
    const latest = await findCredentials(credentialOptions);
    if (latest.oauth && (!credentials.oauth || latest.location === credentials.location)) credentials = latest;
  }
  if (!credentials.oauth) {
    if (credentials.invalidFile) return fallback(makeResult(now, { status: 'error', ...message('claude.err.fileUnreadable') }));
    if (credentials.hasApiKey) return fallback(makeResult(now, { status: 'unsupported', ...message('claude.err.apiKey') }));
    return fallback(makeResult(now, message('claude.err.loginHint')));
  }
  let oauth = credentials.oauth;
  const canRefresh = () => allowRefresh && credentials.refreshable && typeof refreshImpl === 'function';
  /** Returns null on success (oauth updated) or a failure result. */
  const renew = async () => {
    let outcome;
    try { outcome = await refreshImpl({ configDirectory: credentials.configDirectory, expectedAccessToken: oauth.accessToken }); }
    catch { outcome = { ok: false, reason: 'server' }; }
    if (outcome?.ok && typeof outcome.oauth?.accessToken === 'string' && outcome.oauth.accessToken.trim()) {
      oauth = outcome.oauth; credentials = { ...credentials, oauth }; return null;
    }
    const reason = outcome?.reason === 'cooldown' ? outcome.cause : outcome?.reason;
    if (LOGIN_LOST.has(reason)) return makeResult(now, message('claude.err.reloginRequired'));
    return makeResult(now, { status: 'error', ...message(reason === 'locked' ? 'claude.err.refreshing' : 'claude.err.refreshFailed') });
  };
  if (expired(oauth, now, canRefresh() ? EXPIRY_MARGIN_MS : 0)) {
    if (canRefresh()) {
      const failed = await renew();
      // Inside the safety margin the old token still works; use it this once.
      if (failed && expired(oauth, now)) return fallback(failed);
    } else if (expired(oauth, now)) {
      // Keep the last reading (status 'error'); the login itself still exists.
      const lost = !(typeof oauth.refreshToken === 'string' && oauth.refreshToken.trim()) && credentials.location !== 'environment';
      return fallback(makeResult(now, lost ? message('claude.err.expired') : { status: 'error', ...message('claude.err.expired') }));
    }
  }
  if (typeof fetchImpl !== 'function') return fallback(makeResult(now, { status: 'error', ...message('claude.err.noFetch') }));
  const request = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      // Fixed HTTPS endpoint and no redirects prevent forwarding a token elsewhere.
      const response = await fetchImpl(USAGE_URL, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': `claude-code/${CLI_VERSION}`,
          Accept: 'application/json',
        },
      });
      // Error bodies are never read. A success body is read inside the same time
      // limit, so a stalled body cannot hold every later refresh.
      if (!response.ok) return response;
      const aborted = new Promise((_, reject) => {
        const stop = () => reject(Object.assign(new Error('Usage body timed out'), { name: 'AbortError' }));
        if (controller.signal.aborted) stop(); else controller.signal.addEventListener('abort', stop, { once: true });
      });
      const data = await Promise.race([response.json(), aborted]);
      return { status: response.status, ok: true, headers: response.headers, json: async () => data };
    } catch (error) {
      error.timedOut = controller.signal.aborted;
      throw error;
    } finally { clearTimeout(timeout); }
  };
  try {
    let response = await request();
    if (response.status === 401 || response.status === 403) {
      await credentialRetryDelayImpl();
      const latest = await findCredentials(credentialOptions);
      // Retry only a different token written by the CLI for the same source.
      // Repeating the rejected token risks a loop.
      if (latest.oauth && latest.location === credentials.location && latest.oauth.accessToken !== oauth.accessToken && !expired(latest.oauth, now)) {
        credentials = latest; oauth = latest.oauth;
        response = await request();
      } else if (response.status === 401 && canRefresh() && latest.oauth && latest.location === credentials.location) {
        // A rejected but unexpired token: renew once, as Claude Code does.
        const failed = await renew();
        if (failed) return fallback(failed);
        response = await request();
      } else if (response.status === 401 && !latest.oauth) {
        return fallback(makeResult(now, message('claude.err.unauthorized')));
      }
      if (response.status === 401) return fallback(makeResult(now, message('claude.err.unauthorized')));
      // 403 is a permission/scope or network-filter answer, not proof of logout.
      if (response.status === 403) return fallback(makeResult(now, { status: 'error', ...message('claude.err.unauthorized') }));
    }
    if (response.status === 429) {
      let retryAt = null;
      const retryAfter = response.headers?.get?.('retry-after');
      if (retryAfter && /^\d+$/.test(retryAfter)) retryAt = isoDate(now + Number(retryAfter) * 1000);
      else if (retryAfter) retryAt = isoDate(retryAfter);
      return fallback(makeResult(now, { status: 'error', ...message('claude.err.rateLimited'), retryAt }));
    }
    if (!response.ok) return fallback(makeResult(now, { status: 'error', ...message('claude.err.http', { status: Number(response.status) || t('claude.httpUnknown', null, 'ko') }) }));
    const data = await response.json();
    const windows = parseWindows(data);
    if (!windows.length) return fallback(makeResult(now, { status: 'error', ...message('claude.err.noWindows') }));
    const apiKeyWarning = credentials.hasApiKey ? message('claude.err.apiKey') : null;
    // The service fixes a final expiry for the renewable login; show it so the
    // user can sign in again before it lapses.
    const loginExpiresAt = credentials.refreshable && typeof oauth.refreshTokenExpiresAt === 'number' ? isoDate(oauth.refreshTokenExpiresAt) : null;
    return makeResult(now, {
      status: 'ok', plan: planName(oauth), windows, credentialLocation: locationLabel(credentials), loginExpiresAt,
      unofficial: true, cached: false, stale: false,
      warning: apiKeyWarning ? t('claude.warn.apiKey', null, 'ko') : null, warningKey: apiKeyWarning ? 'claude.warn.apiKey' : null,
    });
  } catch (error) {
    // Error messages / response bodies are untrusted and can contain auth values.
    return fallback(makeResult(now, { status: 'error', ...message(error?.timedOut ? 'claude.err.timeout' : 'claude.err.network') }));
  }
}

module.exports = { fetchClaudeUsage, findClaudeExecutable, parseWindows };
