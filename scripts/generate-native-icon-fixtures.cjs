'use strict';
// Writes the tray icon fixtures that verify-icon-pixels.ps1 compares against
// Windows' own LoadImage output. Kept as a file so PowerShell 5.1 quoting cannot break it.
const fs = require('node:fs');
const path = require('node:path');
const icons = require('../src/icons.cjs');
const directory = path.resolve(__dirname, '..', 'artifacts', 'native-icons');
fs.mkdirSync(directory, { recursive: true });
for (const value of [0, 7, 87, 100]) {
  fs.writeFileSync(path.join(directory, `${value}.ico`), icons.trayGaugeIco(value));
  for (const size of icons.TRAY_SIZES) fs.writeFileSync(path.join(directory, `${value}-${size}.png`), icons.trayGaugePng(size, value));
}
console.log(`fixtures written to ${directory}`);
