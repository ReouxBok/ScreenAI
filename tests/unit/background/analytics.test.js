import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

const sidebarSender = chrome => ({ id: chrome.runtime.id, url: chrome.runtime.getURL('src/sidebar/sidebar.html') });

describe('background usage analytics', () => {
  let chromeMock;
  let background;
  let track;

  beforeAll(async () => {
    chromeMock = installFullChromeMock({ version: '2.2.53' });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.resetModules();
    background = await import('../../../src/background.js');
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  beforeEach(async () => {
    track?.mockRestore();
    track = vi.spyOn(background.analytics, 'track');
    if (!background.analytics.isEnabled()) await background.analytics.setEnabled(true);
    track.mockClear();
  });

  const send = request => background.handleMessage(request, sidebarSender(chromeMock));
  const tracked = name => track.mock.calls.filter(([event]) => event === name).map(([, properties]) => properties);

  it('registers an uninstall URL carrying the install id', () => {
    const url = chromeMock.runtime.setUninstallURL.mock.calls.at(-1)?.[0];
    expect(url).toContain('/api/uninstalled?iid=');
    expect(url).toContain(background.analytics.installId);
  });

  it('classifies webinar, Academy, Limova and external links by host only', () => {
    expect(background.classifyLink('https://bienvenue.limova.ai/?utm_source=charly')).toEqual({ link_id: 'webinar', domain: 'bienvenue.limova.ai' });
    expect(background.classifyLink('https://academy.limova.ai/cours/42')).toEqual({ link_id: 'academy', domain: 'academy.limova.ai' });
    expect(background.classifyLink('https://new.limova.ai/home')).toEqual({ link_id: 'limova_app', domain: 'new.limova.ai' });
    expect(background.classifyLink('https://www.limova.ai/pricing')).toEqual({ link_id: 'limova_other', domain: 'www.limova.ai' });
    expect(background.classifyLink('https://example.com/a?b=c')).toEqual({ link_id: 'external', domain: 'example.com' });
    expect(background.classifyLink('javascript:alert(1)')).toBeNull();
  });

  it('records link clicks from the sidebar without the full URL', async () => {
    await send({ type: 'TRACK_EVENT', event: 'link_clicked', properties: { url: 'https://bienvenue.limova.ai/?utm_content=welcome', placement: 'welcome' } });
    expect(tracked('link_clicked')).toEqual([{ link_id: 'webinar', domain: 'bienvenue.limova.ai', placement: 'welcome' }]);
  });

  it('ignores events the sidebar is not allowed to emit', async () => {
    const result = await send({ type: 'TRACK_EVENT', event: 'signed_in', properties: {} });
    expect(result).toEqual({ ok: false });
    expect(track).not.toHaveBeenCalled();
  });

  it('measures a voice session with its turns and end reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-23T10:00:00Z'));
    await send({ type: 'VOICE_SESSION_STATE', active: true });
    await send({ type: 'VOICE_TRANSCRIPT', role: 'user', text: 'texte privé' });
    await send({ type: 'VOICE_TRANSCRIPT', role: 'assistant', text: 'réponse privée' });
    await send({ type: 'VOICE_TRANSCRIPT', role: 'user', text: 'encore' });
    vi.setSystemTime(Date.parse('2026-10-23T10:02:00Z'));
    await send({ type: 'VOICE_SESSION_STATE', active: false, reason: 'user_stop' });
    await new Promise(resolve => setImmediate(resolve));
    vi.useRealTimers();

    expect(tracked('voice_session_started')).toHaveLength(1);
    expect(tracked('voice_session_ended')).toEqual([expect.objectContaining({
      duration_ms: 120_000,
      end_reason: 'user_stop',
      user_turns: 2,
      assistant_turns: 1
    })]);
    expect(JSON.stringify(track.mock.calls)).not.toContain('privé');
  });

  it('tracks a sent message without its text and with a generalized path', async () => {
    await chromeMock.storage.local.set({ limova_ai_processing_consent_v1: true });
    chromeMock.tabs.query.mockResolvedValue([{
      id: 7, windowId: 1, active: true,
      url: 'https://new.limova.ai/workspaces/550e8400-e29b-41d4-a716-446655440000/settings?token=secret'
    }]);
    await send({ type: 'USER_MESSAGE', text: 'mon mot de passe est hunter2' }).catch(() => {});
    chromeMock.tabs.query.mockResolvedValue([]);

    expect(tracked('message_sent')).toEqual([{
      channel: 'text',
      history_length: 0,
      page_path: '/workspaces/:id/settings',
      is_limova_page: true
    }]);
    expect(JSON.stringify(track.mock.calls)).not.toContain('hunter2');
  });

  it('stops sending and flags proxy requests once the user opts out', async () => {
    const result = await send({ type: 'SET_USAGE_ANALYTICS', enabled: false });
    expect(result).toEqual({ ok: true, enabled: false });
    expect(chromeMock.runtime.setUninstallURL).toHaveBeenLastCalledWith('');
    expect((await send({ type: 'GET_PRIVACY_STATE' })).usageAnalytics).toBe(false);

    await chromeMock.storage.local.set({
      charly_auth_session_v1: { token: 'test-charly-session-token-value', expiresAt: Date.now() + 60_000 }
    });
    globalThis.fetch.mockClear();
    await send({ type: 'SET_MEMORY_PREFERENCE', enabled: true }).catch(() => {});
    const proxyCall = globalThis.fetch.mock.calls.find(([url]) => String(url).includes('/api/copilot/preferences/memory'));
    expect(proxyCall?.[1].headers['X-Charly-Analytics']).toBe('off');
  });
});
