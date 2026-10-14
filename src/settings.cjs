'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultAccounts, migrateLegacyAccount, validateAccount, validateAccounts } = require('./accounts.cjs');
const { t } = require('./i18n.cjs');
// Keys understood by 1.4.x and earlier live in `settings`. Newer preferences are
// written next to it under `preferences`, which 1.4.x ignores, so rolling back
// to an older build keeps every account instead of resetting to defaults.
const LEGACY_DEFAULTS = Object.freeze({ refreshSeconds: 120, launchAtLogin: false, startHidden: false, alwaysOnTop: false, notifications: true, resetNotifications: true, theme: 'system', mobileEnabled: false, trayMode: 'usage', accounts: defaultAccounts() });
const PREFERENCE_DEFAULTS = Object.freeze({ language: 'system', autoUpdate: true, claudeNoticeSeen: false });
const DEFAULTS = Object.freeze({ ...LEGACY_DEFAULTS, ...PREFERENCE_DEFAULTS });
const LEGACY_KEYS = Object.freeze(Object.keys(LEGACY_DEFAULTS));
const PREFERENCE_KEYS = Object.freeze(Object.keys(PREFERENCE_DEFAULTS));

function validateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(t('settings.badFormat'));
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(t('settings.unsupported'));
    if (key === 'refreshSeconds') { if (![60, 120, 300].includes(value)) throw new Error(t('settings.badRefresh')); }
    else if (key === 'theme') { if (!['system', 'light', 'dark'].includes(value)) throw new Error(t('settings.badTheme')); }
    else if (key === 'language') { if (!['system', 'ko', 'en'].includes(value)) throw new Error(t('settings.badLanguage')); }
    else if (key === 'accounts') { result[key] = validateAccounts(value); continue; }
    else if (key === 'trayMode') { if (!['usage', 'app'].includes(value)) throw new Error(t('settings.badTray')); }
    else if (typeof value !== 'boolean') throw new Error(t('settings.badValue'));
    result[key] = value;
  }
  return result;
}

/** Keep every valid account; drop only the broken ones and later duplicates. */
function salvageAccounts(source) {
  // Same { account, source } shape as the normal path, so a damaged accounts
  // value resets only the accounts and keeps every other saved setting.
  if (!Array.isArray(source)) return { accounts: defaultAccounts().map(account => ({ account, source: account })), dropped: source !== undefined };
  const accounts = [];
  let dropped = false;
  const seen = new Set();
  const defaults = new Set();
  for (const item of source.slice(0, 20)) {
    try {
      // Former automatic Gemini accounts become manual ones instead of being dropped.
      // Only the in-memory value changes; the file is rewritten on the next real save.
      const account = validateAccount(migrateLegacyAccount(item));
      if (seen.has(account.id) || (account.mode === 'default' && defaults.has(account.providerId))) { dropped = true; continue; }
      seen.add(account.id);
      if (account.mode === 'default') defaults.add(account.providerId);
      accounts.push({ account, source: item });
    } catch { dropped = true; }
  }
  if (source.length > 20) dropped = true;
  return { accounts, dropped };
}

/**
 * Reads settings written by any version. Unknown keys and individual invalid
 * values are skipped (and reported through `repaired`) rather than discarding
 * the whole file, so a newer or older build cannot wipe the account list.
 */
function migrateSavedSettings(saved, preferences = {}) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error(t('settings.badFormat'));
  const { primaryAccountId: rawPrimary, ...rest } = saved;
  const primaryAccountId = typeof rawPrimary === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawPrimary) ? rawPrimary : null;
  let repaired = rawPrimary !== undefined && rawPrimary !== null && primaryAccountId === null;
  const mode = rest.trayMode ?? 'accounts';
  const salvaged = salvageAccounts(rest.accounts ?? defaultAccounts());
  repaired ||= salvaged.dropped;
  const visibleAccounts = salvaged.accounts.map(entry => entry.account);
  const primary = mode === 'primary' ? visibleAccounts.find(account => account.id === primaryAccountId && account.visible) || visibleAccounts.find(account => account.visible) : null;
  const accounts = salvaged.accounts.map(({ account, source }) => ({
    ...account,
    // Older versions tied tray membership to the main screen. Preserve that
    // selection once, without writing to disk just because the app was opened.
    trayVisible: mode === 'primary' ? account.id === primary?.id : source && Object.hasOwn(source, 'trayVisible') ? account.trayVisible : account.visible,
  }));
  const candidate = { ...rest, ...(preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? preferences : {}), accounts, trayMode: mode === 'accounts' || mode === 'primary' ? 'usage' : mode };
  const result = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!Object.hasOwn(DEFAULTS, key)) { repaired = true; continue; }
    try { Object.assign(result, validateSettings({ [key]: value })); } catch { repaired = true; }
  }
  return Object.defineProperty(result, 'repaired', { value: repaired, enumerable: false });
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.value = { ...DEFAULTS, accounts: defaultAccounts() };
    this.mobileKey = crypto.randomBytes(32).toString('hex');
    // True until the key is on disk: a new install, or a key removed to revoke a shared iPhone URL.
    this.mobileKeyIsNew = true;
    this.loadError = null;
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') this.loadError = 'unreadable'; }
    if (raw !== null) {
      let saved = null;
      try { saved = JSON.parse(raw); } catch { this.loadError = 'corrupt'; }
      if (saved && typeof saved === 'object') {
        // The phone key is independent of settings validation.
        if (typeof saved.mobileKey === 'string' && /^[a-f0-9]{64}$/.test(saved.mobileKey)) { this.mobileKey = saved.mobileKey; this.mobileKeyIsNew = false; }
        try {
          const migrated = migrateSavedSettings(saved.settings, saved.preferences);
          this.value = { ...DEFAULTS, ...migrated };
          if (migrated.repaired) this.loadError = 'repaired';
        } catch { this.loadError = 'corrupt'; }
      } else this.loadError = 'corrupt';
      // Keep the original bytes before the first save can overwrite them.
      if (this.loadError) { try { fs.writeFileSync(`${this.file}.bak`, raw, { mode: 0o600 }); } catch { /* Best effort. */ } }
    }
  }

  serialize(value) {
    const settings = {}; const preferences = {};
    for (const key of LEGACY_KEYS) settings[key] = value[key];
    for (const key of PREFERENCE_KEYS) preferences[key] = value[key];
    return JSON.stringify({ settings, preferences, mobileKey: this.mobileKey }, null, 2);
  }

  save(patch) {
    const value = { ...this.value, ...validateSettings(patch) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, this.serialize(value), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.value = value;
    this.mobileKeyIsNew = false;
    return value;
  }
}
module.exports = { DEFAULTS, LEGACY_DEFAULTS, PREFERENCE_DEFAULTS, validateSettings, migrateSavedSettings, SettingsStore };
