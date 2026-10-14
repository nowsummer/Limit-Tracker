'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { t } = require('./i18n.cjs');
const CATALOG = Object.freeze([
  { id: 'claude', name: 'Claude', modes: ['default', 'isolated', 'manual'], automatic: true, description: '이 PC의 Claude Code 로그인 또는 계정별 별도 로그인', usageUrl: 'https://claude.ai/settings/usage' },
  { id: 'codex', name: 'Codex', modes: ['default', 'isolated', 'manual'], automatic: true, description: 'ChatGPT 구독의 Codex 한도를 계정별로 조회', usageUrl: 'https://chatgpt.com/codex/settings/usage' },
  // Manual entry only (1.6): Google's Gemini CLI terms forbid third-party software from using
  // its OAuth sign-in to reach the services behind it, so this app never reads or uses it.
  { id: 'gemini', name: 'Gemini CLI', modes: ['manual'], automatic: false, description: 'Google 약관 때문에 직접 입력만 지원 · 확인한 한도를 직접 기록', usageUrl: 'https://geminicli.com/docs/quota-and-pricing/' },
  { id: 'grok', name: 'Grok', modes: ['manual'], automatic: false, description: '자동 조회 API 미제공 · Grok 설정의 Usage를 보고 직접 기록', usageUrl: 'https://grok.com/' },
  { id: 'custom', name: '다른 AI', modes: ['manual'], automatic: false, description: '서비스 이름, 남은 비율과 초기화 시간을 직접 기록', usageUrl: null }
]);
const TRAY_METRICS = Object.freeze(['primary', 'fable']);
/** Catalog with names and descriptions in the current UI language. */
function localizedCatalog() {
  return CATALOG.map(provider => ({ ...provider, name: provider.id === 'custom' ? t('catalog.custom.name') : provider.name, description: t(`catalog.${provider.id}.description`) }));
}
/** Truncates by code point so emoji and astral characters are never split. */
function clip(value, max) { return [...String(value)].slice(0, max).join(''); }
function defaultAccounts() { return ['claude', 'codex'].map(id => ({ id, providerId: id, label: t('account.defaultLabel'), mode: 'default', visible: true, trayVisible: true, showFable: false, trayMetric: 'primary', manualWindows: [], recordedAt: null })); }
/**
 * 1.5 and earlier could read Gemini automatically ('default' or 'isolated'). 1.6
 * keeps such saved accounts as manual entries with the same id, name and
 * visibility instead of dropping them. Everything else passes through unchanged.
 */
function migrateLegacyAccount(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.providerId !== 'gemini' || !['default', 'isolated'].includes(input.mode)) return input;
  return { ...input, mode: 'manual', manualWindows: [], recordedAt: null };
}
function validateAccount(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(t('account.invalid'));
  const provider = CATALOG.find(p => p.id === input.providerId);
  if (!provider || !provider.modes.includes(input.mode)) throw new Error(t('account.modeUnsupported'));
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id)) throw new Error(t('account.badId'));
  if (typeof input.label !== 'string' || !input.label.trim() || [...input.label.trim()].length > 40) throw new Error(t('account.badLabel'));
  if (typeof input.visible !== 'boolean') throw new Error(t('account.badVisible'));
  if (Object.hasOwn(input, 'trayVisible') && typeof input.trayVisible !== 'boolean') throw new Error(t('account.badTray'));
  if (Object.hasOwn(input, 'showFable') && typeof input.showFable !== 'boolean') throw new Error(t('account.badFable'));
  if (input.showFable === true && provider.id !== 'claude') throw new Error(t('account.fableClaudeOnly'));
  if (Object.hasOwn(input, 'trayMetric') && input.trayMetric !== undefined && !TRAY_METRICS.includes(input.trayMetric)) throw new Error(t('account.badTrayMetric'));
  const windows = input.manualWindows ?? [];
  if (!Array.isArray(windows) || windows.length > 8) throw new Error(t('account.tooManyWindows'));
  const manualWindows = input.mode !== 'manual' ? [] : Array.from(windows, (w, index) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error(t('account.badWindow'));
    const left = w.remainingPercent ?? (typeof w.usedPercent === 'number' ? 100 - w.usedPercent : NaN);
    if (typeof left !== 'number' || !Number.isFinite(left) || left < 0 || left > 100) throw new Error(t('account.badPercent'));
    const reset = w.resetsAt ? new Date(w.resetsAt) : null;
    if (reset && !Number.isFinite(reset.getTime())) throw new Error(t('account.badReset'));
    // Store one decimal place so 100 - (100 - x) cannot produce 12.299999999999997.
    const remaining = Math.round(left * 10) / 10;
    return { id: `manual-${index}`, label: clip(String(w.label || t('account.windowLabel')).trim(), 40), usedPercent: Math.round((100 - remaining) * 10) / 10, remainingPercent: remaining, resetsAt: reset?.toISOString() || null, durationMinutes: Number.isFinite(w.durationMinutes) && w.durationMinutes > 0 ? w.durationMinutes : null };
  });
  // The Fable tray metric only means something for a Claude account that shows Fable.
  const trayMetric = provider.id === 'claude' && input.trayMetric === 'fable' ? 'fable' : 'primary';
  return { id: input.id, providerId: provider.id, label: input.label.trim(), mode: input.mode, visible: input.visible, trayVisible: input.trayVisible ?? true, showFable: input.showFable ?? false, trayMetric, manualWindows, recordedAt: input.recordedAt && Number.isFinite(Date.parse(input.recordedAt)) ? new Date(input.recordedAt).toISOString() : null };
}
function validateAccounts(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error(t('account.tooMany'));
  const accounts = Array.from(value, validateAccount);
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error(t('account.duplicateId'));
  const defaults = accounts.filter(a => a.mode === 'default').map(a => a.providerId);
  if (new Set(defaults).size !== defaults.length) throw new Error(t('account.duplicateDefault'));
  return accounts;
}
function prepareAccount(input, existing = []) {
  const previous = input?.id ? existing.find(a => a.id === input.id) : null;
  if (input?.id && !previous) throw new Error(t('error.accountNotFound'));
  if (previous && ((input.providerId && input.providerId !== previous.providerId) || (input.mode && input.mode !== previous.mode))) throw new Error(t('account.changeType'));
  const account = validateAccount({ visible: true, trayVisible: true, showFable: false, trayMetric: 'primary', label: t('account.newLabel'), manualWindows: [], ...previous, ...input, id: previous?.id || crypto.randomUUID(), recordedAt: previous?.recordedAt });
  if (account.mode === 'manual' && (!previous || JSON.stringify(account.manualWindows) !== JSON.stringify(previous.manualWindows))) account.recordedAt = new Date().toISOString();
  return { account, accounts: validateAccounts(previous ? existing.map(a => a.id === account.id ? account : a) : [...existing, account]) };
}
/** Windows environment names are case-insensitive; plain objects are not. */
function envKeys(env, name) { const upper = name.toUpperCase(); return Object.keys(env).filter(key => key.toUpperCase() === upper); }
function envGet(env, name) { const key = envKeys(env, name)[0]; return key === undefined ? undefined : env[key]; }
function envDelete(env, name) { for (const key of envKeys(env, name)) delete env[key]; }
function envSet(env, name, value) { envDelete(env, name); env[name] = value; }
function accountEnvironment(account, userData, inherited = process.env) {
  const env = { ...inherited };
  if (account.mode !== 'isolated') return env;
  // IDs are validated before reaching this boundary; also reject traversal for direct callers.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(account.id)) throw new Error(t('account.badId'));
  const directory = path.join(userData, 'accounts', account.id);
  if (account.providerId === 'claude') { envSet(env, 'CLAUDE_CONFIG_DIR', path.join(directory, 'claude')); for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) envDelete(env, name); }
  if (account.providerId === 'codex') { envSet(env, 'CODEX_HOME', path.join(directory, 'codex')); for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) envDelete(env, name); }
  return env;
}
function manualUsage(account) {
  const hasWindows = account.manualWindows.length > 0;
  // A Gemini account that used to be checked automatically says why it is now empty.
  const emptyKey = account.providerId === 'gemini' ? 'account.geminiManualOnly' : 'account.manualEmpty';
  return { status: hasWindows ? 'ok' : 'unsupported', plan: t('account.manualPlan', null, 'ko'), planKey: 'account.manualPlan', windows: account.manualWindows, updatedAt: account.recordedAt, manual: true, source: t('account.manualSource', null, 'ko'), sourceKey: 'account.manualSource', error: hasWindows ? null : t(emptyKey, null, 'ko'), errorKey: hasWindows ? null : emptyKey };
}
function visibleProviders(state) { const accounts = state.settings?.accounts; return state.providers.filter(p => p.visible !== false && (!Array.isArray(accounts) || accounts.some(a => a.id === p.id && a.visible))); }
function selectedProviders(state, select) {
  const accounts = state.settings?.accounts;
  if (!Array.isArray(accounts)) return state.providers.filter(select);
  const selected = new Set(accounts.filter(select).map(account => account.id));
  return state.providers.filter(provider => selected.has(provider.id));
}
function trayProviders(state) { return selectedProviders(state, account => account.trayVisible ?? account.visible !== false); }
function monitoredProviders(state) { return selectedProviders(state, account => account.visible !== false || (account.trayVisible ?? account.visible !== false)); }
function reorderAccounts(accounts, ids) {
  if (!Array.isArray(ids) || ids.length !== accounts.length || new Set(ids).size !== ids.length || Array.from(ids).some(id => typeof id !== 'string' || !accounts.some(a => a.id === id))) throw new Error(t('account.orderFailed'));
  const byId = new Map(accounts.map(a => [a.id, a])); return ids.map(id => byId.get(id));
}
module.exports = { CATALOG, TRAY_METRICS, localizedCatalog, defaultAccounts, migrateLegacyAccount, validateAccount, validateAccounts, prepareAccount, accountEnvironment, envGet, manualUsage, visibleProviders, trayProviders, monitoredProviders, reorderAccounts };
