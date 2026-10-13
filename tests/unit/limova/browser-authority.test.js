import { describe, expect, it, vi } from 'vitest';
import { createBrowserAuthority } from '../../../src/limova/browser-authority.js';
const target = { tabId: 7, origin: 'https://example.com', contextVersion: 3 };
function harness() {
  const tabs = { get: vi.fn().mockResolvedValue({ id: 7, active: true, url: 'https://example.com/page' }), query: vi.fn().mockResolvedValue([{ id: 7 }]) };
  const hasConsent = vi.fn().mockResolvedValue(true), hasSiteAccess = vi.fn().mockResolvedValue(true), readBinding = vi.fn().mockResolvedValue(target);
  return { tabs, hasConsent, hasSiteAccess, readBinding, authorize: createBrowserAuthority({ tabs, hasConsent, hasSiteAccess, readBinding }) };
}
describe('browser action authority', () => {
  it('checks consent, host access, active tab and current document binding', async () => {
    const h = harness();
    expect(await h.authorize({ userId: 'user' }, { target })).toEqual(target);
    expect(h.hasSiteAccess).toHaveBeenCalledWith(target.origin, target.tabId, undefined);
  });
  it('stops before observing a tab when consent was revoked', async () => {
    const h = harness(); h.hasConsent.mockResolvedValue(false);
    await expect(h.authorize({}, { target })).rejects.toThrow('consent');
    expect(h.tabs.get).not.toHaveBeenCalled();
  });
  it('stops when permission for this site is absent', async () => {
    const h = harness(); h.hasSiteAccess.mockResolvedValue(false);
    await expect(h.authorize({}, { target })).rejects.toThrow('site access');
    expect(h.readBinding).not.toHaveBeenCalled();
  });
  it.each([
    { active: false, url: 'https://example.com' },
    { active: true, url: 'https://foreign.example' },
    { active: true, url: 'https://example.com', pendingUrl: 'https://example.com/next' },
    { active: true, url: 'https://example.com', discarded: true },
  ])('rejects a tab that changed or is unavailable %#', async tab => {
    const h = harness(); h.tabs.get.mockResolvedValue(tab);
    await expect(h.authorize({}, { target })).rejects.toThrow('target changed');
  });
  it('rejects a different focused window or tab', async () => {
    const h = harness(); h.tabs.query.mockResolvedValue([{ id: 8 }]);
    await expect(h.authorize({}, { target })).rejects.toThrow('target changed');
  });
  it('rejects a stale document even on the same origin', async () => {
    const h = harness(); h.readBinding.mockResolvedValue({ ...target, contextVersion: 4 });
    await expect(h.authorize({}, { target })).rejects.toThrow('page changed');
  });
  it('observes cancellation after asynchronous permission checks', async () => {
    const h = harness(), controller = new AbortController();
    h.hasSiteAccess.mockImplementation(async () => { controller.abort(); return true; });
    await expect(h.authorize({}, { target }, controller.signal)).rejects.toThrow();
    expect(h.tabs.get).not.toHaveBeenCalled();
  });
});
