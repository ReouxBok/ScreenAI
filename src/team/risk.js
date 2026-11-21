// risk.js — The extension's own reading of what an action does, and who must approve it.
//
// TEAM-724, docs/browser-device-protocol.md « Risk classes and autonomy ». The server
// sends its own `risk` / `risk_reason` with every action, computed from the latest
// snapshot. The extension computes its own from the LIVE element and keeps the
// stricter of the two, so a wrong or manipulated server reading can only add an
// approval, never remove one.
//
// Autonomy table (pay / account always ask, at every level):
//   level            read   write  risky  risky pay/account
//   ask_every_time   runs   asks   asks   asks
//   approve_for_me   runs   runs   asks   asks
//   full_access      runs   runs   runs   asks
//
// Everything here is pure and runs in the service worker; the page only reports facts
// about the element (name, form, type), never a decision.

export const RISK_REASONS = Object.freeze(['send', 'pay', 'publish', 'delete', 'account', 'external_form']);
export const ALWAYS_ASK_REASONS = Object.freeze(['pay', 'account']);
export const HINT_REASONS = Object.freeze(['send', 'pay', 'publish', 'delete', 'account']);

export const READ_TOOLS = Object.freeze([
  'browser.list_tabs', 'browser.open_tab', 'browser.close_tab', 'browser.read_page',
  'browser.screenshot', 'browser.navigate', 'browser.scroll'
]);
export const ACTION_TOOLS = Object.freeze([
  'browser.click', 'browser.fill', 'browser.select', 'browser.submit', 'browser.download'
]);
export const ACCESS_TOOLS = Object.freeze(['browser.request_tab']);
export const BROWSER_TOOLS = Object.freeze([...READ_TOOLS, ...ACTION_TOOLS, ...ACCESS_TOOLS]);

// Higher wins when two readings disagree.
const REASON_SEVERITY = { account: 6, pay: 6, delete: 5, send: 4, publish: 4, external_form: 3 };

export function toolKind(tool) {
  if (READ_TOOLS.includes(tool)) return 'read';
  if (ACTION_TOOLS.includes(tool)) return 'action';
  if (ACCESS_TOOLS.includes(tool)) return 'access';
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
 * Should the person approve this call?
 * @param {string} autonomy ask_every_time | approve_for_me | full_access
 * @param {'read'|'action'|'access'} kind
 * @param {{risk: string, reason: string|null}} [risk]
 * @returns {'run'|'ask'}
 */
export function approvalDecision(autonomy, kind, risk = { risk: 'write', reason: null }) {
  if (kind === 'read') return 'run';
  if (kind === 'access') return 'ask';
  if (ALWAYS_ASK_REASONS.includes(risk.reason)) return 'ask';
  if (autonomy === 'full_access') return 'run';
  if (autonomy === 'approve_for_me') return risk.risk === 'risky' ? 'ask' : 'run';
  // ask_every_time, or anything unknown: ask.
  return 'ask';
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
  'browser.download': 'télécharger'
};

const REASON_TEXT = {
  send: 'Cette action envoie un message ou des données.',
  pay: 'Cette action peut déclencher un paiement.',
  publish: 'Cette action publie du contenu.',
  delete: 'Cette action supprime quelque chose.',
  account: 'Cette action peut modifier les réglages de votre compte.',
  external_form: 'Ce formulaire envoie vos données vers un autre site.'
};

export function reasonText(reason, autonomy) {
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  return autonomy === 'ask_every_time'
    ? 'Vous avez choisi « Demander une approbation » : chaque modification attend votre accord.'
    : 'Cette action modifie la page.';
}

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
    case 'browser.request_tab': return 'Demande d’accès à un onglet';
    default: return 'Action';
  }
}
