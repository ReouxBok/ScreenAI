import { describe, it, expect } from 'vitest';
import {
  fieldSecretKind, isCardNumber, isTokenLike, luhnValid, maskText, MASK, redactFillValue, valueSecretKind
} from '../../../src/team/recording-redaction.js';

describe('recording redaction (docs/procedure-recording-format.md « Redaction »)', () => {
  it('redacts by field type and autocomplete', () => {
    expect(fieldSecretKind({ hints: { input_type: 'password' } })).toBe('password');
    expect(fieldSecretKind({ hints: { autocomplete: 'current-password' } })).toBe('password');
    expect(fieldSecretKind({ hints: { autocomplete: 'new-password' } })).toBe('password');
    expect(fieldSecretKind({ hints: { autocomplete: 'one-time-code' } })).toBe('otp');
    for (const token of ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year']) {
      expect(fieldSecretKind({ hints: { autocomplete: token } })).toBe('card');
    }
    expect(fieldSecretKind({ hints: { autocomplete: 'section-pay billing cc-number' } })).toBe('card');
    expect(fieldSecretKind({ hints: { autocomplete: 'email' } })).toBeNull();
  });

  it('redacts by name, label, placeholder and name attribute', () => {
    const cases = [
      [{ label: 'Mot de passe' }, 'password'],
      [{ name: 'Password' }, 'password'],
      [{ placeholder: 'Votre code PIN' }, 'secret'],
      [{ label: 'Numéro de carte' }, 'card'],
      [{ name: 'Card number' }, 'card'],
      [{ label: 'CVV' }, 'card'],
      [{ label: 'CVC' }, 'card'],
      [{ label: 'Cryptogramme visuel' }, 'card'],
      [{ label: 'Date d’expiration' }, 'card'],
      [{ label: 'OTP' }, 'otp'],
      [{ label: 'Code 2FA' }, 'otp'],
      [{ label: 'Code de vérification' }, 'otp'],
      [{ label: 'Code de confirmation' }, 'otp'],
      [{ label: 'Code reçu par SMS' }, 'otp'],
      [{ hints: { input_name: 'user_password' } }, 'password'],
      [{ label: 'Clé API' }, 'secret']
    ];
    for (const [target, kind] of cases) expect(fieldSecretKind(target), JSON.stringify(target)).toBe(kind);
    expect(fieldSecretKind({ label: 'Client' })).toBeNull();
    expect(fieldSecretKind({ label: 'Code postal' })).toBeNull();
  });

  it('follows read_page’s sensitive rule', () => {
    expect(fieldSecretKind({ label: 'IBAN' }, { sensitive: true })).toBe('secret');
  });

  it('detects card numbers with Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(isCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(isCardNumber('5555-5555-5555-4444')).toBe(true);
    expect(isCardNumber('378282246310005')).toBe(true);
    expect(isCardNumber('1234 5678 9012 3456')).toBe(false);
    expect(isCardNumber('06 12 34 56 78')).toBe(false);
    expect(valueSecretKind('4111111111111111', { label: 'Notes' })).toBe('card');
  });

  it('detects keys and tokens', () => {
    for (const token of [
      'sk-proj-abcdefghijklmnop1234',
      'ghp_abcdefghijklmnopqrstuvwxyz1234',
      'xoxb-123456789012-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'Zq8vR2mN4tLx9WbK7pYc3Hd6Fj1Gs5Ae0Uo'
    ]) {
      expect(isTokenLike(token), token).toBe(true);
    }
    expect(isTokenLike('Bonjour, voici ma note pour le client ACME')).toBe(false);
    expect(isTokenLike('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isTokenLike('ma clé est sk-proj-abcdefghijklmnop1234 merci')).toBe(true);
  });

  it('treats 4 to 8 digits as a code only in a field about a code', () => {
    expect(valueSecretKind('482913', { label: 'Code' })).toBe('otp');
    expect(valueSecretKind('4829', { name: 'Code SMS' })).toBe('otp');
    expect(valueSecretKind('482913', { label: 'Quantité' })).toBeNull();
    expect(valueSecretKind('75011', { label: 'Code postal' })).toBeNull();
    expect(valueSecretKind('123', { label: 'Code' })).toBeNull();
    expect(valueSecretKind('123456789', { label: 'Code' })).toBeNull();
  });

  it('sends {redacted} and sensitive instead of the value', () => {
    expect(redactFillValue({ hints: { input_type: 'password' } }, 'hunter2')).toEqual({ value: { redacted: 'password' }, sensitive: true });
    expect(redactFillValue({ label: 'Notes' }, 'ghp_abcdefghijklmnopqrstuvwxyz1234')).toEqual({ value: { redacted: 'secret' }, sensitive: true });
    expect(redactFillValue({ label: 'Client' }, 'ACME SAS')).toEqual({ value: 'ACME SAS', sensitive: false });
    expect(redactFillValue({ label: 'Notes' }, 'x'.repeat(6000)).value).toHaveLength(5000);
  });

  it('masks card numbers, codes and tokens in free text', () => {
    expect(maskText('Votre code 482913 est valable 10 minutes')).toBe(`Votre code ${MASK} est valable 10 minutes`);
    expect(maskText('Code de vérification : 4829')).toBe(`Code de vérification : ${MASK}`);
    expect(maskText('OTP: 123456')).toBe(`OTP: ${MASK}`);
    expect(maskText('Carte 4111 1111 1111 1111 enregistrée')).toBe(`Carte ${MASK} enregistrée`);
    expect(maskText('Facture 2026-042 créée pour 1 200 €')).toBe('Facture 2026-042 créée pour 1 200 €');
    expect(maskText('token ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe(`token ${MASK}`);
  });
});
