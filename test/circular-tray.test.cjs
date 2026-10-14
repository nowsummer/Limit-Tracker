'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { trayGaugePng, TRAY_SIZES } = require('../src/icons.cjs');
function pixels(value, dark = true) {
  const file = trayGaugePng(64, value, { dark });
  const chunks = [];
  for (let at = 8; at < file.length;) {
    const size = file.readUInt32BE(at);
    if (file.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(file.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const data = zlib.inflateSync(Buffer.concat(chunks));
  return (x, y) => [...data.subarray(y * 257 + 1 + x * 4, y * 257 + 5 + x * 4)];
}
test('the full circle stays visible at 0 and fills clockwise with used percentage', () => {
  const empty = pixels(0), quarter = pixels(25), full = pixels(100);
  for (const [x,y] of [[32,3],[60,32],[32,60],[3,32]]) {
    assert.deepEqual(empty(x,y), [91,97,108,255]);
    assert.deepEqual(full(x,y), [249,251,255,255]);
  }
  assert.deepEqual(quarter(52,11), [249,251,255,255]);
  assert.deepEqual(quarter(11,11), [91,97,108,255]);
  assert.deepEqual(quarter(32,60), [91,97,108,255]);
  assert.deepEqual(empty(0,0), [0,0,0,0]);
});
test('unknown usage retains a gray ring and a centered dash, distinct from zero', () => {
  const unknown = pixels(null), light = pixels(null, false);
  assert.deepEqual(unknown(32,3), [91,97,108,255]);
  assert.deepEqual(unknown(32,32), [249,251,255,255]);
  assert.deepEqual(light(32,3), [162,167,177,255]);
  assert.deepEqual(light(32,32), [24,31,40,255]);
  assert.ok(!trayGaugePng(16, null).equals(trayGaugePng(16, 0)));
});
test('all exact-size number masks fit inside the circle with space from its stroke', () => {
  const atlas = require('../assets/tray-glyphs.json');
  assert.equal(atlas.layout, 'centered-circle');
  for (const size of TRAY_SIZES) for (let value = 0; value <= 100; value++) {
    const alpha = zlib.inflateSync(Buffer.from(atlas.glyphs[`${size}:${value}`], 'base64'));
    assert.equal(alpha.length, size * size);
    let count = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (alpha[y * size + x] > 32) {
      count++;
      assert.ok(Math.hypot(x + .5 - size/2, y + .5 - size/2) < size * 13.5/32, `${size}px/${value}: digit touches ring`);
    }
    assert.ok(count > 0, `${size}px/${value}: missing number`);
  }
});
