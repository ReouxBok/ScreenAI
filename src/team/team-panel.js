// team-panel.js — The side panel's « Connexions » section (TEAM-724).
//
// A classic script loaded after sidebar.js; it uses the sidebar's global `t()` from
// i18n.js. Rendering is data-driven: one card per product the service worker lists
// (Limova Team today, « Limova » later), so adding a product needs no change here.
// Every page-derived string (activity domains and labels) is written with textContent.
//
// It talks to the service worker with TEAM_* messages and re-renders on TEAM_STATE.
(function teamPanel() {
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
      const select = el('select', 'team-select');
      select.id = `teamEnv-${product.id}`;
      for (const env of product.environments) {
        const option = el('option', '', env.label);
        option.value = env.id;
        if (env.id === product.defaultEnvironment) option.selected = true;
        select.append(option);
      }
      card.append(labelled(tr('teamEnvironment'), select));
      card.append(button(tr('teamConnect'), 'team-primary', async () => {
        feedback = tr('teamPairingOpened');
        render();
        const response = await send({ type: 'TEAM_CONNECT', productId: product.id, environment: select.value });
        if (!response?.ok) {
          feedback = tr('teamPairingFailed');
          render();
        }
      }));
      return card;
    }

    const meta = [connection.environment_label, connection.device_name].filter(Boolean).join(' · ');
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
      container.replaceChildren(...state.products.map(renderCard));
    }
    const note = $('teamFeedback');
    if (note) note.textContent = feedback;
    const anyConnected = (state?.products || []).some(product => product.connection);
    const stopAll = $('teamStopAll');
    if (stopAll) stopAll.hidden = !anyConnected;
    renderBanner();
    renderActivity();
  }

  function openPanel() {
    const menu = $('headerMenu');
    if (menu) menu.hidden = true;
    $('teamPanel').hidden = false;
    feedback = '';
    refresh();
  }

  function init() {
    if (!$('teamPanel')) return;
    $('teamConnectionsBtn')?.addEventListener('click', openPanel);
    $('authTeamConnections')?.addEventListener('click', openPanel);
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
    refresh();
  }

  globalThis.limovaTeamPanel = { refresh, render, openPanel, getState: () => state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
