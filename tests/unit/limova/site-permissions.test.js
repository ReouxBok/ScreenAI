// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { bindSitePermissions } from '../../../src/limova/site-permissions.js';

beforeEach(() => {
  document.body.innerHTML = '<input id="limovaSiteOrigin"><button id="limovaSiteAllow"></button><button id="limovaSiteDetect"></button><p id="limovaSiteStatus"></p>';
});
const el = id => document.getElementById(id);
function setup(granted = true) {
  const permissions = { request: vi.fn().mockResolvedValue(granted) };
  const tabs = { query: vi.fn().mockResolvedValue([{ url: 'https://example.com/private?secret=value' }]) };
  bindSitePermissions({ document, permissions, tabs });
  return { permissions, tabs };
}
it('requests only the chosen HTTPS origin synchronously from the click', async () => {
  const { permissions } = setup();
  el('limovaSiteOrigin').value = 'https://example.com/page?q=secret';
  el('limovaSiteAllow').click();
  expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
  await vi.waitFor(() => expect(el('limovaSiteStatus').textContent).toContain('Accès autorisé'));
});
it('rejects broad host patterns, credentials and non-HTTPS addresses', () => {
  const { permissions } = setup();
  for (const value of ['https://*.example.com', 'https://user:pass@example.com', 'http://example.com', 'javascript:alert(1)']) {
    el('limovaSiteOrigin').value = value;
    el('limovaSiteAllow').click();
  }
  expect(permissions.request).not.toHaveBeenCalled();
});
it('reports denial without claiming access', async () => {
  setup(false);
  el('limovaSiteOrigin').value = 'https://example.com';
  el('limovaSiteAllow').click();
  await vi.waitFor(() => expect(el('limovaSiteStatus').textContent).toContain('Accès refusé'));
});
it('suggests only the origin without page path or query', async () => {
  setup();
  el('limovaSiteDetect').click();
  await vi.waitFor(() => expect(el('limovaSiteOrigin').value).toBe('https://example.com'));
});


it('relocalizes the existing permission result without requesting access again', async () => {
  let language = 'en';
  const permissions = { request: vi.fn().mockResolvedValue(true) };
  const ui = bindSitePermissions({ document, permissions, tabs: {}, translate: () => `${language}: {origin}` });
  el('limovaSiteOrigin').value = 'https://example.com/private?secret=hidden';
  el('limovaSiteAllow').click();
  await vi.waitFor(() => expect(el('limovaSiteStatus').textContent).toBe('en: https://example.com'));
  language = 'es'; ui.relocalize();
  expect(el('limovaSiteStatus').textContent).toBe('es: https://example.com');
  expect(permissions.request).toHaveBeenCalledTimes(1);
});
