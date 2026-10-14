'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MobileServer, publicSnapshot, privateIPv4 } = require('../src/mobile-server.cjs');

const root = path.resolve(__dirname, '..');
const provider = (id, providerId = 'codex') => ({
  id, providerId, name: providerId, accountLabel: `계정 ${id}`, status: 'ok', plan: 'Plus',
  windows: [{ id: 'primary', label: '5시간', remainingPercent: 74, usedPercent: 26, resetsAt: '2099-01-01T00:00:00Z', durationMinutes: 300, credential: 'not-public' }],
  updatedAt: '2026-10-04T01:00:00Z', credential: 'not-public', env: { SECRET: 'not-public' }
});

test('mobile snapshot publishes only selected accounts, with provider identity and manual provenance', () => {
  const shown = { ...provider('work', 'grok'), mode: 'manual', manual: true };
  const snapshot = publicSnapshot({ providers: [provider('personal'), shown, provider('removed')], settings: { accounts: [{ id: 'personal', visible: false }, { id: 'work', visible: true }] } });
  assert.deepEqual(snapshot.providers.map(p => p.id), ['work']);
  assert.equal(snapshot.providers[0].providerId, 'grok');
  assert.equal(snapshot.providers[0].accountLabel, '계정 work');
  assert.equal(snapshot.providers[0].manual, true);
  assert.equal(snapshot.providers[0].mode, 'manual');
  assert.equal(snapshot.settings, undefined);
  assert.ok(!JSON.stringify(snapshot).includes('not-public'));
  assert.equal(publicSnapshot({ providers: [provider('work')], settings: { accounts: [] } }).providers.length, 0);
  assert.equal(publicSnapshot({ providers: [{ ...provider('work'), visible: false }] }).providers.length, 0);
});

test('private IPv4 validation rejects malformed and public addresses', () => {
  for (const address of ['10.0.0.1', '192.168.1.6', '172.16.0.1', '172.31.255.254', '127.0.0.1']) assert.equal(privateIPv4(address), true, address);
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '10.300.0.1', '10.1.1', '10.1.1.1.attacker.test', '::1', '', null]) assert.equal(privateIPv4(address), false, String(address));
});

test('home screen manifest keeps authorized start URL and all bundled resources are served', async () => {
  const key = 'c'.repeat(64);
  const server = new MobileServer({ key, port: 0, rendererDir: path.join(root, 'src/renderer'), widgetPath: path.join(root, 'src/widget/LimitTracker.js'), getState: () => ({ providers: [provider('work')] }) });
  await server.start();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const resource of ['/', '/manifest.webmanifest', '/api/usage', '/widget.js']) {
      assert.equal((await fetch(base + resource)).status, 401, resource);
      assert.equal((await fetch(base + resource + '?key=' + 'e'.repeat(64))).status, 401, resource);
    }
    const response = await fetch(`${base}/manifest.webmanifest?key=${key}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/manifest\+json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const manifest = await response.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(new URL(manifest.start_url, base).searchParams.get('key'), key);
    assert.equal(new URL(manifest.start_url, base).origin, base);
    const html = await (await fetch(`${base}/?key=${key}`)).text();
    assert.ok(html.includes(`/manifest.webmanifest?key=${key}`));
    assert.ok(html.includes('apple-touch-icon'));
    assert.ok(html.includes('웹 앱으로 열기'));
    const files = ['/mobile.js', '/common.js', '/styles.css', '/mobile.css', '/fonts/PretendardVariable.woff2', '/app-icon.png', '/apple-touch-icon.png'];
    for (const file of files) {
      const asset = await fetch(base + file);
      assert.equal(asset.status, 200, file);
      assert.ok((await asset.arrayBuffer()).byteLength > 50, file);
    }
    const image = Buffer.from(await (await fetch(base + manifest.icons[0].src)).arrayBuffer());
    assert.equal(image.readUInt32BE(16), 256);
    assert.equal(image.readUInt32BE(20), 256);
    const widget = await (await fetch(`${base}/widget.js?key=${key}`)).text();
    assert.ok(!widget.includes('/*SETUP_URL*/ null'));
    assert.ok(widget.includes(`${base}/?key=${key}`));
    assert.equal((await fetch(`${base}/../settings.json?key=${key}`)).status, 404);
  } finally { await server.stop(); }
});

async function renderWidget(providers, family = 'medium', options = {}) {
  const labels = [];
  const stacks = [], textItems = [];
  let cache = options.cache;
  const node = () => {
    const stack = {
      children: [],
      addText(text) { labels.push(text); const item = { text }; textItems.push(item); return item; },
      addStack() { const child = node(); this.children.push(child); return child; }, addSpacer() {},
      layoutHorizontally() {}, layoutVertically() {}, centerAlignContent() {}, setPadding() {}
    };
    stacks.push(stack);
    return stack;
  };
  class Color { constructor(value) { this.value = value; } static dynamic(light) { return light; } }
  const context = {
    args: { widgetParameter: options.widgetParameter === undefined ? `http://192.168.1.2:43821/?key=${'a'.repeat(64)}` : options.widgetParameter, queryParameters: {} },
    config: { runsInWidget: true, widgetFamily: family },
    Keychain: options.keychain || { contains: () => false, set() {} },
    FileManager: { local: () => ({ joinPath: (a, b) => `${a}/${b}`, documentsDirectory: () => '/tmp', writeString(file, value) { cache = value; }, fileExists: () => !!cache, readString: () => cache }) },
    Request: class {
      constructor(url) { this.url = url; (options.requests || []).push(url); }
      async loadJSON() { if (options.offline) throw new Error('Offline'); return { providers }; }
      async loadString() { if (options.offline) throw new Error('Offline'); this.response = { statusCode: options.status || 200 }; return options.status && options.status !== 200 ? 'denied' : JSON.stringify({ providers }); }
    },
    ListWidget: function() { return node(); }, Color,
    Size: class { constructor(width, height) { this.width = width; this.height = height; } },
    Font: { semiboldSystemFont() {}, systemFont() {} },
    Script: { setWidget() {}, complete() {} }
  };
  await vm.runInNewContext(`(async () => {${fs.readFileSync(path.join(root, 'src/widget/LimitTracker.js'), 'utf8')}\n})()`, context);
  labels.stacks = stacks;
  labels.textItems = textItems;
  labels.cache = cache;
  return labels;
}

test('widget reports a rejected connection key instead of showing an old offline snapshot', async () => {
  const labels = await renderWidget([provider('work')], 'medium', { status: 401, cache: JSON.stringify({ connection: 'x', state: { providers: [provider('stale')] } }) });
  assert.ok(labels.some(label => /새 주소/.test(label)));
  assert.ok(!labels.includes('계정 stale'));
});

test('widget prefers an address saved from the setup alert over the address baked into the download', async () => {
  const saved = `http://192.168.1.9:43821/?key=${'b'.repeat(64)}`;
  const baked = `http://192.168.1.2:43821/?key=${'a'.repeat(64)}`;
  const store = new Map([['LimitTrackerConnection', saved], ['LimitTrackerSeed', baked]]);
  const keychain = { contains: name => store.has(name), get: name => store.get(name), set: (name, value) => store.set(name, value) };
  const requests = [];
  const source = fs.readFileSync(path.join(root, 'src/widget/LimitTracker.js'), 'utf8');
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => file === path.join(root, 'src/widget/LimitTracker.js') ? source.replace('/*SETUP_URL*/ null', JSON.stringify(baked)) : original(file, ...rest);
  try { await renderWidget([provider('work')], 'medium', { widgetParameter: '', keychain, requests }); }
  finally { fs.readFileSync = original; }
  assert.ok(requests[0].startsWith('http://192.168.1.9:43821/api/usage'), requests[0]);
  store.set('LimitTrackerSeed', 'older-download');
  const fresh = [];
  fs.readFileSync = (file, ...rest) => file === path.join(root, 'src/widget/LimitTracker.js') ? source.replace('/*SETUP_URL*/ null', JSON.stringify(baked)) : original(file, ...rest);
  try { await renderWidget([provider('work')], 'medium', { widgetParameter: '', keychain, requests: fresh }); }
  finally { fs.readFileSync = original; }
  assert.ok(fresh[0].startsWith('http://192.168.1.2:43821/api/usage'), 'a newly downloaded script seeds its own address once');
});

test('widget supports account identity, manual data, and size limits without inventing values after reset', async () => {
  const accounts = [
    { ...provider('work', 'grok'), manual: true, mode: 'manual' },
    { ...provider('personal', 'gemini'), windows: [{ ...provider('temp').windows[0], resetsAt: '2000-01-01T00:00:00Z' }] },
    provider('extra1'), provider('extra2'), provider('extra3')
  ];
  const medium = await renderWidget(accounts);
  assert.ok(medium.includes('Grok'));
  assert.ok(medium.includes('Gemini'));
  assert.ok(medium.includes('계정 work'));
  assert.ok(medium.includes('직접 입력'));
  assert.ok(medium.includes('갱신 필요'));
  assert.ok(medium.includes('—'));
  assert.ok(medium.some(label => label.endsWith('+3개')));
  assert.ok(!medium.includes('계정 extra1'));
  const small = await renderWidget(accounts, 'small');
  assert.ok(!small.includes('Gemini'));
  assert.ok(small.some(label => label.endsWith('+4개')));
  const large = await renderWidget(accounts, 'large');
  assert.ok(large.includes('계정 extra2'));
  assert.ok(!large.includes('계정 extra3'));
  assert.ok(large.includes('직접 입력'));
});

test('widget uses consumed quota and fills 0%, converted remaining, and 100% correctly', async () => {
  for (const [window, expected] of [
    [{ usedPercent: 0, remainingPercent: 100 }, 0],
    [{ usedPercent: 100, remainingPercent: 0 }, 100],
    [{ remainingPercent: 74 }, 26],
    [{ usedPercent: 30, remainingPercent: 99 }, 30]
  ]) {
    const labels = await renderWidget([{ ...provider('work'), windows: [{ ...window, label: '5시간' }] }]);
    assert.ok(labels.includes(`${expected}%`));
    assert.ok(labels.includes('사용'));
    assert.ok(!labels.includes('남음'));
    const track = labels.stacks.find(stack => stack.backgroundColor?.value === 'E3E6EE');
    assert.equal(track.size.width, 100);
    assert.equal(track.children.length, expected ? 1 : 0);
    if (expected) assert.equal(track.children[0].size.width, expected);
  }
});

test('widget warning colors follow high used percentages at 80% and 95%', async () => {
  for (const [usedPercent, expectedColor] of [[0, '20283C'], [79, '20283C'], [80, 'A86A13'], [94, 'A86A13'], [95, 'BD534C'], [100, 'BD534C']]) {
    const labels = await renderWidget([{ ...provider('work'), windows: [{ usedPercent }] }]);
    assert.equal(labels.textItems.find(item => item.text === `${usedPercent}%`).textColor.value, expectedColor);
    assert.equal(labels.stacks.find(stack => stack.backgroundColor?.value === 'E3E6EE').children[0]?.backgroundColor.value || '20283C', expectedColor);
  }
});

test('widget never turns absent, invalid, or expired quotas into a numeric usage value', async () => {
  for (const window of [
    {}, { usedPercent: null }, { usedPercent: '0' }, { usedPercent: NaN }, { usedPercent: -1 },
    { remainingPercent: 110 }, { usedPercent: 0, remainingPercent: 100, resetsAt: '2000-01-01T00:00:00Z' }
  ]) {
    const labels = await renderWidget([{ ...provider('work'), windows: [window] }]);
    assert.ok(labels.includes('—'));
    assert.ok(labels.includes('갱신 필요'));
    assert.ok(!labels.some(label => /\d+%/.test(label)));
    assert.ok(!labels.stacks.some(stack => stack.backgroundColor?.value === 'E3E6EE'));
  }
});

test('widget retains used values, manual provenance, and expiration when reading an offline cache', async () => {
  const accounts = [{ ...provider('work'), manual: true, mode: 'manual' }];
  const online = await renderWidget(accounts);
  const offline = await renderWidget([], 'large', { offline: true, cache: online.cache });
  assert.ok(offline.includes('26%'));
  assert.ok(offline.includes('오프라인'));
  assert.ok(offline.includes('이전 기록 · 직접 입력'));
  const expiredCache = JSON.parse(online.cache);
  expiredCache.state.providers[0].windows[0].resetsAt = '2000-01-01T00:00:00Z';
  const expired = await renderWidget([], 'large', { offline: true, cache: JSON.stringify(expiredCache) });
  assert.ok(expired.includes('갱신 필요'));
  assert.ok(!expired.includes('0%'));
  assert.ok(!expired.includes('26%'));
});

async function mobilePage({ hidden = false, providers = [provider('work')] } = {}) {
  const nodes = new Map(), listeners = new Map(), intervals = new Map();
  let nextTimer = 1, requests = 0;
  let response = { providers, lastUpdated: '2026-10-04T01:00:00Z' };
  const node = () => ({
    children: [], replaceCount: 0, disabledWrites: [], dataset: {},
    classList: { add() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; this.replaceCount++; },
    setAttribute() {}, addEventListener() {},
    set disabled(value) { this.disabledWrites.push(value); this.disabledValue = value; },
    get disabled() { return this.disabledValue; }
  });
  const document = {
    hidden,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    addEventListener(event, callback) { listeners.set(event, callback); }
  };
  let countdowns = 0;
  const shared = {};
  const sharedContext = { window: shared, navigator: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/renderer/i18n.js'), 'utf8'), sharedContext);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/renderer/common.js'), 'utf8'), sharedContext);
  const ui = {
    hydrateIcons() {}, el(tag, className, textContent) { return { ...node(), tag, className, textContent }; }, icon: () => node(), providerName: p => p.providerId,
    planLabel: p => p.plan, providerStatus: () => ({ className: '', label: '연결됨' }),
    t: shared.LimitUI.t,
    overviewWindows: shared.LimitUI.overviewWindows,
    visibleProviders: shared.LimitUI.visibleProviders,
    statusBadge: () => node(), windowSummary: () => node(),
    primaryWindow: p => p.windows?.[0], renderRing: () => node(), resetBlock: () => node(),
    windowMeter(window, label) { return { ...node(), className: 'usage-window', window, label }; },
    expirySignature: () => 'current', validDate: value => value ? new Date(value) : null,
    exactTime: value => value, safeError: error => error.message,
    tickCountdowns() { countdowns++; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/renderer/mobile.js'), 'utf8'), {
    document, window: { LimitUI: ui, location: { href: 'http://localhost/?key=test' }, matchMedia: () => ({ matches: false }), navigator: {} },
    navigator: {}, URL, AbortController,
    fetch: async () => { requests++; return { ok: true, json: async () => response }; },
    setTimeout: () => nextTimer++, clearTimeout() {},
    setInterval(callback, delay) { const id = nextTimer++; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  return {
    nodes, intervals, get requests() { return requests; }, get countdowns() { return countdowns; },
    setResponse(value) { response = value; },
    async tick(delay) { [...intervals.values()].find(timer => timer.delay === delay)?.callback(); await flush(); },
    async visibility(value) { document.hidden = value; listeners.get('visibilitychange')(); await flush(); }
  };
}

test('mobile periodic refresh leaves unchanged cards and refresh button in place', async () => {
  const page = await mobilePage();
  const grid = page.nodes.get('mobile-providers'), button = page.nodes.get('mobile-refresh');
  const previousCount = grid.replaceCount;
  button.disabledWrites.length = 0;
  await page.tick(60000);
  assert.equal(page.requests, 2);
  assert.equal(grid.replaceCount, previousCount);
  assert.ok(button.disabledWrites.every(value => value === false));
  page.setResponse({ providers: [{ ...provider('work'), windows: [{ usedPercent: 80 }] }], lastUpdated: '2026-10-04T02:00:00Z' });
  await page.tick(60000);
  assert.equal(grid.replaceCount, previousCount + 1);
});

test('mobile hidden pages release both intervals and resume once with an immediate refresh', async () => {
  const page = await mobilePage();
  assert.equal(page.intervals.size, 2);
  await page.visibility(true);
  assert.equal(page.intervals.size, 0);
  const requests = page.requests, countdowns = page.countdowns;
  await page.tick(60000);
  await page.tick(15000);
  assert.equal(page.requests, requests);
  assert.equal(page.countdowns, countdowns);
  await page.visibility(false);
  assert.equal(page.intervals.size, 2);
  assert.equal(page.requests, requests + 1);
  assert.equal(page.countdowns, countdowns + 1);
  await page.visibility(false);
  assert.equal(page.intervals.size, 2);
  const initiallyHidden = await mobilePage({ hidden: true });
  assert.equal(initiallyHidden.requests, 0);
  assert.equal(initiallyHidden.intervals.size, 0);
  await initiallyHidden.visibility(false);
  assert.equal(initiallyHidden.requests, 1);
  assert.equal(initiallyHidden.intervals.size, 2);
});

test('mobile cards compare current and weekly quotas in two columns with extra models collapsed', async () => {
  const current = provider('work').windows[0];
  const weekly = { id: 'seven_day', label: '주간', usedPercent: 37, durationMinutes: 10080 };
  const extra = { id: 'seven_day_sonnet', label: 'Sonnet', usedPercent: 18, durationMinutes: 10080 };
  const page = await mobilePage({ providers: [{ ...provider('work'), windows: [weekly, extra, current] }] });
  const card = page.nodes.get('mobile-providers').children[0];
  const overview = card.children.find(child => child.className === 'mobile-overview-windows');
  assert.equal(overview.children.length, 2);
  assert.equal(overview.children[0].window, current);
  assert.equal(overview.children[1].window, weekly);
  const details = card.children.find(child => child.className === 'mobile-extra-windows');
  assert.equal(details.tag, 'details');
  assert.equal(details.open, false);
  assert.equal(details.children[1].children[0].window, extra);
  const single = await mobilePage();
  const singleOverview = single.nodes.get('mobile-providers').children[0].children.find(child => child.className === 'mobile-overview-windows');
  assert.equal(singleOverview.children[1].window, null);
  assert.equal(singleOverview.children[1].label, '주간 한도');
});

test('without a private address the iPhone sheet is told why (public office network vs no network)', () => {
  const os = require('node:os');
  const original = os.networkInterfaces;
  const server = new MobileServer({ key: 'a'.repeat(64), getState: () => ({}), rendererDir: __dirname });
  server.server = {};
  try {
    os.networkInterfaces = () => ({ '이더넷': [{ family: 'IPv4', address: '203.0.113.20', internal: false }] });
    assert.deepEqual([server.info().url, server.info().reason], [null, 'public-only']);
    os.networkInterfaces = () => ({ '이더넷': [{ family: 'IPv4', address: '169.254.3.4', internal: false }] });
    assert.equal(server.info().reason, 'no-network', 'a self-assigned address is not a network');
    os.networkInterfaces = () => ({});
    assert.equal(server.info().reason, 'no-network');
    os.networkInterfaces = () => ({ '이더넷': [{ family: 'IPv4', address: '203.0.113.20', internal: false }], 'vEthernet (WSL (Hyper-V firewall))': [{ family: 'IPv4', address: '172.23.112.1', internal: false }], 'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }] });
    assert.deepEqual([server.info().url, server.info().reason], [null, 'public-only'], 'a virtual adapter is not offered while a physical one is connected');
    os.networkInterfaces = () => ({ '이더넷': [{ family: 'IPv4', address: '169.254.3.4', internal: false }], 'vEthernet (External)': [{ family: 'IPv4', address: '192.168.0.9', internal: false }] });
    assert.equal(server.info().url, `http://192.168.0.9:${server.port}/?key=${'a'.repeat(64)}`, 'a physical adapter without DHCP does not hide the external switch');
    os.networkInterfaces = () => ({ 'vEthernet (External)': [{ family: 'IPv4', address: '192.168.0.9', internal: false }] });
    assert.equal(server.info().url, `http://192.168.0.9:${server.port}/?key=${'a'.repeat(64)}`, 'a Hyper-V external switch alone still works');
    os.networkInterfaces = () => ({ 'Wi-Fi': [{ family: 'IPv4', address: '192.168.0.7', internal: false }], '이더넷': [{ family: 'IPv4', address: '203.0.113.20', internal: false }] });
    assert.equal(server.info().url, `http://192.168.0.7:${server.port}/?key=${'a'.repeat(64)}`);
    assert.equal(server.info().reason, null);
  } finally { os.networkInterfaces = original; server.server = null; }
  assert.equal(server.info().reason, null, 'nothing to explain while the connection is off');
});

test('the iPhone home screen icon is an opaque 180 px square (iOS rounds it; transparent corners turn black)', () => {
  const zlib = require('node:zlib');
  const { touchIconPng } = require('../src/icons.cjs');
  const png = touchIconPng(180);
  assert.equal(png.readUInt32BE(16), 180); assert.equal(png.readUInt32BE(20), 180);
  const idat = []; for (let i = 8; i < png.length;) { const length = png.readUInt32BE(i); const type = png.toString('ascii', i + 4, i + 8); if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + length)); i += 12 + length; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const alpha = (x, y) => raw[y * (180 * 4 + 1) + 1 + x * 4 + 3];
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179], [90, 90]]) assert.equal(alpha(x, y), 255, `pixel ${x},${y} is opaque`);
});
