import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRecorder, navigationCause } from '../../../src/team/recorder.js';
import { validateRecording } from '../../../src/team/recording-format.js';

const RECORDING_ID = '6f0a4c1e-6b8e-4d7e-9c55-0d3f2a9b1e11';

function setup({ tabs = { 812: { id: 812, url: 'https://app.example.com/invoices?token=x', title: 'Factures', windowId: 1 } }, connected = true, fetchImpl } = {}) {
  const tabMap = new Map(Object.entries(tabs).map(([id, tab]) => [Number(id), { ...tab }]));
  const pendingFlush = new Map();
  const chromeApi = {
    runtime: { getManifest: () => ({ version: '2.2.63' }) },
    tabs: {
      get: vi.fn(async id => {
        if (!tabMap.has(id)) throw new Error('No tab');
        return { ...tabMap.get(id) };
      }),
      create: vi.fn(async ({ url } = {}) => {
        const tab = { id: 900 + tabMap.size, url: url || 'chrome://newtab/', windowId: 1 };
        tabMap.set(tab.id, tab);
        return { ...tab };
      })
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })) },
    scripting: {
      executeScript: vi.fn(async ({ target, func, args }) => {
        if (func.name === 'stopPageRecorder' || func.name === 'pausePageRecorder') {
          const events = pendingFlush.get(target.tabId) || [];
          pendingFlush.delete(target.tabId);
          return [{ result: { ok: true, events: args[0].flush === false ? [] : events } }];
        }
        return [{ result: { ok: true } }];
      })
    }
  };
  const browser = { joinGroup: vi.fn(async () => {}), setRecordingTitle: vi.fn(async () => {}) };
  const takeOver = vi.fn(() => true);
  const handBack = vi.fn();
  const onRevoked = vi.fn();
  const fetchMock = fetchImpl || vi.fn(async () => ({ status: 201, json: async () => ({ recording_id: RECORDING_ID, procedure_id: 'p1', status: 'compiling', redacted: 0, duplicate: false }) }));
  const recorder = createRecorder({
    chromeApi,
    browserFor: () => browser,
    connectionFor: () => (connected ? { api: 'https://api.staging.team.limova.ai', dashboard: 'https://staging.team.limova.ai', token: 'lmd_abcdefghijklmnopqrstuvwxyz012345' } : null),
    takeOver,
    handBack,
    onRevoked,
    fetchImpl: fetchMock,
    randomId: () => RECORDING_ID,
    locale: () => 'fr-FR'
  });
  const sender = (tabId = 812) => ({ tab: { id: tabId }, frameId: 0, url: tabMap.get(tabId)?.url });
  const event = (body, tabId = 812) => recorder.handlePageMessage({ type: 'TEAM_RECORD_EVENT', recording_id: RECORDING_ID, event: body }, sender(tabId));
  return { recorder, chromeApi, browser, takeOver, handBack, onRevoked, fetchMock, tabMap, pendingFlush, sender, event };
}

const page = { url: 'https://app.example.com/invoices/new?x=1', title: 'Nouvelle facture' };

describe('navigation causes', () => {
  it('maps Chrome transitions to typed, link, redirect, history, reload, script', () => {
    expect(navigationCause('typed')).toBe('typed');
    expect(navigationCause('auto_bookmark')).toBe('typed');
    expect(navigationCause('link', [], true)).toBe('link');
    expect(navigationCause('link', [], false)).toBe('script');
    expect(navigationCause('form_submit', [], true)).toBe('link');
    expect(navigationCause('link', ['server_redirect'], true)).toBe('redirect');
    expect(navigationCause('link', ['forward_back'])).toBe('history');
    expect(navigationCause('reload')).toBe('reload');
    expect(navigationCause('link', ['from_address_bar'])).toBe('typed');
    expect(navigationCause('manual_subframe')).toBe('script');
  });
});

describe('recorder (service worker)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('starts in the current tab: it joins the group, holds the agent, and the page is the first step', async () => {
    const { recorder, browser, takeOver, chromeApi } = setup();
    expect(await recorder.start({ productId: 'limova_team', tabId: 812 })).toEqual({ ok: true, recording_id: RECORDING_ID });
    expect(browser.joinGroup).toHaveBeenCalledWith(812);
    expect(browser.setRecordingTitle).toHaveBeenCalledWith('Limova Team · Limova regarde');
    expect(takeOver).toHaveBeenCalledWith('limova_team');
    expect(chromeApi.scripting.executeScript.mock.calls.map(([call]) => call.func.name)).toEqual(['pageSnapshot', 'startPageRecorder']);
    expect(recorder.summary()).toEqual(expect.objectContaining({ status: 'recording', steps: 1, tabs: 1 }));
    expect(recorder.payload().steps[0]).toEqual({ id: 's1', t: 0, kind: 'navigate', tab: 1, url: 'https://app.example.com/invoices', cause: 'typed' });
  });

  it('starts in a new tab of the group, and refuses blocked sites, a second recording, no connection', async () => {
    const fresh = setup();
    expect((await fresh.recorder.start({ productId: 'limova_team', newTab: true })).ok).toBe(true);
    expect(fresh.chromeApi.tabs.create).toHaveBeenCalled();
    expect(fresh.recorder.summary().steps).toBe(0);
    expect((await fresh.recorder.start({ productId: 'limova_team', newTab: true })).error).toBe('busy');

    const linkedin = setup({ tabs: { 5: { id: 5, url: 'https://www.linkedin.com/feed/' } } });
    expect((await linkedin.recorder.start({ productId: 'limova_team', tabId: 5 })).error).toBe('blocked_site');
    const chromePage = setup({ tabs: { 6: { id: 6, url: 'chrome://settings/' } } });
    expect((await chromePage.recorder.start({ productId: 'limova_team', tabId: 6 })).error).toBe('page_unavailable');
    const offline = setup({ connected: false });
    expect((await offline.recorder.start({ productId: 'limova_team', tabId: 812 })).error).toBe('not_connected');
  });

  it('records navigations with their cause, numbers tabs, never Chrome’s tab ids', async () => {
    const { recorder, event, tabMap } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    event({ seq: 1, kind: 'click', target: { role: 'link', name: 'Nouvelle facture' }, page });
    tabMap.get(812).url = 'https://app.example.com/invoices/new?x';
    recorder.onCommitted({ tabId: 812, frameId: 0, url: 'https://app.example.com/invoices/new?x', transitionType: 'link', transitionQualifiers: [] });
    recorder.onHistoryStateUpdated({ tabId: 812, frameId: 0, url: 'https://app.example.com/invoices/new#y' });
    recorder.onCommitted({ tabId: 812, frameId: 1, url: 'https://ads.example.net/frame', transitionType: 'auto_subframe' });
    recorder.onCommitted({ tabId: 999, frameId: 0, url: 'https://elsewhere.example/', transitionType: 'typed' });
    await vi.advanceTimersByTimeAsync(5000);
    recorder.onCommitted({ tabId: 812, frameId: 0, url: 'https://app.example.com/invoices', transitionType: 'reload' });
    tabMap.set(813, { id: 813, url: 'https://app.example.com/print' });
    recorder.onTabCreated({ id: 813, openerTabId: 812 });
    recorder.onCommitted({ tabId: 813, frameId: 0, url: 'https://app.example.com/print', transitionType: 'link', transitionQualifiers: [] });
    const steps = recorder.payload().steps;
    expect(steps.map(step => [step.kind, step.cause, step.tab])).toEqual([
      ['navigate', 'typed', 1], ['click', undefined, 1], ['navigate', 'link', 1], ['navigate', 'reload', 1], ['navigate', 'script', 2]
    ]);
    // The click's check: where it led.
    expect(steps[1].observed).toEqual(expect.objectContaining({ url_changed: true, url: 'https://app.example.com/invoices/new' }));
    expect(JSON.stringify(steps)).not.toMatch(/812|813/);
  });

  it('only accepts page messages from a recorded tab, for this recording', async () => {
    const { recorder, sender } = setup({ tabs: { 812: { id: 812, url: 'https://a.example/' }, 7: { id: 7, url: 'https://b.example/' } } });
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_PING', recording_id: RECORDING_ID }, sender())).toEqual({ ok: false, recording: false });
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_PING', recording_id: RECORDING_ID }, sender())).toEqual({ ok: true, recording: true, paused: false });
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_EVENT', recording_id: 'other', event: {} }, sender()).recording).toBe(false);
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_EVENT', recording_id: RECORDING_ID, event: {} }, sender(7)).recording).toBe(false);
    // A child frame of the recorded tab counts (TEAM-751), never one on a blocked site.
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_PING', recording_id: RECORDING_ID }, { ...sender(), frameId: 3, url: 'https://js.stripe.com/v3/' }).recording).toBe(true);
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_EVENT', recording_id: RECORDING_ID, event: {} }, { ...sender(), frameId: 3, url: 'https://www.linkedin.com/embed' }).recording).toBe(false);
    expect(recorder.handlePageMessage({ type: 'TEAM_RECORD_EVENT', recording_id: RECORDING_ID, event: {} }, { ...sender(), frameId: 3, url: 'chrome-extension://abc/x.html' }).recording).toBe(false);
  });

  it('redacts fill values on capture and keeps one step per field', async () => {
    const { recorder, event } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    event({ seq: 1, kind: 'fill', target: { role: 'textbox', name: 'Client', label: 'Client' }, value: 'ACME', page });
    event({ seq: 2, kind: 'fill', target: { role: 'textbox', name: 'Client', label: 'Client' }, value: 'ACME SAS', page });
    event({ seq: 3, kind: 'fill', target: { role: 'textbox', name: 'Notes' }, value: '4111 1111 1111 1111', page });
    event({ seq: 4, kind: 'fill', target: { role: 'textbox', name: 'Mot de passe' }, value_withheld: true, secret_kind: 'password', page });
    event({ seq: 5, kind: 'fill', target: { role: 'textbox', name: 'Jeton', hints: { input_name: 'api_key' } }, value: 'sk-proj-abcdefghijklmnop1234', page });
    const fills = recorder.payload().steps.filter(step => step.kind === 'fill');
    expect(fills.map(step => step.value)).toEqual(['ACME SAS', { redacted: 'card' }, { redacted: 'password' }, { redacted: 'secret' }]);
    expect(fills[0]).toEqual(expect.objectContaining({ candidate_parameter: true, parameter_name: 'client' }));
    expect(fills.slice(1).every(step => step.sensitive === true)).toBe(true);
    expect(JSON.stringify(recorder._internal())).not.toMatch(/4111|sk-proj/);
  });

  it('merges what the page saw after an action, and falls back to the tab when the page went away', async () => {
    const { recorder, event, tabMap } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    event({ seq: 1, kind: 'click', target: { role: 'button', name: 'Enregistrer' }, page });
    recorder.handlePageMessage({ type: 'TEAM_RECORD_OBSERVED', recording_id: RECORDING_ID, observed: { seq: 1, dom_changed: true, messages: ['Facture créée, code 482913'], url: page.url, title: 'Facture' } }, { tab: { id: 812 }, frameId: 0 });
    event({ seq: 2, kind: 'click', target: { role: 'link', name: 'Imprimer' }, page });
    tabMap.get(812).url = 'https://app.example.com/print?x';
    tabMap.get(812).title = 'Impression';
    await vi.advanceTimersByTimeAsync(3600);
    const [, saved, printed] = recorder.payload().steps;
    expect(saved.observed).toEqual({ url: 'https://app.example.com/invoices/new', url_changed: false, title: 'Facture', dom_changed: true, messages: ['Facture créée, code [masqué]'] });
    expect(printed.observed).toEqual(expect.objectContaining({ url: 'https://app.example.com/print', url_changed: true, title: 'Impression' }));
  });

  it('adds a wait when the person waited for the page', async () => {
    const { recorder, event } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    event({ seq: 1, kind: 'click', target: { role: 'button', name: 'Exporter' }, page });
    const clickedAt = Date.now();
    vi.advanceTimersByTime(9000);
    event({ seq: 2, kind: 'click', target: { role: 'link', name: 'Télécharger' }, page, last_change_at: clickedAt + 6000 });
    const steps = recorder.payload().steps;
    expect(steps.map(step => step.kind)).toEqual(['navigate', 'click', 'wait', 'click']);
    expect(steps[2].ms).toBe(6000);
    expect(validateRecording(recorder.payload())).toEqual([]);
  });

  it('records nothing while paused, keeps what was typed before the pause', async () => {
    const { recorder, event, pendingFlush } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    pendingFlush.set(812, [{ kind: 'fill', target: { name: 'Client' }, value: 'Avant la pause', page }]);
    await recorder.pause();
    expect(recorder.summary().status).toBe('paused');
    expect(event({ seq: 9, kind: 'click', target: { name: 'Pendant' }, page })).toEqual({ ok: true, recording: true, paused: true });
    recorder.onCommitted({ tabId: 812, frameId: 0, url: 'https://app.example.com/secret-detour', transitionType: 'typed' });
    await recorder.resume();
    event({ seq: 10, kind: 'click', target: { name: 'Après' }, page });
    const labels = recorder.payload().steps.map(step => step.target?.name || step.url);
    expect(labels).toEqual(['https://app.example.com/invoices', 'Client', 'Après']);
  });

  it('stops into a step list the person can edit', async () => {
    const { recorder, event, pendingFlush, handBack, browser } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    event({ seq: 1, kind: 'click', target: { role: 'button', name: 'Oups' }, page });
    event({ seq: 2, kind: 'select', target: { role: 'combobox', name: 'TVA' }, option: '20 %', page });
    pendingFlush.set(812, [{ kind: 'fill', target: { role: 'textbox', name: 'Montant HT', label: 'Montant HT' }, value: '1200', page }]);
    await recorder.stop();
    expect(handBack).toHaveBeenCalledWith('limova_team');
    expect(browser.setRecordingTitle).toHaveBeenLastCalledWith(null);
    const review = recorder.review();
    expect(review.steps.map(step => step.label)).toEqual(['Ouverture de app.example.com/invoices', 'Clic sur « Oups »', 'Choix « 20 % » dans « TVA »', 'Saisie dans « Montant HT »']);
    const [, oops, vat, amount] = review.steps;
    expect(amount).toEqual(expect.objectContaining({ value: '1200', can_parameter: true, candidate_parameter: true, parameter_name: 'montant_ht' }));
    expect(recorder.edit({ key: oops.key, remove: true })).toEqual({ ok: true });
    recorder.edit({ key: vat.key, candidate_parameter: true, parameter_name: 'taux de TVA' });
    recorder.edit({ key: amount.key, candidate_parameter: false });
    recorder.setTitle('  Créer une facture  ');
    const payload = recorder.payload();
    expect(payload.title).toBe('Créer une facture');
    expect(payload.steps.map(step => step.kind)).toEqual(['navigate', 'select', 'fill']);
    expect(payload.steps[1]).toEqual(expect.objectContaining({ candidate_parameter: true, parameter_name: 'taux de TVA' }));
    expect(payload.steps[2].candidate_parameter).toBeUndefined();
    expect(validateRecording(payload)).toEqual([]);
  });

  it('uploads once with the device token, then opens « Former Limova »', async () => {
    const { recorder, event, fetchMock, chromeApi } = setup();
    await recorder.start({ productId: 'limova_team', tabId: 812 });
    event({ seq: 1, kind: 'click', target: { role: 'button', name: 'Nouvelle facture' }, page });
    await recorder.stop();
    const result = await recorder.upload();
    expect(result).toEqual(expect.objectContaining({ ok: true, procedure_id: 'p1', duplicate: false }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.staging.team.limova.ai/api/v1/devices/me/recordings');
    expect(init.headers.Authorization).toBe('Device lmd_abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.parse(init.body).recording_id).toBe(RECORDING_ID);
    expect(chromeApi.tabs.create).toHaveBeenCalledWith({ url: 'https://staging.team.limova.ai/skills?tab=training', active: true });
    expect(recorder.summary()).toEqual(expect.objectContaining({ status: 'idle', last_result: expect.objectContaining({ procedure_id: 'p1' }) }));
    expect(recorder.review()).toBeNull();
  });

  it('handles 200 duplicate, 413, 422, 401, 404 and network errors', async () => {
    async function recorded(fetchImpl) {
      const ctx = setup({ fetchImpl });
      await ctx.recorder.start({ productId: 'limova_team', tabId: 812 });
      ctx.event({ seq: 1, kind: 'click', target: { role: 'button', name: 'OK' }, page });
      await ctx.recorder.stop();
      return ctx;
    }
    const duplicate = await recorded(vi.fn(async () => ({ status: 200, json: async () => ({ recording_id: RECORDING_ID, procedure_id: 'p1', duplicate: true }) })));
    expect((await duplicate.recorder.upload()).duplicate).toBe(true);

    let calls = 0;
    const tooLarge = await recorded(vi.fn(async () => (calls++ === 0 ? { status: 413, json: async () => ({}) } : { status: 201, json: async () => ({ procedure_id: 'p2' }) })));
    expect((await tooLarge.recorder.upload()).ok).toBe(true);
    expect(tooLarge.fetchMock).toHaveBeenCalledTimes(2);

    const invalid = await recorded(vi.fn(async () => ({ status: 422, json: async () => ({ detail: 'Enregistrement invalide (steps.1.target): …' }) })));
    expect(await invalid.recorder.upload()).toEqual(expect.objectContaining({ ok: false, error: 'invalid', message: 'Enregistrement invalide (steps.1.target): …' }));
    expect(invalid.recorder.review().error.code).toBe('invalid');

    const revoked = await recorded(vi.fn(async () => ({ status: 401, json: async () => ({}) })));
    expect((await revoked.recorder.upload()).error).toBe('revoked');
    expect(revoked.onRevoked).toHaveBeenCalledWith('limova_team');
    expect(revoked.recorder.review()).not.toBeNull();

    const disabled = await recorded(vi.fn(async () => ({ status: 404, json: async () => ({}) })));
    expect((await disabled.recorder.upload()).error).toBe('disabled');
    expect(disabled.recorder.summary().procedures.limova_team).toBe('off');

    let online = false;
    const flaky = await recorded(vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return { status: 201, json: async () => ({ procedure_id: 'p3' }) };
    }));
    expect((await flaky.recorder.upload()).error).toBe('network');
    online = true;
    expect((await flaky.recorder.upload()).ok).toBe(true);
    // A retry sends the same recording_id: the server answers it once.
    const bodies = flaky.fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).recording_id);
    expect(new Set(bodies)).toEqual(new Set([RECORDING_ID]));
  });

  it('knows when « Former Limova » is off (404) and hides the start', async () => {
    const off = setup({ fetchImpl: vi.fn(async () => ({ status: 404, json: async () => ({}) })) });
    expect(await off.recorder.probe('limova_team')).toBe('off');
    expect((await off.recorder.start({ productId: 'limova_team', tabId: 812 })).error).toBe('disabled');
    const on = setup({ fetchImpl: vi.fn(async () => ({ status: 422, json: async () => ({ detail: 'x' }) })) });
    expect(await on.recorder.probe('limova_team')).toBe('on');
    expect(JSON.parse(on.fetchMock.mock.calls[0][1].body)).toEqual({});
  });

  it('stops by itself at 300 steps and at 2 hours', async () => {
    const many = setup();
    await many.recorder.start({ productId: 'limova_team', tabId: 812 });
    for (let index = 0; index < 305; index += 1) many.event({ seq: index + 1, kind: 'key', key: 'Escape', page });
    await vi.advanceTimersByTimeAsync(0);
    expect(many.recorder.summary()).toEqual(expect.objectContaining({ status: 'review', steps: 300, limit: 'steps' }));

    const long = setup();
    await long.recorder.start({ productId: 'limova_team', tabId: 812 });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(long.recorder.summary()).toEqual(expect.objectContaining({ status: 'review', limit: 'duration' }));
    expect(validateRecording(long.recorder.payload())).toEqual([]);
  });

  it('reads ready.features instead of probing, and re-reads them on every ready (TEAM-731)', async () => {
    const ctx = setup();
    ctx.recorder.setFeatures('limova_team', { procedures: false, login_vault: false });
    expect(ctx.recorder.summary().procedures.limova_team).toBe('off');
    expect((await ctx.recorder.start({ productId: 'limova_team', tabId: 812 })).error).toBe('disabled');
    // The probe answers from what the server said, without a request.
    expect(await ctx.recorder.probe('limova_team')).toBe('off');
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    ctx.recorder.setFeatures('limova_team', { procedures: true, login_vault: false });
    expect((await ctx.recorder.start({ productId: 'limova_team', tabId: 812 })).ok).toBe(true);
  });

  it('records child-frame steps with the tab\'s page and the frame in the target (TEAM-751)', async () => {
    const ctx = setup();
    await ctx.recorder.start({ productId: 'limova_team', tabId: 812 });
    const frameSender = { ...ctx.sender(), frameId: 4, url: 'https://js.stripe.com/v3/elements' };
    const frame = { origin: 'https://js.stripe.com', name: 'Carte', path: [0] };
    ctx.recorder.handlePageMessage({ type: 'TEAM_RECORD_EVENT', recording_id: RECORDING_ID, event: {
      seq: 1, kind: 'click', target: { role: 'button', name: 'Payer', frame }, page: { url: 'https://js.stripe.com/v3/elements', title: 'Stripe' }
    } }, frameSender);
    // The frame's own address is no outcome of the click.
    ctx.recorder.handlePageMessage({ type: 'TEAM_RECORD_OBSERVED', recording_id: RECORDING_ID, observed: {
      seq: 1, url: 'https://js.stripe.com/v3/other', title: 'Stripe', dom_changed: true, messages: ['Paiement accepté']
    } }, frameSender);
    ctx.event({ seq: 1, kind: 'key', key: 'ArrowDown', target: { role: 'combobox', name: 'Ville' }, page });
    ctx.event({ seq: 2, kind: 'key', key: 'F5', page });
    const steps = ctx.recorder.payload().steps;
    expect(steps.map(step => step.key || step.kind)).toEqual(['navigate', 'click', 'ArrowDown']);
    expect(steps[1].page).toEqual({ url: 'https://app.example.com/invoices' });
    expect(steps[1].target.frame).toEqual(frame);
    expect(steps[1].observed).toEqual(expect.objectContaining({ dom_changed: true, messages: ['Paiement accepté'], url_changed: false }));
    expect(JSON.stringify(steps)).not.toContain('js.stripe.com/v3');
  });

  it('sends again without the new keys to a server that only takes Enter, Escape and Tab', async () => {
    const bodies = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.steps.some(step => step.kind === 'key' && step.key === 'ArrowDown')
        ? { status: 422, json: async () => ({ error: { class: 'validation', message: 'Enregistrement invalide : steps.2.key' } }) }
        : { status: 201, json: async () => ({ recording_id: RECORDING_ID, procedure_id: 'p9' }) };
    });
    const ctx = setup({ fetchImpl });
    await ctx.recorder.start({ productId: 'limova_team', tabId: 812 });
    ctx.event({ seq: 1, kind: 'key', key: 'ArrowDown', target: { role: 'combobox', name: 'Ville' }, page });
    ctx.event({ seq: 2, kind: 'key', key: 'Enter', target: { role: 'combobox', name: 'Ville' }, page });
    await ctx.recorder.stop();
    expect((await ctx.recorder.upload()).ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].steps.map(step => step.key || step.kind)).toEqual(['navigate', 'Enter']);
  });

  it('shows the server\'s error message of a 422', async () => {
    const ctx = setup({ fetchImpl: vi.fn(async () => ({ status: 422, json: async () => ({ error: { class: 'validation', message: 'Enregistrement invalide : steps.1.click' } }) })) });
    await ctx.recorder.start({ productId: 'limova_team', tabId: 812 });
    ctx.event({ seq: 1, kind: 'click', target: { role: 'button', name: 'OK' }, page });
    await ctx.recorder.stop();
    expect((await ctx.recorder.upload()).message).toBe('Enregistrement invalide : steps.1.click');
  });
});
