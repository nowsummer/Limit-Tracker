'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  fetchCodexUsage,
  normalizeCodexLimits,
  findCodexExecutable,
  readCodexAccountAndLimits,
} = require('../src/providers/codex.cjs');

const NOW = Date.parse('2026-10-03T17:00:00.000Z');
const FUTURE = Math.floor(NOW / 1000) + 3600;
const regularLimits = () => ({
  rateLimits: {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: FUTURE },
    secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: FUTURE + 604800 },
  },
});

function server({ account = { type: 'chatgpt', planType: 'plus', email: 'private@example.com' },
  limits = regularLimits(), rpcError, stallAt, breakAt, fragment = false, malformed = false,
} = {}) {
  const messages = [];
  let spawnOptions;
  let command;
  let args;
  let child;
  function spawn(executable, arguments_, options) {
    command = executable; args = arguments_; spawnOptions = options;
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('close', null); };
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('close', 0); });
    child.stdin.on('data', chunk => {
      const message = JSON.parse(chunk.toString().trim());
      messages.push(message);
      queueMicrotask(() => {
        if (!message.id) return;
        if (message.method === breakAt) { child.exitCode = 1; child.emit('close', 1); return; }
        if (message.method === stallAt) return;
        const result = message.method === 'initialize' ? { userAgent: 'mock' }
          : message.method === 'account/read' ? { account, requiresOpenaiAuth: true } : limits;
        const response = message.method === 'account/rateLimits/read' && rpcError
          ? { id: message.id, error: rpcError } : { id: message.id, result };
        const line = malformed ? 'unparseable private-token-do-not-return\n' : `${JSON.stringify(response)}\n`;
        if (fragment) {
          child.stdout.write(`${JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } })}\n`);
          for (let i = 0; i < line.length; i += 13) child.stdout.write(line.slice(i, i + 13));
        } else child.stdout.write(line);
      });
    });
    return child;
  }
  return { spawn, messages, get child() { return child; },
    get spawnOptions() { return spawnOptions; }, get command() { return command; }, get args() { return args; } };
}

test('shows subscription percentages and Codex availability one minute after Unix-second reset dates', () => {
  const result = normalizeCodexLimits(regularLimits(), { planType: 'plus' });
  assert.equal(result.plan, 'plus');
  assert.deepEqual(result.windows[0], {
    id: 'codex:primary', label: '5시간', labelKey: 'codex.hours', labelParams: { hours: 5 }, usedPercent: 27, remainingPercent: 73,
    resetsAt: '2026-10-03T18:01:00.000Z', sourceResetsAt: '2026-10-03T18:00:00.000Z', resetAdjustmentMs: 60000, durationMinutes: 300,
  });
  assert.equal(result.windows[1].label, '주간');
  assert.equal(result.windows[1].remainingPercent, 36);
});

test('multi-bucket view supersedes legacy view and distinguishes model buckets', () => {
  const result = normalizeCodexLimits({
    ...regularLimits(),
    rateLimitsByLimitId: {
      spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: FUTURE } },
      codex: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: FUTURE } },
    },
  });
  assert.equal(result.plan, 'pro');
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map(value => [value.id, value.label, value.remainingPercent]), [
    ['codex:primary', '5시간', 91], ['spark:primary', 'Spark · 1시간', 58],
  ]);
});

test('empty multi-bucket response can fall back to legacy view', () => {
  assert.equal(normalizeCodexLimits({ ...regularLimits(), rateLimitsByLimitId: {} }).windows.length, 2);
});

test('unknown usage is omitted, real zero is preserved, percentages stay in range', () => {
  const result = normalizeCodexLimits({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0 }, secondary: { usedPercent: null } },
    high: { primary: { usedPercent: 119 }, secondary: { usedPercent: -4 } },
    invalid: { primary: { usedPercent: Number.NaN }, secondary: { usedPercent: '50' } },
  } });
  assert.deepEqual(result.windows.map(value => value.remainingPercent), [100, 0], 'a negative reading is omitted, not shown as 0% used');
  assert.equal(result.windows[0].resetsAt, null);
  assert.equal(result.windows[0].durationMinutes, null);
});

test('past reset timestamps do not invent replenished quota from stale information', () => {
  const result = normalizeCodexLimits({ rateLimits: {
    primary: { usedPercent: 99, resetsAt: 1730947200, windowDurationMins: 15 },
  } });
  assert.equal(result.windows[0].remainingPercent, 1);
  assert.equal(result.windows[0].resetsAt, '2024-11-07T02:41:00.000Z');
  assert.equal(result.windows[0].sourceResetsAt, '2024-11-07T02:40:00.000Z');
});

test('invalid reset dates and window lengths remain unknown', () => {
  const result = normalizeCodexLimits({ rateLimits: {
    primary: { usedPercent: 22.5, resetsAt: Infinity, windowDurationMins: -10 },
    secondary: { usedPercent: 10, resetsAt: 9e19, windowDurationMins: null },
  } });
  assert.ok(result.windows.every(value => value.resetsAt === null && value.durationMinutes === null));
  assert.equal(result.windows[0].remainingPercent, 77.5);
});

test('locates native executable on PATH without a shell', async () => {
  const checked = [];
  const result = await findCodexExecutable({
    platform: 'win32', home: 'C:\\User', env: { Path: 'C:\\Other;C:\\Tools' },
    access: async value => { checked.push(value); if (value !== 'C:\\Tools\\codex.exe') throw Error('missing'); },
  });
  assert.equal(result, 'C:\\Tools\\codex.exe');
  assert.deepEqual(checked, ['C:\\Other\\codex.exe', 'C:\\Tools\\codex.exe']);
});

test('Explorer launch finds newest installed Codex desktop native binary', async () => {
  const result = await findCodexExecutable({
    platform: 'win32', home: 'C:\\User', env: { LOCALAPPDATA: 'C:\\Local' },
    access: async () => { throw Error('missing'); },
    readdir: async directory => {
      assert.equal(directory, 'C:\\Local\\OpenAI\\Codex\\bin');
      return ['old', 'new'].map(name => ({ name, isDirectory: () => true }));
    },
    stat: async value => ({ isFile: () => true, mtimeMs: value.includes('new') ? 20 : 10 }),
  });
  assert.equal(result, 'C:\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe');
});

test('npm installs are found through the vendored native binary, never the .cmd shim', async () => {
  const existing = new Set(['C:\\Roaming\\npm\\codex.cmd', 'C:\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe']);
  const result = await findCodexExecutable({
    platform: 'win32', home: 'C:\\User', env: { Path: 'C:\\Tools', AppData: 'C:\\Roaming' },
    access: async value => { if (!existing.has(value)) throw Error('missing'); },
    readdir: async () => { throw Error('no desktop install'); },
  });
  if (process.arch !== 'arm64') assert.equal(result, 'C:\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe');
  assert.ok(!result.endsWith('.cmd'));
});

test('a Codex CLI that rejects --listen is retried once with the legacy stdio arguments', async () => {
  const attempts = [];
  const legacy = server();
  const spawn = (executable, args, options) => {
    attempts.push(args);
    if (args.includes('--listen')) {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null; child.kill = () => {};
      queueMicrotask(() => { child.exitCode = 2; child.emit('close', 2); });
      return child;
    }
    return legacy.spawn(executable, args, options);
  };
  const result = await fetchCodexUsage({ now: NOW, executable: 'mock', spawn });
  assert.equal(result.status, 'ok');
  assert.deepEqual(attempts, [['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], ['app-server', '-c', 'analytics.enabled=false']]);
});

test('a Codex CLI without app-server support asks for an update instead of reporting a crash', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.kill = () => {};
    queueMicrotask(() => { child.exitCode = 2; child.emit('close', 2); });
    return child;
  };
  const result = await fetchCodexUsage({ now: NOW, executable: 'mock', spawn });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.errorKey, 'codex.UNSUPPORTED');
});

test('read-only protocol preserves CODEX_HOME and sends no model or auth mutations', async () => {
  const mock = server({ fragment: true });
  const env = { CODEX_HOME: 'C:\\custom-codex', PATH: 'C:\\Tools', SOME_SECRET: 'should-never-be-output' };
  const result = await fetchCodexUsage({ now: NOW, executable: 'C:\\Tools\\codex.exe', spawn: mock.spawn, env });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].remainingPercent, 73);
  assert.equal(result.updatedAt, '2026-10-03T17:00:00.000Z');
  assert.equal(result.source, 'codex-app-server');
  assert.deepEqual(mock.messages.map(message => message.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(mock.messages[2].params, { refreshToken: false });
  assert.equal(mock.spawnOptions.env.CODEX_HOME, env.CODEX_HOME);
  assert.notEqual(mock.spawnOptions.env, env);
  assert.equal(mock.spawnOptions.shell, false);
  assert.equal(mock.spawnOptions.windowsHide, true);
  assert.deepEqual(mock.args, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false']);
  assert.ok(!JSON.stringify(result).includes('private@example.com'));
  assert.ok(!JSON.stringify(result).includes('should-never-be-output'));
  assert.ok(mock.child.stdin.writableEnded);
});

test('missing sign-in reports disconnected without querying usage', async () => {
  const mock = server({ account: null });
  const result = await fetchCodexUsage({ now: NOW, executable: 'mock', spawn: mock.spawn });
  assert.equal(result.status, 'disconnected');
  assert.equal(result.windows.length, 0);
  assert.ok(!mock.messages.some(message => message.method === 'account/rateLimits/read'));
});

test('API-key and Bedrock accounts do not pretend to have subscription quota', async () => {
  for (const type of ['apiKey', 'amazonBedrock']) {
    const mock = server({ account: { type } });
    const result = await fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
    assert.equal(result.status, 'unsupported');
    assert.ok(!mock.messages.some(message => message.method === 'account/rateLimits/read'));
    assert.equal(result.windows.length, 0);
  }
});

test('unsupported CLI method and absent quota report unsupported', async () => {
  for (const options of [{ rpcError: { code: -32601, message: 'Method not found' } }, { limits: {} }]) {
    const mock = server(options);
    const result = await fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.windows.length, 0);
  }
});

test('unauthorized response reports disconnected and never leaks upstream text', async () => {
  const mock = server({ rpcError: { code: -32000, message: 'HTTP 401 token secret-token-123 private@example.com' } });
  const result = await fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
  assert.equal(result.status, 'disconnected');
  assert.ok(!JSON.stringify(result).includes('secret-token-123'));
  assert.ok(!JSON.stringify(result).includes('private@example.com'));
});

test('network failure is an error with no fabricated remaining quota', async () => {
  const mock = server({ rpcError: { code: -32000, message: 'connection failed with secret header' } });
  const result = await fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.windows, []);
  assert.ok(!result.error.includes('secret'));
});

test('command startup failure is classified and contains no raw exception', async () => {
  const result = await fetchCodexUsage({ executable: 'mock', spawn: () => {
    throw Object.assign(Error('private path and credentials'), { code: 'ENOENT' });
  } });
  assert.equal(result.status, 'disconnected');
  assert.ok(!result.error.includes('credentials'));
});

test('bounded timeout terminates a stalled read without a quota fallback', async () => {
  const mock = server({ stallAt: 'account/rateLimits/read' });
  const result = await fetchCodexUsage({ executable: 'mock', spawn: mock.spawn, timeoutMs: 20 });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.windows, []);
  assert.ok(mock.child.stdin.writableEnded);
});

test('unexpected process exit rejects an incomplete read', async () => {
  const mock = server({ breakAt: 'account/read' });
  await assert.rejects(readCodexAccountAndLimits({ executable: 'mock', spawn: mock.spawn }), { code: 'CLI_FAILED' });
});

test('malformed protocol returns a safe failure and closes the subprocess', async () => {
  const mock = server({ malformed: true });
  const result = await fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
  assert.equal(result.status, 'error');
  assert.ok(!result.error.includes('private-token'));
  assert.ok(mock.child.stdin.writableEnded);
});

test('a pre-cancelled request does not launch Codex', async () => {
  const controller = new AbortController();
  controller.abort();
  let launched = false;
  const result = await fetchCodexUsage({ executable: 'mock', signal: controller.signal,
    spawn: () => { launched = true; } });
  assert.equal(result.status, 'error');
  assert.equal(launched, false);
});

test('cancelling a pending usage read closes the subprocess', async () => {
  const mock = server({ stallAt: 'account/rateLimits/read' });
  const controller = new AbortController();
  const pending = fetchCodexUsage({ executable: 'mock', spawn: mock.spawn, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.ok(mock.child.stdin.writableEnded);
});

test('oversized protocol output is rejected before buffering unbounded data', async () => {
  const mock = server({ stallAt: 'initialize' });
  const pending = fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
  await new Promise(resolve => setImmediate(resolve));
  mock.child.stdout.write('x'.repeat(1024 * 1024 + 1));
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.equal(result.windows.length, 0);
  assert.ok(mock.child.stdin.writableEnded);
});

test('server credential requests are rejected without returning credentials', async () => {
  const mock = server({ stallAt: 'account/rateLimits/read' });
  const pending = fetchCodexUsage({ executable: 'mock', spawn: mock.spawn });
  await new Promise(resolve => setImmediate(resolve));
  mock.child.stdout.write(`${JSON.stringify({
    id: 'refresh-1', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' },
  })}\n`);
  const reply = mock.messages.find(message => message.id === 'refresh-1');
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.result, undefined);
  mock.child.stdout.write(`${JSON.stringify({ id: 3, result: regularLimits() })}\n`);
  assert.equal((await pending).status, 'ok');
});
