import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

// Features reach staging.new.limova.ai before production. Trainings and tests
// recorded there must start like on new.limova.ai and reach Studio with
// production URLs, so the tutorial works as soon as it is validated.
const trainingToken = 'staging-training-token-long-enough';
const evaluationToken = 'staging-evaluation-token-long-enough';
const session = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Nouvelle fonctionnalité', goal: 'Tester', agentKey: 'charly', startPath: '/' };
const stagingUrl = 'https://staging.new.limova.ai/agents/nouveau';
let chromeMock, background;

const sender = () => ({ id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('src/sidebar/sidebar.html') });
const message = request => background.handleMessage(request, sender());
const posted = path => fetch.mock.calls
  .filter(([url]) => String(url).endsWith(path))
  .map(([, options]) => JSON.parse(options.body));

async function setup() {
  chromeMock = installFullChromeMock();
  await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
  globalThis.fetch = vi.fn(async url => {
    const path = String(url);
    if (path.endsWith('/training/sessions/connect')) return { ok: true, status: 200, json: async () => session };
    if (path.endsWith('/evaluations/runs/connect')) return { ok: true, status: 200, json: async () => ({ run: { id: 'run-1' }, case: { kind: 'live_action' }, content: { id: 'item-1', title: 'Tuto', versionId: 'v1' } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  vi.resetModules();
  background = await import('../../../src/background.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  chromeMock.tabs.query.mockResolvedValue([{ id: 21, url: stagingUrl, active: true }]);
  chromeMock.tabs.get.mockResolvedValue({ id: 21, windowId: 1, url: stagingUrl, active: true });
  chromeMock.scripting.executeScript.mockResolvedValue([{ result: { title: 'Agents', url: stagingUrl, elements: [] } }]);
}

afterEach(() => {
  uninstallFullChromeMock();
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

describe('Limova staging', () => {
  it('recognises staging as Limova but not look-alike hosts', async () => {
    await setup();
    expect(background.isLimovaUrl(stagingUrl)).toBe(true);
    expect(background.isLimovaUrl('https://new.limova.ai/home')).toBe(true);
    expect(background.isLimovaUrl('https://staging.new.limova.ai.example.com/')).toBe(false);
    expect(background.isLimovaUrl('http://staging.new.limova.ai/')).toBe(false);
    expect(background.isLimovaUrl('https://preview.limova.ai/')).toBe(false);
  });

  it('rewrites staging URLs to production, including inside page context', async () => {
    await setup();
    expect(background.productionLimovaPayload({
      path: 'https://staging.new.limova.ai/agents/:id',
      payload: { context: 'Page: Agents\nURL: https://staging.new.limova.ai/agents/:id', other: 'https://example.com/' }
    })).toEqual({
      path: 'https://new.limova.ai/agents/:id',
      payload: { context: 'Page: Agents\nURL: https://new.limova.ai/agents/:id', other: 'https://example.com/' }
    });
  });

  it('starts a training on staging and records production URLs', async () => {
    await setup();
    const result = await message({ type: 'START_TRAINING', token: trainingToken });
    expect(result).toMatchObject({ ok: true });

    await message({ type: 'TRAINING_EVENT', event: { kind: 'click', path: stagingUrl, label: 'Créer un agent' } });
    const events = posted('/training/sessions/events');
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('staging.new.limova.ai');
    expect(events.map(event => event.path)).toContain('https://new.limova.ai/agents/nouveau');
  });

  it('starts a real test on staging', async () => {
    await setup();
    const result = await message({ type: 'START_EVALUATION', token: evaluationToken });
    expect(result).toMatchObject({ ok: true });
  });

  it('still refuses to start a training on a non-Limova site', async () => {
    await setup();
    chromeMock.tabs.query.mockResolvedValue([{ id: 22, url: 'https://mail.google.com/mail/u/0/', active: true }]);
    const result = await message({ type: 'START_TRAINING', token: trainingToken });
    expect(result.ok).toBe(false);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/training/sessions/connect'))).toBe(false);
  });
});
