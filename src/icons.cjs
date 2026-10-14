'use strict';
const zlib = require('node:zlib');
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); }
function png(width, height, rgba) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
function raster(size, sample) {
  const bytes = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const totals = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const color = sample((x + (sx + 0.5) / 4) * 64 / size, (y + (sy + 0.5) / 4) * 64 / size);
      for (let c = 0; c < 3; c++) totals[c] += color[c] * color[3] / 255;
      totals[3] += color[3];
    }
    const offset = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) bytes[offset + c] = totals[3] ? Math.round(totals[c] * 255 / totals[3]) : 0;
    bytes[offset + 3] = Math.round(totals[3] / 16);
  }
  return png(size, size, bytes);
}
function inside(x, y, left, top, width, height, radius) { return Math.hypot(Math.max(Math.abs(x - left - width / 2) - (width / 2 - radius), 0), Math.max(Math.abs(y - top - height / 2) - (height / 2 - radius), 0)) <= radius; }
/** The two-bar mark on the blue tile, in the tile's 64-unit coordinates (tile spans 2..62). */
function markColor(x, y, edge = 0) {
  if (inside(x, y, 16, 31, 12, 20, 6)) return [202, 223, 255, 255];
  if (inside(x, y, 36, 14, 12, 37, 6)) return [250, 253, 255, 255];
  const t = Math.min(1, Math.max(0, (y - 2) / 60));
  const glow = Math.max(0, 1 - Math.hypot(x - 16, y - 4) / 60);
  return [Math.round(30 - t * 11 + glow * 15 + edge), Math.round(117 - t * 49 + glow * 20 + edge), Math.round(241 - t * 52 + glow * 12 + edge), 255];
}
function iconPng(size = 64) {
  // A crisp, full-size rounded tile and the same two-bar mark at every size.
  return raster(size, (x, y) => inside(x, y, 2, 2, 60, 60, 15) ? markColor(x, y, inside(x, y, 2.7, 2.7, 58.6, 58.6, 14.4) ? 0 : 15) : [0, 0, 0, 0]);
}
/**
 * iPhone home screen icon. iOS rounds the corners itself and paints transparent
 * pixels black, so this is the same tile filling an opaque square edge to edge.
 */
function touchIconPng(size = 180) {
  return raster(size, (x, y) => markColor(2 + x * 60 / 64, 2 + y * 60 / 64));
}
let glyphAtlas;
const glyphCache = new Map();
const TRAY_SIZES = [16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64];
function trayGlyph(size, value) {
  const key = `${size}:${value}`;
  if (glyphCache.has(key)) return glyphCache.get(key);
  glyphAtlas ||= require('../assets/tray-glyphs.json');
  const glyph = zlib.inflateSync(Buffer.from(glyphAtlas.glyphs[key], 'base64'));
  if (glyphCache.size >= 44) glyphCache.delete(glyphCache.keys().next().value);
  glyphCache.set(key, glyph);
  return glyph;
}
function trayGaugePng(size, value, { dark = true } = {}) {
  if (!TRAY_SIZES.includes(size)) throw new Error('Unsupported tray pixel size');
  const valid = Number.isFinite(value) && value >= 0 && value <= 100;
  const percent = valid ? Math.round(value) : null;
  const glyph = valid ? trayGlyph(size, percent) : null;
  const ink = dark ? [249, 251, 255] : [24, 31, 40];
  const accent = ink;
  const track = dark ? [91, 97, 108] : [162, 167, 177];
  const radius = 14.5, halfStroke = 1;
  const sweep = valid ? percent / 100 * Math.PI * 2 : 0;
  const endX = Math.sin(sweep) * radius, endY = -Math.cos(sweep) * radius;
  // A complete quiet gray ring, filled clockwise from twelve o'clock. Only
  // the circle is supersampled; the centered digits keep their exact-size mask.
  const bytes = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let arcAlpha = 0, filled = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const x = (px + (sx + .5) / 4) * 32 / size, y = (py + (sy + .5) / 4) * 32 / size;
    const dx = x - 16, dy = y - 16;
    if (Math.abs(Math.hypot(dx, dy) - radius) <= halfStroke) {
      const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
      arcAlpha++;
      const onCap = Math.hypot(dx, dy + radius) <= halfStroke || Math.hypot(dx - endX, dy - endY) <= halfStroke;
      if (valid && percent > 0 && (angle <= sweep || onCap)) filled++;
    }
    }
    const offset = (py * size + px) * 4;
    const dashHeight = Math.max(1, Math.round(size / 16));
    const glyphAlpha = glyph ? glyph[py * size + px] : (py >= Math.floor((size - dashHeight) / 2) && py < Math.floor((size - dashHeight) / 2) + dashHeight && px >= Math.round(size * .34) && px < Math.round(size * .66) ? 255 : 0);
    const alpha = arcAlpha / 16;
    const g = glyphAlpha / 255;
    const composite = g + alpha * (1 - g);
    for (let c = 0; c < 3; c++) {
      const arc = arcAlpha ? (accent[c] * filled + track[c] * (arcAlpha - filled)) / arcAlpha : 0;
      bytes[offset + c] = composite ? Math.round((ink[c] * g + arc * alpha * (1 - g)) / composite) : 0;
    }
    bytes[offset + 3] = Math.round(composite * 255);
  }
  return png(size, size, bytes);
}
function encodeIco(sizes, pictures) {
  const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4); let offset = header.length;
  sizes.forEach((size, i) => { const entry = 6 + i * 16; header[entry] = size === 256 ? 0 : size; header[entry + 1] = header[entry]; header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(pictures[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += pictures[i].length; });
  return Buffer.concat([header, ...pictures]);
}
function ico() { const sizes = [...TRAY_SIZES, 128, 256]; return encodeIco(sizes, sizes.map(iconPng)); }
function trayGaugeIco(value, options) { return encodeIco(TRAY_SIZES, TRAY_SIZES.map(size => trayGaugePng(size, value, options))); }
module.exports = { iconPng, touchIconPng, trayGaugePng, trayGaugeIco, ico, TRAY_SIZES };
