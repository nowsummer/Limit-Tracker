'use strict';

(() => {
  const ui = window.LimitUI;
  const t = ui.t || ((key, params) => window.LimitI18n?.t(key, params) ?? key);
  const key = new URL(window.location.href).searchParams.get('key') || '';
  let data = { providers: [], lastUpdated: null, refreshing: false };
  let loading = false;
  let networkError = '';
  let expiration = '';
  let widgetCode = '';
  let widgetLoading = false;
  let renderedProviders = '';
  let refreshTimer = null;
  let countdownTimer = null;
  const expandedAccounts = new Set();
  ui.setLanguage?.(window.LimitI18n?.resolve('system', window.navigator?.language) || 'ko');
  ui.hydrateIcons();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.getElementById('app-install').hidden = standalone;
  document.getElementById('mobile-app-badge').hidden = !standalone;

  function renderProvider(provider) {
    const manual = provider.manual || provider.mode === 'manual';
    const providerId = provider.providerId || provider.id;
    const card = ui.el('article', 'mobile-provider');
    card.classList.add(['claude', 'codex', 'gemini', 'grok', 'custom'].includes(providerId) ? providerId : 'custom');
    card.setAttribute('aria-label', t('card.usageAria', { name: ui.providerName(provider), account: provider.accountLabel || '' }));
    const heading = ui.el('div', 'provider-heading');
    const logo = ui.el('div', 'provider-logo');
    logo.append(ui.icon(providerId));
    const identity = ui.el('div', 'provider-identity');
    identity.append(ui.el('h2', 'provider-name', ui.providerName(provider)));
    const plan = ui.planLabel ? ui.planLabel(provider) : provider.plan || '';
    const account = ui.el('div', 'mobile-account-label', provider.accountLabel || plan || t('card.defaultAccount'));
    account.title = [provider.accountLabel, plan].filter(Boolean).join(' · ');
    identity.append(account);
    heading.append(logo, identity);
    if (!ui.showsStatus || ui.showsStatus(provider)) heading.append(ui.statusBadge(provider));
    else { const after = ui.afterLimitLine?.(provider); if (after) heading.append(after); }
    card.append(heading);
    const { primary, weekly, extra, fable } = ui.overviewWindows(provider);
    card.classList.toggle('no-usage', !primary && !fable.length);
    if (primary || fable.length) {
      if (primary) {
        const meters = ui.el('div', 'mobile-overview-windows');
        meters.append(ui.windowMeter(primary, primary.label || t('card.currentLimit'), provider), ui.windowMeter(weekly, weekly?.label || t('card.weeklyLimit'), provider));
        card.append(meters);
      }
      if (fable.length) {
        // Fable belongs to the weekly column, as on the PC.
        const row = ui.el('div', `mobile-fable${primary ? '' : ' no-meters'}`);
        const limits = ui.el('div', 'fable-limits');
        fable.forEach(window => limits.append(ui.windowSummary(window, provider)));
        row.append(limits);
        card.append(row);
      }
      if (extra.length) {
        const details = ui.el('details', 'mobile-extra-windows');
        details.open = expandedAccounts.has(provider.id);
        details.addEventListener('toggle', () => {
          if (details.open) expandedAccounts.add(provider.id);
          else expandedAccounts.delete(provider.id);
        });
        const summary = ui.extraSummary ? ui.extraSummary(extra, provider) : ui.el('summary', '', t('card.extraCountMobile', { count: extra.length }));
        const secondary = ui.el('div', 'usage-windows');
        extra.forEach(window => secondary.append(ui.windowMeter(window, undefined, provider)));
        details.append(summary, secondary);
        card.append(details);
      }
    } else {
      const info = ui.el('div', 'mobile-empty-info');
      info.append(ui.el('div', 'mobile-primary-label', provider.refreshing ? t('m.checkingUsage') : manual ? t('m.enterOnPc') : t('m.checkOnPc')));
      info.append(ui.el('p', 'mobile-empty', provider.error || (provider.refreshing ? t('m.fetching') : manual ? t('m.manualHint') : t('m.loginHint'))));
      card.append(info);
    }
    if (provider.stale && (primary || fable.length)) {
      const warning = ui.el('div', 'provider-error');
      warning.append(ui.el('p', '', provider.error || t('m.oldRecord')));
      if (ui.validDate(provider.lastSuccessAt || provider.updatedAt)) warning.append(ui.el('p', 'error-last-seen', t('m.lastChecked', { time: ui.exactTime(provider.lastSuccessAt || provider.updatedAt) })));
      card.append(warning);
    }
    return card;
  }

  function render() {
    if (data.language && ui.setLanguage?.(data.language)) renderedProviders = '';
    expiration = ui.expirySignature(data.providers);
    const providers = ui.visibleProviders(data).map(provider => networkError ? { ...provider, stale: true, error: t('m.offlineRecord') } : provider);
    const signature = JSON.stringify([providers, expiration, providers.length ? false : loading, providers.length ? '' : networkError]);
    if (signature !== renderedProviders) {
      document.getElementById('mobile-providers').replaceChildren(...providers.map(renderProvider));
      if (!providers.length && !loading && !networkError) {
        const empty = ui.el('div', 'mobile-empty-state');
        empty.append(ui.el('h2', '', t('m.emptyTitle')), ui.el('p', '', t('m.emptyBody')));
        document.getElementById('mobile-providers').append(empty);
      }
      renderedProviders = signature;
    }
    const text = document.getElementById('mobile-update-text');
    text.textContent = loading ? t('m.loading') : networkError ? t('m.checkConnection') : data.refreshing ? t('m.pcRefreshing') : ui.validDate(data.lastUpdated) ? t('m.updatedAt', { time: ui.exactTime(data.lastUpdated) }) : t('m.checkingLogin');
    document.getElementById('mobile-update-dot').className = `live-dot${loading ? ' pending' : networkError ? ' warning' : ''}`;
    const button = document.getElementById('mobile-refresh');
    button.disabled = loading;
    button.classList.toggle('is-refreshing', loading);
    const message = document.getElementById('mobile-network-message');
    message.hidden = !networkError;
    message.textContent = networkError;
    document.getElementById('widget-install').hidden = !key;
  }

  async function loadUsage({ background = false } = {}) {
    if (loading) return;
    if (!key) {
      networkError = t('m.needKey');
      render();
      return;
    }
    loading = true;
    if (!background) render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/usage?key=${encodeURIComponent(key)}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          data = { providers: [], lastUpdated: null, refreshing: false };
          throw new Error(t('m.invalidKey'));
        }
        throw new Error(t('m.noResponse'));
      }
      const next = await response.json();
      if (!Array.isArray(next.providers)) throw new Error(t('m.badData'));
      data = next;
      networkError = '';
    } catch (error) {
      networkError = error.name === 'AbortError' || error instanceof TypeError ? t('m.unreachable') : ui.safeError(error, t('m.unreachableShort'));
    } finally {
      clearTimeout(timeout);
      loading = false;
      render();
    }
  }

  function clipboardFallback(code) {
    const area = document.getElementById('widget-code');
    area.value = code;
    area.hidden = false;
    // iOS Safari ignores selection on a read-only textarea; lift it while copying.
    area.readOnly = false;
    area.focus();
    area.select();
    area.setSelectionRange(0, code.length);
    let copied = false;
    try { copied = document.execCommand('copy') && area.selectionEnd - area.selectionStart === code.length; } catch { /* Direct selection remains available. */ }
    area.readOnly = true;
    if (copied) area.hidden = true;
    return copied;
  }

  async function prepareWidget() {
    if (widgetCode || widgetLoading || !key) return;
    widgetLoading = true;
    const status = document.getElementById('widget-code-status');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/widget.js?key=${encodeURIComponent(key)}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(t('m.widgetLoadFailed'));
      widgetCode = await response.text();
      document.getElementById('copy-widget-button').disabled = false;
      status.textContent = t('m.widgetReady');
      document.getElementById('widget-code').value = widgetCode;
    } catch {
      status.textContent = t('m.widgetLoadFailed');
    } finally { clearTimeout(timeout); widgetLoading = false; }
  }

  document.getElementById('mobile-refresh').addEventListener('click', loadUsage);
  document.getElementById('widget-install').addEventListener('toggle', event => {
    if (event.target.open) prepareWidget();
  });
  document.getElementById('copy-widget-button').addEventListener('click', async () => {
    if (!widgetCode) return;
    const status = document.getElementById('widget-code-status');
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(widgetCode); copied = true; } catch { /* Fall through to direct copy. */ }
    }
    if (!copied) copied = clipboardFallback(widgetCode);
    status.textContent = copied ? t('m.widgetCopied') : t('m.widgetCopyManual');
  });
  document.getElementById('widget-download').href = `/widget.js?key=${encodeURIComponent(key)}`;
  function tickVisiblePage() {
    ui.tickCountdowns();
    if (ui.expirySignature(data.providers) !== expiration) render();
  }
  function pauseTimers() {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = null;
    countdownTimer = null;
  }
  function resumeTimers() {
    if (document.hidden) return;
    if (refreshTimer === null) refreshTimer = setInterval(() => loadUsage({ background: true }), 60000);
    if (countdownTimer === null) countdownTimer = setInterval(tickVisiblePage, 15000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseTimers();
    else {
      tickVisiblePage();
      resumeTimers();
      loadUsage({ background: true });
    }
  });
  resumeTimers();
  if (!document.hidden) loadUsage();
})();
