// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

const STATE = connection => ({
  products: [{
    id: 'limova_team',
    label: 'Limova Team',
    color: '#7C3AED',
    defaultEnvironment: 'production',
    environments: [{ id: 'production', label: 'Production' }, { id: 'staging', label: 'Staging' }],
    connection
  }],
  activity: [{ product: 'limova_team', at: 1_800_000_000_000, domain: 'example.com', label: 'Clic sur « Envoyer »', outcome: 'done' }]
});

function mountPanel() {
  document.body.innerHTML = `
    <div id="headerMenu"></div>
    <button id="teamConnectionsBtn"></button>
    <div id="teamBanner" hidden><span id="teamBannerText"></span><button id="teamBannerControl"></button><button id="teamBannerStop"></button></div>
    <section id="teamPanel" hidden><button id="teamPanelClose"></button><p id="teamFeedback"></p>
      <div id="teamProducts"></div><button id="teamStopAll" hidden></button><ul id="teamActivity"></ul></section>`;
}

describe('side panel « Connexions »', () => {
  let chromeMock;
  let state;
  beforeEach(() => {
    chromeMock = installChromeMock({ lang: 'fr-FR' });
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
    state = STATE(null);
    chromeMock.runtime.sendMessage = vi.fn(async message => (message.type === 'TEAM_GET_STATE' ? { ok: true, state } : { ok: true }));
    mountPanel();
    loadSidebarScript('src/sidebar/i18n.js');
  });
  afterEach(() => uninstallChromeMock());

  async function load() {
    loadSidebarScript('src/team/team-panel.js');
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('offers one « Se connecter » button and no environment choice in user builds', async () => {
    state = STATE(null);
    state.products[0].environments = [{ id: 'production', label: 'Production' }];
    await load();
    const card = document.querySelector('[data-product="limova_team"]');
    expect(card.textContent).toContain('Limova Team');
    expect(card.textContent).toContain('Non connecté');
    expect(card.querySelector('select')).toBeNull();
    const buttons = [...card.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Se connecter']);
    buttons[0].click();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_CONNECT', productId: 'limova_team' });
    expect(document.getElementById('teamStopAll').hidden).toBe(true);
  });

  it('shows the environment choice only behind the developer toggle', async () => {
    state = { ...STATE(null), environmentChoice: true };
    await load();
    const card = document.querySelector('[data-product="limova_team"]');
    const select = card.querySelector('select');
    expect([...select.options].map(option => option.value)).toEqual(['production', 'staging']);
    select.value = 'staging';
    [...card.querySelectorAll('button')].find(button => button.textContent === 'Se connecter').click();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_CONNECT', productId: 'limova_team', environment: 'staging' });
  });

  it('shows the connected state, autonomy, pause, take-over and the activity list', async () => {
    state = STATE({ environment: 'production', environment_label: 'Production', device_name: 'Chrome · macOS', status: 'online', email: 'marie@acme.fr', autonomy: 'full_access', paused: false, control: 'agent', running: 1, held: 0 });
    await load();
    const card = document.querySelector('[data-product="limova_team"]');
    expect(card.textContent).toContain('En ligne');
    expect(card.textContent).toContain('Connecté en tant que marie@acme.fr');
    expect(card.querySelector('select').value).toBe('full_access');
    const labels = [...card.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Mettre en pause', 'Prendre la main', 'Déconnecter']));
    expect(document.getElementById('teamBanner').hidden).toBe(false);
    expect(document.getElementById('teamBannerText').textContent).toContain('Limova Team');
    expect(document.getElementById('teamStopAll').hidden).toBe(false);
    document.getElementById('teamStopAll').click();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_STOP_ALL' });
    expect(document.getElementById('teamActivity').textContent).toContain('example.com');
    card.querySelector('select').value = 'ask_every_time';
    card.querySelector('select').dispatchEvent(new Event('change'));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_SET_AUTONOMY', productId: 'limova_team', autonomy: 'ask_every_time' });
  });

  it('offers « Rendre la main » while the person drives', async () => {
    state = STATE({ environment: 'production', environment_label: 'Production', status: 'online', autonomy: 'approve_for_me', paused: false, control: 'owner', running: 0, held: 1 });
    await load();
    expect(document.getElementById('teamBannerControl').textContent).toBe('Rendre la main');
    document.getElementById('teamBannerControl').click();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_HAND_BACK', productId: 'limova_team' });
  });

  it('never parses page-derived text as HTML', async () => {
    state = STATE(null);
    state.activity = [{ product: 'limova_team', at: 1, domain: '<img src=x onerror=alert(1)>', label: '<b>x</b>', outcome: 'done' }];
    await load();
    expect(document.querySelector('#teamActivity img, #teamActivity b')).toBeNull();
  });

  it('shows the saved-logins opt-in (off by default) and asks consent for one site before sending a session (TEAM-729)', async () => {
    state = STATE({ environment: 'production', environment_label: 'Production', status: 'online', autonomy: 'full_access', paused: false, control: 'agent', running: 0, held: 0,
      vault: { offer_in_own_tabs: false, never_origins: ['https://bad.example'] } });
    chromeMock.runtime.sendMessage = vi.fn(async message => {
      if (message.type === 'TEAM_GET_STATE') return { ok: true, state };
      if (message.type === 'TEAM_SESSION_SUGGEST') return message.input === undefined ? { ok: true, site: 'example.org' } : { ok: true, site: 'free.fr' };
      if (message.type === 'TEAM_SESSION_EXPORT') return { ok: true, count: 12, updated: false };
      return { ok: true };
    });
    await load();
    await new Promise(resolve => setTimeout(resolve, 0));
    const card = () => document.querySelector('[data-product="limova_team"]');
    expect(card().textContent).toContain('Proposer aussi d’enregistrer mes connexions dans mes onglets');
    const toggle = card().querySelector('#teamVaultOwnTabs-limova_team');
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_VAULT_SET_PREFS', productId: 'limova_team', offer_in_own_tabs: true });
    expect(card().textContent).toContain('https://bad.example');

    // The current tab's site is suggested; the person types another one.
    const site = card().querySelector('#teamSessionSite-limova_team');
    expect(site.value).toBe('example.org');
    site.value = 'https://subscribe.free.fr/login';
    site.dispatchEvent(new Event('input'));
    card().querySelector('#teamSessionStart-limova_team').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TEAM_SESSION_EXPORT' }));
    expect(card().textContent).toContain('Limova pourra utiliser ta session free.fr depuis ses navigateurs dans le cloud. Elle est chiffrée et tu peux la supprimer à tout moment.');
    card().querySelector('#teamSessionConfirm-limova_team').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_SESSION_EXPORT', productId: 'limova_team', site: 'free.fr', consent: true });
    expect(card().textContent).toContain('Session free.fr envoyée (12 cookies).');
  });

  describe('home screen product picker (TEAM-726)', () => {
    function mountPicker() {
      document.body.insertAdjacentHTML('afterbegin', `
        <section id="productPicker" hidden>
          <button id="pickLimova"></button><button id="pickTeam"></button>
        </section>
        <button id="teamPanelCloseHolder"></button>`);
      document.getElementById('teamPanel').insertAdjacentHTML('beforeend', '<button id="teamSwitchProduct"></button>');
    }

    function respond({ authenticated = false } = {}) {
      chromeMock.runtime.sendMessage = vi.fn(async message => {
        if (message.type === 'TEAM_GET_STATE') return { ok: true, state };
        if (message.type === 'AUTH_GET_STATE') return { authenticated };
        return { ok: true };
      });
    }

    it('asks « Limova » or « Limova Team » first, before any sign-in', async () => {
      mountPicker();
      respond();
      await load();
      expect(document.getElementById('productPicker').hidden).toBe(false);
      document.getElementById('pickTeam').click();
      expect(document.getElementById('productPicker').hidden).toBe(true);
      expect(document.getElementById('teamPanel').hidden).toBe(false);
      expect(document.getElementById('teamPanel').dataset.mode).toBe('home');
      expect(document.getElementById('teamPanelClose').hidden).toBe(true);
      expect(chromeMock._storage.get('limova_home_product_v1')).toBe('limova_team');
    });

    it('« Limova » leaves Charly as it was', async () => {
      mountPicker();
      respond();
      await load();
      document.getElementById('pickLimova').click();
      expect(document.getElementById('productPicker').hidden).toBe(true);
      expect(document.getElementById('teamPanel').hidden).toBe(true);
      expect(chromeMock._storage.get('limova_home_product_v1')).toBe('limova');
    });

    it('never shows the picker to someone already signed in to Charly', async () => {
      mountPicker();
      respond({ authenticated: true });
      await load();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(document.getElementById('productPicker').hidden).toBe(true);
      expect(document.getElementById('teamPanel').hidden).toBe(true);
    });

    it('opens the Team home directly once chosen, and can switch back', async () => {
      mountPicker();
      chromeMock._storage.set('limova_home_product_v1', 'limova_team');
      respond();
      await load();
      expect(document.getElementById('teamPanel').hidden).toBe(false);
      document.getElementById('teamSwitchProduct').click();
      expect(document.getElementById('productPicker').hidden).toBe(false);
      expect(document.getElementById('teamPanel').hidden).toBe(true);
    });
  });
});
