import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  approvalDecision, approvalTitle, classifyAction, reasonFromName, riskHint, stricterRisk, targetMatches, toolKind
} from '../../../src/team/risk.js';
import { createApprovalManager } from '../../../src/team/approvals.js';

describe('risk classification', () => {
  it('reads risky words in French, English and Spanish', () => {
    expect(reasonFromName('Envoyer le message')).toBe('send');
    expect(reasonFromName('Payer 49 €')).toBe('pay');
    expect(reasonFromName('Passer la commande')).toBe('pay');
    expect(reasonFromName('Publier')).toBe('publish');
    expect(reasonFromName('Supprimer')).toBe('delete');
    expect(reasonFromName('Changer le mot de passe')).toBe('account');
    expect(reasonFromName('Supprimer mon compte')).toBe('account');
    expect(reasonFromName('Eliminar')).toBe('delete');
    expect(reasonFromName('Tarifs')).toBeNull();
    expect(reasonFromName('Comment ça marche ?')).toBeNull();
    expect(reasonFromName('Pays')).toBeNull();
  });

  it('gives read_page risk hints only for controls', () => {
    expect(riskHint({ role: 'button', name: 'Envoyer' })).toBe('send');
    expect(riskHint({ role: 'textbox', name: 'Envoyer' })).toBeNull();
    expect(riskHint({ role: 'button', name: 'OK', submits: true, form: { has_card: true } })).toBe('pay');
    // external_form is a risk_reason, never a risk_hint.
    expect(riskHint({ role: 'button', name: 'OK', submits: true, form: { external: true } })).toBeNull();
  });

  it('classifies actions from the live element', () => {
    expect(classifyAction('browser.click', { role: 'button', name: 'Envoyer' })).toEqual({ risk: 'risky', reason: 'send' });
    expect(classifyAction('browser.click', { role: 'link', name: 'Tarifs' })).toEqual({ risk: 'write', reason: null });
    expect(classifyAction('browser.click', { role: 'button', name: 'OK', submits: true, form: { external: true } }))
      .toEqual({ risk: 'risky', reason: 'external_form' });
    expect(classifyAction('browser.click', { role: 'button', name: 'Enregistrer', page: { path: '/settings/security' } }))
      .toEqual({ risk: 'risky', reason: 'account' });
    expect(classifyAction('browser.fill', { role: 'textbox', name: 'E-mail' })).toEqual({ risk: 'write', reason: null });
    expect(classifyAction('browser.submit', { name: 'Rechercher', form: { method: 'get', external: false } })).toEqual({ risk: 'write', reason: null });
    expect(classifyAction('browser.submit', { name: 'Valider', form: { method: 'post', external: false } })).toEqual({ risk: 'risky', reason: null });
    expect(classifyAction('browser.download', { role: 'link', name: 'Facture.pdf' })).toEqual({ risk: 'write', reason: null });
  });

  it('keeps the stricter of the server and local readings', () => {
    expect(stricterRisk({ risk: 'write', reason: null }, { risk: 'risky', reason: 'send' })).toEqual({ risk: 'risky', reason: 'send' });
    expect(stricterRisk({ risk: 'risky', reason: 'pay' }, { risk: 'write', reason: null })).toEqual({ risk: 'risky', reason: 'pay' });
    expect(stricterRisk({ risk: 'risky', reason: 'send' }, { risk: 'risky', reason: 'account' })).toEqual({ risk: 'risky', reason: 'account' });
    expect(stricterRisk({ risk: 'banana', reason: 'nope' }, { risk: 'write', reason: null })).toEqual({ risk: 'risky', reason: null });
    expect(stricterRisk({}, { risk: 'write', reason: null })).toEqual({ risk: 'write', reason: null });
  });

  it('applies the autonomy table, with pay and account always asking', () => {
    const write = { risk: 'write', reason: null };
    const risky = { risk: 'risky', reason: 'send' };
    const pay = { risk: 'risky', reason: 'pay' };
    const account = { risk: 'risky', reason: 'account' };
    const table = {
      ask_every_time: ['run', 'ask', 'ask', 'ask', 'ask'],
      approve_for_me: ['run', 'run', 'ask', 'ask', 'ask'],
      full_access: ['run', 'run', 'run', 'ask', 'ask']
    };
    for (const [level, expected] of Object.entries(table)) {
      expect([
        approvalDecision(level, 'read'),
        approvalDecision(level, 'action', write),
        approvalDecision(level, 'action', risky),
        approvalDecision(level, 'action', pay),
        approvalDecision(level, 'action', account)
      ]).toEqual(expected);
      expect(approvalDecision(level, 'access')).toBe('ask');
    }
    expect(approvalDecision('unknown', 'action', write)).toBe('ask');
    expect(toolKind('browser.read_page')).toBe('read');
    expect(toolKind('browser.submit')).toBe('action');
    expect(toolKind('browser.request_tab')).toBe('access');
    expect(toolKind('files.list')).toBeNull();
  });

  it('matches targets fuzzily but catches another element', () => {
    expect(targetMatches('Envoyer', 'Envoyer le message')).toBe(true);
    expect(targetMatches('« ENVOYER »', 'envoyer')).toBe(true);
    expect(targetMatches('Créer un compte', 'Creer un compte')).toBe(true);
    expect(targetMatches('Envoyer', 'Supprimer')).toBe(false);
    expect(targetMatches('', 'Envoyer')).toBe(false);
    expect(targetMatches('OK', 'Annuler')).toBe(false);
  });

  it('writes the approval sentence', () => {
    expect(approvalTitle('Limova Team', 'browser.click', 'Envoyer', 'example.com'))
      .toBe('Limova Team veut cliquer sur « Envoyer » sur example.com');
  });
});

describe('approval windows', () => {
  let windowsApi;
  let manager;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    windowsApi = { create: vi.fn(async () => ({ id: 77 })), remove: vi.fn(async () => {}) };
    let n = 0;
    manager = createApprovalManager({ windowsApi, getUrl: path => `chrome-extension://x/${path}`, randomId: () => `a${n += 1}` });
  });
  afterEach(() => vi.useRealTimers());

  it('opens a popup with only an opaque id in its URL', async () => {
    manager.request({ kind: 'action', productId: 'limova_team', title: 'T', target: 'Envoyer' }, { deadlineMs: Date.now() + 10_000 });
    await Promise.resolve();
    const options = windowsApi.create.mock.calls[0][0];
    expect(options.type).toBe('popup');
    expect(options.url).toBe('chrome-extension://x/src/team/approval.html?id=a1');
    expect(manager.get('a1')).toEqual(expect.objectContaining({ title: 'T', target: 'Envoyer' }));
  });

  it('resolves approve, deny, timeout and window close', async () => {
    const approved = manager.request({ kind: 'action', productId: 'p' }, { deadlineMs: Date.now() + 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.decide('a1', 'approve')).toBe(true);
    expect(await approved).toEqual({ decision: 'approve' });
    expect(windowsApi.remove).toHaveBeenCalledWith(77);

    const timedOut = manager.request({ kind: 'action', productId: 'p' }, { deadlineMs: Date.now() + 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await timedOut).toEqual({ decision: 'timeout' });

    const closed = manager.request({ kind: 'action', productId: 'p' }, { deadlineMs: Date.now() + 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    manager.windowClosed(77);
    expect(await closed).toEqual({ decision: 'deny' });
  });

  it('denies every open approval of a product on « Tout arrêter »', async () => {
    const first = manager.request({ kind: 'action', productId: 'limova_team' }, { deadlineMs: Date.now() + 10_000 });
    const other = manager.request({ kind: 'action', productId: 'limova' }, { deadlineMs: Date.now() + 10_000 });
    expect(manager.denyAll('limova_team')).toBe(1);
    expect(await first).toEqual({ decision: 'deny' });
    expect(manager.size()).toBe(1);
    manager.denyAll();
    expect(await other).toEqual({ decision: 'deny' });
  });

  it('needs a tab to approve a request_tab', async () => {
    const shared = manager.request({ kind: 'request_tab', productId: 'p', tabs: [] }, { deadlineMs: Date.now() + 10_000 });
    expect(manager.decide('a1', 'approve')).toBe(false);
    expect(manager.decide('a1', 'approve', { tabId: 5 })).toBe(true);
    expect(await shared).toEqual({ decision: 'approve', tabId: 5 });
  });
});
