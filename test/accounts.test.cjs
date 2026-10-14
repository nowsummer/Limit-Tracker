'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { defaultAccounts, validateAccount, validateAccounts, prepareAccount, accountEnvironment, manualUsage, visibleProviders } = require('../src/accounts.cjs');

const base = (overrides = {}) => ({ id: 'test-account', providerId: 'claude', label: '개인 계정', mode: 'isolated', visible: true, ...overrides });

test('default accounts are distinct fresh records and only one PC-login connection per service is allowed', () => {
  const first = defaultAccounts(); const second = defaultAccounts();
  first[0].label = 'changed'; assert.equal(second[0].label, '기본 계정');
  assert.throws(() => validateAccounts([...second, base({ id: 'extra', providerId: 'claude', mode: 'default' })]), /하나만/);
  assert.equal(validateAccounts([...second, base()]).length, 3);
});

test('account IDs cannot escape isolated folders or collide, and unknown modes are rejected', () => {
  for (const id of ['../escape', 'a/b', 'A', 'a\\b', '', 'a'.repeat(65)]) assert.throws(() => validateAccount(base({ id })));
  assert.throws(() => validateAccounts([base(), base()]));
  assert.throws(() => validateAccount(base({ providerId: 'grok', mode: 'isolated' })));
  assert.throws(() => validateAccount(base({ providerId: 'gemini', mode: 'isolated' })));
  assert.throws(() => validateAccount(base({ providerId: 'unlisted' })));
  assert.throws(() => accountEnvironment(base({ id: '..' }), 'C:\\tracker'));
});

test('preparing and editing accounts preserves ID/provider/mode while allowing visible settings and names', () => {
  const created = prepareAccount({ providerId: 'codex', label: '업무', mode: 'isolated' });
  assert.match(created.account.id, /^[a-z0-9-]+$/);
  const updated = prepareAccount({ id: created.account.id, label: '회사', visible: false }, created.accounts);
  assert.equal(updated.account.providerId, 'codex'); assert.equal(updated.account.visible, false);
  assert.throws(() => prepareAccount({ id: created.account.id, providerId: 'claude' }, created.accounts));
  assert.throws(() => prepareAccount({ id: created.account.id, mode: 'default' }, created.accounts));
  assert.throws(() => prepareAccount({ id: 'missing', label: '없음' }, created.accounts));
});

test('isolated accounts preserve general environment but separate credentials without mutating parent', () => {
  const userData = path.resolve('test-app-data');
  const inherited = { PATH: 'cli-bin', CLAUDE_CONFIG_DIR: 'default-claude', CODEX_HOME: 'default-codex', ANTHROPIC_API_KEY: 'private-key', ANTHROPIC_AUTH_TOKEN: 'private-token', OPENAI_API_KEY: 'private-key', CODEX_API_KEY: 'private-key' };
  for (const providerId of ['claude', 'codex']) {
    const a = accountEnvironment(base({ providerId, id: 'a' }), userData, inherited);
    const b = accountEnvironment(base({ providerId, id: 'b' }), userData, inherited);
    const variable = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }[providerId];
    assert.notEqual(a[variable], b[variable]); assert.ok(a[variable].startsWith(path.join(userData, 'accounts', 'a')));
    assert.equal(a.PATH, inherited.PATH);
    for (const key of { claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'] }[providerId]) assert.equal(a[key], undefined);
  }
  assert.equal(inherited.CLAUDE_CONFIG_DIR, 'default-claude');
  assert.deepEqual(accountEnvironment(base({ mode: 'default' }), userData, inherited), inherited);
});

test('isolated Claude login cannot fall back to another account via inherited OAuth environment', () => {
  const inherited = { CLAUDE_CODE_OAUTH_TOKEN: 'other-claude-account' };
  const claude = accountEnvironment(base(), path.resolve('test-app-data'), inherited);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('manual entries validate ratio/reset and retain manual provenance and timestamp', () => {
  const prepared = prepareAccount({ providerId: 'grok', mode: 'manual', label: 'Grok 개인', manualWindows: [{ label: '주간', remainingPercent: 0, resetsAt: '2026-10-06T09:00:00+09:00' }] });
  const usage = manualUsage(prepared.account);
  assert.equal(usage.manual, true); assert.equal(usage.status, 'ok'); assert.ok(usage.updatedAt);
  assert.equal(usage.windows[0].remainingPercent, 0); assert.equal(usage.windows[0].usedPercent, 100);
  assert.equal(usage.windows[0].resetsAt, '2026-10-06T00:00:00.000Z');
  for (const value of [-1, 101, NaN, Infinity, '50']) assert.throws(() => validateAccount(base({ mode: 'manual', manualWindows: [{ remainingPercent: value }] })));
  assert.throws(() => validateAccount(base({ mode: 'manual', manualWindows: [{ remainingPercent: 50, resetsAt: 'tomorrow' }] })));
  const empty = validateAccount(base({ mode: 'manual' })); assert.equal(manualUsage(empty).status, 'unsupported');
});

test('main/tray selection admits only configured visible account IDs, including same-provider profiles', () => {
  const providers = [{ id: 'a' }, { id: 'b' }, { id: 'c', visible: false }, { id: 'removed' }];
  assert.deepEqual(visibleProviders({ providers, settings: { accounts: [{ id: 'a', visible: true }, { id: 'b', visible: false }, { id: 'c', visible: true }] } }).map(p => p.id), ['a']);
  assert.deepEqual(visibleProviders({ providers, settings: { accounts: [] } }), []);
});
