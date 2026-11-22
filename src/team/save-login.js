// save-login.js — « Enregistrer cette connexion pour Limova ? » (TEAM-729).
//
// The window the service worker opens after a login it saw succeed
// (login-offers.js). Its URL only carries an opaque id; the site and the username come
// from the service worker by message and are written with textContent / value only.
// The password never reaches this page: « Enregistrer » only sends the id and the
// (possibly corrected) username, and the service worker posts the login itself.
// Closing the window counts as « Pas maintenant ».
(function saveLoginWindow() {
  const id = new URLSearchParams(location.search).get('id') || '';
  const $ = elementId => document.getElementById(elementId);
  let details = null;
  let timer = null;
  let done = false;

  const ERRORS = {
    disabled: 'L’enregistrement des connexions n’est pas ouvert pour ton espace Limova Team.',
    revoked: 'Ce navigateur n’est plus connecté à Limova Team.',
    rejected: 'Limova Team n’accepte pas cette connexion pour ce site.',
    blocked_site: 'Limova n’enregistre pas de connexion pour ce site.',
    unavailable: 'Limova Team ne peut pas enregistrer de connexion pour le moment. Réessaie plus tard.',
    network: 'Impossible de joindre Limova Team. La connexion n’a pas été enregistrée.',
    expired: 'Cette demande a expiré : la connexion n’a pas été gardée.',
    invalid_username: 'Indique l’identifiant de ce compte (1 à 320 caractères).'
  };

  function closeSoon(delay = 150) {
    clearInterval(timer);
    setTimeout(() => window.close(), delay);
  }

  function setButtons(enabled) {
    for (const key of ['save', 'later', 'never']) $(key).disabled = !enabled;
    $('username').disabled = !enabled;
  }

  function status(text, kind) {
    const node = $('status');
    node.textContent = text;
    node.className = `countdown${kind ? ` status-${kind}` : ''}`;
  }

  async function decide(decision) {
    if (done) return;
    const payload = { type: 'TEAM_LOGIN_OFFER_DECIDE', id, decision };
    if (decision === 'save') payload.username = $('username').value;
    setButtons(false);
    let response = null;
    try {
      response = await chrome.runtime.sendMessage(payload);
    } catch (_) {
      response = null;
    }
    if (decision !== 'save') {
      done = true;
      closeSoon();
      return;
    }
    if (response?.ok) {
      done = true;
      status(response.updated ? 'Connexion mise à jour. Limova pourra s’en servir.' : 'Connexion enregistrée. Limova pourra s’en servir.', 'ok');
      closeSoon(1400);
      return;
    }
    const error = response?.error || 'unavailable';
    status(ERRORS[error] || ERRORS.unavailable, 'error');
    if (error === 'invalid_username') {
      setButtons(true);
      $('username').focus();
      return;
    }
    done = true;
    $('later').disabled = false;
    $('later').textContent = 'Fermer';
  }

  function render() {
    document.documentElement.style.setProperty('--product', details.productColor || '#7C3AED');
    $('productLabel').textContent = details.productLabel || 'Limova Team';
    const title = details.update ? 'Mettre à jour la connexion enregistrée ?' : 'Enregistrer cette connexion pour Limova ?';
    $('title').textContent = title;
    document.title = title;
    $('site').textContent = details.site || details.origin || '';
    $('site').title = details.origin || '';
    $('username').value = details.username || '';
    const sync = () => { $('save').disabled = done || !$('username').value.trim(); };
    $('username').addEventListener('input', sync);
    sync();
    const tick = () => {
      const left = Math.max(0, Math.round((Number(details.expires_at) - Date.now()) / 1000));
      if (done) return;
      status(left > 0 ? `Sans réponse dans ${left} s, la connexion sera oubliée.` : 'Temps écoulé : la connexion a été oubliée.');
      if (left <= 0) {
        done = true;
        setButtons(false);
        closeSoon(1200);
      }
    };
    tick();
    timer = setInterval(tick, 1000);
    (details.username ? $('save') : $('username')).focus();
  }

  $('save').addEventListener('click', () => decide('save'));
  $('later').addEventListener('click', () => (done ? closeSoon() : decide('later')));
  $('never').addEventListener('click', () => decide('never'));
  $('username').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !$('save').disabled) decide('save');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') (done ? closeSoon() : decide('later'));
  });

  setButtons(false);
  chrome.runtime.sendMessage({ type: 'TEAM_LOGIN_OFFER_GET', id }).then(response => {
    if (!response?.ok) {
      $('title').textContent = 'Cette demande n’est plus valable.';
      $('intro').textContent = 'La connexion n’a pas été gardée.';
      done = true;
      $('save').hidden = true;
      $('never').hidden = true;
      $('later').disabled = false;
      $('later').textContent = 'Fermer';
      return;
    }
    details = response.details;
    setButtons(true);
    render();
  }).catch(() => {
    $('title').textContent = 'Cette demande n’est plus valable.';
  });
})();
