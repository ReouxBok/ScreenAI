// recording-format.js — Build, check and size a `limova.recording.v1` (TEAM-731).
//
// docs/procedure-recording-format.md, with app/schemas/procedure_recording.py as the
// source of truth for limits and names. The recorder (recorder.js) keeps steps in
// memory in its own shape; this module turns them into the wire format, checks them
// against the server's limits before uploading (so a 422 is a bug, not the normal
// path), and cuts a recording over 512 KB (narration first, then steps from the end).
// TEAM-751: `key` steps take every key `browser.press_key` presses (KEY_STEP_KEYS), and
// a target in a child frame carries `frame: {origin, name, path}`.
// Pure: no Chrome API, no storage.

import { maskText } from './recording-redaction.js';

export const RECORDING_SCHEMA = 'limova.recording.v1';
export const MAX_RECORDING_BYTES = 512 * 1024;
export const MAX_STEPS = 300;
export const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
export const MAX_NARRATION_SEGMENTS = 200;
export const MAX_NARRATION_CHARS = 20_000;
export const MAX_VALUE_CHARS = 5_000;
export const STEP_KINDS = Object.freeze(['navigate', 'click', 'fill', 'select', 'check', 'key', 'upload', 'download', 'wait']);
export const NAVIGATE_CAUSES = Object.freeze(['typed', 'link', 'redirect', 'history', 'reload', 'script']);
// TEAM-751: the keys a `key` step may hold (the keys of `browser.press_key`).
export const KEY_STEP_KEYS = Object.freeze([
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown'
]);
// What a server from before TEAM-751 accepts in a `key` step.
export const LEGACY_KEY_STEP_KEYS = Object.freeze(['Enter', 'Escape', 'Tab']);
const ELEMENT_KINDS = ['click', 'fill', 'select', 'check', 'upload', 'download'];
const HINT_LIMITS = { input_type: 30, input_name: 100, autocomplete: 60, testid: 100, id_attr: 100, href_path: 500, landmark: 60 };

// origin + path only; null for anything that is not http(s).
export function cleanUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname || '/'}`.slice(0, 2048);
  } catch {
    return null;
  }
}

function cut(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function compact(object) {
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value === undefined || value === null || value === '') delete object[key];
    else if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) delete object[key];
  }
  return object;
}

// A TargetDescriptor, cut to the server's limits. Never a value, a selector or coordinates.
export function cleanTarget(raw = {}) {
  const hints = {};
  for (const [key, max] of Object.entries(HINT_LIMITS)) {
    const value = key === 'href_path' ? cleanUrl(raw?.hints?.[key]) : cut(raw?.hints?.[key], max);
    if (value) hints[key] = value.slice(0, max);
  }
  const form = raw?.form && typeof raw.form === 'object' ? compact({
    name: cut(raw.form.name, 100),
    action_origin: cut(raw.form.action_origin, 200),
    method: ['get', 'post', 'dialog'].includes(raw.form.method) ? raw.form.method : undefined
  }) : undefined;
  const ordinal = Number.isInteger(raw?.ordinal) && raw.ordinal >= 0 ? Math.min(raw.ordinal, 500) : undefined;
  return compact({
    frame: cleanFrame(raw?.frame),
    role: cut(raw?.role, 40),
    name: cut(raw?.name, 200),
    tag: cut(raw?.tag, 20),
    text: cut(raw?.text, 200),
    label: cut(raw?.label, 200),
    placeholder: cut(raw?.placeholder, 200),
    nearby: cut(raw?.nearby, 300),
    hints,
    form,
    ordinal
  });
}

// A child frame's reference (TEAM-751): `path` (1 to 5 indexes), its origin and name.
// Absent for the top frame.
export function cleanFrame(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.path)) return undefined;
  const path = raw.path.filter(index => Number.isInteger(index) && index >= 0 && index < 1000);
  if (!path.length || path.length !== raw.path.length || path.length > 5) return undefined;
  const origin = cleanUrl(typeof raw.origin === 'string' ? `${raw.origin}/` : '');
  return compact({
    origin: origin ? new URL(origin).origin : undefined,
    name: cut(maskText(typeof raw.name === 'string' ? raw.name : ''), 100),
    path
  });
}

export function hasIdentity(target = {}) {
  const hints = target.hints || {};
  return Boolean(target.name || target.text || target.label || target.placeholder
    || hints.testid || hints.input_name || hints.id_attr || hints.href_path);
}

function cleanFile(raw) {
  const name = cut(raw?.name, 200);
  if (!name) return null;
  return compact({
    name,
    mime: cut(raw?.mime, 120),
    size: Number.isInteger(raw?.size) && raw.size >= 0 ? raw.size : undefined
  });
}

function cleanObserved(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const observed = compact({
    url: cleanUrl(raw.url) || undefined,
    url_changed: typeof raw.url_changed === 'boolean' ? raw.url_changed : undefined,
    title: cut(maskText(raw.title || ''), 200),
    dom_changed: typeof raw.dom_changed === 'boolean' ? raw.dom_changed : undefined,
    messages: Array.isArray(raw.messages)
      ? raw.messages.map(message => cut(maskText(message), 200)).filter(Boolean).slice(0, 5)
      : undefined,
    new_tab: typeof raw.new_tab === 'boolean' ? raw.new_tab : undefined
  });
  if (Array.isArray(observed.messages) && !observed.messages.length) delete observed.messages;
  return Object.keys(observed).length ? observed : undefined;
}

function cleanPage(raw) {
  const url = cleanUrl(raw?.url);
  if (!url) return undefined;
  return compact({ url, title: cut(maskText(raw.title || ''), 200) });
}

/**
 * One step in its wire shape, or null when it cannot be sent (no URL, no target…).
 * `value` of a fill must already be redacted (recorder.js does it on capture).
 */
export function wireStep(step, { id, t }) {
  if (!STEP_KINDS.includes(step?.kind)) return null;
  const out = { id, t, kind: step.kind };
  if (Number.isInteger(step.tab) && step.tab >= 1) out.tab = Math.min(step.tab, 50);
  const page = cleanPage(step.page);
  if (page) out.page = page;
  const observed = cleanObserved(step.observed);
  if (observed) out.observed = observed;
  if (ELEMENT_KINDS.includes(step.kind) || (step.kind === 'key' && step.target)) {
    const target = cleanTarget(step.target);
    if (!hasIdentity(target)) {
      if (step.kind !== 'key') return null;
    } else {
      out.target = target;
    }
  }
  switch (step.kind) {
    case 'navigate': {
      const url = cleanUrl(step.url);
      if (!url) return null;
      out.url = url;
      if (NAVIGATE_CAUSES.includes(step.cause)) out.cause = step.cause;
      break;
    }
    case 'fill': {
      if (step.value && typeof step.value === 'object') {
        if (!['password', 'card', 'otp', 'secret'].includes(step.value.redacted)) return null;
        out.value = { redacted: step.value.redacted };
        out.sensitive = true;
      } else {
        out.value = String(step.value ?? '').slice(0, MAX_VALUE_CHARS);
        if (step.sensitive === true) out.sensitive = true;
      }
      if (step.candidate_parameter === true && typeof out.value === 'string') {
        out.candidate_parameter = true;
        const name = cut(step.parameter_name, 60);
        if (name) out.parameter_name = name;
      }
      break;
    }
    case 'select': {
      const option = cut(step.option, 200);
      if (!option) return null;
      out.option = option;
      if (step.candidate_parameter === true) {
        out.candidate_parameter = true;
        const name = cut(step.parameter_name, 60);
        if (name) out.parameter_name = name;
      }
      break;
    }
    case 'click':
      break;
    case 'check':
      out.checked = step.checked === true;
      break;
    case 'key':
      if (!KEY_STEP_KEYS.includes(step.key)) return null;
      out.key = step.key;
      break;
    case 'upload':
      out.files = (Array.isArray(step.files) ? step.files : []).map(cleanFile).filter(Boolean).slice(0, 20);
      break;
    case 'download': {
      const file = cleanFile(step.file);
      if (file) out.file = file;
      break;
    }
    case 'wait':
      out.ms = Math.max(0, Math.min(600_000, Math.round(Number(step.ms) || 0)));
      break;
    default:
      return null;
  }
  return out;
}

/**
 * The whole recording, ready to upload.
 * @param {object} input {recordingId, title, startedAt, endedAt (ms), steps, narration, appVersion, locale}
 */
export function buildRecording({ recordingId, title, startedAt, endedAt, steps = [], narration = [], appVersion, locale }) {
  const wire = [];
  let lastT = 0;
  for (const step of steps) {
    if (step?.deleted) continue;
    const t = Math.max(lastT, Math.min(MAX_DURATION_MS, Math.max(0, Math.round((step.at ?? startedAt) - startedAt))));
    const out = wireStep(step, { id: `s${wire.length + 1}`, t });
    if (!out) continue;
    lastT = t;
    wire.push(out);
  }
  const origins = [];
  for (const step of wire) {
    for (const url of [step.url, step.page?.url]) {
      const clean = cleanUrl(url);
      if (!clean) continue;
      const origin = new URL(clean).origin;
      if (!origins.includes(origin) && origins.length < 10) origins.push(origin);
    }
  }
  let narrationChars = 0;
  const segments = [];
  for (const segment of narration) {
    const text = cut(maskText(segment?.text || ''), 1000);
    if (!text || segments.length >= MAX_NARRATION_SEGMENTS || narrationChars + text.length > MAX_NARRATION_CHARS) continue;
    narrationChars += text.length;
    const start = Math.max(0, Math.round(Number(segment.start_ms) || 0));
    segments.push({ start_ms: start, end_ms: Math.max(start, Math.round(Number(segment.end_ms) || start)), text });
  }
  const recording = {
    schema: RECORDING_SCHEMA,
    recording_id: recordingId,
    session: compact({
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(Math.max(endedAt, startedAt)).toISOString(),
      origins,
      recorder: compact({ surface: 'chrome_extension', app_version: cut(appVersion, 40) }),
      locale: cut(locale, 20)
    }),
    steps: wire,
    keyframes: []
  };
  const cleanTitle = cut(title, 120);
  if (cleanTitle) recording.title = cleanTitle;
  if (segments.length) recording.narration = segments;
  return recording;
}

export function byteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check a wire recording against the server's rules. Returns a list of problems
 * (empty when it would be accepted), each naming its field like the server's 422.
 */
export function validateRecording(recording) {
  const problems = [];
  if (recording?.schema !== RECORDING_SCHEMA) problems.push('schema');
  if (!UUID.test(String(recording?.recording_id || ''))) problems.push('recording_id');
  if (recording?.title !== undefined && (typeof recording.title !== 'string' || recording.title.length > 120)) problems.push('title');
  const started = Date.parse(recording?.session?.started_at || '');
  const ended = Date.parse(recording?.session?.ended_at || '');
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) problems.push('session.started_at');
  else if (ended - started > MAX_DURATION_MS) problems.push('session.ended_at');
  if (recording?.session?.recorder?.surface !== 'chrome_extension') problems.push('session.recorder.surface');
  const steps = Array.isArray(recording?.steps) ? recording.steps : [];
  if (steps.length < 1 || steps.length > MAX_STEPS) problems.push('steps');
  const ids = new Set();
  let lastT = 0;
  steps.forEach((step, index) => {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(String(step.id || '')) || ids.has(step.id)) problems.push(`steps.${index}.id`);
    ids.add(step.id);
    if (!Number.isInteger(step.t) || step.t < lastT || step.t > MAX_DURATION_MS) problems.push(`steps.${index}.t`);
    lastT = step.t;
    if (!STEP_KINDS.includes(step.kind)) problems.push(`steps.${index}.kind`);
    if (ELEMENT_KINDS.includes(step.kind) && !hasIdentity(step.target)) problems.push(`steps.${index}.target`);
    if (step.kind === 'fill' && typeof step.value === 'string' && step.value.length > MAX_VALUE_CHARS) problems.push(`steps.${index}.value`);
    if (step.kind === 'navigate' && !cleanUrl(step.url)) problems.push(`steps.${index}.url`);
  });
  const narration = Array.isArray(recording?.narration) ? recording.narration : [];
  if (narration.length > MAX_NARRATION_SEGMENTS) problems.push('narration');
  if (narration.reduce((sum, segment) => sum + String(segment.text || '').length, 0) > MAX_NARRATION_CHARS) problems.push('narration');
  if (byteSize(recording) > MAX_RECORDING_BYTES) problems.push('size');
  return problems;
}

/**
 * The same recording for a server from before TEAM-751, whose `key` steps only take
 * Enter, Escape and Tab: the other key steps are left out and the ids renumbered.
 * @returns {{recording: object, dropped: number}}
 */
export function withLegacyKeys(recording) {
  const steps = [];
  let dropped = 0;
  for (const step of recording.steps || []) {
    if (step.kind === 'key' && !LEGACY_KEY_STEP_KEYS.includes(step.key)) {
      dropped += 1;
      continue;
    }
    steps.push({ ...step, id: `s${steps.length + 1}` });
  }
  return { recording: { ...recording, steps }, dropped };
}

/**
 * Fit a recording under the byte limit: narration first, then steps from the end.
 * @returns {{recording: object, cut: {narration: number, steps: number}}}
 */
export function fitRecording(recording, maxBytes = MAX_RECORDING_BYTES) {
  const out = { ...recording, steps: [...recording.steps], narration: recording.narration ? [...recording.narration] : undefined };
  const cutCount = { narration: 0, steps: 0 };
  while (out.narration?.length && byteSize(out) > maxBytes) {
    out.narration.pop();
    cutCount.narration += 1;
  }
  if (out.narration && !out.narration.length) delete out.narration;
  while (out.steps.length > 1 && byteSize(out) > maxBytes) {
    out.steps.pop();
    cutCount.steps += 1;
  }
  return { recording: out, cut: cutCount };
}

function slug(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/**
 * Guess whether a filled value changes from one run to the next (names, amounts,
 * dates, e-mails). Only a suggestion: the person ticks or unticks it at « Arrêter ».
 * @returns {{candidate: boolean, name?: string}}
 */
export function guessParameter(step) {
  if (step?.kind !== 'fill' && step?.kind !== 'select') return { candidate: false };
  if (step.value && typeof step.value === 'object') return { candidate: false };
  const value = String(step.kind === 'select' ? step.option || '' : step.value || '').trim();
  if (!value) return { candidate: false };
  const target = step.target || {};
  const words = `${target.label || ''} ${target.name || ''} ${target.placeholder || ''} ${target.hints?.input_name || ''}`.toLowerCase();
  const type = String(target.hints?.input_type || '').toLowerCase();
  const autocomplete = String(target.hints?.autocomplete || '').toLowerCase();
  const named = slug(target.label || target.name || target.placeholder || target.hints?.input_name);
  if (type === 'email' || autocomplete === 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { candidate: true, name: named || 'email' };
  if (['date', 'datetime-local', 'month', 'week'].includes(type) || /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value)) {
    return { candidate: true, name: named || 'date' };
  }
  if (/montant|prix|price|amount|total|quantit|qty|tarif|somme|budget/.test(words)
    && /^-?\d[\d\s]*(?:[.,]\d+)?\s?(?:€|eur|\$|usd|%)?$/i.test(value)) {
    return { candidate: true, name: named || 'montant' };
  }
  if (/\bnom\b|name|pr[ée]nom|client|soci[ée]t[ée]|company|contact|destinataire|recipient|entreprise|raison sociale/.test(words)
    || /^(given|family|additional)-name$|^name$|^organization$/.test(autocomplete)) {
    return { candidate: true, name: named || 'nom' };
  }
  return { candidate: false };
}

function quoted(text, max = 50) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return `« ${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean} »`;
}

function targetName(target = {}) {
  return target.name || target.label || target.text || target.placeholder || target.hints?.input_name || target.role || 'élément';
}

// The French line the step list shows at « Arrêter ».
export function stepLabel(step) {
  switch (step?.kind) {
    case 'navigate': {
      const url = cleanUrl(step.url);
      const where = url ? `${new URL(url).host}${new URL(url).pathname === '/' ? '' : new URL(url).pathname}` : '';
      const why = { typed: 'Ouverture de', link: 'Arrivée sur', redirect: 'Redirection vers', history: 'Retour sur', reload: 'Actualisation de', script: 'Passage à' }[step.cause] || 'Ouverture de';
      return `${why} ${where}`;
    }
    case 'click': return `Clic sur ${quoted(targetName(step.target))}`;
    case 'fill': return `Saisie dans ${quoted(targetName(step.target))}`;
    case 'select': return `Choix ${quoted(step.option, 40)} dans ${quoted(targetName(step.target))}`;
    case 'check': return `${step.checked ? 'Coche' : 'Décoche'} ${quoted(targetName(step.target))}`;
    case 'key': {
      const names = {
        Enter: 'Entrée', Escape: 'Échap', Tab: 'Tab', Space: 'Espace', Backspace: 'Retour arrière', Delete: 'Suppr',
        ArrowUp: 'Flèche haut', ArrowDown: 'Flèche bas', ArrowLeft: 'Flèche gauche', ArrowRight: 'Flèche droite',
        Home: 'Début', End: 'Fin', PageUp: 'Page précédente', PageDown: 'Page suivante'
      };
      const on = step.target ? ` dans ${quoted(targetName(step.target))}` : '';
      return `Touche ${names[step.key] || step.key}${on}`;
    }
    case 'upload': return `Envoi de ${(step.files || []).map(file => quoted(file.name, 40)).join(', ') || 'fichiers'}`;
    case 'download': return `Téléchargement de ${quoted(step.file?.name || targetName(step.target))}`;
    case 'wait': return `Attente de ${Math.max(1, Math.round((step.ms || 0) / 1000))} s`;
    default: return 'Étape';
  }
}
