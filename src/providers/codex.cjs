'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { t } = require('../i18n.cjs');
const { envGet } = require('../accounts.cjs');

const SOURCE = 'codex-app-server';
const CURRENT_ARGS = Object.freeze(['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false']);
// Releases from before `--listen` existed already default to stdio.
const LEGACY_ARGS = Object.freeze(['app-server', '-c', 'analytics.enabled=false']);
let CLIENT_VERSION = '1.0.0';
try { CLIENT_VERSION = require('../../package.json').version; } catch { /* Packaged without metadata. */ }
// Product timing policy requested by the user: a reported 01:45 boundary is
// presented as available from 01:46. This is not an upstream API guarantee.
const RESET_ADJUSTMENT_MS = 60000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const CODES = Object.freeze(['CLI_NOT_FOUND', 'AUTH_REQUIRED', 'AUTH_UNSUPPORTED', 'UNSUPPORTED', 'NO_WINDOWS', 'TIMEOUT', 'NETWORK', 'PROTOCOL', 'CLI_FAILED', 'RATE_LIMIT_READ_FAILED', 'ABORTED']);
// Korean text stays in `error`; `errorKey` lets the app show the chosen language.
const MESSAGES = Object.freeze(Object.fromEntries(CODES.map(code => [code, t(`codex.${code}`, null, 'ko')])));

class CodexUsageError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.RATE_LIMIT_READ_FAILED);
    this.name = 'CodexUsageError';
    this.code = code;
  }
}

function classifyRpcError(error) {
  if (error?.code === -32601) return new CodexUsageError('UNSUPPORTED');
  // Read messages only to classify the failure. Never return upstream text,
  // which may contain account details, request headers, or credentials.
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (/api.?key|bedrock|not supported.*auth|unsupported.*auth/.test(message)) {
    return new CodexUsageError('AUTH_UNSUPPORTED');
  }
  if (/unauthori[sz]ed|forbidden|\b40[13]\b|not logged|log.?in required|missing credential|authentication|expired token|requires.*auth/.test(message)) {
    return new CodexUsageError('AUTH_REQUIRED');
  }
  if (/network|connection|dns|connect|fetch failed|request.*failed|timed? ?out/.test(message)) {
    return new CodexUsageError('NETWORK');
  }
  return new CodexUsageError('RATE_LIMIT_READ_FAILED');
}

function cleanText(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || fallback;
}

/** Translation key and parameters for a window length. */
function durationLabel(minutes, fallbackKey) {
  if (minutes === 10080) return { key: 'codex.weekly' };
  if (minutes === 1440) return { key: 'codex.day' };
  if (minutes && minutes % 60 === 0) return { key: 'codex.hours', params: { hours: minutes / 60 } };
  if (minutes) return { key: 'codex.minutes', params: { minutes } };
  return { key: fallbackKey };
}
function labelFields(prefix, duration) {
  const text = t(duration.key, duration.params, 'ko');
  const fields = { label: prefix ? `${prefix} · ${text}` : text, labelKey: duration.key };
  if (duration.params) fields.labelParams = duration.params;
  if (prefix) fields.labelPrefix = prefix;
  return fields;
}

function epochSecondsToIso(value, adjustmentMs = 0) {
  // App-server specifies Unix seconds, never milliseconds or a relative TTL.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value * 1000 + adjustmentMs;
  if (milliseconds > 8640000000000000) return null;
  return new Date(milliseconds).toISOString();
}

/**
 * What lets the account keep going past its limit, from the same rate-limit read
 * (learn.chatgpt.com/docs/app-server §6): banked usage resets and credits. Only the
 * count, the earliest expiry and the balance leave this function — never reset ids or
 * the service's untranslated titles. Anything missing or malformed is unknown (null).
 */
function afterLimitOf(result, bucket, now) {
  let resets = null, resetsExpireAt = null;
  const summary = result?.rateLimitResetCredits;
  if (summary && typeof summary === 'object' && Number.isFinite(summary.availableCount) && summary.availableCount >= 1) {
    resets = Math.floor(summary.availableCount);
    // The detail list may be capped or missing (count only); the count is authoritative.
    const rows = Array.isArray(summary.credits) ? summary.credits.filter(row => row && typeof row === 'object' && row.status === 'available') : null;
    const expiry = row => typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) && row.expiresAt > 0 ? row.expiresAt * 1000 : null;
    const live = rows ? rows.filter(row => expiry(row) === null || expiry(row) > now) : null;
    // Empty details explicitly mean none are available. If any listed grant
    // has expired since the server counted it, the total is no longer reliable.
    // Hide it until the next consistent reading rather than guess a new count.
    if (rows && (!rows.length || live.length !== rows.length)) resets = null;
    else if (live) {
      const times = live.map(expiry).filter(time => time !== null && time <= 8640000000000000);
      if (times.length) resetsExpireAt = new Date(Math.min(...times)).toISOString();
    }
  }
  const credits = bucket?.credits && typeof bucket.credits === 'object' ? bucket.credits : result?.rateLimits?.credits;
  let creditBalance = null, unlimitedCredits = false;
  if (credits && typeof credits === 'object') {
    if (credits.unlimited === true) unlimitedCredits = true;
    else if (credits.hasCredits === true && typeof credits.balance === 'string' && /^\d{1,12}(\.\d{1,12})?$/.test(credits.balance.trim()) && Number(credits.balance) > 0) creditBalance = credits.balance.trim();
  }
  return resets || unlimitedCredits || creditBalance ? { resets, resetsExpireAt, creditBalance, unlimitedCredits } : null;
}

/** Convert official app-server snapshots to renderer-safe, quota-based data. */
function normalizeCodexLimits(result, account = null, now = Date.now()) {
  const byId = result?.rateLimitsByLimitId;
  let buckets = byId && typeof byId === 'object' && !Array.isArray(byId)
    ? Object.entries(byId).filter(([, bucket]) => bucket && typeof bucket === 'object')
    : [];
  if (!buckets.length && result?.rateLimits && typeof result.rateLimits === 'object') {
    buckets = [[cleanText(result.rateLimits.limitId, 'codex'), result.rateLimits]];
  }
  buckets.sort(([left], [right]) => {
    if (left === 'codex') return -1;
    if (right === 'codex') return 1;
    return left.localeCompare(right);
  });

  const windows = [];
  let plan = cleanText(account?.planType);
  for (const [key, bucket] of buckets) {
    plan ||= cleanText(bucket.planType);
    const bucketId = cleanText(bucket.limitId, cleanText(key, 'codex'));
    const bucketLabel = bucketId === 'codex' ? '' : cleanText(bucket.limitName, bucketId);
    for (const slot of ['primary', 'secondary']) {
      const quota = bucket[slot];
      // A negative value is not a reading; never present it as a confirmed 0%.
      if (!quota || typeof quota.usedPercent !== 'number' || !Number.isFinite(quota.usedPercent) || quota.usedPercent < 0) continue;
      const usedPercent = Math.min(100, quota.usedPercent);
      const durationMinutes = typeof quota.windowDurationMins === 'number'
        && Number.isFinite(quota.windowDurationMins) && quota.windowDurationMins > 0
        ? quota.windowDurationMins : null;
      const duration = durationLabel(durationMinutes, slot === 'primary' ? 'codex.primary' : 'codex.secondary');
      windows.push({
        id: `${bucketId}:${slot}`,
        ...labelFields(bucketLabel, duration),
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: epochSecondsToIso(quota.resetsAt, RESET_ADJUSTMENT_MS),
        sourceResetsAt: epochSecondsToIso(quota.resetsAt),
        resetAdjustmentMs: RESET_ADJUSTMENT_MS,
        durationMinutes,
      });
    }
  }
  const afterLimit = afterLimitOf(result, buckets.find(([key]) => key === 'codex')?.[1], now);
  return afterLimit ? { windows, plan, afterLimit } : { windows, plan };
}

/** Locate the native CLI without launching a shell or touching authentication. */
async function findCodexExecutable({
  executable,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  access = fs.access,
  readdir = fs.readdir,
  stat = fs.stat,
} = {}) {
  if (typeof executable === 'string' && executable) return executable;
  const isWindows = platform === 'win32';
  const pathApi = isWindows ? path.win32 : path;
  const executableName = isWindows ? 'codex.exe' : 'codex';
  const pathValue = envGet(env, 'PATH') || '';
  const folders = pathValue.split(isWindows ? ';' : ':').filter(Boolean).map(folder => folder.replace(/^"|"$/g, ''));
  folders.push(pathApi.join(home, '.local', 'bin'));
  for (const folder of folders) {
    const candidate = pathApi.join(folder, executableName);
    try { await access(candidate); return candidate; } catch { /* Try next location. */ }
  }
  if (isWindows) {
    // `npm i -g @openai/codex` adds a codex.cmd shim; the native binary is
    // vendored inside the package and can be started without a shell.
    const appData = envGet(env, 'APPDATA');
    const roots = [...new Set([...(appData ? [pathApi.join(appData, 'npm')] : []), ...folders])];
    const triples = process.arch === 'arm64' ? ['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc'] : ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
    for (const root of roots) {
      try { await access(pathApi.join(root, 'codex.cmd')); } catch { continue; }
      for (const triple of triples) {
        const vendored = pathApi.join(root, 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex', 'codex.exe');
        try { await access(vendored); return vendored; } catch { /* Try the next layout. */ }
      }
    }
  }

  if (isWindows && env.LOCALAPPDATA) {
    // Desktop installs put the native CLI under a versioned directory. This
    // also works when Explorer launches our app without Codex's PATH additions.
    const bin = pathApi.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const entries = await readdir(bin, { withFileTypes: true });
      const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        const candidate = pathApi.join(bin, entry.name, 'codex.exe');
        try {
          const info = await stat(candidate);
          return info.isFile() ? { candidate, modified: info.mtimeMs } : null;
        } catch { return null; }
      }));
      const newest = candidates.filter(Boolean).sort((a, b) => b.modified - a.modified)[0];
      if (newest) return newest.candidate;
    } catch { /* No Codex desktop install in this location. */ }
  }
  throw new CodexUsageError('CLI_NOT_FOUND');
}

/**
 * One short-lived stdio connection. Only initialize/account read RPCs are sent.
 * No thread, model, login, logout, credit redemption, or inference requests.
 */
function readCodexAccountAndLimits({
  executable,
  env = process.env,
  spawn = nodeSpawn,
  timeoutMs = 15000,
  signal,
  legacyArgs = false,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let completed = false;
    let buffer = '';
    let account = null;
    let phase = 'initialize';
    let sawOutput = false;
    let forceKillTimer;
    const deadline = setTimeout(() => finish(new CodexUsageError('TIMEOUT')), timeoutMs);

    function stopChild() {
      if (!child) return;
      // EOF lets app-server dispose its own resources normally; enforce a short
      // upper bound if it does not exit. Never write server diagnostics to logs.
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      if (child.exitCode === null && child.signalCode === null) {
        forceKillTimer = setTimeout(() => { try { child.kill(); } catch { /* Already exited. */ } }, 500);
        forceKillTimer.unref?.();
      }
    }

    function finish(error, result) {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      stopChild();
      if (error) reject(error); else resolve(result);
    }

    function onAbort() { finish(new CodexUsageError('ABORTED')); }

    function send(message) {
      if (completed) return;
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch { finish(new CodexUsageError('CLI_FAILED')); }
    }

    function handleMessage(message) {
      if (completed || !message || typeof message !== 'object') return;
      if (message.method && message.id !== undefined) {
        // External credential refresh/attestation requests need their host app.
        // We never supply secrets or approve work through this read-only client.
        send({ id: message.id, error: { code: -32601, message: 'Read-only usage client does not support server requests.' } });
        return;
      }
      const expectedId = phase === 'initialize' ? 1 : phase === 'account' ? 2 : 3;
      if (message.id !== expectedId) return; // Ignore notifications and unrelated IDs.
      if (message.error) { finish(classifyRpcError(message.error)); return; }
      if (!Object.hasOwn(message, 'result')) { finish(new CodexUsageError('PROTOCOL')); return; }
      if (phase === 'initialize') {
        phase = 'account';
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      } else if (phase === 'account') {
        account = message.result?.account;
        if (!account) { finish(new CodexUsageError('AUTH_REQUIRED')); return; }
        if (!['chatgpt', 'chatgptAuthTokens', 'agentIdentity', 'personalAccessToken'].includes(account.type)) {
          finish(new CodexUsageError('AUTH_UNSUPPORTED')); return;
        }
        // Only retain plan/type. Email and other account fields never leave this process.
        account = { type: account.type, planType: cleanText(account.planType) };
        phase = 'limits';
        send({ id: 3, method: 'account/rateLimits/read' });
      } else {
        finish(null, { account, result: message.result });
      }
    }

    function consume(chunk) {
      if (completed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        finish(new CodexUsageError('PROTOCOL')); return;
      }
      let newline;
      while (!completed && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        sawOutput = true;
        let message;
        try { message = JSON.parse(line); }
        catch { finish(new CodexUsageError('PROTOCOL')); return; }
        handleMessage(message);
      }
    }

    if (signal?.aborted) { finish(new CodexUsageError('ABORTED')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(executable, [...(legacyArgs ? LEGACY_ARGS : CURRENT_ARGS)], {
        env: { ...env },
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', error => finish(new CodexUsageError(error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_FAILED')));
      child.on('close', code => {
        clearTimeout(forceKillTimer);
        // Exit code 2 before any output is a command-line usage error.
        finish(new CodexUsageError(code === 2 && !sawOutput && phase === 'initialize' ? 'ARGUMENTS_REJECTED' : 'CLI_FAILED'));
      });
      child.stdin.on('error', () => finish(new CodexUsageError('CLI_FAILED')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', consume);
      child.stdout.on('error', () => finish(new CodexUsageError('CLI_FAILED')));
      child.stderr?.resume();
      child.stderr?.on('error', () => {});
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'limit_tracker', title: 'Limit Tracker', version: CLIENT_VERSION } },
      });
    } catch (error) {
      finish(new CodexUsageError(error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_FAILED'));
    }
  });
}

async function fetchCodexUsage({ now = Date.now(), ...dependencies } = {}) {
  const date = new Date(now);
  const updatedAt = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const base = { id: 'codex', name: 'Codex', status: 'error', plan: null, windows: [], updatedAt, error: null, errorKey: null, source: SOURCE };
  const failure = code => {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'RATE_LIMIT_READ_FAILED';
    return { error: MESSAGES[known], errorKey: `codex.${known}` };
  };
  try {
    const executable = await findCodexExecutable(dependencies);
    let read;
    try { read = await readCodexAccountAndLimits({ ...dependencies, executable }); }
    catch (error) {
      if (error?.code !== 'ARGUMENTS_REJECTED') throw error;
      try { read = await readCodexAccountAndLimits({ ...dependencies, executable, legacyArgs: true }); }
      catch (legacy) { throw legacy?.code === 'ARGUMENTS_REJECTED' ? new CodexUsageError('UNSUPPORTED') : legacy; }
    }
    const normalized = normalizeCodexLimits(read.result, read.account, now);
    if (!normalized.windows.length) return { ...base, ...normalized, status: 'unsupported', ...failure('NO_WINDOWS') };
    return { ...base, ...normalized, status: 'ok' };
  } catch (error) {
    const code = error instanceof CodexUsageError ? error.code : 'RATE_LIMIT_READ_FAILED';
    const status = ['CLI_NOT_FOUND', 'AUTH_REQUIRED'].includes(code) ? 'disconnected'
      : ['UNSUPPORTED', 'AUTH_UNSUPPORTED'].includes(code) ? 'unsupported' : 'error';
    return { ...base, status, ...failure(code) };
  }
}

module.exports = { fetchCodexUsage, normalizeCodexLimits, findCodexExecutable, readCodexAccountAndLimits };
