'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPublicReleaseNotes } = require('../scripts/release-notes.cjs');

test('published release notes are short English user-facing descriptions', () => {
  for (const version of ['1.5.3', '1.5.5']) {
    const notes = readPublicReleaseNotes(path.resolve(__dirname, '..'), version);
    assert.equal((notes.match(/^- /gm) || []).length, 5);
    assert.doesNotMatch(notes, /verification-|작업 히스토리|@gmail\.com|C:\\Users/u);
  }
  for (const file of require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'docs', 'public', 'releases'))) {
    // The public support address may appear; any other mail address may not.
    const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs', 'public', 'releases', file), 'utf8').replaceAll('limittracker.app@gmail.com', '');
    assert.doesNotMatch(text, /verification-|작업 히스토리|@gmail\.com|C:\\Users|[\uac00-\ud7a3]/u, file);
  }
});

test('missing public notes stop a release rather than leaking the internal changelog', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-release-notes-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'CHANGELOG.md'), '## 9.9.9\n내부 작업 기록');
  assert.throws(() => readPublicReleaseNotes(project, '9.9.9'), /Add concise English/);
});

test('Korean or excessive notes are rejected before publishing', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-release-notes-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const dir = path.join(project, 'docs', 'public', 'releases');
  fs.mkdirSync(dir, { recursive: true });
  for (const notes of ['- 알림 수정\n- 로그인 수정\n- 화면 수정', '- one\n- two\n- three\n' + 'x'.repeat(1800), '- one']) {
    fs.writeFileSync(path.join(dir, '9.9.9.md'), notes);
    assert.throws(() => readPublicReleaseNotes(project, '9.9.9'), /Public release notes/);
  }
});
