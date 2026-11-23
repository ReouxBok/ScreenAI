import { describe, it, expect } from 'vitest';
import {
  activityLabel, classifyAction, isPaymentClass, reasonFromName, riskHint, strictestOf, stricterRisk, targetMatches, toolKind
} from '../../../src/team/risk.js';

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

  it('only a payment needs a payment token (browser.v3)', () => {
    expect(isPaymentClass({ risk: 'risky', reason: 'pay' })).toBe(true);
    for (const reason of ['send', 'publish', 'delete', 'account', 'external_form', null]) {
      expect(isPaymentClass({ risk: 'risky', reason })).toBe(false);
    }
    expect(isPaymentClass({ risk: 'write', reason: null })).toBe(false);
    // A batch takes the strictest of its steps.
    expect(strictestOf([{ risk: 'write', reason: null }, { risk: 'risky', reason: 'pay' }, { risk: 'risky', reason: 'send' }]))
      .toEqual({ risk: 'risky', reason: 'pay' });
    expect(toolKind('browser.read_page')).toBe('read');
    expect(toolKind('browser.submit')).toBe('action');
    expect(toolKind('browser.batch')).toBe('action');
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

  it('writes the activity label (the extension has no approval window any more)', () => {
    expect(activityLabel('browser.click', { target: 'Envoyer' })).toBe('Clic sur « Envoyer »');
  });
});
