'use strict';
// Renews an expiring Claude Code subscription login the same way the official
// CLI does, under the CLI's own directory locks, and writes the rotated tokens
// back into that account's .credentials.json. Tokens never leave this process
// except to the fixed Anthropic token endpoint. See SECURITY.md (Known risks).
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Version string of the official CLI whose refresh behaviour this mirrors.
const CLI_VERSION = '2.1.292';
const REFRESH_LOCK = '.oauth_refresh.lock';
const REFRESH_LOCK_STALE_MS = 60000;
const REFRESH_LOCK_TOUCH_MS = 5000;
const WRITE_LOCK = '.storage-write.lock';
const WRITE_LOCK_STALE_MS = 15000;
// A rotated login that could not be saved yet waits here (same folder and
// permissions as the credentials themselves) until the next attempt saves it.
const RECOVERY_FILE = '.limit-tracker-refresh.json';
const DEFAULT_LIFETIME_MS = 8 * 3600000;
const COOLDOWN_MS = Object.freeze({ network: 5 * 60000, server: 5 * 60000, invalid_file: 60000, invalid_grant: 30 * 60000, locked: 60000 });
const MAX_JSON_BYTES = 1024 * 1024;
const cooldowns = new Map();
const inFlight = new Map();
// The same record kept in memory, so a rotation survives even when neither the
// recovery file nor the credentials file could be written (until the app exits).
const pendingRotations = new Map();
const heldLocks = new Set();
let exitHookInstalled = false;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = token => crypto.createHash('sha256').update(String(token)).digest('hex');

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => { for (const dir of heldLocks) { try { require('node:fs').rmdirSync(dir); } catch { /* Already released. */ } } });
}

/** Directory lock with the same stale/touch semantics as proper-lockfile. */
async function acquireLock(dir, { staleMs, waitMs, touchMs = 0, now = Date.now, sleep = wait }) {
  const deadline = now() + waitMs;
  let reclaimed = false;
  for (;;) {
    try {
      await fs.mkdir(dir);
      heldLocks.add(dir); installExitHook();
      let timer = null;
      if (touchMs) { timer = setInterval(() => { const at = new Date(); fs.utimes(dir, at, at).catch(() => {}); }, touchMs); timer.unref?.(); }
      return async () => { if (timer) clearInterval(timer); heldLocks.delete(dir); try { await fs.rmdir(dir); } catch { /* Already released. */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    try {
      const stat = await fs.stat(dir);
      if (!reclaimed && now() - stat.mtimeMs > staleMs) {
        // A crashed process left this behind; the CLI reclaims it the same way.
        reclaimed = true;
        await fs.rm(dir, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      // Only a lock that vanished between mkdir and stat is retried; anything
      // else (access denied) must not spin without the deadline below.
      if (error?.code !== 'ENOENT') throw error;
    }
    if (now() >= deadline) return null;
    await sleep(250);
  }
}

async function readCredentialFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('INVALID_CREDENTIAL_FILE');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_CREDENTIAL_FILE');
  return parsed;
}

async function writeJsonAtomic(file, value, sleep) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  // A transient Windows lock (antivirus, indexer, OneDrive) must not lose data.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, file); return; }
    catch (error) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
      await sleep(150 * (attempt + 1));
    }
  }
}

function mergeOauth(previous, data, now) {
  const expiresIn = Number(data.expires_in);
  const refreshExpiresIn = Number(data.refresh_token_expires_in);
  const scopes = typeof data.scope === 'string' && data.scope.trim() ? data.scope.trim().split(/\s+/) : previous.scopes;
  const merged = {
    ...previous,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim() ? data.refresh_token : previous.refreshToken,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86400 * 30) * 1000 : DEFAULT_LIFETIME_MS),
    scopes,
  };
  // Same rule as the CLI: keep the stored value unless the server sends a new one.
  if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) merged.refreshTokenExpiresAt = now + Math.min(refreshExpiresIn, 86400 * 400) * 1000;
  return merged;
}

/**
 * Replaces claudeAiOauth under the CLI's storage lock. Refuses to write when the
 * lock cannot be taken or the current file cannot be read, so other keys (MCP
 * logins) and a concurrent writer's changes are never overwritten blindly.
 */
async function writeCredentials(file, oauth, { now, sleep, replacing }) {
  const release = await acquireLock(path.join(path.dirname(file), WRITE_LOCK), { staleMs: WRITE_LOCK_STALE_MS, waitMs: 25000, touchMs: 5000, now, sleep });
  if (!release) throw Object.assign(new Error('CREDENTIAL_WRITE_LOCKED'), { code: 'CREDENTIAL_WRITE_LOCKED' });
  try {
    const current = await readCredentialFile(file);
    // Someone else saved a different login meanwhile: theirs wins.
    const stored = current.claudeAiOauth?.accessToken;
    if (replacing !== undefined && stored !== replacing && stored !== oauth.accessToken) throw Object.assign(new Error('CREDENTIALS_CHANGED'), { code: 'CREDENTIALS_CHANGED' });
    await writeJsonAtomic(file, { ...current, claudeAiOauth: oauth }, sleep);
  } finally { await release(); }
}

function classifyFailure(status, body) {
  const code = typeof body?.error === 'string' ? body.error : typeof body?.type === 'string' ? body.type : '';
  if (status === 429 || status >= 500) return 'server';
  if (status === 400 && /invalid_scope/i.test(code)) return 'invalid_scope';
  // Only an explicit rejection of the refresh token means the login is gone.
  if (status >= 400 && status < 500 && /^invalid_grant$/i.test(code)) return 'invalid_grant';
  return 'server';
}

function failure(configDirectory, reason, now, extra = {}) {
  const cooldown = COOLDOWN_MS[reason];
  if (cooldown) cooldowns.set(configDirectory, { until: now + cooldown, reason });
  return { ok: false, reason, ...extra };
}

/**
 * Refresh the claudeAiOauth login stored in <configDirectory>/.credentials.json.
 * Resolves { ok: true, oauth } with the current (possibly rotated-by-others)
 * login, or { ok: false, reason } where reason is one of
 * cooldown | locked | no_login | no_refresh_token | refresh_expired | network | server | invalid_grant | invalid_file.
 */
async function refreshClaudeCredentials({
  configDirectory, expectedAccessToken = null, now = Date.now, fetchImpl = globalThis.fetch,
  timeoutMs = 15000, sleep = wait, cliVersion = CLI_VERSION, force = false,
}) {
  if (typeof configDirectory !== 'string' || !configDirectory) throw new TypeError('configDirectory is required');
  if (inFlight.has(configDirectory)) return inFlight.get(configDirectory);
  const task = (async () => {
    const started = now();
    const cooling = cooldowns.get(configDirectory);
    if (!force && cooling && cooling.until > started) return { ok: false, reason: 'cooldown', until: cooling.until, cause: cooling.reason };
    cooldowns.delete(configDirectory);
    const file = path.join(configDirectory, '.credentials.json');
    const recoveryFile = path.join(configDirectory, RECOVERY_FILE);
    // A sign-in/logout that completed while we waited for storage takes priority
    // over a token we rotated earlier. Never return the previous account here.
    const currentLoginAfterChange = async () => {
      pendingRotations.delete(configDirectory);
      await fs.rm(recoveryFile, { force: true }).catch(() => {});
      try {
        const latest = (await readCredentialFile(file)).claudeAiOauth;
        return typeof latest?.accessToken === 'string' && latest.accessToken.trim()
          ? { ok: true, oauth: latest, rotatedElsewhere: true }
          : { ok: false, reason: 'no_login' };
      } catch (error) {
        return error?.code === 'ENOENT' ? { ok: false, reason: 'no_login' } : failure(configDirectory, 'invalid_file', now());
      }
    };
    let release;
    try { release = await acquireLock(path.join(configDirectory, REFRESH_LOCK), { staleMs: REFRESH_LOCK_STALE_MS, waitMs: 10000, touchMs: REFRESH_LOCK_TOUCH_MS, now, sleep }); }
    catch (error) { return error?.code === 'ENOENT' ? { ok: false, reason: 'no_login' } : failure(configDirectory, 'invalid_file', now()); }
    if (!release) return failure(configDirectory, 'locked', now());
    try {
      let stored;
      try { stored = await readCredentialFile(file); }
      catch (error) { return error?.code === 'ENOENT' ? { ok: false, reason: 'no_login' } : failure(configDirectory, 'invalid_file', now()); }
      const oauth = stored.claudeAiOauth;
      if (!oauth || typeof oauth !== 'object') return { ok: false, reason: 'no_refresh_token' };

      // A rotation that reached us but was not saved last time is saved now,
      // instead of spending the old (already used) refresh token again.
      let recovery = pendingRotations.get(configDirectory) || null;
      if (!recovery) {
        try { recovery = await readCredentialFile(recoveryFile); }
        catch (error) {
          if (error instanceof SyntaxError || error?.message === 'INVALID_CREDENTIAL_FILE') {
            // A damaged record carries nothing usable.
            await fs.rm(recoveryFile, { force: true }).catch(() => {});
          } else if (error?.code !== 'ENOENT') {
            // The record exists but cannot be read right now (antivirus, sync,
            // permissions). It may hold the only copy of a rotation: wait for it
            // instead of spending the stored, possibly used, refresh token.
            return failure(configDirectory, 'invalid_file', now());
          }
        }
      }
      if (recovery) {
        const rotated = recovery.rotated;
        const valid = rotated && typeof rotated.accessToken === 'string' && rotated.accessToken.trim() && typeof rotated.refreshToken === 'string' && rotated.refreshToken.trim();
        if (valid && recovery.replaces === fingerprint(oauth.refreshToken)) {
          try { await writeCredentials(file, { ...oauth, ...rotated }, { now, sleep, replacing: oauth.accessToken }); }
          catch (error) {
            if (['CREDENTIALS_CHANGED', 'ENOENT'].includes(error?.code)) return await currentLoginAfterChange();
            pendingRotations.set(configDirectory, recovery);
            return { ok: true, oauth: { ...oauth, ...rotated }, refreshed: true, persisted: false };
          }
          pendingRotations.delete(configDirectory);
          await fs.rm(recoveryFile, { force: true }).catch(() => {});
          return { ok: true, oauth: { ...oauth, ...rotated }, refreshed: true, recovered: true };
        }
        // The stored login moved on (the CLI saved a newer one): drop the stale record.
        pendingRotations.delete(configDirectory);
        await fs.rm(recoveryFile, { force: true }).catch(() => {});
      }

      const current = now();
      const alive = typeof oauth.accessToken === 'string' && oauth.accessToken.trim() && !(typeof oauth.expiresAt === 'number' && oauth.expiresAt <= current + 60000);
      // Another process (usually Claude Code itself) already rotated the login.
      if (!force && alive && (expectedAccessToken === null || oauth.accessToken !== expectedAccessToken)) return { ok: true, oauth, rotatedElsewhere: true };
      if (typeof oauth.refreshToken !== 'string' || !oauth.refreshToken.trim()) return { ok: false, reason: 'no_refresh_token' };
      if (typeof oauth.refreshTokenExpiresAt === 'number' && oauth.refreshTokenExpiresAt <= current) return { ok: false, reason: 'refresh_expired' };
      if (typeof fetchImpl !== 'function') return failure(configDirectory, 'network', current);
      const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter(scope => typeof scope === 'string') : [];
      const request = async withScope => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
        try {
          const body = { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: typeof oauth.clientId === 'string' && oauth.clientId ? oauth.clientId : CLIENT_ID };
          if (withScope && scopes.length) body.scope = scopes.join(' ');
          const response = await fetchImpl(TOKEN_URL, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `claude-cli/${cliVersion} (external, cli)`, 'x-app': 'cli' },
            body: JSON.stringify(body),
          });
          let data = null;
          try { data = await response.json(); } catch { data = null; }
          return { status: response.status, ok: response.ok, data };
        } finally { clearTimeout(timer); }
      };
      // A failed or unanswered request is not repeated now; the next attempt
      // (after the cooldown) may reuse the stored token, like the CLI does, since
      // only a received rotation proves the token was spent.
      let result;
      try { result = await request(true); } catch { return failure(configDirectory, 'network', now()); }
      if (!result.ok && classifyFailure(result.status, result.data) === 'invalid_scope') {
        try { result = await request(false); } catch { return failure(configDirectory, 'network', now()); }
      }
      if (!result.ok) {
        const reason = classifyFailure(result.status, result.data);
        if (reason === 'invalid_grant') {
          // Never blank the stored login. Someone else may have won the rotation.
          try {
            const latest = (await readCredentialFile(file)).claudeAiOauth;
            if (latest?.accessToken && latest.accessToken !== oauth.accessToken && !(typeof latest.expiresAt === 'number' && latest.expiresAt <= now())) return { ok: true, oauth: latest, rotatedElsewhere: true };
          } catch { /* Fall through to the failure below. */ }
        }
        return failure(configDirectory, reason, now(), { status: result.status });
      }
      if (typeof result.data?.access_token !== 'string' || !result.data.access_token.trim()) return failure(configDirectory, 'server', now(), { status: result.status });
      const merged = mergeOauth(oauth, result.data, now());
      // Keep the received rotation before touching the credentials file, so a
      // failed save can be completed later without spending a token again.
      const record = { replaces: fingerprint(oauth.refreshToken), rotated: merged, savedAt: new Date(now()).toISOString() };
      pendingRotations.set(configDirectory, record);
      try { await writeJsonAtomic(recoveryFile, record, sleep); }
      catch { /* The in-memory copy still covers this run; the save below is attempted. */ }
      try {
        await writeCredentials(file, merged, { now, sleep, replacing: oauth.accessToken });
      } catch (error) {
        if (['CREDENTIALS_CHANGED', 'ENOENT'].includes(error?.code)) return await currentLoginAfterChange();
        // Use the new login now; the recovery record saves it on the next attempt.
        return { ok: true, oauth: merged, refreshed: true, persisted: false };
      }
      pendingRotations.delete(configDirectory);
      await fs.rm(recoveryFile, { force: true }).catch(() => {});
      return { ok: true, oauth: merged, refreshed: true };
    } finally { await release(); }
  })();
  inFlight.set(configDirectory, task);
  try { return await task; } finally { inFlight.delete(configDirectory); }
}

/** Forget in-memory state, as an app restart would (tests). */
function clearRefreshState() { cooldowns.clear(); inFlight.clear(); pendingRotations.clear(); }

module.exports = { refreshClaudeCredentials, acquireLock, mergeOauth, classifyFailure, clearRefreshState, TOKEN_URL, CLIENT_ID, CLI_VERSION, REFRESH_LOCK, WRITE_LOCK, RECOVERY_FILE, COOLDOWN_MS };
