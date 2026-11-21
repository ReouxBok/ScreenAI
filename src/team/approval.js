// approval.js — The small window where the person approves or refuses (TEAM-724).
//
// The URL only carries an opaque id; the details come from the service worker and are
// written with textContent only (element names come from web pages and must never be
// parsed as HTML). Closing the window counts as « Refuser » (the service worker sees
// the window go away).
(function approvalWindow() {
  const id = new URLSearchParams(location.search).get('id') || '';
  const $ = elementId => document.getElementById(elementId);
  let details = null;
  let countdownTimer = null;

  function closeSoon() {
    clearInterval(countdownTimer);
    setTimeout(() => window.close(), 150);
  }

  function decide(decision) {
    const payload = { type: 'TEAM_APPROVAL_DECIDE', id, decision };
    if (decision === 'approve' && details?.kind === 'request_tab') {
      const checked = document.querySelector('input[name="tab"]:checked');
      if (!checked) return;
      payload.tabId = Number(checked.value);
    }
    $('approve').disabled = true;
    $('deny').disabled = true;
    chrome.runtime.sendMessage(payload).catch(() => {}).finally(closeSoon);
  }

  function renderTabs(tabs) {
    const box = $('tabs');
    box.hidden = false;
    box.replaceChildren();
    if (!tabs.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Aucun onglet ne peut être partagé.';
      box.append(empty);
      return;
    }
    for (const tab of tabs) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tab';
      input.value = String(tab.tab_id);
      input.addEventListener('change', () => { $('approve').disabled = false; });
      const text = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.title || tab.domain || 'Onglet';
      const domain = document.createElement('small');
      domain.textContent = tab.domain || '';
      text.append(title, domain);
      label.append(input, text);
      box.append(label);
    }
  }

  function render() {
    document.documentElement.style.setProperty('--product', details.productColor || '#7C3AED');
    $('productLabel').textContent = details.productLabel || 'Limova Team';
    $('title').textContent = details.title || '';
    document.title = details.title || document.title;
    $('reason').textContent = details.reason || '';
    const lines = $('lines');
    lines.replaceChildren();
    for (const line of details.lines || []) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = line.label;
      const value = document.createElement('dd');
      value.textContent = line.text;
      row.append(term, value);
      lines.append(row);
    }
    if (details.domain) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = 'Site';
      const value = document.createElement('dd');
      value.textContent = details.domain;
      row.append(term, value);
      lines.prepend(row);
    }
    if (details.kind === 'request_tab') {
      renderTabs(details.tabs || []);
      $('approve').textContent = 'Partager cet onglet';
    } else {
      $('approve').disabled = false;
      $('approve').textContent = details.confirmLabel || 'Autoriser';
    }
    $('deny').textContent = details.denyLabel || 'Refuser';
    const tick = () => {
      const left = Math.max(0, Math.round((Number(details.expires_at) - Date.now()) / 1000));
      $('countdown').textContent = left > 0 ? `Sans réponse dans ${left} s, l’action sera abandonnée.` : 'Temps écoulé.';
      if (left <= 0) closeSoon();
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
    (details.kind === 'request_tab' ? $('deny') : $('approve')).focus();
  }

  $('approve').addEventListener('click', () => decide('approve'));
  $('deny').addEventListener('click', () => decide('deny'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') decide('deny');
  });

  chrome.runtime.sendMessage({ type: 'TEAM_APPROVAL_GET', id }).then(response => {
    if (!response?.ok) {
      $('title').textContent = 'Cette demande n’est plus valable.';
      $('approve').hidden = true;
      $('deny').textContent = 'Fermer';
      $('deny').addEventListener('click', closeSoon);
      return;
    }
    details = response.details;
    render();
  }).catch(() => {
    $('title').textContent = 'Cette demande n’est plus valable.';
  });
})();
