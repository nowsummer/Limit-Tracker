'use strict';

(() => {
  const i18n = window.LimitI18n;
  const t = (key, params) => (i18n ? i18n.t(key, params) : key);
  const locale = () => (i18n ? i18n.t('locale') : 'ko-KR');
  const icons = {
    app: '<rect x=".75" y=".75" width="22.5" height="22.5" rx="5.625" fill="#176cde" stroke="none"/><rect x="6" y="11.625" width="4.5" height="7.5" rx="2.25" fill="#cadfff" stroke="none"/><rect x="13.5" y="5.25" width="4.5" height="13.875" rx="2.25" fill="#fafdff" stroke="none"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-7.5-7.5h1.5"/><path d="m11 1.5 3 3-3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14Z"/>',
    accounts: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
    custom: '<path d="M8 5h8M8 19h8M5 8v8M19 8v8"/><rect x="7" y="7" width="10" height="10" rx="3"/>',
    settings: '<path d="m9.1 4 .7-2h4.4l.7 2 2.1 1.2 2.1-.4 2.2 3.8-1.4 1.6v2.4l1.4 1.6-2.2 3.8-2.1-.4-2.1 1.2-.7 2H9.8l-.7-2L7 18l-2.1.4-2.2-3.8 1.4-1.6v-2.4L2.7 9l2.2-3.8 2.1.4L9.1 4Z"/><circle cx="12" cy="11.8" r="3.2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    minimize: '<path d="M5 12h14"/>',
    // A plain upright push-pin: the head is filled when "always on top" is on.
    pin: '<path class="pin-head" d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 14v7"/>',
    external: '<path d="M14 4h6v6M20 4 10 14"/><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    grip: '<path d="M5 8h14M5 12h14M5 16h14"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10 5h4M11 18.5h2"/>',
    tray: '<path d="M4 10 2.5 17v3h19v-3L20 10M2.5 17H8l1.5 2h5l1.5-2h5.5"/><path d="M12 3v10m-3-3 3 3 3-3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.5v.1"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  };

  // Service logos identify each provider only; see assets/brands/NOTICE.md (not MIT).
  const brandIcons = {
  "claude": {
    "viewBox": "0 0 125 125",
    "body": "<path d=\"M54.375 118.75L56.125 111L58.125 101L59.75 93L61.25 83.125L62.125 79.875L62 79.625L61.375 79.75L53.875 90L42.5 105.375L33.5 114.875L31.375 115.75L27.625 113.875L28 110.375L30.125 107.375L42.5 91.5L50 81.625L54.875 76L54.75 75.25H54.5L21.5 96.75L15.625 97.5L13 95.125L13.375 91.25L14.625 90L24.5 83.125L49.125 69.375L49.5 68.125L49.125 67.5H47.875L43.75 67.25L29.75 66.875L17.625 66.375L5.75 65.75L2.75 65.125L0 61.375L0.25 59.5L2.75 57.875L6.375 58.125L14.25 58.75L26.125 59.5L34.75 60L47.5 61.375H49.5L49.75 60.5L49.125 60L48.625 59.5L36.25 51.25L23 42.5L16 37.375L12.25 34.75L10.375 32.375L9.625 27.125L13 23.375L17.625 23.75L18.75 24L23.375 27.625L33.25 35.25L46.25 44.875L48.125 46.375L49 45.875V45.5L48.125 44.125L41.125 31.375L33.625 18.375L30.25 13L29.375 9.75C29.0417 8.625 28.875 7.375 28.875 6L32.75 0.750006L34.875 0L40.125 0.750006L42.25 2.625L45.5 10L50.625 21.625L58.75 37.375L61.125 42.125L62.375 46.375L62.875 47.75H63.75V47L64.375 38L65.625 27.125L66.875 13.125L67.25 9.125L69.25 4.375L73.125 1.87501L76.125 3.25L78.625 6.875L78.25 9.125L76.875 18.75L73.875 33.875L72 44.125H73.125L74.375 42.75L79.5 36L88.125 25.25L91.875 21L96.375 16.25L99.25 14H104.625L108.5 19.875L106.75 26L101.25 33L96.625 38.875L90 47.75L86 54.875L86.375 55.375H87.25L102.125 52.125L110.25 50.75L119.75 49.125L124.125 51.125L124.625 53.125L122.875 57.375L112.625 59.875L100.625 62.25L82.75 66.5L82.5 66.625L82.75 67L90.75 67.75L94.25 68H102.75L118.5 69.125L122.625 71.875L125 75.125L124.625 77.75L118.25 80.875L109.75 78.875L89.75 74.125L83 72.5H82V73L87.75 78.625L98.125 88L111.25 100.125L111.875 103.125L110.25 105.625L108.5 105.375L97 96.625L92.5 92.75L82.5 84.375H81.875V85.25L84.125 88.625L96.375 107L97 112.625L96.125 114.375L92.875 115.5L89.5 114.875L82.25 104.875L74.875 93.5L68.875 83.375L68.25 83.875L64.625 121.625L63 123.5L59.25 125L56.125 122.625L54.375 118.75Z\"></path>"
  },
  "codex": {
    "viewBox": "0 0 24 24",
    "body": "<path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z\"></path>"
  },
  "gemini": {
    "viewBox": "0 0 192 192",
    "body": "<path d=\"M164.93 86.68c-13.56-5.84-25.42-13.84-35.6-24.01-10.17-10.17-18.18-22.04-24.01-35.6-2.23-5.19-4.04-10.54-5.42-16.02C99.45 9.26 97.85 8 96 8s-3.45 1.26-3.9 3.05c-1.38 5.48-3.18 10.81-5.42 16.02-5.84 13.56-13.84 25.43-24.01 35.6-10.17 10.16-22.04 18.17-35.6 24.01-5.19 2.23-10.54 4.04-16.02 5.42C9.26 92.55 8 94.15 8 96s1.26 3.45 3.05 3.9c5.48 1.38 10.81 3.18 16.02 5.42 13.56 5.84 25.42 13.84 35.6 24.01 10.17 10.17 18.18 22.04 24.01 35.6 2.24 5.2 4.04 10.54 5.42 16.02A4.03 4.03 0 0 0 96 184c1.85 0 3.45-1.26 3.9-3.05 1.38-5.48 3.18-10.81 5.42-16.02 5.84-13.56 13.84-25.42 24.01-35.6 10.17-10.17 22.04-18.18 35.6-24.01 5.2-2.24 10.54-4.04 16.02-5.42A4.03 4.03 0 0 0 184 96c0-1.85-1.26-3.45-3.05-3.9-5.48-1.38-10.81-3.18-16.02-5.42\"/>"
  },
  "grok": {
    "viewBox": "0 0 512 512",
    "body": "<path d=\"M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.198C390.807 149.726 411.218 120.359 453.03 60.3072C454.02 58.8833 455.01 57.4595 456 56L400.978 113.382V113.204L210.45 312.794\"/><path d=\"M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 84.0229 422.575C74.0561 433.503 64.0553 444.431 56 456L183.007 337.677\"/>"
  }
};

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', brandIcons[name]?.viewBox || '0 0 24 24');
    svg.setAttribute('class', brandIcons[name] ? 'icon brand-icon' : 'icon');
    svg.setAttribute('aria-hidden', 'true');
    // Only the static markup above is ever assigned here.
    svg.innerHTML = brandIcons[name]?.body || icons[name] || icons.info;
    return svg;
  }

  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(node => {
      if (!node.querySelector('svg')) node.append(icon(node.dataset.icon));
    });
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  let tipCount = 0;
  /**
   * A small "ⓘ" button whose explanation appears on hover, keyboard focus or
   * click. The bubble lives in the top layer, so a scrolling sheet never clips it.
   */
  function infoTip(text, label = t('tip.label'), focusKey = '') {
    const wrap = el('span', 'info-tip');
    const button = el('button', 'info-tip-button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.append(icon('info'));
    if (focusKey) button.dataset.focusKey = focusKey;
    const bubble = el('span', 'info-bubble');
    String(text).split('\n').filter(Boolean).forEach(line => bubble.append(el('span', 'info-line', line)));
    bubble.id = `info-tip-${++tipCount}`;
    bubble.setAttribute('role', 'tooltip');
    bubble.setAttribute('popover', 'manual');
    button.setAttribute('aria-describedby', bubble.id);
    let pinned = false;
    const place = () => {
      const anchor = button.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 24);
      bubble.style.width = `${width}px`;
      const left = Math.max(12, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 12));
      bubble.style.left = `${Math.round(left)}px`;
      const height = bubble.offsetHeight;
      const below = anchor.bottom + 8;
      const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - 8 - height);
      bubble.style.top = `${Math.round(top)}px`;
    };
    // The bubble sits in the top layer, so it would not follow a scrolling sheet:
    // like a native tooltip, it closes on scroll or resize.
    const onMove = () => hide();
    const show = () => {
      if (typeof bubble.showPopover !== 'function') return;
      try { if (!bubble.matches(':popover-open')) bubble.showPopover(); } catch { return; }
      place();
      document.addEventListener('scroll', onMove, { capture: true, passive: true });
      window.addEventListener('resize', onMove);
    };
    const hide = () => {
      pinned = false;
      document.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      try { bubble.hidePopover(); } catch { /* Already hidden. */ }
    };
    button.addEventListener('mouseenter', show);
    button.addEventListener('mouseleave', () => { if (!pinned) hide(); });
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) show(); });
    button.addEventListener('blur', hide);
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); pinned = !pinned; if (pinned) show(); else hide(); });
    button.addEventListener('keydown', event => { if (event.key === 'Escape' && bubble.matches(':popover-open')) { event.stopPropagation(); event.preventDefault(); hide(); } });
    wrap.append(button, bubble);
    return wrap;
  }

  function percent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
    return value;
  }

  function remaining(window) {
    if (!window) return null;
    const reset = validDate(window.resetsAt);
    if (reset && reset.getTime() <= Date.now()) return null;
    const left = percent(window.remainingPercent);
    if (left !== null) return left;
    const used = percent(window.usedPercent);
    return used === null ? null : 100 - used;
  }

  function used(window) {
    if (!window) return null;
    const reset = validDate(window.resetsAt);
    if (reset && reset.getTime() <= Date.now()) return null;
    const value = percent(window.usedPercent);
    if (value !== null) return value;
    const left = percent(window.remainingPercent);
    return left === null ? null : 100 - left;
  }

  function formatPercent(value) {
    return value === null ? '—' : new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value);
  }

  function isFableWindow(window) { return /fable/i.test(`${window?.id || ''} ${window?.label || ''}`); }
  // Fable is a Claude limit; other services may name their own limit anything, including "Fable".
  function isProviderFable(provider, window) { return (provider?.providerId || provider?.id) === 'claude' && isFableWindow(window); }

  function primaryWindow(provider) {
    const windows = (Array.isArray(provider.windows) ? provider.windows : []).filter(window => !isProviderFable(provider, window));
    return windows.find(window => window.durationMinutes > 0 && window.durationMinutes <= 1440)
      || windows.find(window => /^(primary|session|five_hour|5h|five-hour)$/i.test(window.id || ''))
      || windows[0]
      || null;
  }

  function overviewWindows(provider) {
    const primary = primaryWindow(provider);
    const rest = (provider.windows || []).filter(window => window !== primary && !isProviderFable(provider, window));
    const weekly = rest.find(window => /^(secondary|weekly|seven_day|7d|seven-day)$/i.test(window.id || ''))
      || rest.find(window => window.durationMinutes >= 10080 && !/sonnet|opus|model/i.test(window.id || ''))
      || rest.find(window => /주간|weekly|7.day/i.test(window.label || '') && !/sonnet|opus|model/i.test(window.id || ''));
    const fable = (provider.providerId || provider.id) === 'claude' && provider.showFable === true
      ? (provider.windows || []).filter(isFableWindow) : [];
    return { primary, weekly: weekly || null, extra: rest.filter(window => window !== weekly), fable };
  }

  function windowSummary(window, provider) {
    const value = used(window);
    const item = el('div', `window-summary${value === null ? ' unknown' : value >= 95 ? ' low' : value >= 80 ? ' medium' : ''}`);
    const label = window.label || t('card.fableSummary');
    item.append(el('span', 'window-summary-label', label), el('strong', '', value === null ? '—' : `${formatPercent(value)}%`));
    item.title = `${label} · ${countdown(window.resetsAt, provider)} · ${exactTime(window.resetsAt)}`;
    item.setAttribute('aria-label', t('card.fableAria', { label, value: value === null ? t('card.unknownShort') : `${formatPercent(value)}%`, countdown: countdown(window.resetsAt, provider) }));
    return item;
  }

  function statusDetails(provider) {
    const lastSeen = provider.lastSuccessAt || provider.updatedAt;
    const manual = provider.manual || provider.mode === 'manual';
    const details = [];
    if (manual) details.push(t('status.manualDetail'));
    if (provider.stale && provider.error) details.push(provider.error);
    if (validDate(lastSeen)) details.push(`${manual ? t('status.entered') : t('status.lastChecked')}: ${exactTime(lastSeen)}`);
    if (validDate(provider.loginExpiresAt)) details.push(t('status.loginUntil', { time: exactTime(provider.loginExpiresAt) }));
    if (provider.source) details.push(String(provider.source));
    return details;
  }

  /** Normal ("connected") accounts show no badge at all; call sites check showsStatus first. */
  function showsStatus(provider) { return providerStatus(provider).className !== 'connected'; }

  function statusBadge(provider, { onRelogin = null } = {}) {
    const status = providerStatus(provider);
    const interactive = status.relogin && typeof onRelogin === 'function';
    const badge = el(interactive ? 'button' : 'span', `provider-status ${status.className}`, status.label);
    const details = statusDetails(provider);
    if (status.relogin) details.push(t('login.periodShort'));
    if (interactive) {
      badge.type = 'button';
      badge.dataset.focusKey = `${provider.id}-relogin`;
      badge.addEventListener('click', () => onRelogin(badge));
      details.unshift(t('status.reloginAction'));
    }
    badge.title = details.join(' ');
    if (details.length) badge.setAttribute('aria-label', `${status.label}. ${details.join(' ')}`);
    return badge;
  }

  /** "More limits (2)" with the highest one surfaced when it is 80% or more. */
  function extraSummary(extra, provider, labelKey = null) {
    const manual = provider.manual || provider.mode === 'manual';
    // Claude model-scoped weekly rows are seven_day_<model>; surface rows, the old
    // 'apps' row, Codex buckets and manual entries are not known to be per model.
    const perModel = !manual && (provider.providerId || provider.id) === 'claude' && extra.every(window => /^seven_day_(?!surface_|oauth_apps$)/.test(String(window?.id || '')));
    const text = t(labelKey || (perModel ? 'card.extraCount' : 'card.extraCountManual'), { count: extra.length });
    const summary = el('summary', '', text);
    summary.dataset.focusKey = `${provider.id}-extra`;
    const peak = extra.map(window => ({ window, value: used(window) })).filter(item => item.value !== null).sort((a, b) => b.value - a.value)[0];
    if (peak && peak.value >= 80) {
      summary.classList.add(peak.value >= 95 ? 'low' : 'medium');
      summary.append(el('strong', 'extra-peak', `${formatPercent(peak.value)}%`));
      summary.setAttribute('aria-label', t('card.extraPeakAria', { label: text, value: formatPercent(peak.value) }));
      summary.title = `${peak.window.label || t('card.extraLimit')} · ${countdown(peak.window.resetsAt, provider)}`;
    }
    return summary;
  }

  function validDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function exactTime(value, withDate = true, withSeconds = true) {
    const date = validDate(value);
    if (!date) return t('reset.none');
    const options = withDate
      ? { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) };
    return new Intl.DateTimeFormat(locale(), options).format(date);
  }

  function countdown(value, provider) {
    const date = validDate(value);
    if (!date) return t('reset.none');
    const minutes = Math.ceil((date.getTime() - Date.now()) / 60000);
    if (minutes <= 0) return provider?.manual || provider?.mode === 'manual' ? t('reset.manualDue') : t('reset.pending');
    if (minutes < 60) return t('reset.minutes', { minutes });
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    const mins = minutes % 60;
    if (days > 0) return t('reset.days', { days, hours: hours > 0 ? t('reset.daysHours', { hours }) : '' });
    return t('reset.hours', { hours, minutes: mins > 0 ? t('reset.hoursMinutes', { minutes: mins }) : '' });
  }

  function resetBlock(window, compact = false, provider) {
    const block = el('div', 'reset-block');
    block.append(icon('clock'));
    const label = el('span', 'reset-countdown', countdown(window?.resetsAt, provider));
    if (validDate(window?.resetsAt)) label.dataset.reset = window.resetsAt;
    if (provider?.manual || provider?.mode === 'manual') label.dataset.manual = 'true';
    block.append(label);
    if (validDate(window?.resetsAt)) {
      block.title = t('reset.scheduled', { time: exactTime(window.resetsAt) });
      const exact = el('time', 'reset-exact', exactTime(window.resetsAt));
      exact.dateTime = window.resetsAt;
      block.append(exact);
    }
    if (compact) block.classList.add('compact');
    return block;
  }

  function renderRing(provider, primary) {
    const left = used(primary);
    const ring = el('div', `remaining-ring${left === null ? ' unknown' : left >= 95 ? ' low' : left >= 80 ? ' medium' : ''}`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ring-svg');
    svg.setAttribute('viewBox', '0 0 180 180');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'ring-track');
    circle.setAttribute('cx', '90');
    circle.setAttribute('cy', '90');
    circle.setAttribute('r', '80');
    svg.append(circle);
    if (left !== null) {
      const value = circle.cloneNode();
      value.setAttribute('class', 'ring-value');
      value.setAttribute('stroke-dasharray', String(2 * Math.PI * 80));
      value.setAttribute('stroke-dashoffset', String(2 * Math.PI * 80 * (1 - left / 100)));
      svg.append(value);
    }
    ring.append(svg);
    const center = el('div', 'ring-center');
    center.append(el('span', 'ring-label', t('card.ringLabel')));
    const value = el('div', 'remaining-value', formatPercent(left));
    if (left !== null) value.append(el('span', 'remaining-unit', '%'));
    center.append(value);
    ring.append(center);
    return ring;
  }

  function windowMeter(window, label, provider) {
    const valueUsed = used(window);
    const title = label || window?.label || t('card.extraLimit');
    const item = el('div', `usage-window${valueUsed === null ? ' unknown' : valueUsed >= 95 ? ' low' : valueUsed >= 80 ? ' medium' : ''}`);
    const header = el('div', 'usage-window-header');
    header.append(el('span', 'usage-window-label', title));
    const value = el('span', 'usage-window-value');
    value.append(el('strong', '', valueUsed === null ? '—' : `${formatPercent(valueUsed)}%`));
    header.append(value);
    const meter = el('div', 'usage-meter');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', t('card.usageOf', { label: title }));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    if (valueUsed !== null) {
      meter.setAttribute('aria-valuenow', String(valueUsed));
      const fill = el('div', 'usage-meter-value');
      fill.style.width = `${valueUsed}%`;
      meter.append(fill);
    } else meter.setAttribute('aria-valuetext', t('card.unknownValue'));
    const reset = resetBlock(window, true, provider);
    reset.title = exactTime(window?.resetsAt);
    if (!window) reset.replaceChildren(el('span', 'reset-countdown', t('card.noWindow')));
    item.append(header, meter, reset);
    return item;
  }

  function providerStatus(provider) {
    if (!(provider.windows || []).length && (provider.refreshing || provider.status === 'loading')) return { label: t('status.checking'), className: 'pending' };
    if (provider.manual || provider.mode === 'manual') return { label: t('status.manual'), className: 'manual' };
    if (provider.stale) return { label: t('status.stale'), className: 'warning' };
    if (validDate(primaryWindow(provider)?.resetsAt)?.getTime() <= Date.now()) return { label: t('status.resetPending'), className: 'pending' };
    if (provider.status === 'ok' || (provider.status === 'loading' && (provider.windows || []).length)) {
      const loginEnds = validDate(provider.loginExpiresAt)?.getTime();
      if (loginEnds && loginEnds - Date.now() < 3 * 86400000) {
        const ms = loginEnds - Date.now();
        const label = ms <= 0 ? t('status.reloginNow') : ms < 86400000 ? t('status.reloginHours', { hours: Math.max(1, Math.ceil(ms / 3600000)) }) : t('status.reloginDays', { days: Math.max(1, Math.round(ms / 86400000)) });
        return { label, className: 'warning', relogin: true };
      }
      return { label: t('status.connected'), className: 'connected' };
    }
    if (provider.status === 'disconnected') return { label: t('status.loginRequired'), className: '' };
    if (provider.status === 'unsupported') return { label: t('status.unsupported'), className: '' };
    return { label: t('status.error'), className: 'error' };
  }

  function providerName(provider) {
    const id = provider.providerId || provider.id;
    return ({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini CLI', grok: 'Grok', custom: t('provider.custom') })[id] || provider.name || t('provider.custom');
  }

  function planLabel(provider) {
    if (!provider.plan) return provider.manual || provider.mode === 'manual' ? t('card.manualRecord') : '';
    return String(provider.plan).replace(/^claude\s+/i, '').replace(/\b(plus|pro|max|free|team|enterprise|business)\b/gi, word => word[0].toUpperCase() + word.slice(1).toLowerCase());
  }

  function orderedProviders(state) {
    const accounts = state.settings?.accounts || [];
    const config = new Map(accounts.map((account, index) => [account.id, { account, index }]));
    return (state.providers || []).map(provider => {
      const account = config.get(provider.id)?.account;
      return { ...provider, visible: account?.visible ?? provider.visible ?? true,
        trayVisible: account?.trayVisible ?? provider.trayVisible ?? account?.visible ?? provider.visible ?? true,
        showFable: account?.showFable ?? provider.showFable ?? false,
        trayMetric: account?.trayMetric ?? provider.trayMetric ?? 'primary' };
    }).sort((a, b) => (config.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER) - (config.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER));
  }

  function visibleProviders(state) { return orderedProviders(state).filter(provider => provider.visible !== false); }

  function trayProviders(state) {
    return state.settings?.trayMode === 'app' ? visibleProviders(state) : orderedProviders(state).filter(provider => provider.trayVisible !== false);
  }

  function formatCredits(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    // Ordinary amounts keep two decimals; a balance under 1 keeps two significant digits, so it never reads as 0.
    return new Intl.NumberFormat(i18n?.getLanguage?.() === 'en' ? 'en-US' : 'ko-KR', number < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 }).format(number);
  }
  /**
   * Codex usage resets and credits that let an account keep going past a limit. Shown
   * only from 80% of the current or weekly limit, from a fresh reading. Claude's usage
   * reply carries no balance or reset grants, so nothing is claimed for it.
   */
  function afterLimitInfo(provider) {
    const info = provider?.afterLimit;
    if (!info || typeof info !== 'object' || (provider.providerId || provider.id) !== 'codex') return null;
    if (provider.status !== 'ok' || provider.stale || provider.manual || provider.mode === 'manual') return null;
    const { primary, weekly } = overviewWindows(provider);
    const peak = Math.max(-1, ...[primary, weekly].map(window => used(window) ?? -1));
    if (peak < 80) return null;
    const parts = [];
    // Past the earliest use-by, wait for the next reading instead of offering a reset that may be gone.
    const resetExpiry = validDate(info.resetsExpireAt);
    const resets = Number.isInteger(info.resets) && info.resets > 0 && !(resetExpiry && resetExpiry.getTime() <= Date.now()) ? info.resets : 0;
    const credits = [];
    if (info.unlimitedCredits === true) credits.push(t('card.creditsUnlimited'));
    else if (typeof info.creditBalance === 'string' && Number(info.creditBalance) > 0 && formatCredits(info.creditBalance)) credits.push(t(Number(info.creditBalance) === 1 ? 'card.creditsOne' : 'card.credits', { balance: formatCredits(info.creditBalance) }));
    if (resets) parts.push(t(resets === 1 ? 'card.resetsOne' : 'card.resetsMany', { count: resets }));
    parts.push(...credits);
    if (!parts.length) return null;
    const expires = resets ? resetExpiry : null;
    return {
      text: parts.join(' · '),
      title: expires ? t(resets === 1 ? 'card.resetsUseBy' : 'card.resetsEarliestUseBy', { time: exactTime(info.resetsExpireAt, true, false) }) : '',
      // What remains once the earliest use-by passes, so a line already on screen can update itself.
      expiresAt: expires ? expires.toISOString() : null,
      afterExpiry: credits.join(' · '),
    };
  }
  function afterLimitLine(provider) {
    const info = afterLimitInfo(provider);
    if (!info) return null;
    const line = el('div', 'after-limit', info.text);
    line.setAttribute('role', 'note');
    line.setAttribute('aria-label', [info.text, info.title].filter(Boolean).join(', '));
    // The whole text on hover too: a narrow window may cut the line short.
    line.title = [info.text, info.title].filter(Boolean).join(' · ');
    if (info.expiresAt) { line.dataset.resetsExpire = info.expiresAt; line.dataset.afterExpiry = info.afterExpiry; }
    return line;
  }

  function renderProvider(provider, handlers = {}) {
    const name = providerName(provider);
    const kind = provider.providerId || provider.id;
    const { primary, weekly, extra, fable } = overviewWindows(provider);
    const checking = !primary && (provider.refreshing || provider.status === 'loading');
    const manual = provider.manual || provider.mode === 'manual';
    const card = el('article', `provider-card ${kind}${!primary && !fable.length ? ' no-usage' : ''}`);
    card.dataset.accountId = provider.id;
    card.setAttribute('aria-label', t('card.usageAria', { name, account: provider.accountLabel || '' }));
    const heading = el('div', 'provider-heading');
    const logo = el('div', 'provider-logo');
    logo.append(icon(kind));
    const names = el('div', 'provider-identity');
    names.append(el('h2', 'provider-name', name));
    const account = el('div', 'provider-plan', provider.accountLabel || planLabel(provider) || t('card.defaultAccount'));
    account.title = [provider.accountLabel, planLabel(provider), ...statusDetails(provider)].filter(Boolean).join(' · ');
    names.append(account);
    if (showsStatus(provider)) names.append(statusBadge(provider, { onRelogin: handlers.openExternal ? button => handlers.openExternal('login', provider.id, button) : null }));
    heading.append(logo, names);
    card.append(heading);

    if (primary) {
      const meters = el('div', 'overview-windows');
      meters.append(windowMeter(primary, primary.label || t('card.currentLimit'), provider), windowMeter(weekly, weekly?.label || t('card.weeklyLimit'), provider));
      card.append(meters);
    } else if (!fable.length) {
      const empty = el('div', 'empty-message');
      const disconnected = provider.status === 'disconnected';
      empty.append(el('h3', '', checking ? t('card.checking') : manual ? t('card.enterUsage') : disconnected ? t('card.loginNeeded') : t('card.unavailable')));
      const message = el('p', '', checking ? t('card.checkingBody') : provider.error || (manual ? t('card.enterUsageBody') : t('card.unavailableBody')));
      message.title = message.textContent;
      empty.append(message);
      if (!checking) {
        const button = el('button', 'text-button provider-page', manual ? t('card.enterButton') : disconnected ? t('card.loginButton') : t('card.openUsagePage'));
        button.type = 'button';
        button.dataset.focusKey = `${provider.id}-connect`;
        button.append(icon(manual ? 'edit' : 'external'));
        button.addEventListener('click', () => manual ? handlers.editAccount?.(provider.id) : handlers.openExternal?.(disconnected ? 'login' : 'usage', provider.id, button));
        empty.append(button);
      }
      card.append(empty);
    }

    // The second row lines up with the meters: Fable belongs to the weekly column.
    const cell = el('div', 'provider-bottom-cell');
    if (fable.length) {
      const limits = el('div', 'fable-limits');
      fable.forEach(window => limits.append(windowSummary(window, provider)));
      cell.append(limits);
    }
    if (extra.length) {
      const details = el('details', 'extra-windows');
      const panel = el('div', 'usage-windows extra-panel');
      panel.id = `extra-${provider.id}`;
      extra.forEach(window => panel.append(windowMeter(window, undefined, provider)));
      const summary = extraSummary(extra, provider);
      summary.setAttribute('aria-controls', panel.id);
      details.append(summary);
      card.append(details, panel);
    }
    if (manual) {
      // A pencil, like everywhere else, so the Fable value beside it keeps its full label.
      const page = el('button', 'text-button provider-page icon-only');
      page.type = 'button';
      page.title = t('card.editRecord');
      page.setAttribute('aria-label', t('card.editRecord'));
      page.append(icon('edit'));
      page.dataset.focusKey = `${provider.id}-usage`;
      page.addEventListener('click', () => handlers.editAccount?.(provider.id));
      cell.append(page);
    }
    // Usage resets / credits sit under the current-limit column, the one cell free on every card.
    const after = primary ? afterLimitLine(provider) : null;
    if (cell.childElementCount || after) {
      const bottom = el('div', `provider-bottom${primary ? '' : ' no-meters'}`);
      if (after) bottom.append(after);
      if (cell.childElementCount) bottom.append(cell);
      card.append(bottom);
    }
    return card;
  }

  function tickCountdowns(root = document) {
    root.querySelectorAll('[data-reset]').forEach(node => { node.textContent = countdown(node.dataset.reset, { manual: node.dataset.manual === 'true' }); });
    // A usage reset past its use-by is no longer offered; credits on the same line stay.
    root.querySelectorAll('.after-limit[data-resets-expire]').forEach(node => {
      if (!(Date.parse(node.dataset.resetsExpire) <= Date.now())) return;
      const rest = node.dataset.afterExpiry || '';
      if (!rest) { node.remove(); return; }
      node.textContent = rest; node.title = rest; node.setAttribute('aria-label', rest);
      delete node.dataset.resetsExpire;
    });
  }

  function expirySignature(providers) {
    return (providers || []).flatMap(provider => (provider.windows || []).map(window => {
      const date = validDate(window.resetsAt);
      return `${provider.id}:${window.id}:${date && date.getTime() <= Date.now() ? 1 : 0}`;
    })).join('|');
  }

  function safeError(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '';
    return message.trim() ? message.replace(/^Error invoking remote method '[^']+': Error: /, '').slice(0, 300) : fallback;
  }

  function placeholderProviders(message) {
    return ['claude', 'codex'].map(id => ({ id, providerId: id, name: id === 'claude' ? 'Claude' : 'Codex', status: message ? 'error' : 'loading', refreshing: !message, windows: [], plan: null, error: message || null, source: null, updatedAt: null }));
  }

  /** Switches the UI language; returns true when it changed. */
  function setLanguage(language) {
    if (!i18n) return false;
    const changed = i18n.setLanguage(language === 'en' ? 'en' : 'ko');
    if (changed || !document.documentElement.dataset.i18nApplied) { i18n.apply(); document.documentElement.dataset.i18nApplied = 'true'; }
    return changed;
  }

  window.LimitUI = { t, setLanguage, icon, afterLimitInfo, afterLimitLine, hydrateIcons, el, infoTip, statusDetails, showsStatus, extraSummary, percent, remaining, used, formatPercent, primaryWindow, overviewWindows, isFableWindow, windowSummary, statusBadge, validDate, exactTime, countdown, resetBlock, renderRing, windowMeter, providerStatus, providerName, planLabel, visibleProviders, trayProviders, renderProvider, tickCountdowns, expirySignature, safeError, placeholderProviders };
})();
