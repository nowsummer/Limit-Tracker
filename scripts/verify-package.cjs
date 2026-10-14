'use strict';
// Confirms that the built app.asar holds exactly the current sources, and that
// the distributable installer was produced after it. Run after `npm run dist`.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const at = (...parts) => path.join(project, ...parts);
const version = require('../package.json').version;
const archive = at('dist', 'win-unpacked', 'resources', 'app.asar');
const SOURCE_ROOTS = ['src', 'assets', path.join('docs', 'licenses')];
function walk(folder) { return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]); }
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const files = SOURCE_ROOTS.flatMap(root => walk(at(root))).map(file => path.relative(project, file));
const hashes = {};
for (const file of files) {
  const source = fs.readFileSync(at(file));
  const packaged = asar.extractFile(archive, file);
  assert.ok(source.equals(packaged), `Packaged file differs: ${file}`);
  hashes[file.replaceAll('\\', '/')] = crypto.createHash('sha256').update(source).digest('hex');
}
// Nothing else from the project (internal notes, tests, history) may ship.
const listed = asar.listPackage(archive).map(entry => entry.replace(/^[\\/]/, '').replaceAll('\\', '/'));
const unexpected = listed.filter(entry => {
  const top = entry.split('/')[0];
  if (['src', 'assets', 'node_modules', 'package.json'].includes(top)) return false;
  if (entry === 'docs' || entry.startsWith('docs/licenses')) return false;
  return true;
});
assert.deepEqual(unexpected, [], `Unexpected packaged entries: ${unexpected.join(', ')}`);
assert.ok(listed.some(entry => entry.startsWith('node_modules/electron-updater/')), 'electron-updater must be bundled');
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const updateConfig = fs.readFileSync(at('dist', 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
assert.match(updateConfig, /provider: github/); assert.match(updateConfig, /owner: nowsummer/); assert.match(updateConfig, /repo: Limit-Tracker/);
assert.doesNotMatch(updateConfig, /token/i, 'no credential may be embedded in the update config');

const asarTime = fs.statSync(archive).mtimeMs;
const outputs = {};
for (const [name, file] of [['installer', `Limit-Tracker-${version}.exe`]]) {
  const full = at('dist', file);
  const stat = fs.statSync(full);
  assert.ok(stat.mtimeMs >= asarTime - 1000, `${file} is older than the verified app.asar`);
  outputs[name] = { file, bytes: stat.size, sha256: digest(full) };
}
const latest = fs.readFileSync(at('dist', 'latest.yml'), 'utf8');
assert.match(latest, new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm'));
assert.match(latest, new RegExp(`path: Limit-Tracker-${version.replace(/\./g, '\\.')}\\.exe`));
// The verified build must come from committed code, so its tag restores it exactly.
const git = (...args) => { const run = spawnSync('git', args, { cwd: project, encoding: 'utf8' }); assert.equal(run.status, 0, `git ${args[0]} failed`); return run.stdout.trim(); };
const CODE_PATHS = ['src', 'assets', 'build', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json'];
assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...CODE_PATHS), '', 'Commit the sources before verifying a release build.');
const gitCommit = git('rev-parse', 'HEAD');
const result = { version, gitCommit, sourceFilesMatched: files.length, sourceSha256: hashes, packagedEntries: listed.length, outputs, verifiedAt: new Date().toISOString() };
fs.mkdirSync(at('artifacts'), { recursive: true });
fs.writeFileSync(at('artifacts', 'package-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ version, sourceFilesMatched: files.length, packagedEntries: listed.length, outputs }, null, 2));
