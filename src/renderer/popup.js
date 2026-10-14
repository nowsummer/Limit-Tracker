'use strict';

(() => {
  const ui = window.LimitUI;
  const t = ui.t;
  const bridge = window.limitTracker;
  // The popup grows with its accounts and stops at three; more accounts scroll.
  const MAX_FULL_CARDS = 3;
  let state = { providers: ui.placeholderProviders(), settings: { theme: 'system' }, refreshing: false, lastUpdated: null };
  let expiration = '';
  let cardsSignature = '';
  let manualRefreshing = false;
  let stateReceived = false;
  let reportedHeight = 0;
  let measureFrame = 0;
  ui.setLanguage(window.LimitI18n?.resolve('system', navigator.language) || 'ko');
  ui.hydrateIcons();

  function renderProvider(provider) {
    const card = ui.el('article', `popup-provider ${provider.providerId || provider.id}`);
    card.dataset.accountId = provider.id;
    card.setAttribute('aria-label', t('card.usageAria', { name: ui.providerName(provider), account: provider.accountLabel || '' }));
    const heading = ui.el('div', 'popup-provider-heading');
    const logo = ui.el('div', 'provider-logo');
    logo.append(ui.icon(provider.providerId || provider.id));
    const identity = ui.el('div', 'popup-identity');
    identity.append(ui.el('h2', '', ui.providerName(provider)), ui.el('div', 'popup-account-label', provider.accountLabel || ui.planLabel(provider) || t('card.defaultAccount')));
    heading.append(logo, identity);
    if (ui.showsStatus(provider)) heading.append(ui.statusBadge(provider));
    else { const after = ui.afterLimitLine(provider); if (after) heading.append(after); }
    heading.title = ui.statusDetails(provider).join(' · ');
    card.append(heading);
    const { primary, weekly, extra, fable } = ui.overviewWindows(provider);
    if (primary || fable.length) {
      if (primary) {
        const meters = ui.el('div', 'popup-meters');
        meters.append(ui.windowMeter(primary, primary.label || t('card.currentLimit'), provider), ui.windowMeter(weekly, weekly?.label || t('card.weeklyLimit'), provider));
        card.append(meters);
      }
      if (fable.length || extra.length) {
        const additional = ui.el('div', 'popup-additional');
        if (fable.length) {
          const limits = ui.el('div', 'fable-limits');
          fable.forEach(window => limits.append(ui.windowSummary(window, provider)));
          additional.append(limits);
        }
        if (extra.length) {
          const details = ui.el('details', 'popup-extra');
          const summary = ui.extraSummary(extra, provider);
          const panel = ui.el('div', 'usage-windows extra-panel');
          panel.id = `popup-extra-${provider.id}`;
          summary.setAttribute('aria-controls', panel.id);
          extra.forEach(window => panel.append(ui.windowMeter(window, undefined, provider)));
          details.append(summary);
          details.addEventListener('toggle', scheduleMeasure);
          additional.append(details, panel);
        }
        card.append(additional);
      }
    } else card.append(ui.el('p', 'popup-empty', provider.refreshing || provider.status === 'loading' ? t('popup.checkingUsage') : provider.status === 'disconnected' ? t('popup.loginInWindow') : provider.error || t('popup.checkInWindow')));
    if (provider.stale) {
      heading.title = t('popup.staleTitle', { time: ui.exactTime(provider.lastSuccessAt || provider.updatedAt) });
      card.title = provider.error || heading.title;
    }
    return card;
  }

  /** Height the window needs to show the heading, up to three cards and the footer. */
  function desiredHeight() {
    const shell = document.querySelector('.popup-shell');
    const container = document.getElementById('popup-providers');
    const shellStyle = getComputedStyle(shell);
    const listStyle = getComputedStyle(container);
    const gap = parseFloat(shellStyle.rowGap) || 0;
    const listGap = parseFloat(listStyle.rowGap) || 0;
    const items = [...container.children];
    const shown = items.slice(0, MAX_FULL_CARDS);
    const list = shown.reduce((sum, item) => sum + item.getBoundingClientRect().height, 0) + Math.max(0, shown.length - 1) * listGap + (parseFloat(listStyle.paddingTop) || 0) + (parseFloat(listStyle.paddingBottom) || 0);
    container.classList.toggle('has-more', items.length > MAX_FULL_CARDS);
    return Math.ceil((parseFloat(shellStyle.paddingTop) || 0) + (parseFloat(shellStyle.paddingBottom) || 0)
      + document.querySelector('.popup-heading').getBoundingClientRect().height + gap
      + list + gap + document.querySelector('.popup-footer').getBoundingClientRect().height);
  }

  function measure() {
    measureFrame = 0;
    if (!bridge?.reportPopupSize || !stateReceived) return;
    const height = desiredHeight();
    if (Math.abs(height - reportedHeight) < 1) return;
    reportedHeight = height;
    bridge.reportPopupSize(height).catch(() => {});
  }
  function scheduleMeasure() { if (!measureFrame) measureFrame = requestAnimationFrame(measure); }

  function updateScrollHint() {
    const container = document.getElementById('popup-providers');
    container.classList.toggle('at-end', container.scrollTop + container.clientHeight >= container.scrollHeight - 2);
  }

  function render(next) {
    if (!next) return;
    state = { ...state, ...next };
    if (ui.setLanguage(state.language)) cardsSignature = '';
    expiration = ui.expirySignature(state.providers);
    document.documentElement.dataset.theme = state.settings?.theme || 'system';
    const providers = ui.trayProviders(state);
    const container = document.getElementById('popup-providers');
    const scroll = container.scrollTop;
    const signature = JSON.stringify(providers.map(provider => ({ ...provider, refreshing: !provider.windows?.length && provider.refreshing, status: provider.windows?.length && provider.status === 'loading' ? 'ok' : provider.status }))) + expiration + state.settings?.trayMode + (state.language || '');
    if (signature !== cardsSignature) {
      cardsSignature = signature;
      const expanded = new Set([...container.querySelectorAll('.popup-provider:has(details[open])')].map(card => card.dataset.accountId));
      const focusKey = document.activeElement?.dataset?.focusKey;
      const cards = providers.map(renderProvider);
      container.replaceChildren(...cards);
      cards.forEach(card => { if (expanded.has(card.dataset.accountId)) card.querySelector('details')?.setAttribute('open', ''); });
      if (!providers.length) container.append(ui.el('p', 'popup-empty-state', state.settings?.trayMode === 'app' ? t('popup.emptyApp') : t('popup.emptyTray')));
      if (focusKey) container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
      scheduleMeasure();
    }
    container.scrollTop = scroll;
    updateScrollHint();
    const refresh = document.getElementById('popup-refresh');
    const showRefreshing = state.refreshing && (manualRefreshing || !providers.some(provider => provider.windows?.length));
    refresh.classList.toggle('is-refreshing', showRefreshing);
    refresh.setAttribute('aria-busy', String(showRefreshing));
    document.getElementById('popup-updated').textContent = showRefreshing ? t('popup.refreshing') : ui.validDate(state.lastUpdated) ? t('popup.checkedAt', { time: ui.exactTime(state.lastUpdated, false, false) }) : t('popup.connecting');
  }

  document.getElementById('popup-refresh').addEventListener('click', async () => {
    if (!bridge || manualRefreshing) return;
    manualRefreshing = true;
    render({ ...state, refreshing: true });
    try {
      const next = await bridge.refresh();
      if (next) render(next);
    } catch { render({ ...state, refreshing: false }); }
    finally { manualRefreshing = false; render(state); }
  });
  document.getElementById('popup-open').addEventListener('click', () => bridge?.windowAction('show-main'));
  // Like any flyout, Esc closes it.
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) bridge?.windowAction('close'); });
  document.getElementById('popup-providers').addEventListener('scroll', updateScrollHint, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleMeasure).observe(document.querySelector('.popup-shell'));
  render(state);
  const ready = document.fonts?.ready || Promise.resolve();
  if (bridge) {
    bridge.onState(render);
    bridge.getState().then(next => { render(next); }).catch(() => {}).finally(() => ready.then(() => { stateReceived = true; scheduleMeasure(); }));
  }
  let countdownTimer;
  function syncVisibility() {
    clearInterval(countdownTimer);
    if (document.hidden) return;
    const tick = () => { ui.tickCountdowns(); if (ui.expirySignature(state.providers) !== expiration) render(state); };
    tick();
    countdownTimer = setInterval(tick, 15000);
  }
  document.addEventListener('visibilitychange', () => {
    syncVisibility();
    if (!document.hidden) bridge?.getState().then(render).catch(() => {});
  });
  syncVisibility();
})();
