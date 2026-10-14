'use strict';
const { AlertLog } = require('./alert-log.cjs');

/** Threshold crossings survive a failed toast, but never a reset or disabled alerts. */
class UsageAlerts {
  constructor({ notify, now = Date.now, retryAfterMs = 60000 }) {
    this.notify = notify; this.now = now; this.enabled = false;
    this.previous = new Map(); this.pending = new Map();
    this.delivered = new AlertLog(null, { now, retryAfterMs, limit: 512 });
  }
  observe(providers, enabled) {
    this.enabled = !!enabled;
    if (!enabled) this.pending.clear();
    const active = new Set(); const deliveries = [];
    for (const provider of providers) {
      if (provider.manual) continue;
      for (const window of provider.windows || []) {
        if (window.resetsAt && Date.parse(window.resetsAt) <= this.now()) continue;
        const key = `${provider.id}:${window.id}:${window.resetsAt}`;
        active.add(key);
        // Errors keep the baseline for recovery; caches cannot create crossings.
        if (provider.status !== 'ok' || provider.stale || provider.cached || provider.refreshing) continue;
        const percent = window.usedPercent ?? (typeof window.remainingPercent === 'number' ? 100 - window.remainingPercent : null);
        if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
        const previous = this.previous.get(key);
        for (const threshold of [80, 95]) {
          const alert = `${key}:${threshold}`;
          if (!enabled || percent < threshold) { this.pending.delete(alert); continue; }
          if (previous < threshold || this.pending.has(alert)) {
            this.pending.set(alert, { key, provider, window, percent: Math.round(percent), threshold });
            deliveries.push(this.delivered.sendOnce(alert, () => {
              const current = this.pending.get(alert);
              return this.enabled && current ? this.notify(current) : false;
            }).then(accepted => { if (accepted || this.delivered.has(alert)) this.pending.delete(alert); }, () => {}));
          }
        }
        this.previous.set(key, percent);
      }
    }
    for (const key of this.previous.keys()) if (!active.has(key)) this.previous.delete(key);
    for (const [key, item] of this.pending) if (!active.has(item.key)) this.pending.delete(key);
    return Promise.all(deliveries);
  }
}
module.exports = { UsageAlerts };
