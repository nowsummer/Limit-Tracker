'use strict';
const fs = require('node:fs');
const MAX_AGE = 86400000;

function usedPercent(window) {
  const value = window?.usedPercent ?? (typeof window?.remainingPercent === 'number' ? 100 - window.remainingPercent : null);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

// Persist reset schedules and their usage baseline, never login credentials.
class ResetReminders {
  constructor({ file, now = Date.now, notify, retryAfterMs = 60000 }) {
    this.file = file; this.now = now; this.notify = notify; this.items = new Map(); this.dirty = false;
    this.retryAfterMs = retryAfterMs; this.pendingDeliveries = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const item of saved) {
        if (typeof item.key !== 'string' || !Number.isFinite(item.at) || item.at <= now() - MAX_AGE) continue;
        // Read existing reminders from versions that did not store a window ID.
        if (!item.windowId && typeof item.providerId === 'string' && item.key.startsWith(item.providerId + ':') && item.key.endsWith(':' + item.at)) {
          item.windowId = item.key.slice(item.providerId.length + 1, -String(item.at).length - 1);
          this.dirty = true;
        }
        this.items.set(item.key, item);
      }
      this.dirty ||= saved.length !== this.items.size;
    } catch {}
  }

  save() {
    if (!this.file || !this.dirty) return false;
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.items.values()]), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
      return true;
    } catch { return false; }
  }

  observe(providers, enabled) {
    const now = this.now(); const ids = new Set(providers.map(p => p.id));
    for (const [key, item] of this.items) {
      if (!ids.has(item.providerId) || item.at < now - MAX_AGE) { this.items.delete(key); this.dirty = true; }
    }
    // Upgrade remembered Codex deadlines exactly once to the same effective
    // timestamp that the normalizer supplies to every screen and tooltip.
    for (const p of providers) {
      if (p.manual || (p.providerId || p.id) !== 'codex') continue;
      for (const [key, item] of this.items) {
        if (item.providerId !== p.id || item.manual) continue;
        const window = p.windows.find(w => w.id === item.windowId);
        const adjustment = window?.resetAdjustmentMs;
        if (adjustment !== 60000 || item.resetAdjustmentMs === adjustment) continue;
        item.at += adjustment;
        item.resetAdjustmentMs = adjustment;
        item.key = `${p.id}:${item.windowId}:${item.at}`;
        this.items.delete(key);
        if (!this.items.has(item.key)) this.items.set(item.key, item);
        this.dirty = true;
      }
    }
    // Automatic schedules only request a recheck at their due time. A successful
    // post-deadline server read must establish the reset before notification.
    this.tick(enabled, { persist: false });
    const confirmedWindows = new Set();
    for (const p of providers) {
      // A locally cached reading (Claude status line) is not a new server response.
      if (p.status !== 'ok' || p.stale || p.cached || p.refreshing || p.manual) continue;
      const capturedAt = Date.parse(p.updatedAt);
      if (!Number.isFinite(capturedAt) || capturedAt > now + 1000) continue;
      for (const item of this.items.values()) {
        if (item.providerId !== p.id || item.sent || item.confirmedAt || item.manual || item.at > now || capturedAt < item.at) continue;
        const window = p.windows.find(w => w.id === item.windowId);
        if (!window) continue;
        const nextReset = Date.parse(window.resetsAt);
        const currentUsed = usedPercent(window);
        const advanced = Number.isFinite(nextReset) && nextReset > item.at;
        const dropped = typeof item.baselineUsed === 'number' && currentUsed !== null && currentUsed < item.baselineUsed - 0.001;
        // A server may merely correct its advertised boundary by a minute.
        // A later timestamp with unchanged/exhausted usage is not a reset.
        if (!dropped && !(advanced && currentUsed === 0)) continue;
        item.confirmedAt = capturedAt; this.dirty = true;
        const identity = `${p.id}:${item.windowId}`;
        // Corrected deadlines can leave more than one pending schedule for the
        // same observed period. Confirm them together, with one notification.
        confirmedWindows.add(identity);
      }
    }
    // Retire due schedules that can no longer be confirmed, silently, so they
    // stop driving extra forced refreshes for up to a day.
    for (const p of providers) {
      if (p.manual) continue;
      const loggedOut = p.status === 'disconnected' || p.status === 'unsupported';
      const fresh = p.status === 'ok' && !p.stale && !p.cached && !p.refreshing;
      if (!loggedOut && !fresh) continue;
      const capturedAt = Date.parse(p.updatedAt);
      for (const item of this.items.values()) {
        if (item.providerId !== p.id || item.sent || item.confirmedAt || item.manual || item.at > now) continue;
        if (!loggedOut) {
          if (!Number.isFinite(capturedAt) || capturedAt < item.at) continue;
          const window = p.windows.find(w => w.id === item.windowId);
          if (window) {
            // Small boundary corrections (Codex moves by about a minute) keep the
            // schedule pending; only a reading that is clearly in a later period,
            // with a known usage that did not establish the reset, retires it. That
            // later period has its own schedule with its own baseline.
            const nextReset = Date.parse(window.resetsAt);
            const period = window.durationMinutes > 0 ? window.durationMinutes * 60000 : null;
            const threshold = period ? Math.min(30 * 60000, period / 2) : 30 * 60000;
            if (!(Number.isFinite(nextReset) && nextReset - item.at >= threshold && usedPercent(window) !== null)) continue;
          }
        }
        item.sent = true; item.retired = true; this.dirty = true;
      }
    }
    for (const p of providers) {
      if (p.cached && !p.manual) continue;
      if (!(p.status === 'ok' && !p.stale && !p.refreshing) && !(p.manual && p.status === 'unsupported')) continue;
      const currentKeys = new Set(p.windows.map(w => `${p.id}:${w.id}:${Date.parse(w.resetsAt)}`));
      // A correction of a future schedule supersedes it. Due automatic schedules
      // are retained while the server still reports the old period.
      for (const [key, item] of this.items) {
        const sourceBoundaryPassed = item.resetAdjustmentMs > 0 && item.at - item.resetAdjustmentMs <= now;
        if (item.providerId === p.id && !item.sent && item.at > now && (!sourceBoundaryPassed || confirmedWindows.has(`${p.id}:${item.windowId}`)) && !currentKeys.has(key)) { this.items.delete(key); this.dirty = true; }
      }
    }
    for (const p of providers) {
      if (p.status !== 'ok' || p.stale || p.refreshing || (p.cached && !p.manual)) continue;
      for (const window of p.windows) {
        const at = Date.parse(window.resetsAt); if (!Number.isFinite(at) || at <= now) continue;
        const key = `${p.id}:${window.id}:${at}`;
        const baselineUsed = usedPercent(window);
        const existing = this.items.get(key);
        if (!existing) {
          this.items.set(key, { key, providerId: p.id, windowId: window.id, name: p.name, accountLabel: p.accountLabel, label: window.label, at, sent: false, manual: !!p.manual, baselineUsed, resetAdjustmentMs: window.resetAdjustmentMs || 0 });
          this.dirty = true;
        } else if (!existing.sent && existing.baselineUsed !== baselineUsed && !(existing.resetAdjustmentMs > 0 && now >= existing.at - existing.resetAdjustmentMs)) {
          // Preserve the pre-reset baseline during Codex's display adjustment:
          // an early decrease with the old timestamp still needs confirmation
          // from a fresh response after the effective availability time.
          existing.baselineUsed = baselineUsed; this.dirty = true;
        }
      }
    }
    this.tick(enabled, { persist: false }); this.save();
  }

  tick(enabled, { persist = true } = {}) {
    const now = this.now(); let changed = false;
    const deliveries = new Map();
    for (const item of this.items.values()) {
      if (item.sent || item.at > now) continue;
      // Disabled notifications are consumed, so enabling later cannot replay a
      // backlog. Automatic active notifications require observe() confirmation.
      if (!enabled || item.at <= now - MAX_AGE) {
        item.sent = true; changed = true; this.dirty = true;
      } else if ((item.manual || item.confirmedAt) && !(item.retryAt > now)) {
        const identity = `${item.providerId}:${item.windowId}`;
        if (!deliveries.has(identity)) deliveries.set(identity, []);
        deliveries.get(identity).push(item);
      }
    }
    for (const [identity, items] of deliveries) changed = this.deliver(identity, items) || changed;
    if (persist) this.save();
    return changed;
  }

  /** Coalesce corrected deadlines; only accepted delivery consumes the alert. */
  deliver(identity, items) {
    const pending = this.pendingDeliveries.get(identity);
    if (pending) { items.forEach(item => pending.add(item)); return false; }
    const group = new Set(items);
    this.pendingDeliveries.set(identity, group);
    const finish = accepted => {
      for (const item of group) {
        if (this.items.get(item.key) !== item || item.sent) continue;
        if (accepted) { item.sent = true; delete item.retryAt; }
        else item.retryAt = this.now() + this.retryAfterMs;
        this.dirty = true;
      }
      this.pendingDeliveries.delete(identity);
      this.save();
    };
    try {
      const outcome = this.notify(items[0]);
      if (outcome && typeof outcome.then === 'function') Promise.resolve(outcome).then(value => finish(value !== false), () => finish(false));
      else finish(outcome !== false); // Synchronous legacy notification callbacks.
    } catch { finish(false); }
    return true;
  }

  nextCheckAt() {
    let next = null; const cutoff = this.now() - MAX_AGE;
    for (const item of this.items.values()) {
      const due = Math.max(item.at, item.retryAt || 0);
      if (!item.sent && item.at > cutoff && (next === null || due < next)) next = due;
    }
    return next;
  }

  nextFutureCheckAt() {
    let next = null; const now = this.now();
    for (const item of this.items.values()) if (!item.sent && item.at > now && (next === null || item.at < next)) next = item.at;
    return next;
  }

  hasPendingDue() {
    const now = this.now();
    return [...this.items.values()].some(item => !item.sent && !item.confirmedAt && !item.manual && item.at <= now && item.at > now - MAX_AGE);
  }
}
module.exports = { ResetReminders };
