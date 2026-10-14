'use strict';
const { t } = require('./i18n.cjs');
function used(window, now = Date.now()) {
  if (!window || window.resetsAt && Date.parse(window.resetsAt) <= now) return null;
  const value = Number.isFinite(window.usedPercent) ? window.usedPercent : Number.isFinite(window.remainingPercent) ? 100 - window.remainingPercent : null;
  return value !== null && value >= 0 && value <= 100 ? value : null;
}
const isFableLabel = w => /fable/i.test(`${w?.id || ''}${w?.label || ''}`);
// Fable is a Claude limit; a manual account may call its own limit anything.
const claudeFable = (p, w) => (p?.providerId || p?.id) === 'claude' && isFableLabel(w);
function primaryWindow(p) { const windows = (p.windows || []).filter(w => !claudeFable(p, w)); return windows.find(w => w.durationMinutes > 0 && w.durationMinutes <= 1440) || windows[0] || null; }
function fableWindow(p) { return (p.windows || []).find(w => claudeFable(p, w)) || null; }
/** The window the tray icon shows: Fable when the account asks for it and has one. */
function trayWindow(p) {
  if (p?.trayMetric === 'fable' && p.showFable) { const fable = fableWindow(p); if (fable) return fable; }
  return primaryWindow(p);
}
function weeklyWindow(p, primary) { return (p.windows || []).find(w => w !== primary && !claudeFable(p, w) && !/sonnet|opus|oauth/i.test(w.id + w.label) && (w.durationMinutes >= 10000 || /week|주간|7일/i.test(w.id + w.label))); }
function shortName(p) { return [...(({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' })[p.providerId || p.id] || p.name || 'AI')].slice(0, 12).join(''); }
function accountName(p, maxLength = 10) { const fallback = t('pres.default'); const name = (p.accountLabel || fallback).replace(/\s*계정$/, '').trim() || fallback; return [...name].slice(0, maxLength).join(''); }
function formatUsed(w, now) { const value = used(w, now); return value === null ? '—' : `${Math.round(value)}%`; }
function compactSummary(p, now = Date.now()) {
  const name = `${shortName(p)} ${accountName(p)}`;
  if (!(p.windows || []).length) return `${name} · ${p.status === 'loading' ? t('pres.connecting') : p.status === 'disconnected' ? t('pres.loginRequired') : t('pres.checkRequired')}`;
  const primary = primaryWindow(p); const week = weeklyWindow(p, primary);
  return `${name} · ${formatUsed(primary, now)}${week ? ' / ' + formatUsed(week, now) : ''}${p.stale ? t('pres.staleSuffix') : p.manual ? t('pres.manualSuffix') : ''}`;
}
function trayTooltip(providers, now = Date.now()) {
  if (!providers.length) return t('tray.selectAccounts');
  const header = t('tray.header');
  const rows = [];
  for (const p of providers) {
    const reset = resetRemaining(primaryWindow(p), now);
    const row = `${compactSummary(p, now)}${reset ? ' · ' + reset : ''}`;
    const suffix = providers.length > rows.length + 1 ? `\n${t('tray.more', { count: providers.length - rows.length - 1 })}` : '';
    if ([header, ...rows, row].join('\n').length + suffix.length > 127) break;
    rows.push(row);
  }
  if (rows.length < providers.length) rows.push(t('tray.more', { count: providers.length - rows.length }));
  return [header, ...rows].join('\n');
}
function resetRemaining(w, now = Date.now()) {
  const at = Date.parse(w?.resetsAt);
  if (!Number.isFinite(at)) return '';
  if (at <= now) return t('pres.waiting');
  const minutes = Math.ceil((at - now) / 60000);
  if (minutes >= 1440) return t('pres.daysHours', { days: Math.floor(minutes / 1440), hours: Math.floor(minutes % 1440 / 60) });
  if (minutes >= 60) return t('pres.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return t('pres.minutes', { minutes });
}
function singleTooltip(p, now = Date.now()) {
  if (!p.windows?.length) return compactSummary(p, now).slice(0, 127);
  const primary = primaryWindow(p);
  const week = weeklyWindow(p, primary);
  const fable = p.showFable ? fableWindow(p) : null;
  const rows = [`${shortName(p)} · ${accountName(p, 16)}${p.stale ? t('pres.staleTag') : p.manual ? t('pres.manualTag') : ''}`];
  // The window that the icon's number shows is listed first.
  const ordered = trayWindow(p) === fable && fable ? [fable, primary, week] : [primary, week, fable];
  for (const w of ordered.filter(Boolean)) {
    const label = w === fable ? t('pres.fable') : w === week ? t('pres.weekly') : [...(w.label || t('pres.short'))].slice(0, 10).join('');
    const reset = resetRemaining(w, now);
    const row = t('pres.row', { label, used: formatUsed(w, now), reset: reset || t('pres.noReset') });
    if ([...rows, row].join('\n').length <= 127) rows.push(row);
  }
  return rows.join('\n');
}
module.exports = { used, primaryWindow, fableWindow, trayWindow, compactSummary, trayTooltip, singleTooltip, resetRemaining };
