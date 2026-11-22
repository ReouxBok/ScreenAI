// team-panel.js — The side panel's « Connexions » section (TEAM-724).
//
// A classic script loaded after sidebar.js; it uses the sidebar's global `t()` from
// i18n.js. Rendering is data-driven: one card per product the service worker lists
// (Limova Team today, « Limova » later), so adding a product needs no change here.
// Every page-derived string (activity domains and labels) is written with textContent.
//
// It talks to the service worker with TEAM_* messages and re-renders on TEAM_STATE.
//
// TEAM-726: the side panel's home screen first asks « Limova » or « Limova Team ».
// « Limova » leaves Charly exactly as before (its own sign-in and chat). « Limova
// Team » shows the Team home: one « Se connecter » button (no environment choice in
// user builds), then who is connected, online or not, pause, « Tout arrêter » and
// « Déconnecter ». People already signed in to Charly never see the picker.
//
// TEAM-729: a connected card also shows « Connexions enregistrées »: the opt-in
// « Proposer aussi d’enregistrer mes connexions dans mes onglets » (off by default), the
// « Jamais pour ces sites » list, and « Envoyer ma session à Limova » for one site at a
// time, behind a consent screen naming that site. The panel never sees a password or a
// cookie: it sends the site, the service worker reads and sends the cookies.
(function teamPanel() {
  const HOME_KEY = 'limova_home_product_v1';
  const $ = id => document.getElementById(id);
  const tr = key => (typeof globalThis.t === 'function' ? globalThis.t(key) : key);
  const STATUS_KEYS = {
    online: 'teamStatusOnline',
    connecting: 'teamStatusConnecting',
    offline: 'teamStatusOffline',
    idle: 'teamStatusOffline',
    disabled: 'teamStatusDisabled',
    replaced: 'teamStatusReplaced',
    revoked: 'teamStatusNotConnected'
  };
  const AUTONOMY_OPTIONS = [
    ['ask_every_time', 'autonomyAsk'],
    ['approve_for_me', 'autonomyBalanced'],
    ['full_access', 'autonomyFull']
  ];
  let state = null;
  let feedback = '';
  // « Envoyer ma session à Limova »: kept across re-renders (TEAM_STATE redraws the cards).
  const session = { site: null, consent: null, busy: false, message: '', kind: '' };
  const SESSION_ERRORS = {
    invalid_site: 'teamSessionInvalid',
    blocked_site: 'teamSessionBlocked',
    no_cookies: 'teamSessionEmpty',
    too_many: 'teamSessionTooLarge',
    too_large: 'teamSessionTooLarge',
    disabled: 'teamSessionDisabled'
  };

  function send(message) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  async function refresh() {
    const response = await send({ type: 'TEAM_GET_STATE' });
    if (response?.ok) {
      state = response.state;
      render();
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function labelled(labelText, control) {
    const wrap = el('label', 'team-field');
    wrap.append(el('span', 'team-field-label', labelText), control);
    return wrap;
  }

  function fill(text, values) {
    return Object.entries(values).reduce((out, [key, value]) => out.split(`{${key}}`).join(String(value)), text);
  }

  async function suggestSite() {
    if (session.site !== null) return;
    session.site = '';
    const response = await send({ type: 'TEAM_SESSION_SUGGEST' });
    if (!session.site && typeof response?.site === 'string') {
      session.site = response.site;
      render();
    }
  }

  async function exportSession(productId) {
    const site = session.consent;
    session.busy = true;
    session.message = tr('teamSessionSending');
    session.kind = '';
    render();
    const response = await send({ type: 'TEAM_SESSION_EXPORT', productId, site, consent: true });
    session.busy = false;
    session.consent = null;
    if (response?.ok) {
      session.message = fill(tr('teamSessionSent'), { site, count: Number(response.count) || 0 });
      session.kind = 'ok';
    } else {
      session.message = tr(SESSION_ERRORS[response?.error] || 'teamSessionFailed');
      session.kind = 'error';
    }
    render();
  }

  function renderVault(product, connection) {
    const box = el('section', 'team-vault');
    box.append(el('h4', 'team-vault-title', tr('teamVaultTitle')));
    const vault = connection.vault || { offer_in_own_tabs: false, never_origins: [] };

    const toggle = el('label', 'team-check');
    const input = el('input');
    input.type = 'checkbox';
    input.id = `teamVaultOwnTabs-${product.id}`;
    input.checked = vault.offer_in_own_tabs === true;
    input.addEventListener('change', () => send({ type: 'TEAM_VAULT_SET_PREFS', productId: product.id, offer_in_own_tabs: input.checked }));
    toggle.append(input, el('span', '', tr('teamVaultOwnTabs')));
    box.append(toggle, el('p', 'team-muted', tr('teamVaultHint')));

    if (vault.never_origins?.length) {
      box.append(el('p', 'team-field-label', tr('teamVaultNever')));
      const list = el('ul', 'team-never');
      for (const origin of vault.never_origins) {
        const row = el('li');
        row.append(el('span', '', origin), button(tr('teamVaultNeverRemove'), 'team-link-muted', () => (
          send({ type: 'TEAM_VAULT_SET_PREFS', productId: product.id, remove_never: origin })
        )));
        list.append(row);
      }
      box.append(list);
    }

    box.append(el('h4', 'team-vault-title', tr('teamSessionTitle')));
    if (session.consent) {
      const consent = el('div', 'team-consent');
      consent.setAttribute('role', 'group');
      consent.append(el('p', '', fill(tr('teamSessionConsent'), { site: session.consent })));
      const actions = el('div', 'team-actions');
      const confirm = button(tr('teamSessionConfirm'), 'team-primary', () => exportSession(product.id));
      confirm.id = `teamSessionConfirm-${product.id}`;
      confirm.disabled = session.busy;
      const cancel = button(tr('teamSessionCancel'), 'team-secondary', () => {
        session.consent = null;
        session.message = '';
        render();
      });
      cancel.disabled = session.busy;
      actions.append(cancel, confirm);
      consent.append(actions);
      box.append(consent);
    } else {
      box.append(el('p', 'team-muted', tr('teamSessionHint')));
      const site = el('input', 'team-select');
      site.id = `teamSessionSite-${product.id}`;
      site.type = 'text';
      site.placeholder = 'free.fr';
      site.autocomplete = 'off';
      site.spellcheck = false;
      site.value = session.site || '';
      site.addEventListener('input', () => { session.site = site.value; });
      box.append(labelled(tr('teamSessionSite'), site));
      const start = button(tr('teamSessionStart'), 'team-secondary', async () => {
        // The service worker turns what was typed into the registrable domain whose
        // cookies it would read; the consent screen names exactly that site.
        const response = await send({ type: 'TEAM_SESSION_SUGGEST', input: String(session.site || '') });
        if (!response?.ok || typeof response.site !== 'string') {
          session.message = tr(response?.error === 'blocked_site' ? 'teamSessionBlocked' : 'teamSessionInvalid');
          session.kind = 'error';
          render();
          return;
        }
        session.site = response.site;
        session.consent = response.site;
        session.message = '';
        render();
      });
      start.id = `teamSessionStart-${product.id}`;
      box.append(start);
    }
    if (session.message) {
      const note = el('p', `team-muted${session.kind === 'error' ? ' team-error' : session.kind === 'ok' ? ' team-ok' : ''}`, session.message);
      note.setAttribute('role', 'status');
      box.append(note);
    }
    return box;
  }

  function renderCard(product) {
    const card = el('article', 'team-card');
    card.style.setProperty('--product', product.color);
    card.dataset.product = product.id;
    const head = el('header', 'team-card-head');
    head.append(el('span', 'team-dot'), el('strong', 'team-card-title', product.label));
    const connection = product.connection;
    const statusKey = connection ? (STATUS_KEYS[connection.status] || 'teamStatusOffline') : 'teamStatusNotConnected';
    const pill = el('span', `team-status team-status-${connection ? connection.status : 'none'}`, tr(statusKey));
    head.append(pill);
    card.append(head);

    if (!connection) {
      // Only the developer toggle shows the environment choice (TEAM-726).
      let select = null;
      if (state?.environmentChoice && product.environments.length > 1) {
        select = el('select', 'team-select');
        select.id = `teamEnv-${product.id}`;
        for (const env of product.environments) {
          const option = el('option', '', env.label);
          option.value = env.id;
          if (env.id === product.defaultEnvironment) option.selected = true;
          select.append(option);
        }
        card.append(labelled(tr('teamEnvironment'), select));
      }
      card.append(button(tr('teamSignIn'), 'team-primary', async () => {
        feedback = tr('teamPairingOpened');
        render();
        const message = { type: 'TEAM_CONNECT', productId: product.id };
        if (select) message.environment = select.value;
        const response = await send(message);
        if (!response?.ok) {
          feedback = tr('teamPairingFailed');
          render();
        }
      }));
      return card;
    }

    // Production is the normal case; any other environment is spelled out.
    const meta = [connection.environment === 'production' ? '' : connection.environment_label, connection.device_name].filter(Boolean).join(' · ');
    if (connection.email) card.append(el('p', 'team-muted', `${tr('teamConnectedAs')} ${connection.email}`));
    if (meta) card.append(el('p', 'team-muted', meta));
    if (connection.status === 'replaced' || connection.status === 'disabled' || connection.status === 'offline') {
      card.append(button(tr('teamReconnect'), 'team-secondary', () => send({ type: 'TEAM_RECONNECT', productId: product.id })));
    }

    const autonomy = el('select', 'team-select');
    autonomy.id = `teamAutonomy-${product.id}`;
    for (const [value, key] of AUTONOMY_OPTIONS) {
      const option = el('option', '', tr(key));
      option.value = value;
      if (value === connection.autonomy) option.selected = true;
      autonomy.append(option);
    }
    autonomy.addEventListener('change', () => send({ type: 'TEAM_SET_AUTONOMY', productId: product.id, autonomy: autonomy.value }));
    card.append(labelled(tr('teamAutonomy'), autonomy));

    const actions = el('div', 'team-actions');
    if (connection.paused) {
      card.append(el('p', 'team-paused', tr('teamPausedNote')));
      actions.append(button(tr('teamResume'), 'team-primary', () => send({ type: 'TEAM_RESUME', productId: product.id })));
    } else {
      actions.append(button(tr('teamPause'), 'team-secondary', () => send({ type: 'TEAM_PAUSE', productId: product.id })));
    }
    if (connection.control === 'owner') {
      actions.append(button(tr('teamHandBack'), 'team-primary', () => send({ type: 'TEAM_HAND_BACK', productId: product.id })));
    } else if (connection.running > 0 || connection.held > 0) {
      actions.append(button(tr('teamTakeOver'), 'team-secondary', () => send({ type: 'TEAM_TAKE_OVER', productId: product.id })));
    }
    card.append(actions);
    card.append(renderVault(product, connection));
    card.append(button(tr('teamDisconnect'), 'team-link-danger', async () => {
      if (!window.confirm(tr('teamDisconnectConfirm'))) return;
      await send({ type: 'TEAM_DISCONNECT', productId: product.id });
      feedback = tr('teamDisconnected');
      refresh();
    }));
    return card;
  }

  function renderBanner() {
    const banner = $('teamBanner');
    if (!banner) return;
    const active = (state?.products || []).find(product => product.connection
      && (product.connection.control === 'owner' || product.connection.running > 0 || product.connection.held > 0));
    if (!active) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.style.setProperty('--product', active.color);
    const owner = active.connection.control === 'owner';
    $('teamBannerText').textContent = `${active.label} · ${tr(owner ? 'teamOwnerDriving' : 'teamAgentDriving')}`;
    const control = $('teamBannerControl');
    control.textContent = tr(owner ? 'teamHandBack' : 'teamTakeOver');
    control.onclick = () => send({ type: owner ? 'TEAM_HAND_BACK' : 'TEAM_TAKE_OVER', productId: active.id });
  }

  function renderActivity() {
    const list = $('teamActivity');
    if (!list) return;
    list.replaceChildren();
    const items = state?.activity || [];
    if (!items.length) {
      list.append(el('li', 'team-muted', tr('teamActivityEmpty')));
      return;
    }
    for (const item of items.slice(0, 12)) {
      const row = el('li', `team-activity-item${item.outcome === 'done' ? '' : ' is-failed'}`);
      const time = el('time', 'team-time', new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      row.append(time, el('span', 'team-activity-label', item.label));
      if (item.domain) row.append(el('span', 'team-activity-domain', item.domain));
      list.append(row);
    }
  }

  function render() {
    const container = $('teamProducts');
    if (container && state) {
      // Redraws must not steal the caret from the field the person is typing in.
      const focusedId = document.activeElement?.id || '';
      container.replaceChildren(...state.products.map(renderCard));
      const again = focusedId ? document.getElementById(focusedId) : null;
      if (again && container.contains(again)) {
        again.focus();
        if (typeof again.setSelectionRange === 'function' && again.type === 'text') again.setSelectionRange(again.value.length, again.value.length);
      }
      if (state.products.some(product => product.connection)) suggestSite();
    }
    const note = $('teamFeedback');
    if (note) note.textContent = feedback;
    const anyConnected = (state?.products || []).some(product => product.connection);
    const stopAll = $('teamStopAll');
    if (stopAll) stopAll.hidden = !anyConnected;
    renderBanner();
    renderActivity();
  }

  function openPanel(mode = 'overlay') {
    const menu = $('headerMenu');
    if (menu) menu.hidden = true;
    const panel = $('teamPanel');
    panel.hidden = false;
    panel.dataset.mode = mode;
    // As the home screen there is nothing to close to; « Changer de produit » goes back.
    const close = $('teamPanelClose');
    if (close) close.hidden = mode === 'home';
    feedback = '';
    refresh();
  }

  function remember(choice) {
    return Promise.resolve(chrome.storage?.local?.set?.({ [HOME_KEY]: choice })).catch(() => {});
  }

  function showPicker() {
    const picker = $('productPicker');
    if (!picker) return;
    $('teamPanel').hidden = true;
    picker.hidden = false;
    $('pickTeam')?.focus();
  }

  async function chooseHome() {
    const stored = await Promise.resolve(chrome.storage?.local?.get?.(HOME_KEY)).then(data => data?.[HOME_KEY]).catch(() => null);
    await refresh();
    const teamConnected = (state?.products || []).some(product => product.connection);
    if (stored === 'limova_team' || (!stored && teamConnected)) {
      openPanel('home');
      return;
    }
    if (stored === 'limova') return;
    // Existing Charly users keep Charly as it was.
    const auth = await send({ type: 'AUTH_GET_STATE' });
    if (auth?.authenticated === true) return;
    showPicker();
  }

  function init() {
    if (!$('teamPanel')) return;
    $('teamConnectionsBtn')?.addEventListener('click', () => openPanel('overlay'));
    $('authTeamConnections')?.addEventListener('click', () => openPanel('overlay'));
    $('pickLimova')?.addEventListener('click', () => {
      remember('limova');
      $('productPicker').hidden = true;
    });
    $('pickTeam')?.addEventListener('click', () => {
      remember('limova_team');
      $('productPicker').hidden = true;
      openPanel('home');
    });
    $('teamSwitchProduct')?.addEventListener('click', showPicker);
    $('teamPanelClose')?.addEventListener('click', () => { $('teamPanel').hidden = true; });
    const stopAll = () => send({ type: 'TEAM_STOP_ALL' });
    $('teamStopAll')?.addEventListener('click', stopAll);
    $('teamBannerStop')?.addEventListener('click', stopAll);
    // Language changes re-run applyTranslations; re-render the dynamic parts too.
    document.querySelectorAll('.lang-option').forEach(option => option.addEventListener('click', () => setTimeout(render, 0)));
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'TEAM_STATE' && message.state) {
        state = message.state;
        render();
      }
    });
    chooseHome();
  }

  globalThis.limovaTeamPanel = { refresh, render, openPanel, getState: () => state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
