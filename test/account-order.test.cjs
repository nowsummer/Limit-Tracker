'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reorderAccounts } = require('../src/accounts.cjs');
const accounts = () => [
  { id: 'claude', providerId: 'claude', label: '개인', visible: true, mode: 'default' },
  { id: 'codex-work', providerId: 'codex', label: '업무', visible: false, mode: 'isolated' },
  { id: 'codex-personal', providerId: 'codex', label: '개인', visible: true, mode: 'isolated' },
];

test('account reorder accepts a full permutation and preserves all account data and original list', () => {
  const original = accounts(); const before = structuredClone(original);
  const reordered = reorderAccounts(original, ['codex-personal', 'claude', 'codex-work']);
  assert.deepEqual(reordered.map(a => a.id), ['codex-personal', 'claude', 'codex-work']);
  assert.equal(reordered[0], original[2]); assert.equal(reordered[1], original[0]); assert.equal(reordered[2], original[1]);
  assert.deepEqual(original, before); assert.equal(reordered[2].visible, false);
});

test('account reorder rejects omissions, duplicates, strangers and non-array/non-string IDs', () => {
  for (const ids of [null, {}, 'claude', [], ['claude', 'codex-work'], ['claude', 'codex-work', 'codex-work'], ['claude', 'codex-work', 'stranger'], ['claude', 'codex-work', 3], ['claude', 'codex-work', null]]) assert.throws(() => reorderAccounts(accounts(), ids));
  assert.deepEqual(reorderAccounts([], []), []);
  assert.throws(() => reorderAccounts([], ['stranger']));
});

test('sparse reorder arrays cannot silently remove accounts through skipped validation', () => {
  assert.throws(() => reorderAccounts([accounts()[0]], Array(1)));
  const ids = ['claude', 'codex-work', 'codex-personal']; delete ids[1];
  assert.throws(() => reorderAccounts(accounts(), ids));
});
