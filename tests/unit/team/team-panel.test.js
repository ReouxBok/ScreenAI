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

  it('renders a card per product, with the environment choice before pairing', async () => {
    await load();
    const card = document.querySelector('[data-product="limova_team"]');
    expect(card.textContent).toContain('Limova Team');
    expect(card.textContent).toContain('Non connecté');
    const select = card.querySelector('select');
    expect([...select.options].map(option => option.value)).toEqual(['production', 'staging']);
    select.value = 'staging';
    [...card.querySelectorAll('button')].find(button => button.textContent === 'Connecter').click();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_CONNECT', productId: 'limova_team', environment: 'staging' });
    expect(document.getElementById('teamStopAll').hidden).toBe(true);
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
});
