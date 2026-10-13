import { describe, it, expect, vi } from 'vitest';
import { createBrowserBinding } from '../../src/limova/browser-binding.js';

function fixture() {
  let version = 0;
  const scripting = { executeScript: vi.fn(async ({ args }) => {
    const request = args[0];
    return [{ frameId: 0, documentId: 'chrome-document', result: { status: 'completed', observation: 'ok',
      binding: { documentId: 'private-token', origin: 'https://example.com',
        contextVersion: request.nextContextVersion ?? request.contextVersion } } }];
  }) };
  return { scripting, driver: createBrowserBinding({ scripting, allocateVersion: async () => ++version }) };
}

describe('Chrome document binding', () => {
  it('targets the exact Chrome document and retains a separate private token', async () => {
    const { driver, scripting } = fixture();
    const page = await driver.bind(7, 'https://example.com');
    expect(page.documentId).toBe('private-token');
    expect(page.chromeDocumentId).toBe('chrome-document');
    await driver.execute(page, 'read_page', { documentId: 'forged', contextVersion: 90 });
    const call = scripting.executeScript.mock.calls.at(-1)[0];
    expect(call.target).toEqual({ tabId: 7, documentIds: ['chrome-document'] });
    expect(call.args[0].documentId).toBe('private-token');
    expect((await driver.inspect(7)).contextVersion).toBe(2);
  });
  it('rejects a stale action before dispatch', async () => {
    const { driver, scripting } = fixture();
    const page = await driver.bind(7, 'https://example.com');
    await driver.execute(page, 'read_page', {});
    await expect(driver.execute(page, 'click', { elementId: 1 })).rejects.toThrow('page changed');
    expect(scripting.executeScript.mock.calls.filter(([call]) => call.args[0].operation === 'click')).toHaveLength(0);
  });
  it('does not fall back to the current tab document after navigation', async () => {
    const { driver, scripting } = fixture();
    const page = await driver.bind(7, 'https://example.com');
    scripting.executeScript.mockRejectedValueOnce(new Error('No document with id'));
    await expect(driver.execute(page, 'click', {})).rejects.toThrow('No document');
    expect(scripting.executeScript).toHaveBeenCalledTimes(2);
  });
  it('rejects a different document returned by Chrome', async () => {
    const { driver, scripting } = fixture();
    await driver.bind(7, 'https://example.com');
    scripting.executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'different', result: { status: 'completed', binding: {} } }]);
    await expect(driver.inspect(7)).rejects.toThrow('document changed');
  });
  it('forgets closed or revoked tabs', async () => {
    const { driver } = fixture();
    await driver.bind(7, 'https://example.com');
    driver.forget(7);
    await expect(driver.inspect(7)).rejects.toThrow('not bound');
  });
});
