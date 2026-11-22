// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

const CONNECTION = { environment: 'production', environment_label: 'Production', status: 'online', autonomy: 'full_access', paused: false, control: 'agent', running: 0, held: 0 };

function stateWith(recorder) {
  return {
    products: [{ id: 'limova_team', label: 'Limova Team', color: '#7C3AED', defaultEnvironment: 'production', environments: [{ id: 'production', label: 'Production' }], connection: CONNECTION }],
    activity: [],
    vault: {},
    recorder: { status: 'idle', procedures: {}, steps: 0, ...recorder }
  };
}

const REVIEW = {
  status: 'review',
  title: '',
  error: null,
  steps: [
    { key: 'k1', kind: 'navigate', label: 'Ouverture de app.example.com/invoices', value: null, redacted: null, can_parameter: false, candidate_parameter: false, parameter_name: '' },
    { key: 'k2', kind: 'fill', label: 'Saisie dans « Client »', value: 'ACME SAS', redacted: null, can_parameter: true, candidate_parameter: true, parameter_name: 'client' },
    { key: 'k3', kind: 'fill', label: 'Saisie dans « Mot de passe »', value: null, redacted: 'password', can_parameter: false, candidate_parameter: false, parameter_name: '' }
  ]
};

describe('side panel « Montrer à Limova » (TEAM-731)', () => {
  let chromeMock;
  let state;
  let review;
  beforeEach(() => {
    chromeMock = installChromeMock({ lang: 'fr-FR' });
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
    chromeMock.tabs = { query: vi.fn(async () => [{ id: 812 }]) };
    review = null;
    chromeMock.runtime.sendMessage = vi.fn(async message => {
      if (message.type === 'TEAM_GET_STATE') return { ok: true, state };
      if (message.type === 'TEAM_RECORD_GET') return { ok: true, summary: state.recorder, review };
      return { ok: true };
    });
    document.body.innerHTML = `
      <div id="headerMenu"></div>
      <div id="teamBanner" hidden><span id="teamBannerText"></span><button id="teamBannerControl"></button><button id="teamBannerStop"></button></div>
      <section id="teamPanel"><div id="teamRecordBar" hidden></div><div id="teamProducts"></div>
        <section id="teamRecordReview" hidden></section><button id="teamStopAll" hidden></button><ul id="teamActivity"></ul></section>`;
    loadSidebarScript('src/sidebar/i18n.js');
  });
  afterEach(() => uninstallChromeMock());

  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  async function load() {
    loadSidebarScript('src/team/team-panel.js');
    await flush();
    await flush();
  }
  const buttons = root => [...root.querySelectorAll('button')];

  it('offers « Montrer à Limova » in the connected card, in this tab or a new one', async () => {
    state = stateWith({});
    await load();
    const box = document.querySelector('[data-recorder="limova_team"]');
    buttons(box).find(button => button.textContent === 'Montrer à Limova').click();
    await flush();
    const here = buttons(document.querySelector('[data-recorder="limova_team"]')).find(button => button.textContent === 'Dans cet onglet');
    here.click();
    await flush();
    await flush();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEAM_RECORD_START', productId: 'limova_team', tabId: 812 });
  });

  it('hides it when « Former Limova » is off for this space', async () => {
    state = stateWith({ procedures: { limova_team: 'off' } });
    await load();
    expect(document.querySelector('[data-recorder]')).toBeNull();
  });

  it('shows « Limova regarde · Pause · Arrêter » while recording, in the panel and the banner', async () => {
    state = stateWith({ status: 'recording', product: 'limova_team', steps: 4 });
    await load();
    const bar = document.getElementById('teamRecordBar');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Limova regarde · 4 étape(s)');
    expect(document.getElementById('teamBanner').hidden).toBe(false);
    buttons(bar).find(button => button.textContent === 'Pause').click();
    buttons(bar).find(button => button.textContent === 'Arrêter').click();
    document.getElementById('teamBannerStop').click();
    const types = chromeMock.runtime.sendMessage.mock.calls.map(([message]) => message.type);
    expect(types).toEqual(expect.arrayContaining(['TEAM_RECORD_PAUSE', 'TEAM_RECORD_STOP']));
    // The banner's stop stops the recording, not every agent call.
    expect(types).not.toContain('TEAM_STOP_ALL');
  });

  it('lets the person delete steps, mark changing values, name the task and send', async () => {
    state = stateWith({ status: 'review', product: 'limova_team', steps: 3 });
    review = REVIEW;
    await load();
    await flush();
    const holder = document.getElementById('teamRecordReview');
    expect(holder.hidden).toBe(false);
    const rows = [...holder.querySelectorAll('.team-record-step')];
    expect(rows.map(row => row.querySelector('.team-record-step-label').textContent)).toEqual(REVIEW.steps.map(step => step.label));
    expect(rows[2].textContent).toContain('Valeur masquée');
    expect(rows[2].querySelector('input[type="checkbox"]')).toBeNull();
    expect(rows[1].querySelector('.team-record-param').value).toBe('client');
    rows[0].querySelector('.team-record-delete').click();
    const box = rows[1].querySelector('input[type="checkbox"]');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    const title = holder.querySelector('#teamRecordTitle');
    title.value = 'Créer une facture';
    title.dispatchEvent(new Event('input'));
    buttons(holder).find(button => button.textContent === 'Envoyer à Limova').click();
    await flush();
    const sentMessages = chromeMock.runtime.sendMessage.mock.calls.map(([message]) => message);
    expect(sentMessages).toEqual(expect.arrayContaining([
      { type: 'TEAM_RECORD_EDIT', key: 'k1', remove: true },
      { type: 'TEAM_RECORD_EDIT', key: 'k2', candidate_parameter: false },
      { type: 'TEAM_RECORD_TITLE', title: 'Créer une facture' },
      { type: 'TEAM_RECORD_UPLOAD' }
    ]));
  });
});
