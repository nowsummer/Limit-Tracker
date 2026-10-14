'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

// UUID v5 namespace owned by Limit Tracker. No credentials or labels enter it.
const NAMESPACE = Buffer.from('8424f031213f44bbbf8a611684597e22', 'hex');
function trayGuid({ appId, executable, userData, accountId = null }) {
  if (typeof appId !== 'string' || !appId || (accountId !== null && (typeof accountId !== 'string' || !accountId))) throw new TypeError('Invalid tray identity');
  const normalize = value => {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value)) throw new TypeError('Tray identity requires an absolute Windows path');
    return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  };
  // Unsigned Windows executables bind GUIDs to their real executable path.
  // Including it permits relocated/portable apps to create valid new icons.
  const name = JSON.stringify([appId, normalize(executable), normalize(userData), accountId === null ? ['app'] : ['account', accountId]]);
  const bytes = crypto.createHash('sha1').update(NAMESPACE).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
module.exports = { trayGuid };
