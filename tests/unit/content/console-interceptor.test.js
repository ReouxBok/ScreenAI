// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('console interceptor — filtered network trace', () => {
  it('records method, generalized path and status without query, headers or body', async () => {
    const originalFetch = vi.fn().mockResolvedValue({ status: 201 });
    window.fetch = originalFetch;
    loadSidebarScript('src/content/console-interceptor.js');

    await window.fetch('/api/contacts/123456?token=NEVER_KEEP', {
      method: 'POST',
      headers: { Authorization: 'Bearer NEVER_KEEP' },
      body: 'private payload'
    });

    expect(window.__limova_network_events).toEqual([
      expect.objectContaining({ method: 'POST', target: '/api/contacts/:id', status: 201 })
    ]);
    const serialized = JSON.stringify(window.__limova_network_events);
    expect(serialized).not.toContain('NEVER_KEEP');
    expect(serialized).not.toContain('private payload');
    expect(serialized).not.toContain('Authorization');
  });

  it('publishes only the allowlisted fields from /users/me', async () => {
    const postMessage = vi.spyOn(window, 'postMessage');
    const payload = {
      data: {
        id: 'limova-user-42',
        firstName: 'Camille',
        lastName: 'Martin',
        locale: 'fr-FR',
        email: 'never-export@example.com',
        accessToken: 'NEVER_EXPORT_TOKEN',
        billing: { card: '4242424242424242' }
      }
    };
    window.__limova_console_intercepted = false;
    window.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      clone: () => ({ json: async () => payload })
    });
    loadSidebarScript('src/content/console-interceptor.js');

    await window.fetch('/users/me');
    await Promise.resolve();
    await Promise.resolve();

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'limova-charly-page',
      type: 'LIMOVA_PROFILE',
      profile: {
        firstName: 'Camille',
        lastName: 'Martin',
        limovaUserId: 'limova-user-42',
        locale: 'fr-FR'
      }
    }), window.location.origin);
    const exported = JSON.stringify(postMessage.mock.calls.at(-1)?.[0]);
    expect(exported).not.toContain('never-export');
    expect(exported).not.toContain('NEVER_EXPORT_TOKEN');
    expect(exported).not.toContain('424242');
  });

  it('keeps useful console errors while redacting credentials and URL queries', () => {
    window.__limova_console_intercepted = false;
    const originalError = console.error;
    console.error = vi.fn();
    loadSidebarScript('src/content/console-interceptor.js');

    console.error('Request failed https://new.limova.ai/api/send?token=SECRET', {
      password: 'NEVER_KEEP',
      email: 'private@example.com'
    });

    const stored = window.__limova_console_logs.at(-1)?.message || '';
    expect(stored).toContain('Request failed https://new.limova.ai/api/send');
    expect(stored).toContain('[email-redacted]');
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toContain('NEVER_KEEP');
    console.error = originalError;
  });
});
