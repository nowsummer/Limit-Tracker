'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fetchClaudeUsage, findClaudeExecutable } = require('../src/providers/claude.cjs');

const NOW = Date.parse('2026-10-04T08:00:00Z');
const TOKEN = 'test-only-subscription-token';
const RESET = '2026-10-04T11:00:00.000Z';

async function fixture(t, credentials) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'limit-tracker-claude-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.claude'));
  if (credentials !== undefined) await fs.writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify(credentials));
  return { home, env: {}, platform: 'linux', now: NOW };
}

function oauth(overrides = {}) {
  return { claudeAiOauth: { accessToken: TOKEN, refreshToken: 'test-only-never-used-refresh', expiresAt: NOW + 3600000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', ...overrides } };
}

function response(data, status = 200, headers = new Headers()) {
  return { ok: status >= 200 && status < 300, status, headers, json: async () => data };
}

test('no subscription login never sends an API request or claims a cached plan', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_max' } }));
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, fetchImpl: () => { requests++; } });
  assert.equal(result.status, 'disconnected');
  assert.equal(result.plan, null);
  assert.deepEqual(result.windows, []);
  assert.equal(requests, 0);
});

test('MCP OAuth credential is never used as a Claude subscription credential', async t => {
  const options = await fixture(t, { mcpOAuth: { unrelatedService: { accessToken: 'test-only-mcp-token' } } });
  const result = await fetchClaudeUsage({ ...options, fetchImpl: () => assert.fail('Must not send MCP token') });
  assert.equal(result.status, 'disconnected');
  assert.equal(JSON.stringify(result).includes('test-only-mcp-token'), false);
});

test('API-key-only users get unsupported, never invented remaining tokens', async t => {
  const options = await fixture(t);
  const result = await fetchClaudeUsage({ ...options, env: { ANTHROPIC_API_KEY: 'test-only-key' }, fetchImpl: () => assert.fail('No model or usage request') });
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.windows, []);
});

test('reads quota percentages, zero usage and optional model windows with fixed secure GET', async t => {
  const options = await fixture(t, oauth());
  const before = await fs.readFile(path.join(options.home, '.claude', '.credentials.json'), 'utf8');
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async (url, request) => {
    requests++;
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['anthropic-beta'], 'oauth-2025-04-20');
    return response({ five_hour: { utilization: 23.5, resets_at: RESET }, seven_day: { utilization: 0, resets_at: '2026-10-10T00:00:00+00:00' }, seven_day_sonnet: null, seven_day_opus: { utilization: 41, resets_at: RESET }, extra_usage: { utilization: 10 } });
  } });
  assert.equal(requests, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'Claude Max 20x');
  assert.equal(result.windows.length, 3);
  assert.deepEqual(result.windows[0], { id: 'five_hour', label: '5시간', labelKey: 'window.fiveHour', usedPercent: 23.5, remainingPercent: 76.5, resetsAt: RESET, durationMinutes: 300 });
  assert.equal(result.windows[1].remainingPercent, 100);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(await fs.readFile(path.join(options.home, '.claude', '.credentials.json'), 'utf8'), before);
});

test('expired login whose refresh token was revoked asks for a new login without a usage request', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW - 1 }));
  const calls = [];
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, execFileImpl: () => assert.fail('No auth-status refresh'),
    refreshImpl: async request => { calls.push(request); return { ok: false, reason: 'invalid_grant' }; },
    fetchImpl: () => assert.fail('Must not request usage with an expired token') });
  assert.equal(result.status, 'disconnected');
  assert.equal(result.errorKey, 'claude.err.reloginRequired');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].configDirectory, path.join(options.home, '.claude'));
  assert.equal(calls[0].expectedAccessToken, TOKEN);
});

test('expired login is renewed like the CLI and the renewed token reads usage', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW - 1 }));
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {},
    refreshImpl: async () => ({ ok: true, refreshed: true, oauth: { ...oauth().claudeAiOauth, accessToken: 'test-only-renewed', expiresAt: NOW + 28800000 } }),
    fetchImpl: async (_url, request) => { assert.equal(request.headers.Authorization, 'Bearer test-only-renewed'); return response({ five_hour: { utilization: 31 } }); } });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].usedPercent, 31);
  assert.ok(!JSON.stringify(result).includes('test-only-renewed'));
});

test('a temporary renewal failure keeps the account connected as an error, not a logout', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW - 1 }));
  for (const reason of ['network', 'server', 'locked']) {
    const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, refreshImpl: async () => ({ ok: false, reason }), fetchImpl: () => assert.fail('No usage request') });
    assert.equal(result.status, 'error', reason);
    assert.match(result.errorKey, reason === 'locked' ? /refreshing/ : /refreshFailed/);
  }
  const cooled = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, refreshImpl: async () => ({ ok: false, reason: 'cooldown', cause: 'invalid_grant' }), fetchImpl: () => assert.fail('No usage request') });
  assert.equal(cooled.status, 'disconnected', 'a cooldown after a revoked login still asks to sign in');
});

test('a renewable login reports the service final expiry; environment tokens do not', async t => {
  const ends = NOW + 2 * 86400000;
  const options = await fixture(t, oauth({ refreshTokenExpiresAt: ends }));
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ five_hour: { utilization: 1 } }) });
  assert.equal(result.loginExpiresAt, new Date(ends).toISOString());
  const env = await fixture(t);
  const fromEnv = await fetchClaudeUsage({ ...env, env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-only-env' }, fetchImpl: async () => response({ five_hour: { utilization: 1 } }) });
  assert.equal(fromEnv.loginExpiresAt, null);
});

test('a token inside the renewal margin is still used if renewal fails', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW + 30000 }));
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, refreshImpl: async () => ({ ok: false, reason: 'network' }), fetchImpl: async () => { requests++; return response({ five_hour: { utilization: 5 } }); } });
  assert.equal(result.status, 'ok'); assert.equal(requests, 1);
});

test('without renewal an expired token keeps the last reading instead of logging out', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW - 1 }));
  const result = await fetchClaudeUsage({ ...options, allowRefresh: false, credentialRetryDelayImpl: async () => {}, refreshImpl: () => assert.fail('Renewal disabled'), fetchImpl: () => assert.fail('Must not request') });
  assert.equal(result.status, 'error');
  assert.match(result.error, /만료/);
});

test('invalid credentials file reports error with no raw contents', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.home, '.claude', '.credentials.json'), `{ broken ${TOKEN}`);
  const result = await fetchClaudeUsage({ ...options, fetchImpl: () => assert.fail('Invalid credentials') });
  assert.equal(result.status, 'error');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('authentication errors do not expose server bodies or resend an unchanged token', async t => {
  const options = await fixture(t, oauth());
  let requests = 0, renewals = 0;
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, refreshImpl: async () => { renewals++; return { ok: false, reason: 'invalid_grant' }; }, fetchImpl: async () => {
    requests++;
    return { ...response(null, 401), json: () => assert.fail('Do not read error body') };
  } });
  assert.equal(result.status, 'disconnected');
  assert.equal(requests, 1);
  assert.equal(renewals, 1, 'a 401 with an unexpired token renews exactly once');
});

test('a 401 renewed by the CLI-compatible refresh is retried once with the new token', async t => {
  const options = await fixture(t, oauth());
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {},
    refreshImpl: async () => ({ ok: true, oauth: { ...oauth().claudeAiOauth, accessToken: 'test-only-after-401' } }),
    fetchImpl: async (_url, request) => { requests++; if (requests === 1) return response(null, 401); assert.equal(request.headers.Authorization, 'Bearer test-only-after-401'); return response({ five_hour: { utilization: 9 } }); } });
  assert.equal(result.status, 'ok'); assert.equal(requests, 2);
});

test('429 preserves retry time and does not turn failure into zero usage', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => response(null, 429, new Headers({ 'retry-after': '300' })) });
  assert.equal(result.status, 'error');
  assert.equal(result.retryAt, '2026-10-04T08:05:00.000Z');
  assert.deepEqual(result.windows, []);
});

test('network failures sanitize exception text that could contain auth values', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => { throw new Error(`Authorization Bearer ${TOKEN}`); } });
  assert.equal(result.status, 'error');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('request timeout aborts the fetch', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, timeoutMs: 10, fetchImpl: (_, request) => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true })) });
  assert.equal(result.status, 'error');
  assert.match(result.error, /시간이 초과/);
});

test('unknown response and invalid values never become fabricated quota windows', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ five_hour: { utilization: '25' }, seven_day: { utilization: -1 }, seven_day_opus: { utilization: null } }) });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.windows, []);
});

test('over-limit percentage cannot render a negative remaining amount', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ five_hour: { utilization: 101.5, resets_at: 'invalid' } }) });
  assert.equal(result.windows[0].usedPercent, 100);
  assert.equal(result.windows[0].remainingPercent, 0);
  assert.equal(result.windows[0].resetsAt, null);
});

test('respects custom Claude config directory without copying credentials', async t => {
  const options = await fixture(t);
  const configDir = path.join(options.home, 'account-work');
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, '.credentials.json'), JSON.stringify(oauth({ subscriptionType: 'team' })));
  const result = await fetchClaudeUsage({ ...options, env: { CLAUDE_CONFIG_DIR: configDir }, fetchImpl: async () => response({ five_hour: { utilization: 20 } }) });
  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'Claude Team');
});

test('optional official status-line cache keeps capture time and discards expired windows', async t => {
  const options = await fixture(t);
  const statusCachePath = path.join(options.home, 'claude-status.json');
  await fs.writeFile(statusCachePath, JSON.stringify({ capturedAt: '2026-10-04T07:50:00Z', rate_limits: { five_hour: { used_percentage: 80, resets_at: NOW / 1000 - 1 }, seven_day: { used_percentage: 25, resets_at: NOW / 1000 + 3600 } } }));
  const result = await fetchClaudeUsage({ ...options, statusCachePath });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, 'seven_day');
  assert.equal(result.updatedAt, '2026-10-04T07:50:00.000Z');
  assert.equal(result.stale, true);
  assert.equal(result.cached, true);
  assert.match(result.source, /공식/);
});

test('optional cache cannot claim unused quota after all windows reset', async t => {
  const options = await fixture(t);
  const statusCachePath = path.join(options.home, 'claude-status.json');
  await fs.writeFile(statusCachePath, JSON.stringify({ capturedAt: '2026-10-04T07:50:00Z', rate_limits: { five_hour: { used_percentage: 80, resets_at: NOW / 1000 - 1 } } }));
  const result = await fetchClaudeUsage({ ...options, statusCachePath });
  assert.equal(result.status, 'disconnected');
  assert.deepEqual(result.windows, []);
});

test('a cached reading preserves the server cooldown through the usage service', async t => {
  const { UsageService } = require('../src/usage-service.cjs');
  const options = await fixture(t, oauth());
  const statusCachePath = path.join(options.home, 'claude-status.json');
  await fs.writeFile(statusCachePath, JSON.stringify({ capturedAt: new Date(NOW - 60000).toISOString(), rate_limits: {
    five_hour: { used_percentage: 82, resets_at: NOW / 1000 + 3600 },
  } }));
  let requests = 0;
  let clock = NOW;
  const service = new UsageService([{ id: 'claude', name: 'Claude', fetch: () => fetchClaudeUsage({
    ...options, now: clock, statusCachePath,
    fetchImpl: async () => { requests++; return response(null, 429, new Headers({ 'retry-after': '600' })); },
  }) }], { now: () => clock });
  await service.refresh({ force: true });
  assert.equal(service.providers[0].cached, true);
  assert.equal(service.providers[0].windows[0].usedPercent, 82);
  assert.equal(service.retryAfter('claude'), NOW + 600000);
  clock += 120000;
  await service.refresh({ force: true });
  assert.equal(requests, 1, 'even manual refresh respects Retry-After while showing the old reading');
  clock = NOW + 600001;
  await service.refresh({ force: true });
  assert.equal(requests, 2);
});

test('WSL uses only running distributions and keeps credentials out of output data', async t => {
  const options = await fixture(t);
  const calls = [];
  const result = await fetchClaudeUsage({ ...options, platform: 'win32', execFileImpl: async (executable, args, processOptions) => {
    calls.push(args);
    assert.equal(executable, 'wsl.exe');
    assert.equal(processOptions.windowsHide, true);
    if (args[0] === '--list') return { stdout: Buffer.from('Ubuntu\r\n', 'utf16le') };
    assert.deepEqual(args.slice(0, 5), ['--distribution', 'Ubuntu', '--exec', 'sh', '-c']);
    return { stdout: JSON.stringify(oauth()) };
  }, fetchImpl: async () => response({ five_hour: { utilization: 22 } }) });
  assert.deepEqual(calls[0], ['--list', '--running', '--quiet']);
  assert.equal(result.status, 'ok');
  assert.equal(result.credentialLocation, 'WSL · Ubuntu');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('executable discovery prefers native user install and does not run a shell', async t => {
  const options = await fixture(t);
  const bin = path.join(options.home, '.local', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'claude.exe');
  await fs.writeFile(executable, 'test fixture');
  assert.equal(await findClaudeExecutable({ ...options, platform: 'win32' }), executable);
});

test('npm-installed Claude Code (claude.cmd under APPDATA npm) is found when no native install exists', async t => {
  const options = await fixture(t);
  const roaming = path.join(options.home, 'AppData', 'Roaming');
  const npm = path.join(roaming, 'npm');
  await fs.mkdir(npm, { recursive: true });
  const shim = path.join(npm, 'claude.cmd');
  await fs.writeFile(shim, '@echo off');
  assert.equal(await findClaudeExecutable({ ...options, platform: 'win32', env: { Appdata: roaming, Path: '' } }), shim);
});

test('CLAUDE_CODE_OAUTH_TOKEN logins are read from the environment and never renewed', async t => {
  const options = await fixture(t);
  const result = await fetchClaudeUsage({ ...options, env: { Claude_Code_OAuth_Token: 'test-only-env-token' }, refreshImpl: () => assert.fail('Never renew an environment token'),
    fetchImpl: async (_url, request) => { assert.equal(request.headers.Authorization, 'Bearer test-only-env-token'); return response({ five_hour: { utilization: 2 } }); } });
  assert.equal(result.status, 'ok');
});

test('a half-written local file is never replaced by another WSL account', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.home, '.claude', '.credentials.json'), '{');
  const result = await fetchClaudeUsage({ ...options, platform: 'win32', credentialRetryDelayImpl: async () => {},
    execFileImpl: async () => assert.fail('No WSL scan while the local file is mid-write'), fetchImpl: () => assert.fail('No request') });
  assert.equal(result.status, 'error');
});

test('parses official server limits rows including a Fable weekly scope and preserves zero usage', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ limits: [
    { kind: 'session', group: 'session', percent: 0, resets_at: RESET, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 34, resets_at: RESET, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 57, resets_at: RESET, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false }
  ] }) });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map(w => [w.id, w.usedPercent, w.remainingPercent]), [['five_hour', 0, 100], ['seven_day', 34, 66], ['seven_day_fable', 57, 43]]);
  assert.deepEqual(result.windows[2], { id: 'seven_day_fable', label: 'Fable 주간', labelKey: 'window.scopedWeekly', labelParams: { name: 'Fable' }, usedPercent: 57, remainingPercent: 43, resetsAt: RESET, durationMinutes: 10080 });
});

test('limits array is authoritative over legacy values and missing Fable is never fabricated', async t => {
  const options = await fixture(t, oauth());
  const modern = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({
    five_hour: { utilization: 90 }, seven_day_opus: { utilization: 50 }, seven_day_fable: { utilization: 40 },
    limits: [{ kind: 'session', percent: 11 }]
  }) });
  assert.deepEqual(modern.windows.map(w => [w.id, w.usedPercent]), [['five_hour', 11]]);
  const empty = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ five_hour: { utilization: 0 }, limits: [] }) });
  assert.equal(empty.status, 'error');
  assert.deepEqual(empty.windows, []);
  const legacy = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ five_hour: { utilization: 0 }, limits: null }) });
  assert.equal(legacy.status, 'ok');
  assert.equal(legacy.windows[0].usedPercent, 0);
});

test('invalid or unclassified scoped rows do not create values or duplicate windows', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, fetchImpl: async () => response({ limits: [
    { kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: '9', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 9 },
    { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Fable\nunsafe' } } },
    { kind: 'invented', percent: 9 },
    { kind: 'session', percent: -1 },
    { kind: 'weekly_scoped', percent: 100, resets_at: 'not-a-date', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 3, scope: { model: { display_name: 'Fable' } } }
  ] }) });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].usedPercent, 100);
  assert.equal(result.windows[0].remainingPercent, 0);
  assert.equal(result.windows[0].resetsAt, null);
});

test('expired token reread follows a token saved by the official CLI without rotating it', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW - 1 }));
  const file = path.join(options.home, '.claude', '.credentials.json');
  const replacement = JSON.stringify(oauth({ accessToken: 'test-only-cli-renewed', expiresAt: NOW + 60000 }));
  let rereads = 0, requests = 0;
  const result = await fetchClaudeUsage({ ...options,
    credentialRetryDelayImpl: async () => { rereads++; await fs.writeFile(file, replacement); },
    execFileImpl: () => assert.fail('No CLI command needed'),
    fetchImpl: async (url, request) => {
      requests++;
      assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(request.headers.Authorization, 'Bearer test-only-cli-renewed');
      return response({ five_hour: { utilization: 12 } });
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(rereads, 1);
  assert.equal(requests, 1);
  assert.equal(await fs.readFile(file, 'utf8'), replacement);
  assert.ok(!JSON.stringify(result).includes('test-only-cli-renewed'));
});

test('401 retries exactly once with a changed persisted access token and no error-body read', async t => {
  const options = await fixture(t, oauth());
  const file = path.join(options.home, '.claude', '.credentials.json');
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, fetchImpl: async (url, request) => {
    requests++;
    if (requests === 1) {
      assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
      await fs.writeFile(file, JSON.stringify(oauth({ accessToken: 'test-only-replaced' })));
      return { ...response(null, 401), json: () => assert.fail('Never inspect an auth error body') };
    }
    assert.equal(request.headers.Authorization, 'Bearer test-only-replaced');
    return response({ five_hour: { utilization: 8 } });
  } });
  assert.equal(result.status, 'ok');
  assert.equal(requests, 2);
});

test('rejected replacement tokens cannot trigger an unbounded refresh/retry loop', async t => {
  const options = await fixture(t, oauth());
  const file = path.join(options.home, '.claude', '.credentials.json');
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, fetchImpl: async () => {
    requests++;
    await fs.writeFile(file, JSON.stringify(oauth({ accessToken: `test-only-next-${requests}` })));
    return { ...response(null, 403), json: () => assert.fail('No error-body read') };
  } });
  assert.equal(result.status, 'error', 'a 403 is a permission answer, not proof of logout');
  assert.equal(requests, 2);
  assert.ok(!JSON.stringify(result).includes('test-only-next'));
});

test('401 reread cannot switch from a local account to a different WSL credential source', async t => {
  const options = await fixture(t, oauth());
  let requests = 0;
  const result = await fetchClaudeUsage({ ...options, platform: 'win32', credentialRetryDelayImpl: async () => {},
    execFileImpl: async (executable, args) => args[0] === '--list'
      ? { stdout: Buffer.from('Ubuntu\r\n', 'utf16le') }
      : { stdout: JSON.stringify(oauth({ accessToken: 'test-only-other-account' })) },
    fetchImpl: async () => {
      requests++;
      await fs.unlink(path.join(options.home, '.claude', '.credentials.json'));
      return response(null, 401);
    }
  });
  assert.equal(result.status, 'disconnected');
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(result).includes('test-only-other-account'));
});

test('a temporarily incomplete credential write gets one bounded reread', async t => {
  const options = await fixture(t);
  const file = path.join(options.home, '.claude', '.credentials.json');
  await fs.writeFile(file, '{');
  let rereads = 0;
  const result = await fetchClaudeUsage({ ...options,
    credentialRetryDelayImpl: async () => { rereads++; await fs.writeFile(file, JSON.stringify(oauth())); },
    fetchImpl: async () => response({ five_hour: { utilization: 4 } })
  });
  assert.equal(result.status, 'ok');
  assert.equal(rereads, 1);
});

test('stored credentials survive independent app process starts without any file write', async t => {
  const options = await fixture(t, oauth());
  const file = path.join(options.home, '.claude', '.credentials.json');
  const before = await fs.readFile(file, 'utf8');
  const script = `const {fetchClaudeUsage}=require(process.argv[1]); fetchClaudeUsage({home:process.argv[2],env:{},platform:'linux',now:Number(process.argv[3]),fetchImpl:async()=>({ok:true,status:200,json:async()=>({five_hour:{utilization:12}})})}).then(r=>console.log(JSON.stringify({status:r.status,windows:r.windows})));`;
  for (let start = 0; start < 2; start++) {
    const result = await promisify(execFile)(process.execPath, ['-e', script, require.resolve('../src/providers/claude.cjs'), options.home, String(NOW)], { windowsHide: true, timeout: 10000 });
    const state = JSON.parse(result.stdout);
    assert.equal(state.status, 'ok');
    assert.equal(state.windows[0].usedPercent, 12);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('a usage body that never finishes is cut off by the same time limit', async t => {
  const options = await fixture(t, oauth());
  const result = await fetchClaudeUsage({ ...options, timeoutMs: 20, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) }) });
  assert.equal(result.status, 'error');
  assert.equal(result.errorKey, 'claude.err.timeout');
});

test('a temporarily unreadable credentials file during renewal is an error, not a logout', async t => {
  const options = await fixture(t, oauth({ expiresAt: NOW - 1 }));
  const result = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, refreshImpl: async () => ({ ok: false, reason: 'invalid_file' }), fetchImpl: () => assert.fail('No request') });
  assert.equal(result.status, 'error');
  const gone = await fetchClaudeUsage({ ...options, credentialRetryDelayImpl: async () => {}, refreshImpl: async () => ({ ok: false, reason: 'no_login' }), fetchImpl: () => assert.fail('No request') });
  assert.equal(gone.status, 'disconnected');
});
