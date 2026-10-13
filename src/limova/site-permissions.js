export function bindSitePermissions({ document, permissions, tabs }) {
  const input = document.getElementById('limovaSiteOrigin');
  const button = document.getElementById('limovaSiteAllow');
  const status = document.getElementById('limovaSiteStatus');
  if (!input || !button || !status) return;
  document.getElementById('limovaSiteDetect').addEventListener('click', async () => {
    try {
      const [tab] = await tabs.query({ active: true, lastFocusedWindow: true });
      const url = new URL(tab?.url);
      if (url.protocol !== 'https:') throw new Error();
      input.value = url.origin;
      status.textContent = 'Vérifie le site, puis clique sur « Autoriser ce site ».';
    } catch { status.textContent = 'Colle l’adresse HTTPS du site à autoriser.'; }
  });
  button.addEventListener('click', () => {
    let origin;
    try {
      const url = new URL(input.value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes('*')) throw new Error();
      origin = url.origin;
    } catch { status.textContent = 'Indique une adresse HTTPS valide, sans identifiants.'; return; }
    // Invoke synchronously from the click so Chrome retains the user gesture.
    const requested = permissions.request({ origins: [`${origin}/*`] });
    button.disabled = true;
    Promise.resolve(requested).then(granted => {
      status.textContent = granted ? `Accès autorisé à ${origin}. Coche ensuite l’autorisation pour ton message.`
        : `Accès refusé à ${origin}. Aucun accès supplémentaire n’a été accordé.`;
    }).catch(() => { status.textContent = 'Chrome n’a pas pu accorder cet accès. Réessaie depuis le bouton.'; })
      .finally(() => { button.disabled = false; });
  });
}
