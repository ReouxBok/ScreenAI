// recording-redaction.js — What a recording must never send (TEAM-731).
//
// docs/procedure-recording-format.md « Redaction (both sides) ». The recorder sends
// `{"redacted": kind}` and `sensitive: true` instead of a fill's value when:
// - the field is a password (`type="password"`, autocomplete current-/new-password);
// - autocomplete says one-time-code (otp) or cc-number / cc-csc / cc-exp* (card);
// - the extension already classes the field `sensitive` in browser.read_page;
// - the field's name, label, placeholder or `name` attribute says password, mot de
//   passe, PIN, card number, numéro de carte, CVV/CVC, cryptogramme, expiration, OTP,
//   2FA, code de vérification / de confirmation / SMS;
// - the value itself is a card number (13 to 19 digits passing Luhn), an API key or
//   token (sk-…, ghp_…, xoxb-…, AKIA…, a JWT, a 32+ character high-entropy string),
//   or 4 to 8 digits typed in a field about a code.
// Narration and observed messages get card-like numbers and « code 482913 »-like
// phrases replaced by « [masqué] ».
//
// Everything here is pure, runs in the service worker, and is applied before a value
// is kept in memory. The page-side recorder (page-recorder.js) already withholds the
// value of fields it can tell are secret; this is the second, complete pass. The
// server applies the same rules again (app/services/procedure_redaction.py).

export const MASK = '[masqué]';

const PASSWORD_WORDS = /(pass(?:word|wd|phrase)?\b|mot[ -]de[ -]passe|\bmdp\b|contrase(?:n|ñ)a|passwort)/i;
const PIN_WORDS = /\bpin\b|code pin|code secret/i;
const CARD_WORDS = /(card.?num|num[ée]ro de (?:la )?carte|carte bancaire|credit.?card|\bcvv\d?\b|\bcvc\d?\b|\bcvn\b|cryptogramme|expiration|date d.?exp|\bexpiry\b|\bcc.?(?:num|exp|csc)\b)/i;
// A bare « code » is not enough: only with a 4 to 8 digit value (valueSecretKind).
const OTP_WORDS = /(\botp\b|\b2fa\b|\bmfa\b|one.?time|code (?:de )?(?:v[ée]rification|confirmation)|verification code|confirmation code|code (?:re[çc]u )?(?:par )?sms|\bsms code\b)/i;
const SECRET_WORDS = /(api.?key|\bsecret\b|\btoken\b|cl[ée] (?:d.)?api|security code|code de s[ée]curit[ée])/i;
// A field « about a code », where 4 to 8 digits are a one-time code.
const CODE_FIELD = /(\bcode\b|\botp\b|\bpin\b|\bsms\b|v[ée]rification|verification|confirmation|2fa|mfa)/i;
// Codes that are ordinary data, not secrets: « Code postal » 75011 must stay readable.
const PUBLIC_CODE = /(code postal|postal ?code|\bzip\b|\bcp\b|code promo|promo ?code|coupon|code client|customer (?:code|id)|code produit|product code|code article|\bsku\b|code naf|code ape|code pays|country code|code tva|vat code|code iso|code r[ée]f[ée]rence|code interne|code (?:du )?(?:projet|chantier|dossier))/i;

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgh[osur]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\blmd_[A-Za-z0-9_-]{16,}/
];

export function luhnValid(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// 13 to 19 digits, spaces or dashes allowed between groups, passing Luhn.
export function isCardNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^[\d][\d -]{11,22}[\d]$/.test(text)) return false;
  return luhnValid(text.replace(/[ -]/g, ''));
}

function shannonEntropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// A key or token: a known prefix anywhere, or one 32+ character high-entropy word.
export function isTokenLike(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (TOKEN_PATTERNS.some(pattern => pattern.test(text))) return true;
  if (/\s/.test(text) || text.length < 32) return false;
  if (!/^[A-Za-z0-9+/=_.:-]+$/.test(text)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter(pattern => pattern.test(text)).length;
  return classes >= 2 && shannonEntropy(text) >= 3.5;
}

function autocompleteKind(autocomplete) {
  const tokens = String(autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some(token => token === 'current-password' || token === 'new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'otp';
  if (tokens.some(token => token === 'cc-number' || token === 'cc-csc' || token.startsWith('cc-exp'))) return 'card';
  return null;
}

function wordsOf(target) {
  return [target?.name, target?.label, target?.placeholder, target?.hints?.input_name, target?.hints?.id_attr]
    .filter(value => typeof value === 'string' && value)
    .join(' ');
}

/**
 * Is this field a secret, whatever its value? Returns the redaction kind, or null.
 * @param {object} target the step's TargetDescriptor (role, name, label, placeholder, hints)
 * @param {{sensitive?: boolean}} [facts] what the page reported (read_page's sensitive rule)
 */
export function fieldSecretKind(target = {}, facts = {}) {
  if (String(target?.hints?.input_type || '').toLowerCase() === 'password') return 'password';
  const fromAutocomplete = autocompleteKind(target?.hints?.autocomplete);
  if (fromAutocomplete) return fromAutocomplete;
  const words = wordsOf(target);
  if (PASSWORD_WORDS.test(words)) return 'password';
  if (CARD_WORDS.test(words)) return 'card';
  if (OTP_WORDS.test(words) && !PUBLIC_CODE.test(words)) return 'otp';
  if (PIN_WORDS.test(words)) return 'secret';
  if (SECRET_WORDS.test(words)) return 'secret';
  if (facts.sensitive === true) return 'secret';
  return null;
}

/**
 * Is this value a secret, whatever its field? Returns the redaction kind, or null.
 */
export function valueSecretKind(value, target = {}) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (isCardNumber(text)) return 'card';
  if (isTokenLike(text)) return 'secret';
  const words = wordsOf(target);
  if (/^\d{4,8}$/.test(text) && CODE_FIELD.test(words) && !PUBLIC_CODE.test(words)) return 'otp';
  return null;
}

/**
 * The value a fill step may carry: the text, or {redacted: kind} with sensitive: true.
 * @returns {{value: string | {redacted: string}, sensitive: boolean}}
 */
export function redactFillValue(target, value, facts = {}) {
  const kind = fieldSecretKind(target, facts) || valueSecretKind(value, target);
  if (kind) return { value: { redacted: kind }, sensitive: true };
  return { value: String(value ?? '').slice(0, 5000), sensitive: false };
}

/**
 * Mask card-like numbers, « code 482913 »-like phrases and tokens in free text
 * (observed messages, narration, titles).
 */
export function maskText(text) {
  let out = String(text ?? '');
  // Card-like: 13 to 19 digits, optionally grouped by spaces or dashes.
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, match => (match.replace(/[ -]/g, '').length >= 13 ? MASK : match));
  // « code 482913 », « Votre code de vérification est : 4829 », « OTP: 123456 », « PIN 1234 ».
  out = out.replace(/\b(codes?|otp|pin|2fa|v[ée]rification|verification|confirmation|sms)\b([^\d\n]{0,40}?)(\d{4,8})\b/gi,
    (match, word, between) => `${word}${between}${MASK}`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(new RegExp(pattern.source, 'g'), MASK);
  return out;
}
