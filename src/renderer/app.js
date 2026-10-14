'use strict';

(() => {
  const ui = window.LimitUI;
  const t = ui.t;
  const bridge = window.limitTracker;
  const defaults = { refreshSeconds: 120, launchAtLogin: false, startHidden: false, alwaysOnTop: false, notifications: true, resetNotifications: true, theme: 'system', mobileEnabled: false, trayMode: 'usage', language: 'system', autoUpdate: true };
  const fallbackCatalog = () => [
    { id: 'claude', name: 'Claude', modes: ['default', 'isolated', 'manual'], description: t('catalog.claude') },
    { id: 'codex', name: 'Codex', modes: ['default', 'isolated', 'manual'], description: t('catalog.codex') },
    { id: 'gemini', name: 'Gemini CLI', modes: ['manual'], description: t('catalog.gemini') },
    { id: 'grok', name: 'Grok', modes: ['manual'], description: t('catalog.grok') },
    { id: 'custom', name: t('catalog.customName'), modes: ['manual'], description: t('catalog.custom') }
  ];
  let state = { providers: ui.placeholderProviders(), settings: defaults, refreshing: false, lastUpdated: null, mobile: { enabled: false, url: null, urls: [], port: 43821 }, appVersion: '', update: null };
  let toastTimer;
  let expiration = '';
  let editingAccount = null;
  let accountsSignature = '';
  // While a row is being dragged, a refresh must not rebuild the list under the pointer.
  let accountDragActive = false;
  let cardsSignature = '';
  let deleteArmed = false;
  let reorderPending = false;
  let manualRefreshing = false;
  let updateBusy = false;
  const loginPending = new Set();
  const externalPending = new Set();
  const controls = [...document.querySelectorAll('[name]')];
  // Until the app state arrives, follow the Windows display language.
  ui.setLanguage(window.LimitI18n?.resolve('system', navigator.language) || 'ko');
  ui.hydrateIcons();

  /** Once per install, when an automatic Claude account exists: say plainly that the method is unofficial. */
  function showClaudeNoticeOnce() {
    const settings = state.settings;
    if (!bridge || !settings || settings.claudeNoticeSeen !== false) return;
    if (!accounts().some(account => account.providerId === 'claude' && account.mode !== 'manual')) return;
    toast(t('notice.claudeMethod'));
    bridge.setSettings({ claudeNoticeSeen: true }).catch(() => {});
  }

  function toast(message) {
    const node = document.getElementById('toast');
    node.textContent = message;
    node.hidden = false;
    if (typeof node.showPopover === 'function') {
      try { node.showPopover(); } catch { /* Already visible. */ }
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (typeof node.hidePopover === 'function') { try { node.hidePopover(); } catch { /* Already dismissed. */ } }
      node.hidden = true;
    }, Math.min(15000, Math.max(6500, String(message).length * 90)));
  }

  async function openExternal(destination, accountId, button) {
    if (!bridge) return;
    const login = destination === 'login' || destination.endsWith('-login');
    const key = accountId || destination;
    // Double clicks must not open two login consoles or two browser tabs.
    if (externalPending.has(key)) return;
    externalPending.add(key);
    if (login) { loginPending.add(key); toast(t('login.opening')); }
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
      const result = await bridge.openExternal(destination, accountId);
      if (result?.ok === false) throw new Error(result.error || t('login.failed'));
      if (login) toast(result?.message || t('login.opened'));
    } catch (error) { toast(ui.safeError(error, t('login.pageFailed'))); }
    finally {
      loginPending.delete(key);
      setTimeout(() => externalPending.delete(key), 800);
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }

  function renderUpdateLine() {
    const text = document.getElementById('update-text');
    const dot = document.getElementById('update-dot');
    const providers = ui.visibleProviders(state);
    const allOkay = providers.length > 0 && providers.every(provider => (provider.status === 'ok' || provider.manual || (provider.status === 'loading' && provider.windows?.length)) && !provider.stale && ui.used(ui.primaryWindow(provider)) !== null);
    const showRefreshing = state.refreshing && (manualRefreshing || !providers.some(provider => provider.windows?.length));
    dot.className = `live-dot${showRefreshing ? ' pending' : !allOkay ? ' warning' : ''}`;
    if (showRefreshing) text.textContent = t('dash.checkingUsage');
    else if (providers.length === 0) text.textContent = t('dash.selectAccounts');
    else if (ui.validDate(state.lastUpdated)) text.textContent = `${t('dash.checkedAt', { time: ui.exactTime(state.lastUpdated, false, false) })}${allOkay ? '' : t('dash.checkStatus')}`;
    else text.textContent = t('dash.loginHint');
    const seconds = state.settings?.refreshSeconds || 60;
    document.getElementById('interval-text').textContent = t('dash.interval', { minutes: Math.round(seconds / 60) });
    const refresh = document.getElementById('refresh-button');
    refresh.classList.toggle('is-refreshing', showRefreshing);
    refresh.setAttribute('aria-busy', String(showRefreshing));
    refresh.setAttribute('aria-label', showRefreshing ? t('dash.refreshing') : t('dash.refresh'));
  }

  function renderUpdateArea() {
    const update = state.update;
    const status = document.getElementById('update-status');
    const check = document.getElementById('update-check-button');
    const install = document.getElementById('update-install-button');
    const download = document.getElementById('update-download-button');
    const open = document.getElementById('update-open-button');
    const note = document.getElementById('auto-update-note');
    if (!update) { status.textContent = t('update.unsupported'); check.disabled = true; install.hidden = download.hidden = open.hidden = true; return; }
    note.textContent = update.selfUpdating || update.mode === 'installed' ? t('settings.autoUpdateNote') : t('settings.autoUpdateManualNote');
    const version = update.latestVersion || '';
    const checked = ui.validDate(update.checkedAt) ? ui.exactTime(update.checkedAt) : '';
    const messages = {
      idle: t('update.idle'),
      checking: t('update.checking'),
      'up-to-date': t('update.upToDate', { time: checked }),
      available: update.selfUpdating ? t('update.available', { version }) : t('update.availableManual', { version }),
      downloading: t('update.downloading', { version, percent: Number.isFinite(update.percent) ? update.percent : 0 }),
      downloaded: update.error === 'blocked' ? t('update.errorBlocked') : t('update.downloaded', { version: update.downloadedVersion || version }),
      unsupported: t('update.unsupported'),
      error: update.error === 'network' ? t('update.errorNetwork') : update.error === 'no-release' ? t('update.errorNoRelease') : update.error === 'blocked' ? t('update.errorBlocked') : t('update.errorFailed'),
    };
    status.textContent = messages[update.status] || t('update.idle');
    check.disabled = updateBusy || ['checking', 'downloading', 'unsupported'].includes(update.status);
    install.hidden = !update.canInstall;
    download.hidden = !update.canDownload;
    // Before installing, the release notes are one click away; a copy that cannot update itself opens the download page.
    const reviewing = update.status === 'downloaded' && update.selfUpdating;
    open.dataset.i18n = reviewing ? 'settings.viewChanges' : 'settings.openDownload';
    open.textContent = t(open.dataset.i18n);
    open.hidden = !(reviewing || (update.status === 'available' && !update.selfUpdating));
  }

  function syncSettings(forceControl) {
    const settings = { ...defaults, ...state.settings };
    document.documentElement.dataset.theme = settings.theme;
    document.getElementById('tray-selection-note').hidden = settings.trayMode === 'app' || accounts().some(account => (account.trayVisible ?? account.visible) !== false);
    controls.forEach(control => {
      if (control.disabled || (control === document.activeElement && control !== forceControl)) return;
      if (control.type === 'checkbox') control.checked = Boolean(settings[control.name]);
      else control.value = String(settings[control.name] ?? '');
    });
    const pin = document.getElementById('pin-button');
    pin.setAttribute('aria-pressed', String(settings.alwaysOnTop));
    pin.title = settings.alwaysOnTop ? t('title.unpin') : t('title.pin');
    pin.setAttribute('aria-label', pin.title);
    document.getElementById('app-version').textContent = state.appVersion ? `v${state.appVersion}` : '';
    document.getElementById('about-version').textContent = state.appVersion ? t('settings.aboutVersion', { version: state.appVersion }) : '';
    const mobile = state.mobile || {};
    document.getElementById('mobile-connection').hidden = !mobile.enabled;
    const noAddress = !!mobile.enabled && !mobile.url;
    document.getElementById('mobile-url').value = mobile.url || '';
    document.getElementById('copy-mobile-button').disabled = !mobile.url;
    document.querySelector('#mobile-connection .url-field').hidden = noAddress;
    document.getElementById('mobile-private-note').hidden = noAddress;
    document.getElementById('mobile-status').textContent = noAddress ? t(mobile.reason === 'public-only' ? 'mobile.publicOnly' : 'mobile.noAddress') : '';
    renderUpdateArea();
  }

  function render(next) {
    if (!next || typeof next !== 'object') return;
    state = { ...state, ...next, settings: { ...defaults, ...state.settings, ...next.settings } };
    if (ui.setLanguage(state.language)) {
      // Everything built from strings is rebuilt in the new language.
      cardsSignature = ''; accountsSignature = '';
      if (document.getElementById('account-dialog').open) refreshAccountDialogText();
    }
    expiration = ui.expirySignature(state.providers);
    const providers = ui.visibleProviders(state);
    const focusKey = document.activeElement?.dataset?.focusKey;
    const signature = JSON.stringify(providers.map(provider => ({ ...provider, refreshing: !provider.windows?.length && provider.refreshing, status: provider.windows?.length && provider.status === 'loading' ? 'ok' : provider.status }))) + expiration;
    if (signature !== cardsSignature) {
      cardsSignature = signature;
      const expanded = new Set([...document.querySelectorAll('.provider-card:has(.extra-windows[open])')].map(card => card.dataset.accountId));
      const cards = providers.map(provider => ui.renderProvider(provider, { openExternal, editAccount }));
      if (!cards.length) {
        const empty = ui.el('div', 'dashboard-empty');
        empty.append(ui.icon('accounts'), ui.el('h2', '', t('dash.emptyTitle')), ui.el('p', '', t('dash.emptyBody')));
        const add = ui.el('button', 'primary-button', t('dash.addAccount'));
        add.dataset.focusKey = 'dashboard-add';
        add.addEventListener('click', () => editAccount());
        empty.append(add);
        cards.push(empty);
      }
      document.getElementById('providers').replaceChildren(...cards);
      cards.forEach(card => { if (expanded.has(card.dataset.accountId)) card.querySelector('.extra-windows')?.setAttribute('open', ''); });
    }
    document.getElementById('account-count').textContent = t('dash.visibleCount', { count: providers.length });
    renderAccounts();
    syncSettings();
    renderUpdateLine();
    if (focusKey) {
      // A sign-in button disappears once signed in: fall back to that row's edit button.
      const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) || (focusKey.endsWith('-settings-login') ? document.querySelector(`[data-focus-key="${CSS.escape(focusKey.replace(/-settings-login$/, '-settings-edit'))}"]`) : null);
      target?.focus({ preventScroll: true });
    }
  }

  function catalog() { return Array.isArray(state.catalog) && state.catalog.length ? state.catalog : fallbackCatalog(); }
  function accounts() {
    return state.settings.accounts || state.providers.map(provider => ({ id: provider.id, providerId: provider.providerId || provider.id, label: provider.accountLabel || t('card.defaultAccount'), mode: provider.mode || 'default', visible: provider.visible !== false, trayVisible: provider.trayVisible ?? provider.visible !== false, showFable: provider.showFable === true, trayMetric: provider.trayMetric || 'primary' }));
  }
  const modeName = mode => ({ default: t('mode.default'), isolated: t('mode.isolated'), manual: t('mode.manual') })[mode] || mode;
  const modeDescription = mode => ({ default: t('mode.defaultDescription'), isolated: t('mode.isolatedDescription'), manual: t('mode.manualDescription') })[mode] || '';

  function renderAccounts() {
    if (accountDragActive) return;
    const list = accounts();
    // The sign-in button depends on the deadline too, so a renewed sign-in or the 3-day line re-renders the row.
    const signature = JSON.stringify(list) + JSON.stringify(state.providers.map(p => { const ends = ui.validDate(p.loginExpiresAt)?.getTime(); return [p.id, p.windows?.length && p.status === 'loading' ? 'ok' : p.status, p.loginExpiresAt || null, !!ends && ends - Date.now() < 3 * 86400000]; }));
    if (signature === accountsSignature) return;
    accountsSignature = signature;
    const container = document.getElementById('account-list');
    const rows = list.map((account, index) => {
      const provider = state.providers.find(item => item.id === account.id);
      const row = ui.el('div', `account-row ${account.providerId}`);
      const logo = ui.el('div', 'provider-logo'); logo.append(ui.icon(account.providerId));
      const identity = ui.el('div', 'account-identity');
      const serviceName = catalog().find(item => item.id === account.providerId)?.name || account.providerId;
      identity.append(ui.el('strong', '', account.label), ui.el('small', '', `${serviceName} · ${account.mode === 'manual' ? t('row.modeManual') : account.mode === 'isolated' ? t('row.modeIsolated') : t('row.modeDefault')}`));
      const actions = ui.el('div', 'account-row-actions');
      const edit = ui.el('button', 'text-button account-edit', t('row.edit')); edit.type = 'button';
      edit.dataset.focusKey = `${account.id}-settings-edit`; edit.setAttribute('aria-label', t('row.editAria', { label: account.label }));
      edit.addEventListener('click', () => editAccount(account.id));
      actions.append(edit);
      const healthy = provider && (provider.status === 'ok' || (provider.status === 'loading' && provider.windows?.length));
      const loginEnds = ui.validDate(provider?.loginExpiresAt)?.getTime();
      const loginSoon = loginEnds && loginEnds - Date.now() < 3 * 86400000;
      if (account.mode !== 'manual' && (!healthy || loginSoon)) {
        const login = ui.el('button', `text-button account-login${healthy ? ' soon' : ''}`, healthy ? t('row.relogin') : t('row.login')); login.type = 'button';
        login.dataset.focusKey = `${account.id}-settings-login`;
        login.addEventListener('click', () => openExternal('login', account.id, login));
        actions.append(login);
      }
      const display = ui.el('div', 'account-display-options');
      for (const [field, label, description] of [['visible', t('row.screen'), t('row.screenDescription')], ['trayVisible', t('row.tray'), t('row.trayDescription')]]) {
        const option = ui.el('label', 'account-display-option');
        option.append(ui.el('span', 'row-switch-label', label));
        const toggle = ui.el('input', 'switch');
        toggle.type = 'checkbox';
        toggle.checked = (account[field] ?? (field === 'trayVisible' ? account.visible : true)) !== false;
        toggle.dataset.focusKey = `${account.id}-${field}`;
        toggle.setAttribute('aria-label', `${account.label} ${description}`);
        toggle.addEventListener('change', async () => {
          const before = !toggle.checked;
          // Keep focus on the switch: busy instead of disabled, then refocus.
          if (display.getAttribute('aria-busy') === 'true') { toggle.checked = before; return; }
          display.setAttribute('aria-busy', 'true');
          try {
            const current = accounts().find(item => item.id === account.id) || account;
            const result = await bridge.saveAccount({ ...current, [field]: toggle.checked });
            if (result?.ok === false) throw new Error(result.error);
            render(result?.state || await bridge.getState());
            document.getElementById('settings-save-status').textContent = t('settings.displaySaved', { label });
          } catch (error) { toggle.checked = before; toast(ui.safeError(error, t('settings.displayFailed'))); }
          finally {
            display.removeAttribute('aria-busy');
            document.querySelector(`[data-focus-key="${CSS.escape(`${account.id}-${field}`)}"]`)?.focus({ preventScroll: true });
          }
        });
        option.append(toggle);
        display.append(option);
      }
      // ≡ handle: drag to reorder; with the keyboard, focus it and press ↑/↓.
      row.dataset.accountId = account.id;
      const handle = ui.el('button', 'drag-handle');
      handle.type = 'button';
      handle.append(ui.icon('grip'));
      handle.title = t('row.dragTitle');
      handle.setAttribute('aria-label', t('row.dragAria', { label: account.label, position: index + 1, count: list.length }));
      handle.dataset.focusKey = `${account.id}-order`;
      handle.disabled = reorderPending || list.length < 2;
      handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        moveAccount(account.id, event.key === 'ArrowUp' ? -1 : 1);
      });
      handle.addEventListener('pointerdown', event => startDrag(event, row));
      row.append(handle, logo, identity, actions, display);
      return row;
    });
    if (!rows.length) rows.push(ui.el('p', 'setting-note', t('settings.noAccounts')));
    container.replaceChildren(...rows);
    document.getElementById('account-list-header').hidden = !list.length;
    // The 4-week sign-in rule matters only to Claude accounts that sign in.
    const claudeSignIn = list.some(account => account.providerId === 'claude' && account.mode !== 'manual');
    document.getElementById('login-period-note').hidden = !claudeSignIn;
    const tip = document.getElementById('login-period-tip');
    tip.replaceChildren(...(claudeSignIn ? [ui.infoTip(t('login.periodNote'), t('login.periodTipLabel'), 'login-period-tip')] : []));
    // Usage-page links in the help sheet follow the services in use.
    const providersInUse = new Set(list.map(account => account.providerId));
    document.querySelectorAll('[data-help-provider]').forEach(button => { button.hidden = list.length ? !providersInUse.has(button.dataset.helpProvider) : button.dataset.helpProvider === 'gemini'; });
  }

  async function moveAccount(id, offset) {
    if (accountDragActive) return;
    const ordered = accounts().map(account => account.id);
    const index = ordered.indexOf(id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    await saveOrder(ordered, id);
  }

  async function saveOrder(ordered, focusId, { pointer = false } = {}) {
    if (reorderPending || !bridge?.reorderAccounts) return false;
    reorderPending = true;
    document.querySelectorAll('.drag-handle').forEach(button => { button.disabled = true; });
    let saved = false;
    try {
      const result = await bridge.reorderAccounts(ordered);
      if (result?.ok === false) throw new Error(result.error);
      render(result?.state || await bridge.getState());
      document.getElementById('settings-save-status').textContent = t('settings.orderSaved');
      saved = true;
    } catch (error) { toast(ui.safeError(error, t('settings.orderFailed'))); }
    finally {
      reorderPending = false;
      accountsSignature = '';
      renderAccounts();
      if (focusId && !pointer) document.querySelector(`[data-focus-key="${CSS.escape(`${focusId}-order`)}"]`)?.focus({ preventScroll: true });
    }
    return saved;
  }

  /**
   * Direct manipulation: the row follows the pointer 1:1 from where it was
   * grabbed, the others make room, and the new order is saved on release.
   */
  function startDrag(event, row) {
    if (event.button !== 0 || reorderPending || accountDragActive) return;
    const container = document.getElementById('account-list');
    const rows = [...container.querySelectorAll('.account-row')];
    const from = rows.indexOf(row);
    if (rows.length < 2 || from < 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    accountDragActive = true;
    const rects = rows.map(item => item.getBoundingClientRect());
    const pitch = rects[from].height;
    const minDy = rects[0].top - rects[from].top;
    const maxDy = rects[rects.length - 1].bottom - rects[from].bottom;
    const startY = event.clientY;
    let to = from, moved = false, done = false;
    const sheet = container.closest('dialog');
    const onKey = keyEvent => { if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); cancel(); } };
    const cancel = () => finish({ save: false });
    const move = moveEvent => {
      // The button was released somewhere we did not hear about: end the drag.
      if (moveEvent.pointerType === 'mouse' && moveEvent.buttons === 0) { finish({ save: moved }); return; }
      const dy = Math.max(minDy, Math.min(maxDy, moveEvent.clientY - startY));
      if (!moved && Math.abs(dy) < 3) return;
      if (!moved) { moved = true; row.classList.add('dragging'); container.classList.add('is-sorting'); }
      row.style.transform = `translateY(${dy}px)`;
      const center = rects[from].top + rects[from].height / 2 + dy;
      to = rows.reduce((count, item, i) => i !== from && center > rects[i].top + rects[i].height / 2 ? count + 1 : count, 0);
      rows.forEach((item, i) => {
        if (i === from) return;
        const shift = from < to && i > from && i <= to ? -pitch : from > to && i >= to && i < from ? pitch : 0;
        item.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const finish = async ({ save = true } = {}) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      sheet?.removeEventListener('close', cancel);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
      handle.removeEventListener('lostpointercapture', onLost);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', cancel);
      const reset = () => { rows.forEach(item => { item.style.transform = ''; }); row.classList.remove('dragging'); container.classList.remove('is-sorting'); };
      // Catch up on any refresh that arrived during the drag.
      if (!save || !moved || to === from) { accountDragActive = false; reset(); renderAccounts(); return; }
      const ordered = rows.map(item => item.dataset.accountId);
      ordered.splice(to, 0, ordered.splice(from, 1)[0]);
      // Settle the held row into its slot, then save; the re-render replaces the rows in place.
      row.style.transition = 'transform 180ms cubic-bezier(.2, .8, .2, 1)';
      row.style.transform = `translateY(${rects[to].top - rects[from].top + (to > from ? rects[to].height - pitch : 0)}px)`;
      await new Promise(resolve => { const timer = setTimeout(resolve, 220); row.addEventListener('transitionend', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      // Still locked during the settle; saveOrder takes the lock over before its first await.
      accountDragActive = false;
      const saved = await saveOrder(ordered, row.dataset.accountId, { pointer: true });
      container.classList.remove('is-sorting');
      if (!saved) { reset(); row.style.transition = ''; accountsSignature = ''; renderAccounts(); }
    };
    const onUp = () => finish();
    // Capture lost without a pointerup (another window took it): do not save a half-done drag.
    const onLost = () => finish({ save: false });
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', onLost);
    document.addEventListener('keydown', onKey, true);
    sheet?.addEventListener('close', cancel);
  }

  function updateAccountFields() {
    const provider = catalog().find(item => item.id === document.getElementById('account-provider').value) || catalog()[0];
    const modeSelect = document.getElementById('account-mode');
    modeSelect.replaceChildren(...(provider.modes || ['manual']).map(mode => {
      const option = ui.el('option', '', modeName(mode)); option.value = mode; return option;
    }));
    modeSelect.value = editingAccount?.mode || provider.modes?.[0] || 'manual';
    if (!editingAccount && modeSelect.value === 'default' && accounts().some(a => a.providerId === provider.id && a.mode === 'default') && provider.modes.includes('isolated')) modeSelect.value = 'isolated';
    document.getElementById('provider-description').textContent = provider.description || '';
    document.getElementById('account-fable-row').hidden = provider.id !== 'claude';
    updateLoginRow();
    updateModeFields();
    updateTrayMetricRow();
  }

  /** Sign-in row in the account editor: existing automatic accounts only. */
  function updateLoginRow() {
    const row = document.getElementById('account-login-row');
    const account = editingAccount;
    row.hidden = !account || account.mode === 'manual';
    if (row.hidden) return;
    const provider = state.providers.find(item => item.id === account.id);
    const ends = ui.validDate(provider?.loginExpiresAt);
    document.getElementById('account-login-note').textContent = ends ? t('account.loginUntil', { time: ui.exactTime(ends.toISOString()) }) : t('account.loginNote');
    const tip = document.getElementById('account-login-tip');
    tip.replaceChildren();
    if (account.providerId === 'claude') tip.append(ui.infoTip(t('login.periodNote'), t('login.periodTipLabel'), 'account-login-tip'));
  }

  function updateTrayMetricRow() {
    const claude = document.getElementById('account-provider').value === 'claude';
    const fable = document.getElementById('account-show-fable').checked;
    document.getElementById('account-tray-metric-row').hidden = !(claude && fable);
  }

  function updateModeFields() {
    const mode = document.getElementById('account-mode').value;
    document.getElementById('mode-description').textContent = modeDescription(mode);
    const manualFields = document.getElementById('manual-fields');
    manualFields.hidden = mode !== 'manual';
    // Hidden inputs must not take part in validation or submission.
    manualFields.querySelectorAll('input, button').forEach(input => { input.disabled = mode !== 'manual'; });
    const create = !editingAccount;
    document.getElementById('save-account').textContent = create && mode === 'isolated' ? t('account.createAndLogin') : create ? t('account.create') : t('account.save');
  }

  /** Re-renders the strings of an open account dialog after a language switch. */
  function refreshAccountDialogText() {
    const providerSelect = document.getElementById('account-provider');
    const selected = providerSelect.value;
    providerSelect.replaceChildren(...catalog().map(provider => { const option = ui.el('option', '', provider.name); option.value = provider.id; return option; }));
    providerSelect.value = selected;
    const mode = document.getElementById('account-mode').value;
    updateAccountFields();
    document.getElementById('account-mode').value = mode;
    updateModeFields();
    document.getElementById('account-title').textContent = editingAccount ? t('account.edit') : t('account.add');
    document.getElementById('delete-account').textContent = deleteArmed ? t('account.deleteConfirm') : t('account.delete');
  }

  function localDate(value) {
    const date = ui.validDate(value);
    if (!date) return '';
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }

  const oneDecimal = value => Math.round(Number(value) * 10) / 10;

  function addManualWindow(window = {}) {
    const list = document.getElementById('manual-window-list');
    if (list.children.length >= 8) return;
    const row = ui.el('div', 'manual-window-row');
    row.dataset.windowId = window.id || `manual-${Date.now()}-${list.children.length}`;
    if (window.durationMinutes) row.dataset.durationMinutes = window.durationMinutes;
    const name = ui.el('input', 'field-input manual-label'); name.placeholder = t('account.windowNamePlaceholder'); name.maxLength = 40; name.value = window.label || ''; name.setAttribute('aria-label', t('account.windowName'));
    // step=any: the form validates the range itself, and a stored value can never lock the form.
    const percent = ui.el('input', 'field-input manual-used'); percent.type = 'number'; percent.min = '0'; percent.max = '100'; percent.step = 'any'; percent.placeholder = t('account.windowPercentPlaceholder'); percent.setAttribute('aria-label', t('account.windowPercentAria'));
    const usedValue = ui.percent(window.usedPercent) ?? (ui.percent(window.remainingPercent) !== null ? 100 - window.remainingPercent : null);
    percent.value = usedValue === null ? '' : String(oneDecimal(usedValue));
    const reset = ui.el('input', 'field-input manual-reset'); reset.type = 'datetime-local'; reset.value = localDate(window.resetsAt); reset.setAttribute('aria-label', t('account.windowResetAria'));
    const remove = ui.el('button', 'icon-button manual-remove'); remove.type = 'button'; remove.setAttribute('aria-label', t('account.windowRemove')); remove.append(ui.icon('close')); remove.addEventListener('click', () => row.remove());
    const labels = ui.el('div', 'manual-window-labels'); labels.append(ui.el('span', '', t('account.windowName')), ui.el('span', '', t('account.windowPercent')));
    const first = ui.el('div', 'manual-window-main'); first.append(name, percent, remove);
    const resetLabel = ui.el('label', 'manual-reset-label', t('account.windowReset')); resetLabel.append(reset);
    row.append(labels, first, resetLabel); list.append(row);
    const disabled = document.getElementById('account-mode').value !== 'manual';
    row.querySelectorAll('input, button').forEach(input => { input.disabled = disabled; });
  }

  function editAccount(id) {
    editingAccount = id ? accounts().find(account => account.id === id) : null;
    const providerSelect = document.getElementById('account-provider');
    providerSelect.replaceChildren(...catalog().map(provider => { const option = ui.el('option', '', provider.name); option.value = provider.id; return option; }));
    providerSelect.value = editingAccount?.providerId || 'claude';
    providerSelect.disabled = Boolean(editingAccount);
    document.getElementById('account-mode').disabled = Boolean(editingAccount);
    document.getElementById('account-label').value = editingAccount?.label || '';
    document.getElementById('account-visible').checked = editingAccount?.visible !== false;
    document.getElementById('account-tray-visible').checked = (editingAccount?.trayVisible ?? editingAccount?.visible) !== false;
    document.getElementById('account-show-fable').checked = editingAccount?.showFable === true;
    document.getElementById('account-tray-metric').value = editingAccount?.trayMetric === 'fable' ? 'fable' : 'primary';
    document.getElementById('account-title').textContent = editingAccount ? t('account.edit') : t('account.add');
    document.getElementById('account-error').hidden = true;
    const remove = document.getElementById('delete-account'); remove.hidden = !editingAccount; remove.textContent = t('account.delete'); deleteArmed = false;
    document.getElementById('manual-window-list').replaceChildren();
    updateAccountFields();
    if (editingAccount?.manualWindows?.length) editingAccount.manualWindows.forEach(addManualWindow);
    else addManualWindow();
    openDialog('account-dialog');
    if (editingAccount) document.getElementById('account-label').focus();
  }

  /** Focus target after the account dialog closes (its opener may have been re-rendered). */
  function restoreFocusAfterDialog(accountId) {
    const keys = accountId ? [`${accountId}-usage`, `${accountId}-settings-edit`, `${accountId}-connect`] : ['dashboard-add'];
    for (const key of keys) {
      const target = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (target && target.offsetParent !== null) { target.focus({ preventScroll: true }); return; }
    }
    document.getElementById(document.getElementById('settings-dialog').open ? 'settings-add-account' : 'add-account-button')?.focus({ preventScroll: true });
  }

  document.getElementById('account-provider').addEventListener('change', updateAccountFields);
  document.getElementById('account-mode').addEventListener('change', updateModeFields);
  document.getElementById('account-show-fable').addEventListener('change', updateTrayMetricRow);
  document.getElementById('add-manual-window').addEventListener('click', () => addManualWindow());
  document.getElementById('account-relogin').addEventListener('click', event => { if (editingAccount) openExternal('login', editingAccount.id, event.currentTarget); });
  document.getElementById('account-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('save-account');
    const error = document.getElementById('account-error'); error.hidden = true;
    const providerId = document.getElementById('account-provider').value;
    const mode = document.getElementById('account-mode').value;
    // Re-base on the current saved account so changes made meanwhile (for
    // example from the tray menu) are not reverted by this form.
    const current = editingAccount ? accounts().find(account => account.id === editingAccount.id) || editingAccount : {};
    const showFable = providerId === 'claude' && document.getElementById('account-show-fable').checked;
    const account = { ...current, providerId, mode, label: document.getElementById('account-label').value.trim(), visible: document.getElementById('account-visible').checked, trayVisible: document.getElementById('account-tray-visible').checked, showFable, trayMetric: showFable && document.getElementById('account-tray-metric').value === 'fable' ? 'fable' : 'primary' };
    if (!account.label) { error.textContent = t('account.labelRequired'); error.hidden = false; return; }
    if (mode === 'manual') {
      account.manualWindows = [];
      for (const row of document.querySelectorAll('.manual-window-row')) {
        const value = row.querySelector('.manual-used').value;
        const label = row.querySelector('.manual-label').value.trim();
        const reset = row.querySelector('.manual-reset').value;
        if (!value && !label && !reset) continue;
        if (value === '' || ui.percent(Number(value)) === null) { error.textContent = t('account.percentError'); error.hidden = false; return; }
        const resetDate = reset ? new Date(reset) : null;
        if (resetDate && !Number.isFinite(resetDate.getTime())) { error.textContent = t('account.resetError'); error.hidden = false; return; }
        const usedPercent = oneDecimal(value);
        const original = editingAccount?.manualWindows?.find(window => window.id === row.dataset.windowId);
        // The minute-only input must not truncate an unchanged saved deadline.
        const resetsAt = original && localDate(original.resetsAt) === reset ? original.resetsAt : resetDate?.toISOString() || null;
        account.manualWindows.push({ id: row.dataset.windowId, label: label || t('account.windowDefaultLabel'), usedPercent, remainingPercent: oneDecimal(100 - usedPercent), resetsAt, durationMinutes: Number(row.dataset.durationMinutes) || null });
      }
    }
    // Only fields actually changed in this editor take precedence. Other fields
    // may have changed through the tray while the dialog was open.
    if (editingAccount) {
      for (const key of ['label', 'visible', 'trayVisible', 'showFable', 'trayMetric', 'manualWindows']) {
        if (JSON.stringify(account[key]) === JSON.stringify(editingAccount[key])) account[key] = current[key];
      }
    }
    button.disabled = true;
    const isNew = !editingAccount;
    const editedId = editingAccount?.id || null;
    try {
      const result = await bridge.saveAccount(account);
      if (result?.ok === false) throw new Error(result.error);
      document.getElementById('account-dialog').close();
      render(result?.state || await bridge.getState());
      restoreFocusAfterDialog(editedId || result?.account?.id);
      toast(isNew ? t('account.added') : t('account.saved'));
      if (isNew && mode === 'isolated' && result?.account?.id) await openExternal('login', result.account.id);
    } catch (failure) { error.textContent = ui.safeError(failure, t('account.saveFailed')); error.hidden = false; }
    finally { button.disabled = false; }
  });
  document.getElementById('delete-account').addEventListener('click', async event => {
    if (!editingAccount) return;
    if (!deleteArmed) { deleteArmed = true; event.target.textContent = t('account.deleteConfirm'); return; }
    event.target.disabled = true;
    try {
      const result = await bridge.removeAccount(editingAccount.id);
      if (result?.ok === false) throw new Error(result.error);
      document.getElementById('account-dialog').close();
      render(result?.state || await bridge.getState());
      restoreFocusAfterDialog(null);
      toast(t('account.deleted'));
    } catch (error) { toast(ui.safeError(error, t('account.deleteFailed'))); }
    finally { event.target.disabled = false; }
  });

  async function refresh() {
    if (!bridge || manualRefreshing) return;
    // The main process joins an automatic refresh that is already running,
    // so a click during it still shows progress and waits for the result.
    manualRefreshing = true;
    state.refreshing = true;
    renderUpdateLine();
    try {
      const next = await bridge.refresh();
      if (next) render(next);
    } catch (error) {
      state.refreshing = false;
      toast(ui.safeError(error, t('refresh.failed')));
    } finally { manualRefreshing = false; renderUpdateLine(); }
  }

  function openDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog.open) return;
    dialog.showModal();
    // Start on the title, not on Close: no ring around X, and Enter cannot dismiss the sheet.
    dialog.querySelector('.sheet-heading h2')?.focus({ preventScroll: true });
    measureMain();
  }

  async function runUpdateAction(action) {
    if (!bridge || updateBusy) return;
    updateBusy = true; renderUpdateArea();
    try {
      if (action === 'check') render(await bridge.checkUpdates());
      else if (action === 'download') render(await bridge.downloadUpdate());
      else if (action === 'install') await bridge.installUpdate();
    } catch (error) { toast(ui.safeError(error, t('update.errorFailed'))); }
    finally { updateBusy = false; renderUpdateArea(); }
  }

  document.getElementById('refresh-button').addEventListener('click', refresh);
  document.getElementById('test-notification').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const result = await bridge.testNotification();
      const off = [['notifications', 'settings.notifications'], ['resetNotifications', 'settings.resetNotifications']].filter(([field]) => state.settings?.[field] === false).map(([, key]) => `‘${t(key)}’`);
      toast(!result?.ok ? t('settings.testBlocked') : off.length ? t(off.length > 1 ? 'settings.testAppOffBoth' : 'settings.testAppOff', { names: off.join(t('settings.and')) }) : t('settings.testSent'));
    }
    catch { toast(t('settings.testFailed')); }
    finally { button.disabled = false; }
  });
  document.getElementById('update-check-button').addEventListener('click', () => runUpdateAction('check'));
  document.getElementById('update-download-button').addEventListener('click', () => runUpdateAction('download'));
  document.getElementById('update-install-button').addEventListener('click', () => runUpdateAction('install'));
  document.getElementById('update-open-button').addEventListener('click', event => openExternal('release', undefined, event.currentTarget));
  document.getElementById('settings-button').addEventListener('click', () => openDialog('settings-dialog'));
  document.getElementById('add-account-button').addEventListener('click', () => editAccount());
  document.getElementById('settings-add-account').addEventListener('click', () => editAccount());
  document.getElementById('mobile-button').addEventListener('click', () => openDialog('mobile-dialog'));
  document.getElementById('help-button').addEventListener('click', () => openDialog('help-dialog'));
  for (const [id, action] of [['close-button', 'close'], ['minimize-button', 'minimize'], ['pin-button', 'toggle-pin']]) {
    document.getElementById(id).addEventListener('click', async () => {
      try { const next = await bridge?.windowAction(action); if (next && action === 'toggle-pin') render(next); }
      catch (error) { toast(ui.safeError(error, t('window.failed'))); }
    });
  }
  document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => {
    // Close on a backdrop click only when the press also started on the
    // backdrop; a text selection dragged outside the sheet keeps it open.
    let pressedOnBackdrop = false;
    const outside = event => { const rect = dialog.getBoundingClientRect(); return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom; };
    dialog.addEventListener('pointerdown', event => { pressedOnBackdrop = event.target === dialog && outside(event); });
    dialog.addEventListener('click', event => {
      const close = pressedOnBackdrop && event.target === dialog && outside(event);
      pressedOnBackdrop = false;
      if (close) dialog.close();
    });
  });
  document.querySelectorAll('[data-external]').forEach(button => button.addEventListener('click', () => openExternal(button.dataset.external, undefined, button)));
  controls.forEach(control => control.addEventListener('change', async () => {
    if (!bridge) return;
    let value = control.type === 'checkbox' ? control.checked : control.value;
    if (control.name === 'refreshSeconds') value = Number(value);
    if (control.getAttribute('aria-busy') === 'true') return;
    control.setAttribute('aria-busy', 'true');
    const saveStatus = document.getElementById('settings-save-status');
    saveStatus.textContent = t('settings.saving');
    if (control.name === 'theme') document.documentElement.dataset.theme = value;
    try {
      const next = await bridge.setSettings({ [control.name]: value });
      if (next) render(next);
      saveStatus.textContent = t('settings.saved');
    } catch (error) {
      saveStatus.textContent = t('settings.saveFailed');
      toast(ui.safeError(error, t('settings.saveError')));
    } finally {
      control.removeAttribute('aria-busy');
      syncSettings(control);
    }
  }));
  document.getElementById('copy-mobile-button').addEventListener('click', async () => {
    try {
      await bridge.copyMobileUrl();
      toast(t('mobile.copied'));
    } catch (error) { toast(ui.safeError(error, t('mobile.copyFailed'))); }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey && event.key.toLowerCase() === 'r') || event.key === 'F5') {
      event.preventDefault();
      refresh();
    }
    if (event.ctrlKey && event.key === ',') {
      event.preventDefault();
      openDialog('settings-dialog');
    }
  });

  // The window height follows the content, so there is no empty space below the
  // cards; while a sheet is open the window keeps enough height for it.
  const SHEET_MIN_HEIGHT = 600;
  let reportedMainHeight = 0, mainMeasureFrame = 0, stateRendered = !bridge;
  function measureMain() {
    if (!stateRendered) return;
    cancelAnimationFrame(mainMeasureFrame);
    mainMeasureFrame = requestAnimationFrame(() => {
      const titlebar = document.querySelector('.titlebar');
      const dashboard = document.querySelector('.dashboard');
      if (!titlebar || !dashboard) return;
      let height = Math.ceil(titlebar.getBoundingClientRect().height + dashboard.getBoundingClientRect().height);
      if (document.querySelector('dialog.sheet[open]')) height = Math.max(height, SHEET_MIN_HEIGHT);
      if (Math.abs(height - reportedMainHeight) < 2) return;
      reportedMainHeight = height;
      bridge?.reportMainSize?.(height).catch(() => {});
    });
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(measureMain).observe(document.querySelector('.dashboard'));
  (document.fonts?.ready || Promise.resolve()).then(measureMain);

  // Closing a sheet with the mouse returns focus to its opener; a keyboard focus
  // ring there would look like a stuck selection.
  let pointerInput = false;
  document.addEventListener('pointerdown', () => { pointerInput = true; }, true);
  document.addEventListener('keydown', () => { pointerInput = false; }, true);
  document.querySelectorAll('dialog.sheet').forEach(dialog => dialog.addEventListener('close', () => {
    measureMain();
    if (!pointerInput) return;
    requestAnimationFrame(() => { const active = document.activeElement; if (active && active !== document.body && active.matches(':focus-visible')) active.blur(); });
  }));

  render(state);
  if (bridge) {
    bridge.onState(render);
    bridge.getState().then(render).catch(() => {
      render({ providers: ui.placeholderProviders(t('dash.stateError')) });
      toast(t('dash.stateToast'));
    }).finally(() => { stateRendered = true; measureMain(); showClaudeNoticeOnce(); });
  } else render({ providers: ui.placeholderProviders(t('dash.placeholder')) });
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
