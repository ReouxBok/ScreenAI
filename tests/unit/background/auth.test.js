import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFullChromeMock, uninstallFullChromeMock } from '../../helpers/chrome-mock-full.js';

describe('background Charly OTP authentication', () => {
  let background;
  let chromeMock;

  beforeAll(async () => {
    chromeMock = installFullChromeMock();
    globalThis.fetch = vi.fn();
    vi.resetModules();
    background = await import('../../../src/background.js');
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  afterAll(() => {
    uninstallFullChromeMock();
    delete globalThis.fetch;
  });

  beforeEach(async () => {
    globalThis.fetch.mockReset();
    await background.clearCharlyAuthSession(false);
  });

  it('restores a persistent Charly session without requiring a Limova tab', async () => {
    await chromeMock.storage.local.set({
      charly_auth_session_v1: {
        token: 'signed-charly-session-token-value',
        expiresAt: Date.now() + 24 * 60 * 60_000
      }
    });

    await expect(background.getProxyAccessToken(true)).resolves.toBe('signed-charly-session-token-value');
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('requests an OTP from the Charly proxy', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, challenge: 'signed-otp-challenge', expiresIn: 600 })
    });

    await expect(background.requestCharlyOtp('member@example.com')).resolves.toMatchObject({
      challenge: 'signed-otp-challenge'
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/request-otp$/),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'member@example.com' }) })
    );
  });

  it('persists a verified session for future browser restarts', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'verified-charly-session-token', expiresIn: 2_592_000 })
    });

    await expect(background.verifyCharlyOtp('challenge', '123456')).resolves.toEqual({
      ok: true,
      authenticated: true
    });
    const stored = await chromeMock.storage.local.get('charly_auth_session_v1');
    expect(stored.charly_auth_session_v1.token).toBe('verified-charly-session-token');
    expect(stored.charly_auth_session_v1.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses access when no persistent Charly session exists', async () => {
    await expect(background.getProxyAccessToken(true)).rejects.toThrow('Connecte-toi à Charly');
  });

  it('keeps authentication indeterminate during a transient Chrome storage failure', async () => {
    chromeMock.storage.local.remove.mockClear();
    chromeMock.storage.local.get.mockRejectedValueOnce(new Error('Extension storage is restarting'));

    await expect(background.getCharlyAuthState(false)).resolves.toEqual({
      authenticated: null,
      pending: true
    });
    expect(chromeMock.storage.local.remove).not.toHaveBeenCalledWith('charly_auth_session_v1');
  });
});
