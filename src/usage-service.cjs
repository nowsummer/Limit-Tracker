'use strict';
const { EventEmitter } = require('node:events');
const { t } = require('./i18n.cjs');
// A server may ask us to wait; never let one header silence an account for long.
const MAX_RETRY_WAIT_MS = 30 * 60000;
function initialProvider(id, name) { return { id, name, status: 'loading', refreshing: true, plan: null, windows: [], updatedAt: null, error: null, errorKey: null, errorParams: null, source: '', stale: false, lastSuccessAt: null }; }
function monitored(p) { return p?.visible !== false || p?.trayVisible === true; }
function mergeProvider(previous, next) {
  if (next.status === 'ok') return { ...next, stale: !!next.stale, lastSuccessAt: next.updatedAt };
  // Keep the last good reading on a transient failure, labelled as stale.
  if (next.status === 'error' && previous.windows.length) return { ...previous, status: 'error', stale: true, error: next.error, errorKey: next.errorKey ?? null, errorParams: next.errorParams ?? null, retryAt: next.retryAt, updatedAt: next.updatedAt };
  return { ...next, stale: false, lastSuccessAt: null };
}
class UsageService extends EventEmitter {
  constructor(providers, { now = Date.now, onListenerError = () => {} } = {}) {
    super(); this.now = now; this.onListenerError = onListenerError; this.refreshing = false; this.lastUpdated = null; this.pending = null; this.lastAttempt = -Infinity; this.nextAllowed = new Map(); this.generation = 0; this.providers = []; this.configure(providers);
  }
  /** A failing UI listener must never stop the fetch loop or wedge `pending`. */
  notify() {
    try { this.emit('change', this.snapshot()); }
    catch (error) { try { this.onListenerError(error); } catch { /* Ignore reporter failures. */ } }
  }
  configure(providers) {
    const previous = new Map(this.providers.map(p => [p.id, p]));
    this.fetchers = providers.map((entry, i) => typeof entry === 'function' ? { id: ['claude', 'codex'][i] || String(i), name: ['Claude', 'Codex'][i] || 'AI', fetch: entry } : entry);
    this.providers = this.fetchers.map(p => ({ ...(previous.get(p.id) || initialProvider(p.id, p.name)), ...p.metadata, ...(!monitored(p.metadata) ? { refreshing: false } : {}), id: p.id, name: p.name }));
    for (const key of this.nextAllowed.keys()) if (!this.fetchers.some(p => p.id === key)) this.nextAllowed.delete(key);
    this.generation++; this.lastAttempt = -Infinity;
    this.notify();
  }
  snapshot() { return { providers: this.providers, refreshing: this.refreshing, lastUpdated: this.lastUpdated }; }
  reorder(ids) {
    const order = new Map(ids.map((id, i) => [id, i]));
    if (order.size !== this.providers.length || this.providers.some(p => !order.has(p.id))) throw new Error('Invalid account order');
    this.providers.sort((a, b) => order.get(a.id) - order.get(b.id));
    this.fetchers.sort((a, b) => order.get(a.id) - order.get(b.id));
    this.notify();
  }
  /** When the account may be queried again (0 when allowed now). */
  retryAfter(id) { return this.nextAllowed.get(id) || 0; }
  refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (!force && this.now() - this.lastAttempt < 10000) return Promise.resolve(this.snapshot());
    this.lastAttempt = this.now(); this.refreshing = true;
    this.providers = this.providers.map(p => ({ ...p, refreshing: monitored(p) && this.now() >= (this.nextAllowed.get(p.id) || 0) }));
    this.notify();
    this.pending = (async () => {
      try {
        let generation;
        do {
          generation = this.generation;
          const queue = this.fetchers.filter(p => monitored(p.metadata));
          const worker = async () => {
            while (queue.length && generation === this.generation) {
              const descriptor = queue.shift();
              if (this.now() < (this.nextAllowed.get(descriptor.id) || 0)) continue;
              let next;
              try { next = await descriptor.fetch(); if (!next || !Array.isArray(next.windows)) throw new Error('Invalid provider result'); }
              catch { next = { ...initialProvider(descriptor.id, descriptor.name), status: 'error', updatedAt: new Date(this.now()).toISOString(), error: t('usage.failed', null, 'ko'), errorKey: 'usage.failed' }; }
              // Record a server's back-off even if the account list changed meanwhile.
              const retry = Date.parse(next.retryAt);
              this.nextAllowed.set(descriptor.id, Number.isFinite(retry) && retry > this.now() ? Math.min(retry, this.now() + MAX_RETRY_WAIT_MS) : 0);
              if (generation !== this.generation) continue;
              const i = this.providers.findIndex(p => p.id === descriptor.id);
              if (i < 0) continue;
              this.providers[i] = { ...mergeProvider(this.providers[i], next), ...descriptor.metadata, id: descriptor.id, name: descriptor.name, refreshing: false };
              this.notify();
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
        } while (generation !== this.generation);
      } finally {
        this.lastUpdated = new Date(this.now()).toISOString(); this.refreshing = false; this.pending = null;
        this.providers = this.providers.map(p => p.refreshing ? { ...p, refreshing: false } : p);
      }
      this.notify(); return this.snapshot();
    })();
    return this.pending;
  }
}
module.exports = { UsageService, mergeProvider, initialProvider, MAX_RETRY_WAIT_MS };
