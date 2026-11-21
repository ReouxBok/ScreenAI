// pair-callback.js — The page the Limova Team dashboard sends the tab to after the
// person approved this browser (TEAM-724).
//
// It is a web_accessible_resources entry reachable only from the Team dashboard
// origins. It hands `code` and `state` to the service worker, which checks `state`
// against the pairing this browser started and redeems the code with its PKCE
// verifier. The code is removed from the address bar at once. On success the tab
// closes itself after a few seconds; « Ouvrir le panneau Charly » opens the side panel
// (Chrome only allows that from a click).
(function pairCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  history.replaceState(null, '', location.pathname);
  const $ = elementId => document.getElementById(elementId);
  let windowId = null;
  let tabId = null;

  chrome.tabs.getCurrent(tab => {
    windowId = tab?.windowId ?? null;
    tabId = tab?.id ?? null;
  });

  function closeTab() {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => window.close());
    else window.close();
  }

  $('closeTab').addEventListener('click', closeTab);
  $('openPanel').addEventListener('click', () => {
    if (windowId !== null) chrome.sidePanel.open({ windowId }).catch(() => {});
    setTimeout(closeTab, 300);
  });

  function show(ok, title, message) {
    $('title').textContent = title;
    $('message').textContent = message;
    $('message').className = ok ? 'status-ok' : 'status-error';
    $('openPanel').hidden = !ok;
    $('closeTab').hidden = false;
  }

  chrome.runtime.sendMessage({ type: 'TEAM_PAIR_CALLBACK', code, state }).then(response => {
    if (response?.ok) {
      show(true, `${response.product || 'Limova Team'} est connecté à ce navigateur`,
        'Limova peut maintenant agir dans le groupe d’onglets « Limova Team », selon le niveau d’autonomie choisi dans le panneau Charly. Cet onglet va se fermer.');
      setTimeout(closeTab, 6000);
    } else {
      show(false, 'La connexion n’a pas abouti', response?.message || 'Relance la connexion depuis le panneau Charly.');
    }
  }).catch(() => {
    show(false, 'La connexion n’a pas abouti', 'Charly ne répond pas. Recharge l’extension puis relance la connexion.');
  });
})();
