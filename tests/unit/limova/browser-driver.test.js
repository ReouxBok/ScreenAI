import { describe, it, expect, vi } from 'vitest';
import { createBrowserDriver } from '../../../src/limova/browser-driver.js';

function harness() {
  let version;
  let sequence = 0;
  const tab = { id: 1, active: true, url: 'https://example.com/page' };
  const chrome = {
    tabs: { query: vi.fn(async () => [tab]), get: vi.fn(async () => tab) },
    permissions: { contains: vi.fn(async () => true) },
    scripting: { executeScript: vi.fn(async ({ args }) => {
      const input = args[0];
      version ??= input.contextVersion;
      if (input.nextContextVersion) version = input.nextContextVersion;
      return [{ frameId: 0, documentId: 'chrome-id', result: { status: 'completed', observation: 'ok',
        binding: { origin: 'https://example.com', documentId: 'private-id', contextVersion: version } } }];
    }) },
  };
  const journal = { allocateVersion: vi.fn(async () => ++sequence) };
  const hasConsent = vi.fn(async () => true);
  const scope = { userId: 'user', workspaceId: 'workspace', sessionId: 'session' };
  const driver = createBrowserDriver({ chrome, journal, scope, hasConsent });
  return { chrome, journal, hasConsent, scope, driver };
}

describe('browser driver assembly', () => {
  it('keeps private document and session identifiers out of the page context', async () => {
    const h = harness();
    const page = await h.driver.readPage();
    expect(page).toEqual({ tabId: 1, origin: 'https://example.com', contextVersion: 1 });
    await h.driver.execute({ target: page, input: { operation: 'read_page' } });
    expect((await h.driver.readPage()).contextVersion).toBe(2);
  });
  it('refuses a new active tab instead of silently retargeting the turn', async () => {
    const h = harness();
    await h.driver.readPage();
    h.chrome.tabs.query.mockResolvedValue([{ id: 2, active: true, url: 'https://example.com/other' }]);
    await expect(h.driver.readPage()).rejects.toThrow('target changed');
  });
  it('checks permissions again after the asynchronous version allocation', async () => {
    const h = harness();
    const target = await h.driver.readPage();
    h.journal.allocateVersion.mockImplementation(async () => {
      h.chrome.permissions.contains.mockResolvedValue(false);
      return 2;
    });
    await expect(h.driver.execute({ target, input: { operation: 'click', elementId: 1 } })).rejects.toThrow('site access');
    expect(h.chrome.scripting.executeScript.mock.calls.some(([call]) => call.args[0].operation === 'click')).toBe(false);
  });
  it('requires consent before reading the page or injecting a binding', async () => {
    const h = harness();
    h.hasConsent.mockResolvedValue(false);
    await expect(h.driver.readPage()).rejects.toThrow('consent');
    expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('rejects another account at the authorization boundary', async () => {
    const h = harness();
    const target = await h.driver.readPage();
    await expect(h.driver.authorize({ ...h.scope, userId: 'other' }, { target })).rejects.toThrow('context changed');
  });
});

it('refuses navigation to an origin without Chrome permission', async () => {
  const h = harness();
  const target = await h.driver.readPage();
  h.chrome.permissions.contains.mockImplementation(async ({ origins }) => origins[0] === 'https://example.com/*');
  const result = await h.driver.execute({ target, input: { operation: 'navigate', url: 'https://other.example/page' } });
  expect(result.status).toBe('rejected');
  expect(h.chrome.scripting.executeScript.mock.calls.some(([call]) => call.args[0].operation === 'navigate')).toBe(false);
});

it('rejects executable URLs and credential-bearing navigation', async () => {
  const h = harness();
  const target = await h.driver.readPage();
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) {
    expect((await h.driver.execute({ target, input: { operation: 'navigate', url } })).status).toBe('rejected');
  }
});
