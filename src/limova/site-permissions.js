export function bindSitePermissions({ document, permissions, tabs, translate = (_key, fallback) => fallback }) {
  const input = document.getElementById('limovaSiteOrigin');
  const button = document.getElementById('limovaSiteAllow');
  const status = document.getElementById('limovaSiteStatus');
  if (!input || !button || !status) return;
  let notice = null;
  function report(key, fallback, origin = '') {
    notice = { key, fallback, origin };
    status.textContent = translate(key, fallback).replace('{origin}', origin);
  }
  document.getElementById('limovaSiteDetect').addEventListener('click', async () => {
    try {
      const [tab] = await tabs.query({ active: true, lastFocusedWindow: true });
      const url = new URL(tab?.url);
      if (url.protocol !== 'https:') throw new Error();
      input.value = url.origin;
      report("limovaSiteReview", "Vérifie le site, puis clique sur « Autoriser ce site ».");
    } catch { report("limovaSitePaste", "Colle l’adresse HTTPS du site à autoriser."); }
  });
  button.addEventListener('click', () => {
    let origin;
    try {
      const url = new URL(input.value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || /[*%]/.test(url.hostname)) throw new Error();
      origin = url.origin;
    } catch { report("limovaSiteInvalid", "Indique une adresse HTTPS valide, sans identifiants."); return; }
    // Invoke synchronously from the click so Chrome retains the user gesture.
    let requested;
    try { requested = permissions.request({ origins: [`${origin}/*`] }); }
    catch { report("limovaSiteError", "Chrome n’a pas pu accorder cet accès. Réessaie depuis le bouton."); return; }
    button.disabled = true;
    Promise.resolve(requested).then(granted => {
      if (granted) report('limovaSiteGranted', 'Accès autorisé à {origin}. Coche ensuite l’autorisation pour ton message.', origin);
      else report('limovaSiteDenied', 'Accès refusé à {origin}. Aucun accès supplémentaire n’a été accordé.', origin);
    }).catch(() => { report("limovaSiteError", "Chrome n’a pas pu accorder cet accès. Réessaie depuis le bouton."); })
      .finally(() => { button.disabled = false; });
  });
  return { relocalize() { if (notice) report(notice.key, notice.fallback, notice.origin); } };
}
