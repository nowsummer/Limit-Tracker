const fs = require('node:fs'); const { iconPng, ico } = require('../src/icons.cjs');
fs.mkdirSync('assets', { recursive: true }); fs.writeFileSync('assets/icon.png', iconPng(256)); fs.writeFileSync('assets/icon.ico', ico());
