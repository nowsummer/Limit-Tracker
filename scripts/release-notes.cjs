'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readPublicReleaseNotes(project, version) {
  const file = path.join(project, 'docs', 'public', 'releases', `${version}.md`);
  if (!fs.existsSync(file)) throw new Error(`Add concise English release notes first: docs/public/releases/${version}.md`);
  const notes = fs.readFileSync(file, 'utf8').trim();
  const bullets = notes.match(/^- /gm) || [];
  if (/[\uac00-\ud7a3]/u.test(notes) || notes.length > 1800 || bullets.length < 3 || bullets.length > 5) {
    throw new Error('Public release notes must be English and contain 3–5 short bullets (at most 1800 characters).');
  }
  return notes;
}

module.exports = { readPublicReleaseNotes };
