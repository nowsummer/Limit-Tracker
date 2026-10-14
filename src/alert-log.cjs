'use strict';
// Alerts that must come once, not once per run (the sign-in deadline alert). Only the
// account id and the deadline are stored, in the app's own settings folder.
const fs = require('node:fs');

class AlertLog {
  constructor(file, { limit = 50, now = Date.now, retryAfterMs = 60000 } = {}) {
    Object.assign(this, { file, limit, now, retryAfterMs });
    this.keys = null; this.pending = new Map(); this.retryAt = new Map();
  }
  load() {
    if (this.keys) return this.keys;
    if (!this.file) return (this.keys = new Set());
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.keys = new Set(Array.isArray(list) ? list.filter(key => typeof key === 'string' && key.length < 300).slice(-this.limit) : []);
    } catch { this.keys = new Set(); }
    return this.keys;
  }
  has(key) { return this.load().has(key); }
  /** A poll may overlap delivery. Persist only an accepted notification, never a failed attempt. */
  sendOnce(key, send) {
    if (this.has(key)) return Promise.resolve(false);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.now() < (this.retryAt.get(key) || 0)) return Promise.resolve(false);
    const task = Promise.resolve().then(async () => {
      try {
        if (await send() !== true) {
          this.retryAt.set(key, this.now() + this.retryAfterMs);
          return false;
        }
        this.add(key);
        this.retryAt.delete(key);
        return true;
      } catch (error) {
        this.retryAt.set(key, this.now() + this.retryAfterMs);
        throw error;
      } finally {
        this.pending.delete(key);
        while (this.retryAt.size > this.limit) this.retryAt.delete(this.retryAt.keys().next().value);
      }
    });
    this.pending.set(key, task);
    return task;
  }
  /** Remembers the key; a failed write only means the alert may repeat after a restart. */
  add(key) {
    const keys = this.load();
    keys.add(key);
    while (keys.size > this.limit) keys.delete(keys.values().next().value);
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...keys]), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { AlertLog };
