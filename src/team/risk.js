// risk.js — The extension's own reading of what an action does, and who must approve it.
//
// TEAM-724, docs/browser-device-protocol.md « Risk classes and autonomy ». The server
// sends its own `risk` / `risk_reason` with every action, computed from the latest
// snapshot. The extension computes its own from the LIVE element and keeps the
// stricter of the two, so a wrong or manipulated server reading can only add an
// approval, never remove one.
//
// `browser.v2` (TEAM-726): the extension no longer asks before actions, whatever its
// autonomy level. Only paying (`pay`, from the server or from this reading) waits for
// the person's click in a Chrome window. Other confirmations happen in the chat,
// decided by the server from the autonomy level. Sensitive fields, blocked sites,
// pause and take-over are still enforced elsewhere, at every level.
//
// TEAM-751: `browser.press_key` is a write, except Enter and Space on an element, which
// are judged like what they do (Enter in a form field like `browser.submit` on that
// form, Enter or Space on a button or link like `browser.click` on it). `browser.upload`
// is a write (an account settings page stays `account`); `upload` is the server's
// reason for a file from the Mac, which this extension never sends.
//
// Everything here is pure and runs in the service worker; the page only reports facts
// about the element (name, form, type), never a decision.

export const RISK_REASONS = Object.freeze(['send', 'pay', 'publish', 'delete', 'account', 'external_form', 'upload']);
// The only reason the extension itself still asks the person (TEAM-726).
export const OWNER_APPROVAL_REASONS = Object.freeze(['pay']);
export const HINT_REASONS = Object.freeze(['send', 'pay', 'publish', 'delete', 'account']);

export const READ_TOOLS = Object.freeze([
  'browser.list_tabs', 'browser.open_tab', 'browser.close_tab', 'browser.read_page',
  'browser.screenshot', 'browser.navigate', 'browser.scroll'
]);
export const ACTION_TOOLS = Object.freeze([
  'browser.click', 'browser.fill', 'browser.select', 'browser.submit', 'browser.download',
  'browser.batch', 'browser.press_key', 'browser.upload'
]);
// `browser.press_key` (TEAM-751): these keys only. Typing text is `browser.fill`.
export const PRESS_KEYS = Object.freeze([
  'Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'
]);
// Keys that activate the element they are pressed on: the server must know which.
export const ACTIVATING_KEYS = Object.freeze(['Enter', 'Space']);
export const ACCESS_TOOLS = Object.freeze(['browser.request_tab']);
// TEAM-729: types a saved login, sealed by the server for this device (docs/login-vault.md).
export const VAULT_TOOLS = Object.freeze(['browser.fill_secret']);
export const BROWSER_TOOLS = Object.freeze([...READ_TOOLS, ...ACTION_TOOLS, ...ACCESS_TOOLS, ...VAULT_TOOLS]);

// Higher wins when two readings disagree.
const REASON_SEVERITY = { account: 6, pay: 6, delete: 5, send: 4, publish: 4, upload: 3, external_form: 3 };

export function toolKind(tool) {
  if (READ_TOOLS.includes(tool)) return 'read';
  if (ACTION_TOOLS.includes(tool)) return 'action';
  if (ACCESS_TOOLS.includes(tool)) return 'access';
  if (VAULT_TOOLS.includes(tool)) return 'vault';
  return null;
}

// Lower-case, no accents, punctuation as spaces: « Envoyer le message ! » -> « envoyer le message ».
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, ' ')
    .replace(/[^a-z0-9@]+/g, ' ')
    .trim();
}

// Vocabularies match whole words of the normalised name (French, English, Spanish).
const VOCABULARY = [
  ['account', /\b(?:mot(?:s)? de passe|password|passwort|contrasena|change(?:r)? (?:d |l |mon |votre |your |the )?(?:e ?mail|adresse e ?mail|email address)|modifier (?:l |mon |votre )?(?:adresse )?e ?mail|securite|security|seguridad|2fa|mfa|double authentification|two factor|authentification a deux facteurs|supprimer (?:mon |le |votre |ce )?compte|delete (?:my |your |the )?account|close (?:my |your )?account|fermer (?:mon |le |votre )?compte|eliminar (?:mi )?cuenta|facturation|billing|facturacion|moyen(?:s)? de paiement|payment method(?:s)?|metodo de pago)\b/],
  ['pay', /\b(?:payer|paiement|payment|pay|pay now|pagar|pago|acheter|achat|buy|buy now|purchase|comprar|commander|passer (?:la |ma )?commande|place (?:my |the |your )?order|valider (?:la |ma )?commande|confirmer (?:l )?achat|confirm (?:purchase|payment|order)|checkout|check out|finaliser (?:la |ma )?commande|faire un don|donate|souscrire|regler)\b/],
  ['delete', /\b(?:supprimer|suppression|delete|remove|effacer|erase|eliminar|borrar|retirer|vider|empty trash|corbeille|trash|discard)\b/],
  ['publish', /\b(?:publier|publication|publish|post|poster|tweet|tweeter|publicar|partager|share|compartir|mettre en ligne|go live|commenter|repost|reposter)\b/],
  ['send', /\b(?:envoyer|envoi|send|send message|enviar|soumettre|submit|reply|repondre|responder|transmettre|forward|reenvoyer|inviter|invite|invitar)\b/]
];

// Pages whose ordinary « Enregistrer » changes account settings.
const ACCOUNT_PATH = /\/(?:password|mot-de-passe|security|securite|billing|facturation|2fa|mfa|two-factor|account\/(?:delete|close|email))(?:\/|$)/i;
const PAY_PATH = /\/(?:checkout|paiement|payment|pay|cart\/checkout|commande\/paiement)(?:\/|$)/i;

export function reasonFromName(name) {
  const text = normalizeText(name);
  if (!text) return null;
  for (const [reason, pattern] of VOCABULARY) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function strongestReason(...reasons) {
  let best = null;
  for (const reason of reasons) {
    if (!reason || !REASON_SEVERITY[reason]) continue;
    if (!best || REASON_SEVERITY[reason] > REASON_SEVERITY[best]) best = reason;
  }
  return best;
}

// What `read_page` shows as `risk_hint`: send, pay, publish, delete, account or absent.
export function riskHint(element) {
  if (!element) return null;
  const role = element.role;
  if (!['button', 'link', 'menuitem', 'tab', 'option', 'switch'].includes(role) && !element.submits) return null;
  const fromName = reasonFromName(element.name);
  const fromForm = element.submits ? formReason(element.form) : null;
  const reason = strongestReason(fromName, fromForm === 'external_form' ? null : fromForm);
  return HINT_REASONS.includes(reason) ? reason : null;
}

function formReason(form) {
  if (!form) return null;
  if (form.has_card) return 'pay';
  if (form.has_new_password) return 'account';
  if (form.external) return 'external_form';
  return null;
}

/**
 * The extension's reading of one action on a live element.
 * @param {string} tool browser.click | fill | select | submit | download
 * @param {object} element facts the page reported (name, role, tag, submits, form, page)
 * @returns {{risk: 'write'|'risky', reason: string|null}}
 */
export function classifyAction(tool, element = {}) {
  const page = element.page || {};
  const pathReason = ACCOUNT_PATH.test(page.path || '') ? 'account' : PAY_PATH.test(page.path || '') ? 'pay' : null;
  if (tool === 'browser.fill' || tool === 'browser.select') {
    // Typing commits nothing; the click or submit that follows is judged on its own.
    return { risk: 'write', reason: null };
  }
  if (tool === 'browser.download') {
    return { risk: 'write', reason: null };
  }
  if (tool === 'browser.upload') {
    // A chat attachment is a write; on an account settings page it stays `account`.
    return ACCOUNT_PATH.test(page.path || '') ? { risk: 'risky', reason: 'account' } : { risk: 'write', reason: null };
  }
  const nameReason = reasonFromName(element.name);
  if (tool === 'browser.submit') {
    const form = element.form || {};
    const reason = strongestReason(nameReason, formReason(form), pathReason);
    // A same-site GET form (a search box) is only a write.
    const sameSiteGet = form.method === 'get' && !form.external;
    if (reason) return { risk: 'risky', reason };
    return { risk: sameSiteGet ? 'write' : 'risky', reason: null };
  }
  // browser.click
  const submitsForm = Boolean(element.submits && element.form);
  const reason = strongestReason(
    nameReason,
    submitsForm ? formReason(element.form) : null,
    // On a billing or security page, any button may change the account.
    element.role === 'button' || submitsForm ? pathReason : null
  );
  return reason ? { risk: 'risky', reason } : { risk: 'write', reason: null };
}

const KEY_CLICK_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'switch', 'checkbox', 'radio'];

/**
 * The extension's reading of `browser.press_key` (and of a batch's `key` step).
 * @param {string} key one of PRESS_KEYS
 * @param {object|null} element the live element the key is pressed on, or null
 * @returns {{risk: 'write'|'risky', reason: string|null}}
 */
export function classifyKey(key, element) {
  if (!element || !ACTIVATING_KEYS.includes(key)) return { risk: 'write', reason: null };
  const clicks = KEY_CLICK_ROLES.includes(element.role) || ['button', 'a', 'summary'].includes(element.tag) || element.submits;
  if (key === 'Enter' && element.editable && !element.multiline && (element.in_form || element.form)) {
    // Enter in a form field submits its form.
    return classifyAction('browser.submit', element);
  }
  if (key === 'Enter' && element.editable && element.multiline) {
    // A message composer sends on Enter: read its name (« Envoyer un message »).
    const reason = reasonFromName(element.name);
    return reason ? { risk: 'risky', reason } : { risk: 'write', reason: null };
  }
  if (clicks) return classifyAction('browser.click', element);
  return { risk: 'write', reason: null };
}

/**
 * Keep the stricter of the server's and the extension's readings.
 * Unknown server values count as risky: a reading we cannot understand never lowers the bar.
 */
export function stricterRisk(server = {}, local = {}) {
  const serverRisk = server.risk === 'write' || server.risk === 'risky' ? server.risk : (server.risk == null ? 'write' : 'risky');
  const serverReason = RISK_REASONS.includes(server.reason) ? server.reason : null;
  const reason = strongestReason(serverReason, local.reason);
  const risky = serverRisk === 'risky' || local.risk === 'risky' || Boolean(reason);
  return { risk: risky ? 'risky' : 'write', reason };
}

/**
 * Must the person click « Autoriser » in Chrome before this action runs?
 * Only for a payment (TEAM-726); everything else runs, at every autonomy level.
 * @param {{risk: string, reason: string|null}} risk the stricter reading
 * @returns {boolean}
 */
export function needsOwnerApproval(risk = {}) {
  return OWNER_APPROVAL_REASONS.includes(risk.reason);
}

/**
 * The strictest reading of several steps (`browser.batch`).
 * @param {Array<{risk: string, reason: string|null}>} readings
 */
export function strictestOf(readings) {
  return readings.reduce((acc, reading) => stricterRisk(acc, reading), { risk: 'write', reason: null });
}

/**
 * Does the model's `target` still name this element? Tolerant of case, accents,
 * punctuation and small wording changes, strict enough to catch an id that now
 * points at another control.
 */
export function targetMatches(target, name) {
  const wanted = normalizeText(target);
  const actual = normalizeText(name);
  if (!wanted || !actual) return false;
  if (wanted === actual) return true;
  const shorter = wanted.length <= actual.length ? wanted : actual;
  const longer = shorter === wanted ? actual : wanted;
  // « Envoyer » vs « Envoyer le message »: containment on word boundaries.
  if (shorter.length >= 3 && ` ${longer} `.includes(` ${shorter} `)) return true;
  const wantedWords = new Set(wanted.split(' ').filter(word => word.length > 1));
  const actualWords = new Set(actual.split(' ').filter(word => word.length > 1));
  if (!wantedWords.size || !actualWords.size) return false;
  let shared = 0;
  for (const word of wantedWords) if (actualWords.has(word)) shared += 1;
  const union = new Set([...wantedWords, ...actualWords]).size;
  return shared / union >= 0.6;
}

const VERBS = {
  'browser.click': 'cliquer sur',
  'browser.fill': 'écrire dans',
  'browser.select': 'choisir une option dans',
  'browser.submit': 'envoyer le formulaire',
  'browser.download': 'télécharger',
  'browser.batch': 'agir sur',
  'browser.press_key': 'appuyer sur une touche dans',
  'browser.upload': 'déposer des fichiers dans'
};

// The French name of a key, for the activity list and the approval window.
export const KEY_LABELS = Object.freeze({
  Enter: 'Entrée', Tab: 'Tab', Escape: 'Échap', Space: 'Espace', Backspace: 'Retour arrière', Delete: 'Suppr',
  ArrowUp: 'Flèche haut', ArrowDown: 'Flèche bas', ArrowLeft: 'Flèche gauche', ArrowRight: 'Flèche droite',
  Home: 'Début', End: 'Fin', PageUp: 'Page précédente', PageDown: 'Page suivante'
});

// The approval window only opens for a payment now (TEAM-726).
export const PAY_REASON_TEXT = 'Cette action peut déclencher un paiement. Limova attend votre accord avant de payer.';

function quoted(text, max = 80) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return `« ${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean} »`;
}

// « Limova Team veut cliquer sur « Envoyer » sur example.com »
export function approvalTitle(productLabel, tool, targetName, domain) {
  const verb = VERBS[tool] || 'agir sur';
  return `${productLabel} veut ${verb} ${quoted(targetName)}${domain ? ` sur ${domain}` : ''}`;
}

// The short label shown in the side panel's activity list and the chat's live steps.
export function activityLabel(tool, args = {}, targetName = '') {
  const name = targetName || args.target || '';
  switch (tool) {
    case 'browser.list_tabs': return 'Liste des onglets';
    case 'browser.open_tab': return 'Ouverture d’un onglet';
    case 'browser.close_tab': return 'Fermeture d’un onglet';
    case 'browser.read_page': return 'Lecture de la page';
    case 'browser.screenshot': return 'Capture de la page';
    case 'browser.navigate': return args.action === 'back' ? 'Retour' : args.action === 'forward' ? 'Page suivante' : args.action === 'reload' ? 'Actualisation' : 'Navigation';
    case 'browser.scroll': return 'Défilement';
    case 'browser.click': return `Clic sur ${quoted(name, 40)}`;
    case 'browser.fill': return `Saisie dans ${quoted(name, 40)}`;
    case 'browser.select': return `Choix dans ${quoted(name, 40)}`;
    case 'browser.submit': return `Envoi de ${quoted(name, 40)}`;
    case 'browser.download': return `Téléchargement de ${quoted(name, 40)}`;
    case 'browser.batch': return `Remplissage de la page (${Number(args.steps?.length) || 0} étapes)`;
    case 'browser.press_key': {
      const key = `${args.shift === true ? 'Maj+' : ''}${KEY_LABELS[args.key] || 'Touche'}`;
      return name ? `Touche ${key} dans ${quoted(name, 40)}` : `Touche ${key}`;
    }
    // A count, never the files' names.
    case 'browser.upload': {
      const count = Array.isArray(args.files) ? args.files.length : 0;
      return `Envoi de ${count} fichier${count > 1 ? 's' : ''}${name ? ` dans ${quoted(name, 40)}` : ''}`;
    }
    case 'browser.request_tab': return 'Demande d’accès à un onglet';
    // Never the login's label or username: only that a saved login was used.
    case 'browser.fill_secret': return 'Connexion avec un identifiant enregistré';
    default: return 'Action';
  }
}
