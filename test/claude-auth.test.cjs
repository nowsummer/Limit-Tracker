'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshClaudeCredentials, acquireLock, mergeOauth, classifyFailure, clearRefreshState, TOKEN_URL, CLIENT_ID, REFRESH_LOCK, WRITE_LOCK, RECOVERY_FILE } = require('../src/providers/claude-auth.cjs');

const NOW = Date.parse('2026-10-07T00:00:00Z');
function setup(oauthOverrides = {}, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-claude-auth-'));
  const oauth = { accessToken: 'sk-ant-oat01-old', refreshToken: 'sk-ant-ort01-old', expiresAt: NOW - 1000, refreshTokenExpiresAt: NOW + 86400000 * 20, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', ...oauthOverrides };
  fs.writeFileSync(path.join(directory, '.credentials.json'), JSON.stringify({ mcpOAuth: { notion: { accessToken: 'mcp-token' } }, claudeAiOauth: oauth, ...extra }));
  return { directory, oauth };
}
function response(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
const success = { access_token: 'sk-ant-oat01-new', refresh_token: 'sk-ant-ort01-new', expires_in: 28800, scope: 'user:inference user:profile', token_type: 'bearer' };
const noSleep = async () => {};

test.beforeEach(() => clearRefreshState());

test('a newer login written while a recovery record waits for the storage lock wins', async () => {
  const { directory, oauth } = setup();
  const file = path.join(directory, '.credentials.json');
  const newer = { ...oauth, accessToken: 'synthetic-other-account', refreshToken: 'synthetic-other-refresh', expiresAt: NOW + 3600000 };
  fs.writeFileSync(path.join(directory, RECOVERY_FILE), JSON.stringify({ replaces: require('node:crypto').createHash('sha256').update(oauth.refreshToken).digest('hex'), rotated: { ...oauth, accessToken: success.access_token, refreshToken: success.refresh_token, expiresAt: NOW + 3600000 } }));
  const fsp = require('node:fs/promises');
  const mkdir = fsp.mkdir;
  fsp.mkdir = async (target, ...args) => {
    if (target === path.join(directory, WRITE_LOCK)) fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: newer }));
    return mkdir(target, ...args);
  };
  let result;
  try { result = await refreshClaudeCredentials({ configDirectory: directory, now: () => NOW, fetchImpl: async () => assert.fail('Recovery must not send a request'), sleep: noSleep }); }
  finally { fsp.mkdir = mkdir; }
  assert.equal(result.ok, true);
  assert.equal(result.oauth.accessToken, newer.accessToken, 'never query the old account after a concurrent sign-in');
  assert.equal(fs.existsSync(path.join(directory, RECOVERY_FILE)), false);
});

for (const deleted of [false, true]) test(`a logout during token renewal is respected (${deleted ? 'deleted file' : 'removed login'})`, async () => {
  const { directory } = setup();
  const file = path.join(directory, '.credentials.json');
  const loggedOut = { mcpOAuth: { untouched: true } };
  const result = await refreshClaudeCredentials({ configDirectory: directory, now: () => NOW, sleep: noSleep, fetchImpl: async () => {
    if (deleted) fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify(loggedOut));
    return response(200, success);
  } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_login');
  if (deleted) assert.equal(fs.existsSync(file), false, 'logout must not recreate the credential file');
  else assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), loggedOut);
  assert.equal(fs.existsSync(path.join(directory, RECOVERY_FILE)), false);
});

test('refresh rotates tokens via the CLI endpoint, keeps other keys, and writes atomically', async () => {
  const { directory } = setup();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return response(200, success); };
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(result.refreshed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.match(calls[0].init.headers['User-Agent'], /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { grant_type: 'refresh_token', refresh_token: 'sk-ant-ort01-old', client_id: CLIENT_ID, scope: 'user:inference user:profile' });
  const saved = JSON.parse(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8'));
  assert.equal(saved.mcpOAuth.notion.accessToken, 'mcp-token', 'MCP logins must survive the rewrite');
  assert.equal(saved.claudeAiOauth.accessToken, 'sk-ant-oat01-new');
  assert.equal(saved.claudeAiOauth.refreshToken, 'sk-ant-ort01-new');
  assert.equal(saved.claudeAiOauth.expiresAt, NOW + 28800 * 1000);
  assert.equal(saved.claudeAiOauth.subscriptionType, 'max');
  assert.equal(saved.claudeAiOauth.rateLimitTier, 'default_claude_max_5x');
  assert.equal(saved.claudeAiOauth.refreshTokenExpiresAt, NOW + 86400000 * 20);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), [], 'locks and temp files are released');
});

test('a login already rotated by another process is reused without a network request', async () => {
  const { directory } = setup({ accessToken: 'sk-ant-oat01-fresh', expiresAt: NOW + 3600000 });
  let calls = 0;
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-stale', now: () => NOW, fetchImpl: async () => { calls++; return response(200, success); }, sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(result.rotatedElsewhere, true); assert.equal(result.oauth.accessToken, 'sk-ant-oat01-fresh'); assert.equal(calls, 0);
});

test('invalid_grant never blanks the stored login, sets a cooldown, and reports a re-login', async () => {
  const { directory } = setup();
  const fetchImpl = async () => response(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' });
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep });
  assert.equal(result.ok, false); assert.equal(result.reason, 'invalid_grant');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8'));
  assert.equal(saved.claudeAiOauth.refreshToken, 'sk-ant-ort01-old');
  const again = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW + 1000, fetchImpl: async () => { throw new Error('must not be called during cooldown'); }, sleep: noSleep });
  assert.equal(again.reason, 'cooldown'); assert.equal(again.cause, 'invalid_grant');
});

test('invalid_grant after the CLI already rotated the file adopts the CLI token', async () => {
  const { directory } = setup();
  const file = path.join(directory, '.credentials.json');
  const fetchImpl = async () => {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...current, claudeAiOauth: { ...current.claudeAiOauth, accessToken: 'sk-ant-oat01-cli', refreshToken: 'sk-ant-ort01-cli', expiresAt: NOW + 28800000 } }));
    return response(400, { error: 'invalid_grant' });
  };
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(result.rotatedElsewhere, true); assert.equal(result.oauth.accessToken, 'sk-ant-oat01-cli');
});

test('invalid_scope retries exactly once without scope', async () => {
  const { directory } = setup();
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response(400, { error: 'invalid_scope' }) : response(200, success); };
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(bodies.length, 2); assert.equal('scope' in bodies[1], false);
});

test('transport errors and timeouts never resend the single-use refresh token', async () => {
  const { directory } = setup();
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new TypeError('fetch failed'); };
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep });
  assert.equal(result.ok, false); assert.equal(result.reason, 'network'); assert.equal(calls, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8'));
  assert.equal(saved.claudeAiOauth.refreshToken, 'sk-ant-ort01-old');
  const again = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW + 1000, fetchImpl, sleep: noSleep });
  assert.equal(again.reason, 'cooldown'); assert.equal(calls, 1);
});

test('429 and 5xx responses are reported as server failures with a short cooldown', async () => {
  const { directory } = setup();
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl: async () => response(503, { error: 'overloaded' }), sleep: noSleep });
  assert.equal(result.ok, false); assert.equal(result.reason, 'server'); assert.equal(result.status, 503);
  const after = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW + 6 * 60000, fetchImpl: async () => response(200, success), sleep: noSleep });
  assert.equal(after.ok, true, 'cooldown expired after five minutes');
});

test('expired or missing refresh tokens short-circuit without a request', async () => {
  const expired = setup({ refreshTokenExpiresAt: NOW - 1 });
  const missing = setup({ refreshToken: '' });
  const fetchImpl = async () => { throw new Error('must not request'); };
  assert.equal((await refreshClaudeCredentials({ configDirectory: expired.directory, now: () => NOW, fetchImpl, sleep: noSleep })).reason, 'refresh_expired');
  assert.equal((await refreshClaudeCredentials({ configDirectory: missing.directory, now: () => NOW, fetchImpl, sleep: noSleep })).reason, 'no_refresh_token');
  assert.equal((await refreshClaudeCredentials({ configDirectory: path.join(expired.directory, 'nope'), now: () => NOW, fetchImpl, sleep: noSleep })).reason, 'no_login', 'a missing login folder is a logout');
});

test('the CLI refresh lock is honoured while fresh and reclaimed when stale', async () => {
  const { directory } = setup();
  const lock = path.join(directory, REFRESH_LOCK);
  fs.mkdirSync(lock);
  let clock = NOW;
  const locked = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl: async () => response(200, success), sleep: async () => { clock += 5000; } });
  assert.equal(locked.ok, false); assert.equal(locked.reason, 'locked');
  assert.equal(fs.existsSync(lock), true, 'a live lock owned by another process is left alone');
  clearRefreshState();
  const stale = new Date(NOW - 120000);
  fs.utimesSync(lock, stale, stale);
  clock = NOW;
  const reclaimed = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl: async () => response(200, success), sleep: noSleep });
  assert.equal(reclaimed.ok, true);
  assert.equal(fs.existsSync(lock), false);
});

test('concurrent refreshes of one account share a single request', async () => {
  const { directory } = setup();
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return response(200, success); };
  const [a, b] = await Promise.all([1, 2].map(() => refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep })));
  assert.equal(calls, 1); assert.equal(a.ok, true); assert.equal(b.ok, true);
});

test('write lock waits for a fresh storage lock and proceeds after it is released', async () => {
  const { directory } = setup();
  const writeLock = path.join(directory, WRITE_LOCK);
  fs.mkdirSync(writeLock);
  let clock = NOW;
  const sleep = async () => { clock += 250; if (clock > NOW + 1000) { try { fs.rmdirSync(writeLock); } catch {} } };
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl: async () => response(200, success), sleep });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'sk-ant-oat01-new');
});

test('a briefly locked credentials file is retried so the rotated login is not lost', async () => {
  const { directory } = setup();
  const file = path.join(directory, '.credentials.json');
  const fsp = require('node:fs/promises');
  const realRename = fsp.rename;
  let failures = 0;
  fsp.rename = async (from, to) => { if (to === file && failures < 2) { failures++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } return realRename(from, to); };
  try {
    const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl: async () => response(200, success), sleep: noSleep });
    assert.equal(result.ok, true);
  } finally { fsp.rename = realRename; }
  assert.equal(failures, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, 'sk-ant-ort01-new');
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
});

test('mergeOauth keeps the old refresh token and scopes when the server omits them', () => {
  const merged = mergeOauth({ accessToken: 'a', refreshToken: 'r', scopes: ['user:inference'], subscriptionType: 'pro' }, { access_token: 'b' }, NOW);
  assert.equal(merged.refreshToken, 'r'); assert.deepEqual(merged.scopes, ['user:inference']); assert.equal(merged.expiresAt, NOW + 8 * 3600000); assert.equal(merged.subscriptionType, 'pro');
});

test('acquireLock returns null after the wait budget without touching a live lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-lock-'));
  const dir = path.join(directory, 'x.lock');
  fs.mkdirSync(dir);
  let clock = NOW;
  const release = await acquireLock(dir, { staleMs: 60000, waitMs: 1000, now: () => clock, sleep: async () => { clock += 500; } });
  assert.equal(release, null);
  assert.equal(fs.existsSync(dir), true);
});

test('only an explicit invalid_grant means the login is gone', () => {
  assert.equal(classifyFailure(400, { error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(classifyFailure(401, { error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(classifyFailure(404, { type: 'not_found_error' }), 'server', 'an unknown route is a service problem, not a logout');
  assert.equal(classifyFailure(404, { error: 'route_not_found' }), 'server');
  assert.equal(classifyFailure(403, { error: 'permission_denied' }), 'server');
  assert.equal(classifyFailure(400, { error: 'invalid_request' }), 'server');
  assert.equal(classifyFailure(400, null), 'server');
  assert.equal(classifyFailure(400, { error: 'invalid_scope' }), 'invalid_scope');
  assert.equal(classifyFailure(503, { error: 'invalid_grant' }), 'server');
});

test('a rotation that cannot be saved (storage lock held) is kept and saved on the next attempt without a new request', async () => {
  const { directory } = setup();
  const file = path.join(directory, '.credentials.json');
  const writeLock = path.join(directory, WRITE_LOCK);
  fs.mkdirSync(writeLock);
  let clock = NOW;
  let requests = 0;
  const first = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl: async () => { requests++; return response(200, success); }, sleep: async () => { clock += 1000; } });
  assert.equal(first.ok, true); assert.equal(first.persisted, false);
  assert.equal(first.oauth.accessToken, 'sk-ant-oat01-new', 'the received login is used right away');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.claudeAiOauth.refreshToken, 'sk-ant-ort01-old', 'nothing was written without the storage lock');
  assert.equal(stored.mcpOAuth.notion.accessToken, 'mcp-token');
  assert.ok(fs.existsSync(path.join(directory, RECOVERY_FILE)), 'the rotation waits in the recovery record');
  fs.rmdirSync(writeLock);
  clearRefreshState();
  const second = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl: async () => { requests++; return response(400, { error: 'invalid_grant' }); }, sleep: noSleep });
  assert.equal(second.ok, true); assert.equal(second.recovered, true);
  assert.equal(requests, 1, 'the spent refresh token is never sent again');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.claudeAiOauth.refreshToken, 'sk-ant-ort01-new');
  assert.equal(saved.mcpOAuth.notion.accessToken, 'mcp-token');
  assert.equal(fs.existsSync(path.join(directory, RECOVERY_FILE)), false);
});

test('an unreadable credentials file at save time is never replaced by a file holding only claudeAiOauth', async () => {
  const { directory } = setup();
  const file = path.join(directory, '.credentials.json');
  const fetchImpl = async () => { fs.writeFileSync(file, '{ half written'); return response(200, success); };
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl, sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(result.persisted, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ half written', 'the file another writer is producing is left alone');
  assert.ok(fs.existsSync(path.join(directory, RECOVERY_FILE)));
});

test('a stale recovery record (the CLI saved a newer login) is discarded, not applied', async () => {
  const { directory } = setup({ accessToken: 'sk-ant-oat01-cli', refreshToken: 'sk-ant-ort01-cli', expiresAt: NOW + 3600000 });
  fs.writeFileSync(path.join(directory, RECOVERY_FILE), JSON.stringify({ replaces: 'not-the-current-token', rotated: { accessToken: 'sk-ant-oat01-mine', refreshToken: 'sk-ant-ort01-mine' } }));
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl: async () => assert.fail('No request: the CLI login is fresh'), sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(result.rotatedElsewhere, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'sk-ant-oat01-cli');
  assert.equal(fs.existsSync(path.join(directory, RECOVERY_FILE)), false);
});

test('a lock whose state cannot be read fails instead of spinning forever', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-lock-eacces-'));
  const dir = path.join(directory, 'x.lock');
  fs.mkdirSync(dir);
  const fsp = require('node:fs/promises');
  const realStat = fsp.stat;
  fsp.stat = async target => { if (target === dir) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realStat(target); };
  try { await assert.rejects(acquireLock(dir, { staleMs: 60000, waitMs: 1000, now: () => NOW, sleep: noSleep }), /denied/); }
  finally { fsp.stat = realStat; }
});

test('a rotation survives in memory when neither the recovery record nor the login file can be written', async () => {
  const { directory } = setup();
  const file = path.join(directory, '.credentials.json');
  const writeLock = path.join(directory, WRITE_LOCK);
  const recoveryPath = path.join(directory, RECOVERY_FILE);
  fs.mkdirSync(writeLock);
  fs.mkdirSync(recoveryPath);
  let clock = NOW;
  let requests = 0;
  const fetchImpl = async () => { requests++; return response(200, success); };
  const first = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl, sleep: async () => { clock += 1000; } });
  assert.equal(first.ok, true); assert.equal(first.persisted, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, 'sk-ant-ort01-old');
  fs.rmdirSync(writeLock); fs.rmdirSync(recoveryPath);
  const second = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => clock, fetchImpl: async () => { requests++; return response(400, { error: 'invalid_grant' }); }, sleep: noSleep });
  assert.equal(second.ok, true); assert.equal(second.recovered, true);
  assert.equal(requests, 1, 'the spent refresh token is not sent again');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, 'sk-ant-ort01-new');
});

test('a recovery record that exists but cannot be read blocks the request instead of spending the old token', async () => {
  const { directory } = setup();
  const recoveryPath = path.join(directory, RECOVERY_FILE);
  fs.writeFileSync(recoveryPath, JSON.stringify({ replaces: 'x', rotated: {} }));
  const fsp = require('node:fs/promises');
  const realReadFile = fsp.readFile;
  fsp.readFile = async (target, ...rest) => { if (String(target) === recoveryPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return realReadFile(target, ...rest); };
  try {
    const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl: async () => assert.fail('No request while the record is unreadable'), sleep: noSleep });
    assert.equal(result.ok, false); assert.equal(result.reason, 'invalid_file');
  } finally { fsp.readFile = realReadFile; }
  assert.ok(fs.existsSync(recoveryPath), 'the unreadable record is kept');
});

test('a damaged recovery record is discarded and the normal renewal continues', async () => {
  const { directory } = setup();
  const recoveryPath = path.join(directory, RECOVERY_FILE);
  fs.writeFileSync(recoveryPath, '{ not json');
  let requests = 0;
  const result = await refreshClaudeCredentials({ configDirectory: directory, expectedAccessToken: 'sk-ant-oat01-old', now: () => NOW, fetchImpl: async () => { requests++; return response(200, success); }, sleep: noSleep });
  assert.equal(result.ok, true); assert.equal(result.refreshed, true); assert.equal(requests, 1);
  assert.equal(fs.existsSync(recoveryPath), false);
});
