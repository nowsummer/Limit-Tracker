'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const login = require('../src/login.cjs');
const { loginCommand, launchLoginProcess } = login;

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-login-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function fakeSpawn(onSpawn) { return (...args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => { child.unreferenced = true; }; process.nextTick(() => { onSpawn?.(...args); child.emit('spawn'); child.stdout.emit('data', Buffer.from('LIMIT_TRACKER_LOGIN_PID:12345\r\n')); }); return child; }; }

test('PowerShell command quotes spaces, Unicode, apostrophes and literal shell metacharacters', () => {
  const exe = path.resolve("Owner's tools", '$(should-stay-literal)', 'claude.exe');
  const cmd = loginCommand(exe, 'claude');
  assert.ok(cmd.includes(`& '${exe.replace(/'/g, "''")}' auth login`));
  assert.equal(loginCommand(path.resolve('codex.exe'), 'codex').includes(' login;'), true);
  for (const invalid of ['relative.exe', path.resolve('a') + '\n', path.resolve('a') + '\0']) assert.throws(() => loginCommand(invalid, 'claude'));
  assert.throws(() => loginCommand(path.resolve('grok.exe'), 'grok'));
  assert.throws(() => loginCommand(path.resolve('gemini.cmd'), 'gemini'));
});

test('Gemini has no sign-in: nothing is located, downloaded, started or created on disk', t => {
  assert.deepEqual(Object.keys(login).sort(), ['launchLoginProcess', 'loginCommand']);
  const userData = fixture(t);
  for (const mode of ['default', 'isolated']) {
    let spawned = false;
    assert.throws(() => launchLoginProcess({ executable: path.join(userData, 'gemini.cmd'), userData, account: { id: 'google-one', providerId: 'gemini', mode }, inherited: {}, spawnImpl: () => { spawned = true; } }), /로그인을 지원하지 않습니다/);
    assert.equal(spawned, false);
  }
  assert.deepEqual(fs.readdirSync(userData), []);
});

test('launcher acknowledges the real visible console PID and preserves interactive target handles', async t => {
  const userData = fixture(t); const executable = path.join(userData, "한국어's cli.exe");
  let launched;
  const child = await launchLoginProcess({ executable, userData, account: { id: 'claude', providerId: 'claude', mode: 'default' }, inherited: { SystemRoot: 'C:\\Windows', PATH: 'tools' }, spawnImpl: fakeSpawn((shell, args, options) => { launched = { shell, args, options }; }) });
  assert.equal(child.unreferenced, true);
  assert.equal(child.loginPid, 12345);
  assert.equal(launched.options.windowsHide, true); assert.equal(launched.options.detached, false); assert.equal(launched.options.shell, false);
  assert.equal(launched.options.cwd, userData);
  assert.equal(launched.options.timeout, undefined);
  const decoded = Buffer.from(launched.args.at(-1), 'base64').toString('utf16le');
  const encodedTarget = Buffer.from(loginCommand(executable, 'claude'), 'utf16le').toString('base64');
  assert.ok(decoded.includes(encodedTarget));
  assert.ok(decoded.includes('Start-Process')); assert.ok(decoded.includes('-WindowStyle Normal -PassThru'));
  assert.equal(decoded.includes('-NoNewWindow'), false); assert.equal(decoded.includes('-RedirectStandard'), false);
});

test('OS spawn failures return a readable message without private process error output', async t => {
  const userData = fixture(t);
  const spawnImpl = () => { const child = new EventEmitter(); process.nextTick(() => child.emit('error', new Error('private token command contents'))); return child; };
  await assert.rejects(launchLoginProcess({ executable: path.join(userData, 'claude.exe'), userData, account: { id: 'claude', providerId: 'claude', mode: 'default' }, spawnImpl }), error => /로그인 창/.test(error.message) && !error.message.includes('private'));
});

test('bootstrap spawn alone is not a success and target errors are readable', async t => {
  const userData = fixture(t); let child;
  const spawnImpl = () => { child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {}; return child; };
  const promise = launchLoginProcess({ executable: path.join(userData, 'claude.exe'), userData, account: { id: 'claude', providerId: 'claude', mode: 'default' }, spawnImpl });
  let settled = false; promise.then(() => { settled = true; }, () => { settled = true; });
  child.emit('spawn'); await Promise.resolve(); assert.equal(settled, false);
  child.stdout.emit('data', Buffer.from('LIMIT_TRACKER_LOGIN_ERROR\n'));
  await assert.rejects(promise, /로그인 창을 시작하지 못했습니다/);
});
