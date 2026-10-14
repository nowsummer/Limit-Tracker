'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]); }
for (const file of ['src', 'scripts', 'test'].flatMap(walk).filter(file => /\.(cjs|js)$/.test(file) && !file.endsWith('LimitTracker.js'))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log('JavaScript syntax checks passed.');
