'use strict';
// Publishes the verified build of the current version as a GitHub Release, so
// every installed copy updates itself.
//
//   npm run release            publish (asks for GitHub sign-in only if needed)
//   npm run release -- --login sign in to GitHub on this PC, nothing else
//   npm run release -- --dry   check everything without uploading
//
// The GitHub sign-in is handled by Git Credential Manager (bundled with Git for
// Windows) and stored in this PC's Windows Credential Manager. No token is ever
// written to the project, the build, or a log.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { readPublicReleaseNotes } = require('./release-notes.cjs');
const project = path.resolve(__dirname, '..');
const at = (...parts) => path.join(project, ...parts);
const pkg = require('../package.json');
const { owner, repo } = pkg.build.publish[0];
const version = pkg.version;
const args = new Set(process.argv.slice(2));
const API = `https://api.github.com/repos/${owner}/${repo}`;

function credential(action, input, interactive) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: interactive ? '1' : '0', GCM_INTERACTIVE: interactive ? 'auto' : 'never' };
  const result = spawnSync('git', ['credential', action], { input, env, encoding: 'utf8', windowsHide: !interactive, timeout: interactive ? 5 * 60000 : 20000 });
  if (result.status !== 0) return null;
  return result.stdout;
}
function getToken(interactive) {
  const output = credential('fill', 'protocol=https\nhost=github.com\n\n', interactive);
  const fields = Object.fromEntries(String(output || '').split(/\r?\n/).filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return fields.password ? { token: fields.password, raw: output } : null;
}
async function github(token, method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'limit-tracker-release', ...headers }, body });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) { const error = new Error(`GitHub ${method} ${new URL(url).pathname} → ${response.status} ${data?.message || ''}`.trim()); error.status = response.status; throw error; }
  return data;
}
function releaseNotes() {
  return readPublicReleaseNotes(project, version);
}

function bridgeYaml(file) {
  const bytes = fs.readFileSync(file);
  return [`version: ${version}`, `path: ${path.basename(file)}`, `sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}`, `size: ${bytes.length}`, `releaseDate: '${new Date().toISOString()}'`, ''].join('\n');
}

(async () => {
  if (args.has('--login')) {
    const login = getToken(true);
    if (!login) throw new Error('GitHub sign-in was cancelled.');
    const user = await github(login.token, 'GET', 'https://api.github.com/user');
    credential('approve', login.raw, false);
    console.log(`GitHub sign-in saved on this PC for ${user.login}.`);
    return;
  }
  const publicNotes = releaseNotes();
  const check = JSON.parse(fs.readFileSync(at('artifacts', 'package-verification.json'), 'utf8'));
  assert.equal(check.version, version, 'Run npm run dist and scripts/verify-package.cjs for this version first.');
  const installer = at('dist', check.outputs.installer.file);
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest(installer), check.outputs.installer.sha256, 'Installer changed since verification');
  // The release must be the verified, committed code: its tag is what rollback restores.
  const git = (...gitArgs) => { const run = spawnSync('git', gitArgs, { cwd: project, encoding: 'utf8' }); assert.equal(run.status, 0, `git ${gitArgs[0]} failed`); return run.stdout.trim(); };
  const CODE_PATHS = ['src', 'assets', 'build', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json'];
  assert.match(check.gitCommit || '', /^[0-9a-f]{40,64}$/, 'Run verify-package again (no commit recorded).');
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...CODE_PATHS), '', 'Commit the sources before releasing.');
  assert.equal(git('rev-parse', 'HEAD'), check.gitCommit, 'HEAD differs from the verified build; run verify-package again.');
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
  const sourceFiles = ['src', 'assets', path.join('docs', 'licenses')].flatMap(root => walk(at(root))).map(file => path.relative(project, file).split(path.sep).join('/')).sort();
  assert.deepEqual(sourceFiles, Object.keys(check.sourceSha256).sort(), 'Source files changed since verification');
  for (const [file, hash] of Object.entries(check.sourceSha256)) assert.equal(digest(at(file)), hash, `Source changed since verification: ${file}`);
  const tag = `v${version}`;
  const localTag = git('tag', '--list', tag);
  if (localTag) assert.equal(git('rev-list', '-n', '1', tag), check.gitCommit, `${tag} points to different code`);
  // 1.5.0's single-file copies ('휴대용') look only for portable.yml. Point it at
  // the installer: they verify it, swap it in and start it with --updated, which
  // installs the program and moves them to the one-file setup.
  fs.writeFileSync(at('dist', 'portable.yml'), bridgeYaml(installer));
  const assets = [installer, `${installer}.blockmap`, at('dist', 'latest.yml'), at('dist', 'portable.yml')];
  for (const file of assets) assert.ok(fs.existsSync(file), `Missing ${path.basename(file)}`);
  if (args.has('--dry')) { console.log(JSON.stringify({ version, owner, repo, assets: assets.map(file => path.basename(file)), notes: publicNotes }, null, 2)); return; }

  const login = getToken(!args.has('--no-login'));
  if (!login) throw new Error('No GitHub sign-in on this PC. Run: npm run release -- --login');
  const { token } = login;
  const repository = await github(token, 'GET', API).catch(error => { throw error.status === 404 ? new Error(`Repository ${owner}/${repo} was not found. Create it on GitHub as a Public repository first.`) : error; });
  if (repository.private) throw new Error(`${owner}/${repo} is private. Change it to Public (Settings → General → Danger Zone) so other PCs can download updates.`);
  credential('approve', login.raw, false);
  const existing = await github(token, 'GET', `${API}/releases/tags/${encodeURIComponent(tag)}`).catch(error => { if (error.status === 404) return null; throw error; });
  if (existing && !existing.draft) throw new Error(`${tag} is already published. Bump the version before releasing again.`);
  // A draft first, so nobody downloads a release whose files are still uploading.
  const release = existing || await github(token, 'POST', `${API}/releases`, JSON.stringify({ tag_name: tag, target_commitish: repository.default_branch, name: `Limit Tracker ${version}`, body: publicNotes, draft: true, prerelease: false }), { 'Content-Type': 'application/json' });
  const uploaded = new Set((release.assets || []).map(asset => asset.name));
  for (const file of assets) {
    const name = path.basename(file);
    if (uploaded.has(name)) { const old = release.assets.find(asset => asset.name === name); await github(token, 'DELETE', `${API}/releases/assets/${old.id}`); }
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(name)}`);
    await github(token, 'POST', uploadUrl, fs.readFileSync(file), { 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' });
    console.log(`uploaded ${name}`);
  }
  const published = await github(token, 'PATCH', `${API}/releases/${release.id}`, JSON.stringify({ draft: false, make_latest: 'true' }), { 'Content-Type': 'application/json' });
  if (!localTag) git('tag', '-a', '-m', `Limit Tracker ${version}`, tag, check.gitCommit);
  const record = { version, tag, url: published.html_url, assets: assets.map(file => path.basename(file)), publishedAt: published.published_at };
  fs.mkdirSync(at('artifacts'), { recursive: true });
  fs.writeFileSync(at('artifacts', `release-${version}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
})().catch(error => { console.error(`release failed: ${error.message}`); process.exit(1); });
