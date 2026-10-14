'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { t, getLanguage } = require('./i18n.cjs');
const { touchIconPng } = require('./icons.cjs');
const VIRTUAL_ADAPTER = /vEthernet|virtual|vmware|host-only|hyper-v|vpn|tailscale|wsl/i;
function localEntries() {
  const priority = name => VIRTUAL_ADAPTER.test(name) ? 2 : /wi-fi|wifi|wireless/i.test(name) ? 0 : 1;
  return Object.entries(os.networkInterfaces()).sort(([a], [b]) => priority(a) - priority(b))
    .flatMap(([name, entries]) => (entries || []).filter(item => item && item.family === 'IPv4' && !item.internal).map(item => ({ name, address: item.address })));
}
function localAddresses() {
  return [...new Set(localEntries().map(entry => entry.address))];
}
/**
 * Addresses a phone on the same network can open. A virtual adapter's address (WSL,
 * Hyper-V, VirtualBox, VPN) is never that while a physical adapter is connected; it is
 * kept only when nothing else has an address (for example a Hyper-V external switch).
 */
function phoneAddresses() {
  const all = localEntries();
  const physical = all.filter(entry => !VIRTUAL_ADAPTER.test(entry.name) && !/^169\.254\./.test(entry.address));
  return [...new Set((physical.length ? physical : all).map(entry => entry.address))];
}
function privateIPv4(ip) {
  if (typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const bytes = ip.split('.').map(Number);
  return bytes.every(byte => byte >= 0 && byte <= 255) && (bytes[0] === 10 || bytes[0] === 127 || (bytes[0] === 192 && bytes[1] === 168) || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31));
}
/** Only the count, earliest expiry and balance reach the phone (no ids, no service text). */
function publicAfterLimit(value) {
  if (!value || typeof value !== 'object') return null;
  const resets = Number.isInteger(value.resets) && value.resets > 0 ? value.resets : null;
  const resetsExpireAt = resets && typeof value.resetsExpireAt === 'string' && Number.isFinite(Date.parse(value.resetsExpireAt)) ? value.resetsExpireAt : null;
  const creditBalance = typeof value.creditBalance === 'string' && /^\d{1,12}(\.\d{1,12})?$/.test(value.creditBalance) ? value.creditBalance : null;
  const unlimitedCredits = value.unlimitedCredits === true;
  return resets || creditBalance || unlimitedCredits ? { resets, resetsExpireAt, creditBalance, unlimitedCredits } : null;
}
function publicSnapshot(state) {
  const accounts = state.settings?.accounts;
  const visible = Array.isArray(accounts) ? new Set(accounts.filter(account => account.visible !== false).map(account => account.id)) : null;
  return {
    appVersion: state.appVersion, language: state.language === 'en' ? 'en' : 'ko', lastUpdated: state.lastUpdated, refreshing: !!state.refreshing,
    providers: (state.providers || []).filter(provider => provider.visible !== false && (!visible || visible.has(provider.id))).map(p => ({
      id: p.id, providerId: p.providerId || p.id, name: p.name, accountLabel: p.accountLabel,
      status: p.status, plan: p.plan, refreshing: !!p.refreshing, manual: !!p.manual || p.mode === 'manual', mode: p.mode, showFable: !!p.showFable,
      windows: (p.windows || []).filter(w => p.showFable || (p.providerId || p.id) !== 'claude' || !/fable/i.test(w.id + w.label)).map(w => ({ id: w.id, label: w.label, usedPercent: w.usedPercent, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, durationMinutes: w.durationMinutes })),
      updatedAt: p.updatedAt, lastSuccessAt: p.lastSuccessAt, stale: !!p.stale, error: p.error, loginExpiresAt: p.loginExpiresAt || null, afterLimit: publicAfterLimit(p.afterLimit)
    }))
  };
}
function webManifest(key, language = getLanguage()) {
  return {
    id: '/limit-tracker', name: 'Limit Tracker', short_name: 'Limit Tracker', lang: language === 'en' ? 'en' : 'ko',
    description: t('mobile.manifestDescription', null, language),
    start_url: `/?key=${encodeURIComponent(key)}`, scope: '/', display: 'standalone',
    background_color: '#f4f5fb', theme_color: '#f4f5fb',
    icons: [{ src: '/app-icon.png', sizes: '256x256', type: 'image/png', purpose: 'any' }, { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'maskable' }]
  };
}
class MobileServer {
  constructor({ key, getState, rendererDir, widgetPath, iconPath = path.join(__dirname, '..', 'assets', 'icon.png'), port = 43821, onError = () => {} }) { Object.assign(this, { key, getState, rendererDir, widgetPath, iconPath, port, onError }); this.server = null; this.transition = Promise.resolve(); }
  info() {
    const addresses = this.server ? phoneAddresses() : [];
    const urls = addresses.filter(privateIPv4).map(ip => `http://${ip}:${this.port}/?key=${this.key}`);
    // Say why there is no address: only public ones (an office network handing out public
    // IPs; the page is never offered there) or no usable network at all (none, or self-assigned 169.254.x.x).
    const reason = !this.server || urls.length ? null : addresses.some(ip => !/^169\.254\./.test(ip)) ? 'public-only' : 'no-network';
    return { enabled: !!this.server, url: urls[0] || null, urls, port: this.port, reason };
  }
  authorized(url) { const candidate = url.searchParams.get('key') || ''; return /^[a-f0-9]{64}$/.test(candidate) && candidate.length === this.key.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(this.key)); }
  /** Start and stop are serialized so a quick on/off can never leave the port open. */
  queue(step) { const next = this.transition.then(step, step); this.transition = next.catch(() => {}); return next; }
  start() {
    return this.queue(async () => {
      if (this.server) return this.info();
      const server = http.createServer((req, res) => this.handle(req, res));
      server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 12;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); }); });
      // Accept-time failures (for example EMFILE) must not crash the tray app.
      server.on('error', error => { try { this.onError(error); } catch { /* Ignore reporter failures. */ } });
      this.server = server; this.port = server.address().port; return this.info();
    });
  }
  stop() {
    return this.queue(async () => {
      if (!this.server) return;
      const server = this.server; this.server = null;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
  }
  handle(req, res) {
    const send = (code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(body); };
    if (req.method !== 'GET') return send(405, t('mobile.readOnly'));
    // Reject public interfaces, hostile Host headers and DNS rebinding. The phone needs a literal private IPv4 URL.
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const host = (req.headers.host || '').split(':')[0];
    if (!privateIPv4(ip) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !privateIPv4(host) || !['127.0.0.1', ...localAddresses()].includes(host)) return send(403, t('mobile.localOnly'));
    let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(400, t('mobile.badUrl')); }
    const staticFiles = { '/mobile.js': ['mobile.js', 'text/javascript; charset=utf-8'], '/common.js': ['common.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/mobile.css': ['mobile.css', 'text/css; charset=utf-8'], '/fonts/PretendardVariable.woff2': ['fonts/PretendardVariable.woff2', 'font/woff2'] };
    if (staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname];
      try { return send(200, fs.readFileSync(path.join(this.rendererDir, file)), type); } catch { return send(404, t('mobile.fileMissing')); }
    }
    if (url.pathname === '/apple-touch-icon.png') {
      this.touchIcon ||= touchIconPng(180);
      return send(200, this.touchIcon, 'image/png');
    }
    if (url.pathname === '/app-icon.png') {
      try { return send(200, fs.readFileSync(this.iconPath), 'image/png'); } catch { return send(404, t('mobile.iconMissing')); }
    }
    if (!this.authorized(url)) return send(401, t('mobile.unauthorized'));
    if (url.pathname === '/api/usage') return send(200, JSON.stringify(publicSnapshot(this.getState())), 'application/json; charset=utf-8');
    if (url.pathname === '/manifest.webmanifest') return send(200, JSON.stringify(webManifest(this.key)), 'application/manifest+json; charset=utf-8');
    if (url.pathname === '/') { try { return send(200, fs.readFileSync(path.join(this.rendererDir, 'mobile.html'), 'utf8').replace('<!--APP_MANIFEST-->', `<link rel="manifest" href="/manifest.webmanifest?key=${this.key}">`).replace('<html lang="ko"', `<html lang="${getLanguage() === 'en' ? 'en' : 'ko'}"`), 'text/html; charset=utf-8'); } catch { return send(404, t('mobile.pageMissing')); } }
    if (url.pathname === '/widget.js') {
      try { const setupUrl = `http://${host}:${this.port}/?key=${this.key}`; const script = fs.readFileSync(this.widgetPath, 'utf8').replace('/*SETUP_URL*/ null', JSON.stringify(setupUrl)); res.setHeader('Content-Disposition', 'attachment; filename="LimitTracker.js"'); return send(200, script, 'text/javascript; charset=utf-8'); } catch { return send(404, t('mobile.widgetMissing')); }
    }
    return send(404, t('mobile.notFound'));
  }
}
module.exports = { MobileServer, publicSnapshot, privateIPv4, webManifest };
