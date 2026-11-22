// recorder.js — « Montrer à Limova »: record a task in Chrome and send it (TEAM-731).
//
// docs/procedure-recording-format.md (`limova.recording.v1`), checked against
// app/schemas/procedure_recording.py. The person clicks « Montrer à Limova » in the side
// panel's Limova Team card and chooses « Dans cet onglet » (that tab joins the Limova
// Team group: the click is the consent) or « Dans un nouvel onglet ». Then:
//
// - page-recorder.js, injected in each recorded tab's isolated world, reports semantic
//   steps (click, fill once per field, select, check, Enter/Escape, upload names,
//   download) and what changed after each (`observed`);
// - this module adds navigations from chrome.webNavigation with their cause (typed,
//   link, redirect, history, reload, script), numbers the tabs 1, 2… (never Chrome's
//   tab_id), adds a `wait` when the person waited for the page, redacts every fill
//   value on capture (recording-redaction.js), and keeps everything IN MEMORY ONLY;
// - « Pause » records nothing until « Reprendre »; « Arrêter » shows the step list,
//   where the person deletes steps, names the task and ticks « Cette valeur change à
//   chaque fois »; « Envoyer à Limova » uploads once to
//   POST {api}/api/v1/devices/me/recordings and opens {dashboard}/skills?tab=training.
//
// Why memory only, not chrome.storage.session: fill values (names, amounts, e-mails)
// are the person's data even after redaction. The recorded page sends a heartbeat every
// 20 s and the Limova Team socket pings every 25 s, which keeps the service worker
// alive while recording; if Chrome still restarts it, the recording is lost and the
// page recorder stops itself (the worker answers « not recording »). Nothing of a
// recording is ever written to chrome.storage or the logs.
//
// While recording, the person drives: agent calls for this product are held as with
// « Prendre la main », and handed back at « Arrêter ».

import { classifyUrl } from './products.js';
import {
  buildRecording, cleanTarget, cleanUrl, fitRecording, guessParameter, MAX_DURATION_MS, MAX_RECORDING_BYTES,
  MAX_STEPS, stepLabel, validateRecording
} from './recording-format.js';
import { fieldSecretKind, maskText, redactFillValue } from './recording-redaction.js';
import { pageSnapshot } from './page-snapshot.js';
import { pausePageRecorder, startPageRecorder, stopPageRecorder } from './page-recorder.js';

export const RECORDER_PAGE_MESSAGE_TYPES = Object.freeze(['TEAM_RECORD_EVENT', 'TEAM_RECORD_OBSERVED', 'TEAM_RECORD_PING']);
export const RECORDING_GROUP_TITLE = 'Limova Team · Limova regarde';
const OBSERVE_FALLBACK_MS = 3_500;
const CLICK_CAUSE_WINDOW_MS = 2_500;
const WAIT_MIN_GAP_MS = 4_000;
const WAIT_MIN_LATE_CHANGE_MS = 1_500;
const DUPLICATE_NAVIGATION_MS = 1_000;
const UPLOAD_RETRIES_ON_413 = 3;

const UPLOAD_MESSAGES = {
  empty: 'Aucune étape à envoyer.',
  invalid: 'Limova Team n’a pas accepté cet enregistrement.',
  too_large: 'L’enregistrement est trop volumineux, même raccourci.',
  revoked: 'Ce navigateur n’est plus connecté à Limova Team. Reconnecte-le puis renvoie l’enregistrement.',
  disabled: '« Former Limova » n’est pas ouvert pour ton espace Limova Team.',
  network: 'Impossible de joindre Limova Team. Vérifie ta connexion puis réessaie : rien ne sera envoyé deux fois.',
  server: 'Limova Team n’a pas pu recevoir l’enregistrement. Réessaie dans un instant.',
  not_connected: 'Connecte d’abord ce navigateur à Limova Team.'
};

export function navigationCause(transitionType, qualifiers = [], clickedRecently = false) {
  const q = Array.isArray(qualifiers) ? qualifiers : [];
  if (q.includes('forward_back')) return 'history';
  if (q.includes('server_redirect') || q.includes('client_redirect')) return 'redirect';
  if (q.includes('from_address_bar')) return 'typed';
  switch (transitionType) {
    case 'typed':
    case 'auto_bookmark':
    case 'generated':
    case 'keyword':
    case 'keyword_generated':
    case 'start_page':
    case 'auto_toplevel':
      return 'typed';
    case 'reload':
      return 'reload';
    case 'link':
    case 'form_submit':
      // Chrome also says « link » for a page's own location changes: only a click is a link.
      return clickedRecently ? 'link' : 'script';
    default:
      return 'script';
  }
}

function sameTarget(a = {}, b = {}) {
  return a.role === b.role && a.name === b.name && a.label === b.label
    && (a.hints?.input_name || '') === (b.hints?.input_name || '') && (a.ordinal ?? 0) === (b.ordinal ?? 0);
}

export function createRecorder({
  chromeApi = globalThis.chrome,
  browserFor,
  connectionFor,
  takeOver = () => false,
  handBack = () => {},
  onRevoked = () => {},
  onChange = () => {},
  fetchImpl = (...args) => globalThis.fetch(...args),
  timers = globalThis,
  now = () => Date.now(),
  randomId = () => globalThis.crypto.randomUUID(),
  appVersion = () => chromeApi.runtime?.getManifest?.().version || '',
  locale = () => globalThis.navigator?.language || chromeApi.i18n?.getUILanguage?.() || ''
} = {}) {
  let current = null;
  let lastResult = null;
  let keyCounter = 0;
  const procedures = new Map();

  const active = () => Boolean(current && (current.status === 'recording' || current.status === 'paused'));
  const changed = () => onChange(summary());

  async function inject(tabId) {
    if (!active()) return false;
    const tab = await chromeApi.tabs.get(tabId).catch(() => null);
    if (!tab || !classifyUrl(tab.url || '').ok) return false;
    try {
      await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: pageSnapshot, args: [{ installOnly: true }] });
      const results = await chromeApi.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: startPageRecorder,
        args: [{ recordingId: current.id, paused: current.status === 'paused' }]
      });
      return Boolean(results?.[0]?.result?.ok);
    } catch {
      return false;
    }
  }

  async function runInTabs(func, args) {
    const events = [];
    for (const tabId of current.tabs.keys()) {
      try {
        const results = await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func, args: [args] });
        for (const event of results?.[0]?.result?.events || []) events.push({ tabId, event });
      } catch {
        // Closed tab, or a page Chrome does not let us script: nothing to collect.
      }
    }
    return events;
  }

  function addTab(tabId) {
    if (!current.tabs.has(tabId) && current.nextTab <= 50) {
      current.tabs.set(tabId, current.nextTab);
      current.nextTab += 1;
    }
    return current.tabs.get(tabId);
  }

  function push(step) {
    if (current.steps.filter(item => !item.deleted).length >= MAX_STEPS) return false;
    step.key = `k${keyCounter += 1}`;
    current.steps.push(step);
    if (current.steps.filter(item => !item.deleted).length >= MAX_STEPS) {
      current.limit = 'steps';
      stop().catch(() => {});
    }
    changed();
    return true;
  }

  function finishObservation(id, observed) {
    const pending = current?.pending.get(id);
    if (!pending) return;
    current.pending.delete(id);
    timers.clearTimeout(pending.timer);
    const step = pending.step;
    const before = cleanUrl(step.page?.url);
    const after = cleanUrl(observed?.url) || step.observed?.url || before;
    step.observed = {
      ...step.observed,
      ...(observed || {}),
      url: after,
      url_changed: Boolean(step.observed?.url_changed) || Boolean(before && after && before !== after),
      messages: (observed?.messages || step.observed?.messages || []).map(maskText).slice(0, 5)
    };
  }

  function watchObservation(tabId, seq, step) {
    const id = `${tabId}:${seq}`;
    const timer = timers.setTimeout(async () => {
      // The page went away before reporting (it navigated): read the tab instead.
      const tab = await chromeApi.tabs.get(tabId).catch(() => null);
      finishObservation(id, tab ? { url: tab.url, title: maskText(String(tab.title || '')).slice(0, 200), dom_changed: true } : {});
      changed();
    }, OBSERVE_FALLBACK_MS);
    current.pending.set(id, { step, timer, tabId, at: step.at });
  }

  // A navigation in the observation window of an action is that action's outcome.
  function markNavigated(tabId, url) {
    for (const pending of current.pending.values()) {
      if (pending.tabId !== tabId || now() - pending.at > OBSERVE_FALLBACK_MS) continue;
      pending.step.observed = { ...pending.step.observed, url_changed: true, url };
    }
  }

  function lastNavigation(tabId) {
    for (let index = current.steps.length - 1; index >= 0; index -= 1) {
      const step = current.steps[index];
      if (step.kind === 'navigate' && step.tabId === tabId && !step.deleted) return step;
    }
    return null;
  }

  function addNavigation(tabId, rawUrl, cause) {
    const url = cleanUrl(rawUrl);
    if (!url) return;
    const previous = lastNavigation(tabId);
    // Same page again within a second (commit + history update, or a query change): one step.
    if (previous && previous.url === url && (cause === 'script' || now() - previous.at < DUPLICATE_NAVIGATION_MS)) return;
    markNavigated(tabId, url);
    push({ kind: 'navigate', url, cause, tab: current.tabs.get(tabId), tabId, at: now() });
  }

  function addEvent(tabId, event) {
    if (!current || !event || typeof event !== 'object') return;
    const at = now();
    const tab = current.tabs.get(tabId);
    const previous = current.steps.filter(step => !step.deleted).at(-1);
    // The person waited for the page before going on (a long load, a spinner).
    const lateChange = Number(event.last_change_at);
    if (previous && at - previous.at >= WAIT_MIN_GAP_MS && Number.isFinite(lateChange)
      && lateChange - previous.at >= WAIT_MIN_LATE_CHANGE_MS && lateChange < at - 300 && previous.kind !== 'wait') {
      push({ kind: 'wait', ms: Math.min(600_000, Math.round(lateChange - previous.at)), tab, tabId, at: previous.at });
    }
    const page = event.page ? { url: cleanUrl(event.page.url), title: maskText(String(event.page.title || '')).slice(0, 200) } : undefined;
    const target = event.target ? cleanTarget(event.target) : undefined;
    const base = { tab, tabId, at, page };
    let step = null;
    switch (event.kind) {
      case 'fill': {
        const redacted = event.value_withheld === true
          ? { value: { redacted: fieldSecretKind(target, { sensitive: true }) || event.secret_kind || 'secret' }, sensitive: true }
          : redactFillValue(target, event.value, { sensitive: event.sensitive === true });
        step = { ...base, kind: 'fill', target, value: redacted.value, sensitive: redacted.sensitive };
        // One step per field: typing in the same field again right after replaces it.
        if (previous?.kind === 'fill' && previous.tabId === tabId && sameTarget(previous.target, target)) {
          previous.value = step.value;
          previous.sensitive = step.sensitive;
          previous.at = Math.max(previous.at, at);
          const guess = guessParameter(previous);
          previous.candidate_parameter = guess.candidate;
          previous.parameter_name = guess.name;
          changed();
          return;
        }
        const guess = guessParameter(step);
        step.candidate_parameter = guess.candidate;
        if (guess.name) step.parameter_name = guess.name;
        break;
      }
      case 'select':
        step = { ...base, kind: 'select', target, option: String(event.option || '').slice(0, 200) };
        break;
      case 'check':
        step = { ...base, kind: 'check', target, checked: event.checked === true };
        break;
      case 'key':
        if (!['Enter', 'Escape'].includes(event.key)) return;
        step = { ...base, kind: 'key', key: event.key, ...(target ? { target } : {}) };
        break;
      case 'upload':
        step = { ...base, kind: 'upload', target, files: Array.isArray(event.files) ? event.files.slice(0, 20) : [] };
        break;
      case 'download':
        step = { ...base, kind: 'download', target, file: event.file };
        break;
      case 'click':
        step = { ...base, kind: 'click', target };
        current.lastClickAt = at;
        break;
      default:
        return;
    }
    if (!push(step)) return;
    if (['click', 'select', 'check', 'key', 'upload', 'download'].includes(step.kind) && Number.isInteger(event.seq)) {
      watchObservation(tabId, event.seq, step);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async function start({ productId, tabId = null, newTab = false }) {
    if (current && current.status !== 'review') return { ok: false, error: 'busy' };
    if (current?.status === 'review') return { ok: false, error: 'review_pending' };
    const link = connectionFor(productId);
    if (!link) return { ok: false, error: 'not_connected', message: UPLOAD_MESSAGES.not_connected };
    if (procedures.get(productId) === 'off') return { ok: false, error: 'disabled', message: UPLOAD_MESSAGES.disabled };
    const browser = browserFor(productId);
    let tab;
    if (newTab) {
      const window = await chromeApi.windows?.getLastFocused?.({ windowTypes: ['normal'] }).catch(() => null);
      tab = await chromeApi.tabs.create({ active: true, ...(window?.id !== undefined ? { windowId: window.id } : {}) });
    } else {
      if (!Number.isInteger(tabId)) return { ok: false, error: 'invalid_args' };
      tab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (!tab) return { ok: false, error: 'tab_not_found' };
      const verdict = classifyUrl(tab.url || '');
      if (!verdict.ok) return { ok: false, error: verdict.code };
    }
    lastResult = null;
    const startedAt = now();
    current = {
      id: randomId(),
      productId,
      status: 'recording',
      startedAt,
      endedAt: null,
      title: '',
      tabs: new Map(),
      nextTab: 1,
      steps: [],
      pending: new Map(),
      lastClickAt: 0,
      error: null,
      cut: null,
      tookOver: Boolean(takeOver(productId)),
      limitTimer: null
    };
    addTab(tab.id);
    await browser.joinGroup(tab.id).catch(() => {});
    await browser.setRecordingTitle?.(RECORDING_GROUP_TITLE).catch?.(() => {});
    if (!newTab) push({ kind: 'navigate', url: cleanUrl(tab.url), cause: 'typed', tab: 1, tabId: tab.id, at: startedAt });
    await inject(tab.id);
    // A recording lasts at most two hours.
    current.limitTimer = timers.setTimeout(() => {
      if (!active()) return;
      current.limit = 'duration';
      stop().catch(() => {});
    }, MAX_DURATION_MS - 5_000);
    changed();
    return { ok: true, recording_id: current.id };
  }

  async function setPaused(paused) {
    if (!active()) return { ok: false, error: 'not_recording' };
    if (paused && current.status === 'recording') {
      // What was typed before the pause still counts.
      for (const { tabId, event } of await runInTabs(pausePageRecorder, { recordingId: current.id, paused: true })) addEvent(tabId, event);
      current.status = 'paused';
    } else if (!paused && current.status === 'paused') {
      current.status = 'recording';
      await runInTabs(pausePageRecorder, { recordingId: current.id, paused: false });
    }
    changed();
    return { ok: true, paused: current.status === 'paused' };
  }

  async function stop() {
    if (!active()) return { ok: false, error: 'not_recording' };
    const wasRecording = current.status === 'recording';
    const events = await runInTabs(stopPageRecorder, { recordingId: current.id, flush: wasRecording });
    if (wasRecording) for (const { tabId, event } of events) addEvent(tabId, event);
    for (const id of [...current.pending.keys()]) finishObservation(id, null);
    timers.clearTimeout(current.limitTimer);
    current.status = 'review';
    current.endedAt = now();
    const browser = browserFor(current.productId);
    await browser?.setRecordingTitle?.(null).catch?.(() => {});
    if (current.tookOver) handBack(current.productId);
    changed();
    return { ok: true };
  }

  function discard() {
    if (!current) return { ok: true };
    const wasActive = active();
    const { productId, tookOver } = current;
    if (wasActive) {
      runInTabs(stopPageRecorder, { recordingId: current.id, flush: false }).catch(() => {});
      for (const pending of current.pending.values()) timers.clearTimeout(pending.timer);
      timers.clearTimeout(current.limitTimer);
      browserFor(productId)?.setRecordingTitle?.(null).catch?.(() => {});
      if (tookOver) handBack(productId);
    }
    current = null;
    changed();
    return { ok: true };
  }

  // ------------------------------------------------------------------ review

  function reviewSteps() {
    return current.steps.filter(step => !step.deleted).map(step => {
      const redacted = step.kind === 'fill' && step.value && typeof step.value === 'object' ? step.value.redacted : null;
      return {
        key: step.key,
        kind: step.kind,
        label: stepLabel(step),
        tab: step.tab,
        value: step.kind === 'fill' && !redacted ? String(step.value).slice(0, 120) : step.kind === 'select' ? step.option : null,
        redacted,
        can_parameter: (step.kind === 'fill' && !redacted) || step.kind === 'select',
        candidate_parameter: step.candidate_parameter === true,
        parameter_name: step.parameter_name || ''
      };
    });
  }

  function edit({ key, remove, candidate_parameter: candidate, parameter_name: name }) {
    if (current?.status !== 'review') return { ok: false, error: 'not_reviewing' };
    const step = current.steps.find(item => item.key === key && !item.deleted);
    if (!step) return { ok: false, error: 'not_found' };
    if (remove === true) step.deleted = true;
    if (typeof candidate === 'boolean' && (step.kind === 'select' || (step.kind === 'fill' && typeof step.value === 'string'))) {
      step.candidate_parameter = candidate;
    }
    if (typeof name === 'string') step.parameter_name = name.replace(/\s+/g, ' ').trim().slice(0, 60);
    changed();
    return { ok: true };
  }

  function setTitle(title) {
    if (current?.status !== 'review') return { ok: false, error: 'not_reviewing' };
    current.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { ok: true };
  }

  function payload() {
    return buildRecording({
      recordingId: current.id,
      title: current.title,
      startedAt: current.startedAt,
      endedAt: current.endedAt ?? now(),
      steps: current.steps,
      narration: [],
      appVersion: appVersion(),
      locale: locale()
    });
  }

  // ------------------------------------------------------------------ upload

  async function post(link, body) {
    try {
      const response = await fetchImpl(`${link.api}/api/v1/devices/me/recordings`, {
        method: 'POST',
        headers: { Authorization: `Device ${link.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify(body)
      });
      let json = null;
      try { json = await response.json(); } catch { json = null; }
      return { status: response.status, json };
    } catch {
      return { status: 0, json: null };
    }
  }

  function fail(code, message) {
    current.status = 'review';
    current.error = { code, message: message || UPLOAD_MESSAGES[code] || UPLOAD_MESSAGES.server };
    changed();
    return { ok: false, error: code, message: current.error.message };
  }

  async function upload() {
    if (current?.status !== 'review') return { ok: false, error: 'not_reviewing' };
    const link = connectionFor(current.productId);
    if (!link) return fail('not_connected');
    current.status = 'uploading';
    current.error = null;
    changed();
    let { recording, cut } = fitRecording(payload(), MAX_RECORDING_BYTES);
    if (!recording.steps.length) return fail('empty');
    const problems = validateRecording(recording);
    if (problems.length) return fail('invalid', `${UPLOAD_MESSAGES.invalid} (${problems[0]})`);
    let answer = await post(link, recording);
    for (let attempt = 0; answer.status === 413 && attempt < UPLOAD_RETRIES_ON_413; attempt += 1) {
      // The server counts bytes its own way: cut more, narration first, then steps.
      ({ recording, cut } = fitRecording(recording, Math.floor(MAX_RECORDING_BYTES * (0.85 ** (attempt + 1)))));
      answer = await post(link, recording);
    }
    if (answer.status === 201 || answer.status === 200) {
      const result = {
        recording_id: answer.json?.recording_id || current.id,
        procedure_id: answer.json?.procedure_id || null,
        duplicate: answer.json?.duplicate === true || answer.status === 200,
        redacted: Number(answer.json?.redacted) || 0,
        steps: recording.steps.length,
        cut
      };
      procedures.set(current.productId, 'on');
      current = null;
      lastResult = result;
      Promise.resolve(chromeApi.tabs.create({ url: `${link.dashboard}/skills?tab=training`, active: true })).catch(() => {});
      changed();
      return { ok: true, ...result };
    }
    if (answer.status === 413) return fail('too_large');
    if (answer.status === 422 || answer.status === 400) {
      const detail = typeof answer.json?.detail === 'string' ? answer.json.detail.slice(0, 300) : '';
      return fail('invalid', detail || UPLOAD_MESSAGES.invalid);
    }
    if (answer.status === 401) {
      const productId = current.productId;
      fail('revoked');
      onRevoked(productId);
      return { ok: false, error: 'revoked', message: UPLOAD_MESSAGES.revoked };
    }
    if (answer.status === 404) {
      procedures.set(current.productId, 'off');
      return fail('disabled');
    }
    if (answer.status === 0) return fail('network');
    return fail('server');
  }

  // Is « Former Limova » open for this connection? There is no flag in the protocol, so
  // ask the upload route with an empty body: 404 means off, 400/422 means on (an empty
  // body is never stored).
  async function probe(productId) {
    if (procedures.has(productId)) return procedures.get(productId);
    const link = connectionFor(productId);
    if (!link) return 'unknown';
    procedures.set(productId, 'unknown');
    const answer = await post(link, {});
    const verdict = answer.status === 404 ? 'off' : (answer.status === 400 || answer.status === 422) ? 'on' : 'unknown';
    procedures.set(productId, verdict);
    if (verdict === 'unknown') procedures.delete(productId);
    changed();
    return verdict;
  }

  // ------------------------------------------------------------------ Chrome events

  function onCommitted(details) {
    if (!active() || details?.frameId !== 0 || !current.tabs.has(details.tabId) || current.status === 'paused') return;
    const clicked = now() - current.lastClickAt < CLICK_CAUSE_WINDOW_MS;
    addNavigation(details.tabId, details.url, navigationCause(details.transitionType, details.transitionQualifiers, clicked));
  }

  function onHistoryStateUpdated(details) {
    if (!active() || details?.frameId !== 0 || !current.tabs.has(details.tabId) || current.status === 'paused') return;
    const clicked = now() - current.lastClickAt < CLICK_CAUSE_WINDOW_MS;
    const cause = (details.transitionQualifiers || []).includes('forward_back') ? 'history' : clicked ? 'link' : 'script';
    addNavigation(details.tabId, details.url, cause);
  }

  function onDomReady(details) {
    if (!active() || details?.frameId !== 0 || !current.tabs.has(details.tabId)) return;
    inject(details.tabId);
  }

  function onTabCreated(tab) {
    if (!active() || !current.tabs.has(tab?.openerTabId)) return;
    addTab(tab.id);
    browserFor(current.productId)?.joinGroup(tab.id).catch(() => {});
    for (const pending of current.pending.values()) {
      if (pending.tabId === tab.openerTabId && now() - pending.at <= OBSERVE_FALLBACK_MS) {
        pending.step.observed = { ...pending.step.observed, new_tab: true };
      }
    }
    changed();
  }

  function handlePageMessage(request, sender) {
    if (!active() || request?.recording_id !== current.id) return { ok: false, recording: false };
    const tabId = sender?.tab?.id;
    if (sender?.frameId !== 0 || !current.tabs.has(tabId)) return { ok: false, recording: false };
    const paused = current.status === 'paused';
    if (request.type === 'TEAM_RECORD_PING' || paused) return { ok: true, recording: true, paused };
    if (request.type === 'TEAM_RECORD_EVENT') addEvent(tabId, request.event);
    if (request.type === 'TEAM_RECORD_OBSERVED' && request.observed && Number.isInteger(request.observed.seq)) {
      finishObservation(`${tabId}:${request.observed.seq}`, {
        url: request.observed.url,
        title: maskText(String(request.observed.title || '')).slice(0, 200),
        dom_changed: request.observed.dom_changed === true,
        messages: Array.isArray(request.observed.messages) ? request.observed.messages.map(text => String(text).slice(0, 200)) : []
      });
      changed();
    }
    return { ok: true, recording: true, paused: false };
  }

  function summary() {
    return {
      status: current?.status || 'idle',
      product: current?.productId || null,
      started_at: current?.startedAt || null,
      steps: current ? current.steps.filter(step => !step.deleted).length : 0,
      tabs: current ? current.tabs.size : 0,
      limit: current?.limit || null,
      error: current?.error || null,
      last_result: lastResult,
      procedures: Object.fromEntries(procedures)
    };
  }

  function review() {
    if (!current || !['review', 'uploading'].includes(current.status)) return null;
    return { title: current.title, steps: reviewSteps(), error: current.error, status: current.status, limit: current.limit || null };
  }

  function isRecording(productId) {
    return active() && (!productId || current.productId === productId);
  }

  return {
    start, pause: () => setPaused(true), resume: () => setPaused(false), stop, discard, edit, setTitle, upload, probe,
    summary, review, payload: () => (current ? payload() : null), isRecording,
    handlePageMessage, onCommitted, onHistoryStateUpdated, onDomReady, onTabCreated,
    _internal: () => current
  };
}
