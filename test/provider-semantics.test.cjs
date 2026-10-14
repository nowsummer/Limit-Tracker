'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchClaudeUsage } = require('../src/providers/claude.cjs');
const { normalizeCodexLimits } = require('../src/providers/codex.cjs');

test('all automatic providers keep used and remaining orientation consistent at zero, partial and full usage', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'limit-semantics-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.claude'));
  const now = Date.parse('2026-10-04T09:00:00Z');
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-only-token', expiresAt: now + 3600000 } }));
  for (const used of [0, 12.5, 80, 100]) {
    const claude = await fetchClaudeUsage({ home, env: {}, platform: 'linux', wslScan: false, now, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: used, resets_at: '2026-10-04T12:00:00Z' } }) }) });
    const codex = normalizeCodexLimits({ rateLimits: { primary: { usedPercent: used, resetsAt: now / 1000 + 3600 } } });
    for (const [name, result] of [['Claude', claude], ['Codex', codex]]) {
      assert.equal(result.windows.length, 1, name);
      assert.equal(result.windows[0].usedPercent, used, `${name}: display this value as used`);
      assert.equal(result.windows[0].remainingPercent, 100 - used, name);
      assert.equal(result.windows[0].usedPercent + result.windows[0].remainingPercent, 100, name);
    }
  }
});
