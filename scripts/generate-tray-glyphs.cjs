'use strict';

// Run with Electron before packaging when the bundled font or tray typography changes.
// Runtime tray rendering uses only the generated alpha masks and Node.js.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, webPreferences: { sandbox: true } });
  const font = fs.readFileSync(path.join(__dirname, '../src/renderer/fonts/PretendardVariable.woff2')).toString('base64');
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8">');
  const masks = await win.webContents.executeJavaScript(`(async () => {
    const font = new FontFace('Tray Pretendard', 'url(data:font/woff2;base64,${font})', { weight: '100 900' });
    document.fonts.add(await font.load());
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const result = {};
    for (const size of [16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64]) {
    canvas.width = canvas.height = size;
    for (let value = 0; value <= 100; value++) {
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      // Rasterize at the actual target pixel size: preserve font hinting and do
      // not downsample a 256px glyph again when composing a tiny Windows icon.
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      const text = String(value);
      let pixels;
      let fontPixels = Math.round(size * (value === 100 ? .38 : value >= 10 ? .52 : .56));
      for (; fontPixels >= 4; fontPixels--) {
        ctx.clearRect(0, 0, size, size);
        ctx.font = '750 ' + fontPixels + 'px "Tray Pretendard"';
        const metrics = ctx.measureText(text);
        // Center the visible ink, not the font's asymmetric ascender/descender box.
        // Integer origins keep each mask aligned with the native Windows pixels.
        const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
        const x = Math.round((size - width) / 2 + metrics.actualBoundingBoxLeft);
        const y = Math.round((size + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
        ctx.fillText(text, x, y);
        pixels = ctx.getImageData(0, 0, size, size).data;
        const maximumRadius = size * 13.5 / 32 - Math.max(.75, size * .02);
        let fits = true;
        for (let py = 0; py < size && fits; py++) for (let px = 0; px < size; px++) {
          if (pixels[(py * size + px) * 4 + 3] > 32 && Math.hypot(px + .5 - size / 2, py + .5 - size / 2) > maximumRadius) { fits = false; break; }
        }
        if (fits) break;
      }
      ctx.restore();
      let alpha = '';
      for (let i = 3; i < pixels.length; i += 4) alpha += String.fromCharCode(pixels[i]);
      result[size + ':' + value] = btoa(alpha);
    }
    }
    return result;
  })()`);
  const glyphs = Object.fromEntries(Object.entries(masks).map(([value, alpha]) => [value, zlib.deflateSync(Buffer.from(alpha, 'base64'), { level: 9 }).toString('base64')]));
  const output = { version: 3, layout: 'centered-circle', sizes: [16,20,24,28,32,36,40,44,48,56,64], font: 'Pretendard Variable', weight: 750, encoding: 'zlib-base64-alpha8', glyphs };
  const destination = path.join(__dirname, '../assets/tray-glyphs.json');
  fs.writeFileSync(destination, JSON.stringify(output));
  console.log(`Wrote ${Object.keys(glyphs).length} tray glyphs (${fs.statSync(destination).size} bytes).`);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
