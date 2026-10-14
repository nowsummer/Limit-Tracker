'use strict';
// Brings back the program code of an earlier version as a NEW version, so that
// installed copies "update" to the old behaviour (auto-update never downgrades).
//
//   npm run rollback -- --list            show the saved versions
//   npm run rollback -- v1.5.0            restore v1.5.0's code as the next patch version
//   npm run rollback -- v1.5.0 1.6.1      ... with an explicit new version number
//
// Files outside the restored paths are left as they are. Nothing is deleted:
// the current code stays in git history.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};
// build/ holds the installer script, which electron-builder picks up by itself.
const RESTORED = ['src', 'assets', 'build', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json'];
const args = process.argv.slice(2);
const positional = args.filter(arg => !arg.startsWith('--'));
const tags = git('tag', '--list', 'v*', '--sort=-v:refname').split(/\r?\n/).filter(Boolean);
if (!positional.length || args.includes('--list')) {
  for (const tag of tags) console.log(`${tag}\t${git('log', '-1', '--format=%ad %s', '--date=short', tag)}`);
  process.exit(0);
}
const tag = positional[0].startsWith('v') ? positional[0] : `v${positional[0]}`;
if (!tags.includes(tag)) throw new Error(`Unknown version ${tag}. Use --list to see saved versions.`);
// Code from before 1.5.0 has no updater: copies that receive it could never
// update again. Those builds stay available locally in dist/.
const [major, minor] = tag.slice(1).split('.').map(Number);
if ((major < 1 || (major === 1 && minor < 5)) && !args.includes('--allow-no-updater')) throw new Error(`${tag} predates automatic updates. Use its archived EXE in dist/ for this PC instead, or pass --allow-no-updater if you really mean to ship it.`);
if (git('status', '--porcelain')) throw new Error('Commit or discard the current changes first.');
const current = require('../package.json').version.split('.').map(Number);
const next = positional[1] || `${current[0]}.${current[1]}.${current[2] + 1}`;
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`Invalid version ${next}`);
// Copies only update upward: the re-release must be newer than anything shipped.
const { compareVersions } = require('../src/updater.cjs');
const newest = [current.join('.'), ...tags.map(saved => saved.slice(1))].filter(value => /^\d+\.\d+\.\d+$/.test(value)).sort((a, b) => compareVersions(b, a))[0];
if (!(compareVersions(next, newest) > 0)) throw new Error(`The re-release version must be higher than ${newest}.`);
for (const item of RESTORED) {
  const exists = spawnSync('git', ['cat-file', '-e', `${tag}:${item}`], { cwd: project }).status === 0;
  // Restore exactly: what the tag does not have is removed, not kept from now.
  git('rm', '-r', '-q', '--ignore-unmatch', '--', item);
  if (exists) git('checkout', tag, '--', item);
}
for (const file of ['package.json', 'package-lock.json']) {
  const full = path.join(project, file);
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  data.version = next;
  if (data.packages?.['']) data.packages[''].version = next;
  fs.writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
}
git('add', '-A');
git('commit', '-q', '-m', `되돌리기: ${tag} 코드를 ${next}로 다시 배포 준비`);
console.log(`Restored ${tag} as ${next}. Next: npm test, npm run dist, node scripts/verify-package.cjs, npm run release.`);
