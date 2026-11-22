// browser-engine.js — The shared browser engine behind every product connection (TEAM-724).
//
// One engine, one scope per product (`engine.forProduct(product)`). A product scope:
// - owns one Chrome tab group (« Limova Team », purple) and only touches tabs inside it;
//   any other tab answers `not_in_group`. Tabs it opens, and tabs an action opens, are
//   moved into the group;
// - runs every `browser.*` tool of docs/browser-device-protocol.md with its exact args,
//   data and error codes;
// - reads and acts through the injected page functions (page-snapshot.js,
//   page-actions.js), which keep the element map in the extension's isolated world;
// - never stores what it reads: page text, element names, screenshots and field values
//   live in memory until the answer is sent.
//
// `browser.v2` (TEAM-726): every page-changing tool takes `include_page: true` and
// answers `data.page` (read_page's data, read once the page settled), and
// `browser.batch` runs up to 20 fill/select/check/click steps on one snapshot, all
// checked before the first one runs. Waits follow the tab's events and DOM quiet
// rather than fixed delays; a navigation still gets at most 20 s.
//
// `browser.fill_secret` (TEAM-729, docs/login-vault.md): `fillSecret` opens a login the
// server sealed for this socket's key (vault.js), checks the group, the seal, the LIVE
// origin, the elements and the password form's target, types the values with
// `fillSecretInPage`, and answers `filled` flags. It is the only path that types into a
// sensitive field; `browser.fill` and `browser.batch` keep refusing them.
//
// Approvals and autonomy are not decided here (see team-controller.js). For actions the
// engine splits the work in two: `prepareAction` checks everything and reads the live
// element (so the controller can judge risk and ask the person), then `executeAction`
// acts and verifies what happened.
//
// TEAM-751 (`browser.v2+keys`, `+upload`, `+frames`):
// - `browser.press_key` presses one of PRESS_KEYS on an element (or the focused one),
//   with the default action emulated in the page (page-actions.js); a batch takes `key`
//   steps too;
// - `browser.upload` puts chat attachments (inline base64, 5 MiB in all) into a file
//   input or drops them on a drop area; files from the Mac (`source: "mac"`) are for
//   Limova Desktop only and answer `unsupported`. The bytes live in this call's memory
//   until the answer is sent: never stored, never logged, never in an answer;
// - read_page reads child frames too: frame-tree.js decides which and names them
//   (`fr1`, `fr2`… per snapshot), each frame keeps its own map in its isolated world,
//   and an action on `fr2.e5` runs in that frame's document only (chrome.scripting
//   `documentIds`), so a frame that navigated answers `stale_snapshot`.
//
// `renderCapture(dataUrl, {viewportWidth, viewportHeight, masks, markers})` is injected
// (background.js's renderSilentVisualCapture) to avoid a circular import.

import { blockedHostSuffixes, classifyUrl, domainOf, safeFavicon, safeUrl } from './products.js';
import {
  ACTIVATING_KEYS, classifyAction, classifyKey, PRESS_KEYS, riskHint, strictestOf, targetMatches
} from './risk.js';
import { inspectPageElement, pageSnapshot, preparePageCapture, probeFrame } from './page-snapshot.js';
import { collectPageVerification, fillSecretInPage, performPageAction, probeFocus, scrollPage } from './page-actions.js';
import { buildFrameTree, frameTextHeader, parseElementId, publicFrames } from './frame-tree.js';
import { openSeal } from './vault.js';

export const GROUPS_SESSION_KEY = 'limova_tab_groups_v1';
export const SCREENSHOT_MAX_BASE64 = 1_500_000;
const NAVIGATION_SETTLE_MAX_MS = 20_000;
// Verification polls the page instead of sleeping a fixed time (TEAM-726): it ends as
// soon as the DOM has been quiet for VERIFY_QUIET_MS, after at least VERIFY_MIN_MS, and
// never later than VERIFY_MAX_MS (a navigation still gets its 20 s).
const VERIFY_FIRST_CHECK_MS = 120;
const VERIFY_POLL_MS = 100;
const VERIFY_MIN_MS = 350;
const VERIFY_MAX_MS = 3_000;
const VERIFY_QUIET_MS = 300;
const LOAD_POLL_FALLBACK_MS = 500;
const BATCH_NAVIGATION_PEEK_MS = 120;
const BATCH_MAX_STEPS = 20;
const BATCH_ACTIONS = ['fill', 'select', 'check', 'click', 'key'];
// `browser.upload` (TEAM-751).
export const UPLOAD_MAX_FILES = 10;
// 5 MiB in all: the call's base64 must stay under Redis' 8 MB pub/sub soft limit.
export const UPLOAD_MAX_INLINE_BYTES = 5 * 1024 * 1024;
const ELEMENT_ID_HELP = 'element_id must look like e12 (or fr2.e12 in a frame)';
const OPEN_TAB_WAIT_MS = 10_000;
const TEXT_LIMITS = { min: 500, max: 20000, fallback: 8000 };
// `include_page` reads a shorter page by default (TEAM-726).
const INCLUDED_TEXT_LIMITS = { min: 500, max: 20000, fallback: 4000 };
const ELEMENT_LIMITS = { min: 1, max: 400, fallback: 200 };

const HINT_LIMITS = { input_type: 30, input_name: 100, autocomplete: 60, testid: 100, id_attr: 100, href_path: 500, landmark: 60 };

// Keep only the descriptor fields of the server's TargetDescriptor, cut to its limits.
export function descriptorFieldsOf(item) {
  const out = {};
  for (const [key, max] of [['label', 200], ['placeholder', 200], ['nearby', 300]]) {
    if (typeof item?.[key] === 'string' && item[key]) out[key] = item[key].slice(0, max);
  }
  if (item?.hints && typeof item.hints === 'object') {
    const hints = {};
    for (const [key, max] of Object.entries(HINT_LIMITS)) {
      if (typeof item.hints[key] === 'string' && item.hints[key]) hints[key] = item.hints[key].slice(0, max);
    }
    if (Object.keys(hints).length) out.hints = hints;
  }
  return out;
}

export function toolError(code, message) {
  return { ok: false, error: { code, message: message || code } };
}

function ok(data) {
  return { ok: true, data };
}

function isTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

function boundedInt(value, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function isCancelled(signal) {
  return Boolean(signal?.aborted);
}

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The bytes a standard base64 string holds, or -1 when it is not standard base64
 * (TEAM-751: checked before anything reaches the page, without decoding it).
 * @param {string} data
 * @returns {number}
 */
export function base64ByteLength(data) {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return -1;
  if (!data.length) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * Does a file input's `accept` let this file in? By extension (`.pdf`), MIME type
 * (`application/pdf`) or MIME family (`image/*`), as the file dialog filters them.
 * @param {string} accept the attribute as written ('' accepts everything)
 * @param {{name: string, mime?: string}} file
 * @returns {boolean}
 */
export function acceptAllows(accept, file) {
  const tokens = String(accept || '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const name = String(file?.name || '').toLowerCase();
  const mime = String(file?.mime || '').toLowerCase().split(';')[0].trim();
  return tokens.some(token => {
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return Boolean(mime) && mime.startsWith(token.slice(0, -1));
    return Boolean(mime) && mime === token;
  });
}

/**
 * Check the `files` of a `browser.upload` before touching the page.
 * @param {unknown} files the call's `files`
 * @returns {{error: object}|{files: Array<{name: string, mime: string, size: number}>}} the
 *   files without their data (the data stays in the call's args)
 */
export function checkUploadFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > UPLOAD_MAX_FILES) {
    return { error: toolError('invalid_args', `files must hold 1 to ${UPLOAD_MAX_FILES} files`) };
  }
  let total = 0;
  const out = [];
  for (const [index, file] of files.entries()) {
    const fail = message => ({ error: toolError('invalid_args', `Fichier ${index + 1} : ${message}`) });
    if (!file || typeof file !== 'object' || Array.isArray(file)) return fail('a file must be an object');
    if (file.source === 'mac') {
      return { error: toolError('unsupported', 'Chrome cannot read the Mac’s folders: only Limova Desktop uploads a file from them. Use a chat attachment.') };
    }
    if (file.source !== 'inline') return fail('source must be inline');
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || /[\/\\]/.test(file.name)) return fail('name must be a file name of at most 200 characters');
    if (file.mime !== undefined && file.mime !== null && (typeof file.mime !== 'string' || file.mime.length > 120)) return fail('mime must be at most 120 characters');
    if (!Number.isInteger(file.size) || file.size < 0) return fail('size must be a number of bytes');
    const bytes = base64ByteLength(file.data);
    if (bytes < 0) return fail('data must be standard base64');
    if (bytes !== file.size) return fail('size does not match data');
    total += bytes;
    if (total > UPLOAD_MAX_INLINE_BYTES) return { error: toolError('too_large', 'At most 5 MiB of files per call.') };
    out.push({ name: file.name, mime: typeof file.mime === 'string' ? file.mime : '', size: bytes });
  }
  return { files: out };
}

const SECRET_FIELDS = ['username', 'password', 'otp'];
const SECRET_MASK = '••••••';

/**
 * Replace every occurrence of a secret in the strings of an answer (TEAM-729). A page
 * may echo what was typed (« show password », a badly made error message); the answer
 * goes to the model, so a secret must never ride along. Short strings are skipped: a
 * 3-character « secret » would mask ordinary words.
 */
export function scrubSecrets(value, secrets) {
  const list = secrets.filter(secret => typeof secret === 'string' && secret.length >= 4);
  if (!list.length) return value;
  const scrub = node => {
    if (typeof node === 'string') {
      let out = node;
      for (const secret of list) if (out.includes(secret)) out = out.split(secret).join(SECRET_MASK);
      return out;
    }
    if (Array.isArray(node)) return node.map(scrub);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(node)) out[key] = scrub(item);
      return out;
    }
    return node;
  };
  return scrub(value);
}

/**
 * @param {object} deps
 * @param {object} [deps.chromeApi] chrome.* (tabs, tabGroups, windows, scripting, storage)
 * @param {Function} deps.renderCapture background.js renderSilentVisualCapture
 */
export function createBrowserEngine({
  chromeApi = globalThis.chrome,
  renderCapture,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  random = Math.random
} = {}) {
  const groupIds = new Map();
  let groupsLoaded = null;
  // A random start, so snapshot ids from before a service-worker restart never collide.
  let snapshotCounter = 1000 + Math.floor(random() * 9000);

  function loadGroups() {
    if (!groupsLoaded) {
      groupsLoaded = Promise.resolve(chromeApi.storage?.session?.get(GROUPS_SESSION_KEY))
        .then(data => {
          const saved = data?.[GROUPS_SESSION_KEY];
          if (saved && typeof saved === 'object') {
            for (const [productId, groupId] of Object.entries(saved)) {
              if (Number.isInteger(groupId) && !groupIds.has(productId)) groupIds.set(productId, groupId);
            }
          }
        })
        .catch(() => {});
    }
    return groupsLoaded;
  }

  async function saveGroups() {
    await chromeApi.storage?.session?.set({ [GROUPS_SESSION_KEY]: Object.fromEntries(groupIds) }).catch?.(() => {});
  }

  // Run a page function in the top frame, or (TEAM-751) in one child frame's document.
  // `gone` says the frame's document no longer exists: the frame navigated or was
  // removed since the snapshot, so its ids are stale.
  async function execute(tabId, func, args, frame = null) {
    const target = !frame
      ? { tabId, frameIds: [0] }
      : frame.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [frame.frameId] };
    try {
      const results = await chromeApi.scripting.executeScript({ target, world: 'ISOLATED', func, args: [args] });
      const first = Array.isArray(results) ? results[0] : null;
      return { ok: true, result: first?.result ?? null, documentId: first?.documentId ?? null };
    } catch (error) {
      const message = String(error?.message || '');
      return { ok: false, message, gone: Boolean(frame) && /No document with id|No frame with id|Frame with ID/i.test(message) };
    }
  }

  // TEAM-751: every frame's own account of where it sits, then the frame tree.
  async function readFrameTree(tab) {
    const frames = await Promise.resolve(chromeApi.webNavigation?.getAllFrames?.({ tabId: tab.id })).catch(() => null);
    if (!Array.isArray(frames) || !frames.some(frame => frame?.frameId !== 0)) return [];
    let results;
    try {
      results = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'ISOLATED',
        func: probeFrame,
        args: [{ blockedHosts: blockedHostSuffixes() }]
      });
    } catch {
      return [];
    }
    const probes = new Map();
    for (const item of results || []) {
      if (Number.isInteger(item?.frameId) && item.result?.ok) probes.set(item.frameId, { ...item.result, documentId: item.documentId || null });
    }
    return buildFrameTree({ frames, probes, classify: url => classifyUrl(url), topOrigin: originOf(tab.url || '') || '' });
  }

  function forProduct(product) {
    const productKey = product.id;
    // tab id -> {id, frames} of the latest snapshot read by this product; `frames` maps
    // each frame id of that snapshot (`fr2`) to its Chrome frame and document (TEAM-751).
    const latestSnapshots = new Map();
    const knownSnapshot = tabId => latestSnapshots.get(tabId)?.id;

    // Inject once; if the page was still loading (the frame was being replaced),
    // wait for it to settle and try once more.
    async function executeWhenReady(tabId, func, args, signal) {
      const first = await execute(tabId, func, args);
      if (first.ok) return first;
      await waitForLoad(tabId, 5_000, signal);
      return execute(tabId, func, args);
    }

    async function currentGroupId() {
      await loadGroups();
      const groupId = groupIds.get(productKey);
      if (!Number.isInteger(groupId)) return null;
      try {
        await chromeApi.tabGroups.get(groupId);
        return groupId;
      } catch {
        groupIds.delete(productKey);
        await saveGroups();
        return null;
      }
    }

    // While « Montrer à Limova » records, the group says so (TEAM-731).
    let recordingTitle = null;

    async function setGroupTitle(busy) {
      const groupId = await currentGroupId();
      if (groupId === null) return;
      await chromeApi.tabGroups.update(groupId, {
        title: recordingTitle || (busy ? product.groupBusyTitle : product.groupTitle),
        color: product.groupColor
      }).catch(() => {});
    }

    async function setRecordingTitle(title) {
      recordingTitle = title || null;
      await setGroupTitle(false);
    }

    async function addToGroup(tabId, busy = false) {
      const groupId = await currentGroupId();
      if (groupId !== null) {
        await chromeApi.tabs.group({ groupId, tabIds: [tabId] });
        return groupId;
      }
      const tab = await chromeApi.tabs.get(tabId);
      const created = await chromeApi.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      groupIds.set(productKey, created);
      await saveGroups();
      await chromeApi.tabGroups.update(created, {
        title: busy ? product.groupBusyTitle : product.groupTitle,
        color: product.groupColor,
        collapsed: false
      }).catch(() => {});
      return created;
    }

    function toTab(tab) {
      const url = tab?.url || tab?.pendingUrl || '';
      return {
        tab_id: tab.id,
        url: safeUrl(url),
        domain: domainOf(url),
        title: String(tab.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        favicon_url: safeFavicon(tab.favIconUrl),
        active: Boolean(tab.active),
        loading: tab.status === 'loading'
      };
    }

    // The tab, if it exists and is in this product's group.
    async function groupTab(tabId) {
      if (!isTabId(tabId)) return { error: toolError('invalid_args', 'tab_id must be a tab number') };
      let tab;
      try {
        tab = await chromeApi.tabs.get(tabId);
      } catch {
        return { error: toolError('tab_not_found', 'This tab was closed.') };
      }
      const groupId = await currentGroupId();
      if (groupId === null || tab.groupId !== groupId) {
        return { error: toolError('not_in_group', `This tab is not in the ${product.groupTitle} tab group.`) };
      }
      return { tab };
    }

    function pageError(tab) {
      const verdict = classifyUrl(tab.url || tab.pendingUrl || '');
      if (verdict.ok) return null;
      return toolError(verdict.code, verdict.code === 'blocked_site'
        ? 'Limova does not act on this site.'
        : 'Chrome does not let extensions read this page.');
    }

    function settled(tab) {
      // A new tab first reports `about:blank` as complete; wait for the real page.
      return Boolean(tab && tab.status !== 'loading' && !tab.pendingUrl && tab.url && tab.url !== 'about:blank');
    }

    // Wait for the tab to finish loading: woken by the tab's own onUpdated events,
    // with a slow poll as a fallback, capped at maxMs.
    async function waitForLoad(tabId, maxMs, signal) {
      const started = now();
      let wake = null;
      const listener = id => { if (id === tabId && wake) wake(); };
      chromeApi.tabs.onUpdated?.addListener?.(listener);
      try {
        let tab = null;
        while (now() - started < maxMs) {
          if (isCancelled(signal)) return tab;
          try {
            tab = await chromeApi.tabs.get(tabId);
          } catch {
            return null;
          }
          if (settled(tab)) return tab;
          await Promise.race([new Promise(resolve => { wake = resolve; }), sleep(LOAD_POLL_FALLBACK_MS)]);
          wake = null;
        }
        return tab;
      } finally {
        chromeApi.tabs.onUpdated?.removeListener?.(listener);
      }
    }

    async function targetWindowId() {
      const groupId = await currentGroupId();
      if (groupId !== null) {
        const group = await chromeApi.tabGroups.get(groupId).catch(() => null);
        if (group?.windowId) return group.windowId;
      }
      const window = await chromeApi.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      return window?.id ?? undefined;
    }

    // ---------------------------------------------------------------- read tools

    async function listTabs() {
      const groupId = await currentGroupId();
      const all = await chromeApi.tabs.query({});
      const inGroup = groupId === null ? [] : all.filter(tab => tab.groupId === groupId);
      return ok({
        group: { title: product.groupTitle, color: product.groupColor },
        tabs: inGroup.map(toTab),
        other_tabs: all.length - inGroup.length
      });
    }

    async function openTab(args, { signal, busy } = {}) {
      if (typeof args.url !== 'string') return toolError('invalid_args', 'url is required');
      if (args.active !== undefined && typeof args.active !== 'boolean') return toolError('invalid_args', 'active must be a boolean');
      const verdict = classifyUrl(args.url, { fromAgent: true });
      if (!verdict.ok) return toolError(verdict.code, verdict.code === 'invalid_args' ? 'Only http(s) URLs can be opened.' : 'Limova does not open this site.');
      const windowId = await targetWindowId();
      const created = await chromeApi.tabs.create({
        url: verdict.url.href,
        active: args.active === true,
        ...(windowId !== undefined ? { windowId } : {})
      });
      await addToGroup(created.id, busy);
      const loaded = await waitForLoad(created.id, OPEN_TAB_WAIT_MS, signal);
      return ok({ tab: toTab(loaded || created) });
    }

    async function closeTab(args) {
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return error;
      await chromeApi.tabs.remove(tab.id).catch(() => {});
      latestSnapshots.delete(tab.id);
      return ok({ closed: true });
    }

    async function readPage(args, { signal } = {}) {
      const maxText = boundedInt(args.max_text_chars, TEXT_LIMITS);
      const maxElements = boundedInt(args.max_elements, ELEMENT_LIMITS);
      if (maxText === null) return toolError('invalid_args', 'max_text_chars must be 500 to 20000');
      if (maxElements === null) return toolError('invalid_args', 'max_elements must be 1 to 400');
      const checked = await groupTab(args.tab_id);
      if (checked.error) return checked.error;
      // Never map the outgoing document of a page that is still loading.
      const tab = checked.tab.status === 'loading'
        ? (await waitForLoad(checked.tab.id, NAVIGATION_SETTLE_MAX_MS, signal)) || checked.tab
        : checked.tab;
      const unavailable = pageError(tab);
      if (unavailable) return unavailable;
      const snapshotId = `s${snapshotCounter += 1}`;
      const run = await executeWhenReady(tab.id, pageSnapshot, { productKey, snapshotId, maxText, maxElements });
      if (!run.ok || !run.result) return toolError('page_unavailable', 'Chrome cannot read this page.');
      if (!run.result.ok) return toolError(run.result.code || 'page_unavailable', 'Chrome cannot read this page.');
      const raw = run.result;
      const elements = publicElements(raw, null);
      const forms = publicForms(raw, null);
      let text = String(raw.text || '');
      let textTruncated = Boolean(raw.text_truncated);
      let elementsTruncated = Boolean(raw.elements_truncated);
      const suspicious = (raw.suspicious || []).slice(0, 5).map(item => ({ kind: 'hidden_instructions', text: String(item.text || '').slice(0, 300) }));

      // TEAM-751: child frames, top first for the element and text budgets.
      const tree = await readFrameTree(tab);
      for (const entry of tree) {
        if (!entry.readable) continue;
        if (isCancelled(signal)) {
          entry.readable = false;
          entry.reason = 'page_unavailable';
          continue;
        }
        const header = frameTextHeader(entry);
        const textLeft = Math.max(0, maxText - text.length - header.length - 2);
        const frameRun = await execute(tab.id, pageSnapshot, {
          productKey, snapshotId, maxText: textLeft, maxElements: Math.max(0, maxElements - elements.length), frame: true
        }, entry);
        if (!frameRun.ok || !frameRun.result?.ok) {
          entry.readable = false;
          entry.reason = 'page_unavailable';
          continue;
        }
        const part = frameRun.result;
        const frameElements = publicElements(part, entry);
        entry.elements = frameElements.length;
        elements.push(...frameElements);
        forms.push(...publicForms(part, entry));
        if (part.elements_truncated) elementsTruncated = true;
        if (part.text_truncated) textTruncated = true;
        if (part.text) text += `\n${header}\n${part.text}`;
        for (const item of (part.suspicious || []).slice(0, 5)) {
          if (suspicious.length >= 10) break;
          suspicious.push({ kind: 'hidden_instructions', text: String(item.text || '').slice(0, 300), frame: entry.id });
        }
      }
      latestSnapshots.set(tab.id, {
        id: snapshotId,
        frames: new Map(tree.map(entry => [entry.id, {
          id: entry.id, frameId: entry.frameId, documentId: entry.documentId, origin: entry.origin,
          readable: entry.readable, reason: entry.reason || null
        }]))
      });
      const fresh = await chromeApi.tabs.get(tab.id).catch(() => tab);
      return ok({
        tab: toTab(fresh),
        snapshot_id: snapshotId,
        elements,
        forms,
        frames: publicFrames(tree),
        text: text.slice(0, maxText),
        text_truncated: textTruncated || text.length > maxText,
        elements_truncated: elementsTruncated,
        suspicious
      });
    }

    // Whitelist: only these fields of a frame's elements leave the browser. A child
    // frame's ids, forms and elements carry its prefix (`fr2.e3`, TEAM-751).
    function publicElements(raw, frame) {
      const prefix = frame ? `${frame.id}.` : '';
      const formsById = new Map((raw.forms || []).map(form => [form.id, form]));
      return (raw.elements || []).map(item => {
        const entry = { id: `${prefix}${item.id}`, role: item.role, tag: item.tag };
        if (item.type) entry.type = item.type;
        entry.name = item.name;
        if (item.state) entry.state = item.state;
        if (typeof item.checked === 'boolean') entry.checked = item.checked;
        if (item.selected !== undefined && item.state !== 'sensitive') entry.selected = item.selected;
        if (Array.isArray(item.options) && item.state !== 'sensitive') entry.options = item.options;
        // browser.v2+upload: what a file field takes and how many files it holds.
        if (item.type === 'file') {
          entry.accept = typeof item.accept === 'string' ? item.accept.slice(0, 200) : '';
          entry.multiple = item.multiple === true;
          entry.files = Number.isInteger(item.files) ? item.files : 0;
        }
        if (item.form) entry.form = `${prefix}${item.form}`;
        if (item.href) entry.href = item.href;
        entry.in_viewport = Boolean(item.in_viewport) && (!frame || frame.in_viewport);
        if (item.disabled) entry.disabled = true;
        if (frame) entry.frame = frame.id;
        // browser.record.v1 (TEAM-731): the same descriptor fields a recording's target
        // carries, so replays compare like with like. Never a value.
        Object.assign(entry, descriptorFieldsOf(item));
        const hint = riskHint({ name: item.name, role: item.role, submits: item.submits, form: formsById.get(item.form) });
        if (hint) entry.risk_hint = hint;
        return entry;
      });
    }

    function publicForms(raw, frame) {
      const prefix = frame ? `${frame.id}.` : '';
      return (raw.forms || []).map(form => ({
        id: `${prefix}${form.id}`,
        method: form.method,
        action_origin: form.action_origin,
        external: Boolean(form.external)
      }));
    }

    // The frame an element id names in the latest snapshot of this tab, checked live:
    // still there, still the same document, not on a blocked site (TEAM-751).
    async function resolveFrame(tab, snapshotId, frameRef) {
      if (!frameRef) return { frame: null };
      const known = latestSnapshots.get(tab.id);
      if (!known || known.id !== snapshotId) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };
      const entry = known.frames.get(frameRef);
      if (!entry) return { error: toolError('element_not_found', `No frame ${frameRef} in this snapshot.`) };
      if (!entry.readable) {
        return { error: entry.reason === 'blocked_site'
          ? toolError('blocked_site', 'Limova does not act in this frame’s site.')
          : toolError('element_not_found', `Frame ${frameRef} was not read.`) };
      }
      if (typeof chromeApi.webNavigation?.getFrame === 'function') {
        const live = await Promise.resolve(chromeApi.webNavigation.getFrame({ tabId: tab.id, frameId: entry.frameId })).catch(() => null);
        if (!live || (live.documentId && entry.documentId && live.documentId !== entry.documentId)) {
          return { error: toolError('stale_snapshot', 'This frame changed since the read. Read the page again.') };
        }
        if (classifyUrl(live.url || '').code === 'blocked_site') return { error: toolError('blocked_site', 'Limova does not act in this frame’s site.') };
      }
      return { frame: entry };
    }

    // Live facts about one element of the snapshot, in whatever frame it is.
    async function inspectElement(tab, snapshotId, elementId, { upload = false } = {}) {
      const parsed = parseElementId(elementId);
      if (!parsed) return { error: toolError('invalid_args', ELEMENT_ID_HELP) };
      const located = await resolveFrame(tab, snapshotId, parsed.frame);
      if (located.error) return located;
      const options = { productKey, snapshotId, elementId: parsed.local, upload };
      const run = located.frame
        ? await execute(tab.id, inspectPageElement, options, located.frame)
        : await executeWhenReady(tab.id, inspectPageElement, options);
      if (run.gone) return { error: toolError('stale_snapshot', 'This frame changed since the read. Read the page again.') };
      if (!run.ok || !run.result) return { error: toolError('page_unavailable', 'Chrome cannot read this page.') };
      if (!run.result.ok) {
        return { error: toolError(run.result.code, run.result.code === 'stale_snapshot' ? 'Read the page again.' : 'The element is gone, hidden or disabled.') };
      }
      const element = { ...run.result.element, page: run.result.page };
      if (located.frame) {
        // Risk reads the tab's page (a checkout page) and the frame's own page alike.
        element.frame_page = run.result.page;
        const top = parseTopPage(tab);
        if (top) element.page = top;
      }
      return { element, frame: located.frame, local: parsed.local };
    }

    function parseTopPage(tab) {
      try {
        const url = new URL(tab.url || '');
        return { origin: url.origin, path: url.pathname, title: String(tab.title || '').slice(0, 300) };
      } catch {
        return null;
      }
    }

    // The extension's reading of an action, on the tab's page and on the frame's.
    function localReading(read, element) {
      const readings = [read(element)];
      if (element?.frame_page) readings.push(read({ ...element, page: element.frame_page }));
      return strictestOf(readings);
    }

    async function screenshot(args) {
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return error;
      const unavailable = pageError(tab);
      if (unavailable) return unavailable;
      if (typeof renderCapture !== 'function') return toolError('unsupported', 'Screenshots are not available.');
      // captureVisibleTab only captures the visible tab of a window: bring it to the front.
      await chromeApi.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await chromeApi.tabs.update(tab.id, { active: true }).catch(() => {});
      // One frame for the window to come to the front before the capture.
      await sleep(150);
      const prep = await executeWhenReady(tab.id, preparePageCapture, { productKey });
      if (!prep.ok || !prep.result?.ok) return toolError('page_unavailable', 'Chrome cannot capture this page.');
      await addFrameGeometry(tab, prep.result);
      let capture = null;
      for (const quality of [55, 35]) {
        let dataUrl;
        try {
          dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality });
        } catch {
          return toolError('page_unavailable', 'Chrome cannot capture this page.');
        }
        capture = await renderCapture(dataUrl, prep.result).catch(() => null);
        dataUrl = null;
        if (capture?.data && capture.data.length <= SCREENSHOT_MAX_BASE64) break;
      }
      if (!capture?.data || capture.mimeType !== 'image/jpeg') return toolError('internal', 'The capture could not be prepared.');
      if (capture.data.length > SCREENSHOT_MAX_BASE64) return toolError('too_large', 'The capture is too large.');
      const fresh = await chromeApi.tabs.get(tab.id).catch(() => tab);
      return ok({ tab: toTab(fresh), image: { mime: 'image/jpeg', data: capture.data }, masked: Number(prep.result.maskedCount) || 0 });
    }

    // TEAM-751: the fields inside child frames are masked too, where the frame's place in
    // the tab is known (best effort: a frame Chrome does not let the extension script
    // keeps what it shows). Labels use the latest snapshot's frame ids (`#fr1.e3`).
    async function addFrameGeometry(tab, capture) {
      const tree = await readFrameTree(tab);
      if (!tree.length) return;
      const known = latestSnapshots.get(tab.id);
      const labelOf = new Map([...(known?.frames?.values() || [])].filter(entry => entry.documentId).map(entry => [entry.documentId, entry.id]));
      for (const entry of tree) {
        if (!entry.readable || !entry.offset || !entry.clip) continue;
        if (capture.masks.length >= 120) break;
        const label = labelOf.get(entry.documentId);
        const run = await execute(tab.id, preparePageCapture, { productKey, labelPrefix: label ? `${label}.` : '' }, entry);
        if (!run.ok || !run.result?.ok) continue;
        const place = box => {
          const left = Math.max(entry.clip.left, entry.offset.left + box.left);
          const top = Math.max(entry.clip.top, entry.offset.top + box.top);
          const right = Math.min(entry.clip.right, entry.offset.left + box.left + (box.width || 0));
          const bottom = Math.min(entry.clip.bottom, entry.offset.top + box.top + (box.height || 0));
          return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
        };
        for (const mask of run.result.masks || []) {
          const placed = place(mask);
          if (placed && capture.masks.length < 120) capture.masks.push(placed);
        }
        if (label) {
          for (const marker of run.result.markers || []) {
            const left = entry.offset.left + marker.left;
            const top = entry.offset.top + marker.top;
            if (left < entry.clip.left || top < entry.clip.top - 14 || left > entry.clip.right || top > entry.clip.bottom) continue;
            if (capture.markers.length < 80) capture.markers.push({ ...marker, left, top });
          }
        }
      }
      capture.maskedCount = capture.masks.length;
      capture.markerCount = capture.markers.length;
    }

    // ---------------------------------------------------------------- verification

    function watchNewTabs(openerTabId) {
      const opened = [];
      const listener = tab => {
        if (tab?.openerTabId === openerTabId) opened.push(tab);
      };
      chromeApi.tabs.onCreated?.addListener(listener);
      return {
        opened,
        stop: () => chromeApi.tabs.onCreated?.removeListener(listener)
      };
    }

    // What the frames an action touched say now (TEAM-751: one action may run in a child
    // frame, a batch in several). A frame whose document went away navigated.
    async function collectFrom(tabId, targets, finish) {
      const infos = [];
      for (const target of targets) {
        const run = await execute(tabId, collectPageVerification, { productKey, elementId: finish ? null : target.elementId, finish }, target.frame);
        if (run.ok && run.result) infos.push(run.result);
        else if (target.frame) infos.push({ same_document: false, mutations: 0, structural: 0, quiet_ms: null, messages: [], field_state: null });
        else return null;
      }
      if (infos.length === 1) return infos[0];
      const messages = [];
      for (const info of infos) for (const text of info.messages || []) if (!messages.includes(text)) messages.push(text);
      const quiet = infos.map(info => info.quiet_ms).filter(Number.isFinite);
      return {
        same_document: infos.every(info => info.same_document),
        mutations: infos.reduce((sum, info) => sum + (info.mutations || 0), 0),
        structural: infos.reduce((sum, info) => sum + (info.structural || 0), 0),
        quiet_ms: quiet.length ? Math.min(...quiet) : null,
        messages: messages.slice(0, 5),
        field_state: infos.find(info => info.field_state !== null && info.field_state !== undefined)?.field_state ?? null
      };
    }

    function sameFrame(a, b) {
      return (a?.documentId || a?.frameId || null) === (b?.documentId || b?.frameId || null);
    }

    async function verify(tabId, before, { elementId = null, targets = null, signal, newTabs, busy } = {}) {
      const watched = Array.isArray(targets) && targets.length ? targets : [{ frame: null, elementId }];
      const started = now();
      await sleep(VERIFY_FIRST_CHECK_MS);
      let tab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (tab?.status === 'loading') tab = await waitForLoad(tabId, NAVIGATION_SETTLE_MAX_MS, signal);
      let info = null;
      while (tab && !isCancelled(signal)) {
        info = await collectFrom(tabId, watched, false);
        const elapsed = now() - started;
        if (!info || !info.same_document || elapsed >= VERIFY_MAX_MS) break;
        if (elapsed >= VERIFY_MIN_MS && (info.quiet_ms ?? 0) >= VERIFY_QUIET_MS) break;
        await sleep(VERIFY_POLL_MS);
        tab = await chromeApi.tabs.get(tabId).catch(() => null);
        if (tab?.status === 'loading') tab = await waitForLoad(tabId, NAVIGATION_SETTLE_MAX_MS, signal);
      }
      if (tab) await collectFrom(tabId, watched, true);
      let newTab = null;
      if (newTabs?.opened.length) {
        const opened = newTabs.opened[0];
        await addToGroup(opened.id, busy).catch(() => {});
        const fresh = await chromeApi.tabs.get(opened.id).catch(() => opened);
        newTab = toTab(fresh);
      }
      const urlChanged = Boolean(tab && before.url !== (tab.url || ''));
      const newDocument = Boolean(info && !info.same_document);
      const domChanged = urlChanged || newDocument || Boolean(info?.mutations);
      return {
        tab: tab ? toTab(tab) : null,
        verification: {
          url_changed: urlChanged,
          title: tab ? String(tab.title || '').slice(0, 300) : null,
          dom_changed: domChanged,
          messages: Array.isArray(info?.messages) ? info.messages.slice(0, 5) : [],
          field_state: watched.some(target => target.elementId) && info?.same_document ? info.field_state ?? null : null,
          new_tab: newTab
        },
        snapshot_stale: urlChanged || newDocument || Boolean(info?.structural)
      };
    }

    // `include_page: true` (TEAM-726): validated before acting, read after settling.
    function pageOptions(args) {
      if (args.include_page === undefined || args.include_page === false) return { include: false };
      if (args.include_page !== true) return { error: toolError('invalid_args', 'include_page must be a boolean') };
      const maxText = boundedInt(args.max_text_chars, INCLUDED_TEXT_LIMITS);
      const maxElements = boundedInt(args.max_elements, ELEMENT_LIMITS);
      if (maxText === null) return { error: toolError('invalid_args', 'max_text_chars must be 500 to 20000') };
      if (maxElements === null) return { error: toolError('invalid_args', 'max_elements must be 1 to 400') };
      return { include: true, maxText, maxElements };
    }

    // `data.page` is exactly read_page's data; its snapshot replaces the previous one.
    async function attachPage(result, tabId, page, signal) {
      if (!page?.include || !result?.ok || !isTabId(tabId)) return result;
      const read = await readPage({ tab_id: tabId, max_text_chars: page.maxText, max_elements: page.maxElements }, { signal });
      if (read.ok) result.data.page = read.data;
      else result.data.page_error = read.error.code;
      return result;
    }

    async function withPage(args, run, tabIdOf, signal) {
      const page = pageOptions(args);
      if (page.error) return page.error;
      const result = await run();
      return attachPage(result, tabIdOf(result), page, signal);
    }

    async function navigate(args, { signal, busy } = {}) {
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return error;
      const hasUrl = args.url !== undefined;
      const hasAction = args.action !== undefined;
      if (hasUrl === hasAction) return toolError('invalid_args', 'Give either url or action.');
      let target = null;
      if (hasUrl) {
        const verdict = classifyUrl(args.url, { fromAgent: true });
        if (!verdict.ok) return toolError(verdict.code, verdict.code === 'invalid_args' ? 'Only http(s) URLs can be opened.' : 'Limova does not open this site.');
        target = verdict.url.href;
      } else if (!['back', 'forward', 'reload'].includes(args.action)) {
        return toolError('invalid_args', 'action must be back, forward or reload');
      }
      if (!hasUrl) {
        const unavailable = pageError(tab);
        if (unavailable?.error.code === 'blocked_site') return unavailable;
      }
      const before = { url: tab.url || '' };
      const newTabs = watchNewTabs(tab.id);
      let done = true;
      try {
        if (target) await chromeApi.tabs.update(tab.id, { url: target });
        else if (args.action === 'back') await chromeApi.tabs.goBack(tab.id);
        else if (args.action === 'forward') await chromeApi.tabs.goForward(tab.id);
        else await chromeApi.tabs.reload(tab.id);
      } catch {
        // No page to go back or forward to.
        done = false;
      }
      latestSnapshots.delete(tab.id);
      const outcome = await verify(tab.id, before, { signal, newTabs, busy });
      newTabs.stop();
      return ok({
        tab: outcome.tab || toTab(tab),
        done,
        verification: outcome.verification,
        snapshot_stale: true
      });
    }

    async function scroll(args, { signal, busy } = {}) {
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return error;
      if (!['down', 'up', 'top', 'bottom'].includes(args.direction)) return toolError('invalid_args', 'direction must be down, up, top or bottom');
      const usesElement = args.element_id !== undefined || args.snapshot_id !== undefined;
      if (usesElement && (typeof args.element_id !== 'string' || typeof args.snapshot_id !== 'string')) {
        return toolError('invalid_args', 'element_id needs its snapshot_id');
      }
      const unavailable = pageError(tab);
      if (unavailable) return unavailable;
      let frame = null;
      let elementId = null;
      if (usesElement) {
        const known = knownSnapshot(tab.id);
        if (known && known !== args.snapshot_id) return toolError('stale_snapshot', 'Read the page again.');
        const parsed = parseElementId(args.element_id);
        if (!parsed) return toolError('invalid_args', ELEMENT_ID_HELP);
        // An element of a child frame scrolls inside that frame (TEAM-751).
        const located = await resolveFrame(tab, args.snapshot_id, parsed.frame);
        if (located.error) return located.error;
        frame = located.frame;
        elementId = parsed.local;
      }
      const run = await execute(tab.id, scrollPage, {
        productKey, direction: args.direction,
        snapshotId: usesElement ? args.snapshot_id : null,
        elementId
      }, frame);
      if (run.gone) return toolError('stale_snapshot', 'This frame changed since the read. Read the page again.');
      if (!run.ok || !run.result) return toolError('page_unavailable', 'Chrome cannot scroll this page.');
      if (!run.result.ok) return toolError(run.result.code, run.result.code);
      const outcome = await verify(tab.id, { url: tab.url || '' }, { targets: [{ frame, elementId: null }], signal, busy });
      return ok({
        tab: outcome.tab || toTab(tab),
        done: true,
        verification: { ...outcome.verification, scroll: { moved: run.result.moved, at_top: run.result.at_top, at_bottom: run.result.at_bottom } },
        snapshot_stale: true
      });
    }

    // ---------------------------------------------------------------- actions

    const ACTIONS = {
      'browser.click': 'click',
      'browser.fill': 'fill',
      'browser.select': 'select',
      'browser.submit': 'submit',
      'browser.download': 'download'
    };

    function targetError(element) {
      return toolError('stale_snapshot', `This id now names « ${String(element.name).slice(0, 60)} », not the target. Read the page again.`);
    }

    function keyArgsError(source, { needElement }) {
      if (!PRESS_KEYS.includes(source.key)) return `key must be one of ${PRESS_KEYS.join(', ')}`;
      if (source.shift !== undefined && typeof source.shift !== 'boolean') return 'shift must be true or false';
      const named = source.element_id !== undefined && source.element_id !== null;
      if (!named && ACTIVATING_KEYS.includes(source.key)) return `${source.key} activates an element: give its element_id and target`;
      if (named || needElement) {
        if (!parseElementId(source.element_id)) return ELEMENT_ID_HELP;
        if (typeof source.target !== 'string' || !source.target.trim() || source.target.length > 300) return 'target must name the element';
      }
      return null;
    }

    // A key that edits a field never runs in a password, card or code field.
    function keyRefusal(key, element) {
      if (['Backspace', 'Delete', 'Space'].includes(key) && element?.sensitive) {
        return toolError('sensitive_field', 'Limova never types in password, card or code fields. Ask the person to take over.');
      }
      if (key === 'Enter' && element?.href && classifyUrl(element.href, { fromAgent: true }).code === 'blocked_site') {
        return toolError('blocked_site', 'This link leads to a site Limova does not act on.');
      }
      if (key === 'Enter' && element?.form?.action_origin && (element.submits || (element.editable && !element.multiline))
        && classifyUrl(element.form.action_origin, { fromAgent: true }).code === 'blocked_site') {
        return toolError('blocked_site', 'This form sends to a site Limova does not act on.');
      }
      return null;
    }

    // The tab is still in the group and on the page the plan was made on.
    async function liveTab(plan) {
      const tab = await chromeApi.tabs.get(plan.tab.id).catch(() => null);
      if (!tab) return { error: toolError('tab_not_found', 'This tab was closed.') };
      const groupId = await currentGroupId();
      if (groupId === null || tab.groupId !== groupId) return { error: toolError('not_in_group', 'This tab left the group.') };
      if (safeUrl(tab.url) !== safeUrl(plan.tab.url)) return { error: toolError('stale_snapshot', 'The page changed. Read it again.') };
      return { tab };
    }

    // The frame that has the focus now, for a key without an element (TEAM-751): each
    // frame says whether its focused element is a child frame, from the top down.
    async function focusedFrame(tab) {
      const frames = await Promise.resolve(chromeApi.webNavigation?.getAllFrames?.({ tabId: tab.id })).catch(() => null);
      if (!Array.isArray(frames) || !frames.some(frame => frame?.frameId !== 0)) return { frame: null };
      let results;
      try {
        results = await chromeApi.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true }, world: 'ISOLATED', func: probeFocus, args: [{ blockedHosts: blockedHostSuffixes() }]
        });
      } catch {
        return { frame: null };
      }
      const byPath = new Map();
      for (const item of results || []) {
        if (Array.isArray(item?.result?.path)) byPath.set(item.result.path.join('.'), item);
      }
      let current = byPath.get('');
      let frame = null;
      for (let depth = 0; current && Number.isInteger(current.result.child) && depth < 6; depth += 1) {
        const path = [...current.result.path, current.result.child];
        const next = byPath.get(path.join('.'));
        if (!next) return { error: toolError('page_unavailable', 'The focus is in a frame Chrome does not let Limova reach.') };
        if (next.result.blocked) return { error: toolError('blocked_site', 'The focus is in a frame of a site Limova does not act on.') };
        frame = { frameId: next.frameId, documentId: next.documentId || null };
        current = next;
      }
      return { frame };
    }

    // A page function that ran while its frame went away did run: it navigated.
    function navigatedDuring(run) {
      return !run.ok && !run.gone && /removed|navigat|closed|unloaded|No frame/i.test(run.message);
    }

    /**
     * Check an action and read its live element. Returns {error} or {plan}.
     * plan.element holds the facts risk.classifyAction needs (never a value).
     */
    async function prepareAction(tool, args) {
      if (tool === 'browser.batch') return prepareBatch(args);
      if (tool === 'browser.press_key') return prepareKey(args);
      if (tool === 'browser.upload') return prepareUpload(args);
      const page = pageOptions(args);
      if (page.error) return { error: page.error };
      const action = ACTIONS[tool];
      if (!action) return { error: toolError('unsupported', `Unknown tool ${tool}`) };
      if (typeof args.snapshot_id !== 'string' || !args.snapshot_id) return { error: toolError('invalid_args', 'snapshot_id is required') };
      if (!parseElementId(args.element_id)) return { error: toolError('invalid_args', ELEMENT_ID_HELP) };
      if (typeof args.target !== 'string' || !args.target.trim() || args.target.length > 300) return { error: toolError('invalid_args', 'target must name the element') };
      if (action === 'fill') {
        if (typeof args.value !== 'string') return { error: toolError('invalid_args', 'value must be text') };
        if (args.value.length > 5000) return { error: toolError('too_large', 'value is limited to 5000 characters') };
      }
      if (action === 'select' && (typeof args.option !== 'string' || !args.option.trim())) {
        return { error: toolError('invalid_args', 'option must name the choice') };
      }
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return { error };
      const unavailable = pageError(tab);
      if (unavailable) return { error: unavailable };
      const known = knownSnapshot(tab.id);
      if (known && known !== args.snapshot_id) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };
      const inspected = await inspectElement(tab, args.snapshot_id, args.element_id);
      if (inspected.error) return { error: inspected.error };
      const { element } = inspected;
      if (!targetMatches(args.target, element.name)) return { error: targetError(element) };
      // A file field takes files, not clicks: a click would only try to open the file dialog.
      if (element.is_file) return { error: toolError('invalid_args', 'This is a file field: use browser.upload.') };
      if (action === 'fill') {
        if (element.sensitive) return { error: toolError('sensitive_field', 'Limova never types passwords, card numbers or codes. Ask the person to take over.') };
        if (!element.editable) return { error: toolError('invalid_args', 'This element is not a text field.') };
      }
      if (action === 'select' && !element.is_select) return { error: toolError('invalid_args', 'This element is not a list of choices; use a click.') };
      if (action === 'submit' && !element.in_form && !element.is_form) return { error: toolError('invalid_args', 'This element is not in a form.') };
      // A download is a click on a link or button the page offers; no `downloads` permission.
      if (action === 'download' && !['link', 'button', 'menuitem'].includes(element.role)) {
        return { error: toolError('invalid_args', 'Only a link or a button can start a download.') };
      }
      if (element.href) {
        const verdict = classifyUrl(element.href, { fromAgent: true });
        if (!verdict.ok && verdict.code === 'blocked_site') return { error: toolError('blocked_site', 'This link leads to a site Limova does not act on.') };
      }
      if (element.form?.action_origin && (action === 'submit' || element.submits)) {
        const verdict = classifyUrl(element.form.action_origin, { fromAgent: true });
        if (!verdict.ok && verdict.code === 'blocked_site') return { error: toolError('blocked_site', 'This form sends to a site Limova does not act on.') };
      }
      return {
        plan: {
          tool, action, tab, args, element, page,
          frame: inspected.frame,
          local: localReading(item => classifyAction(tool, item), element),
          domain: domainOf(tab.url || ''),
          snapshotId: args.snapshot_id,
          elementId: inspected.local
        }
      };
    }

    async function executeAction(plan, options = {}) {
      if (plan.kind === 'batch') return executeBatch(plan, options);
      if (plan.kind === 'key') return executeKey(plan, options);
      if (plan.kind === 'upload') return executeUpload(plan, options);
      const { signal, busy } = options;
      if (isCancelled(signal)) return toolError('paused', 'Stopped.');
      const live = await liveTab(plan);
      if (live.error) return live.error;
      const { tab } = live;
      const newTabs = watchNewTabs(tab.id);
      const before = { url: tab.url || '' };
      const run = await execute(tab.id, performPageAction, {
        productKey,
        snapshotId: plan.snapshotId,
        elementId: plan.elementId,
        action: plan.action,
        value: plan.action === 'fill' ? plan.args.value : undefined,
        option: plan.action === 'select' ? plan.args.option : undefined,
        expectName: plan.element.name
      }, plan.frame);
      if (run.gone) {
        newTabs.stop();
        return toolError('stale_snapshot', 'This frame changed since the read. Read the page again.');
      }
      if (!run.ok) {
        // The frame went away while the action ran: it navigated, so it did run.
        if (!navigatedDuring(run)) {
          newTabs.stop();
          return toolError('page_unavailable', 'Chrome cannot act on this page.');
        }
      } else if (!run.result?.ok) {
        newTabs.stop();
        const code = run.result?.code || 'internal';
        return toolError(code, run.result?.message || code);
      }
      const outcome = await verify(tab.id, before, {
        targets: [{ frame: plan.frame, elementId: plan.action === 'fill' || plan.action === 'select' ? plan.elementId : null }],
        signal, newTabs, busy
      });
      newTabs.stop();
      if (outcome.verification.url_changed) latestSnapshots.delete(tab.id);
      const verification = outcome.verification;
      if (plan.action === 'fill' && verification.field_state === null && run.result?.field_state) {
        verification.field_state = run.result.field_state;
      }
      return attachPage(ok({
        tab: outcome.tab || toTab(tab),
        done: true,
        verification,
        snapshot_stale: outcome.snapshot_stale
      }), tab.id, plan.page, signal);
    }

    // ---------------------------------------------------------------- keys (TEAM-751)

    async function prepareKey(args) {
      const page = pageOptions(args);
      if (page.error) return { error: page.error };
      const problem = keyArgsError(args, { needElement: false });
      if (problem) return { error: toolError('invalid_args', problem) };
      const named = args.element_id !== undefined && args.element_id !== null;
      if (named && (typeof args.snapshot_id !== 'string' || !args.snapshot_id)) return { error: toolError('invalid_args', 'snapshot_id is required with element_id') };
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return { error };
      const unavailable = pageError(tab);
      if (unavailable) return { error: unavailable };
      let inspected = { element: null, frame: null, local: null };
      if (named) {
        const known = knownSnapshot(tab.id);
        if (known && known !== args.snapshot_id) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };
        inspected = await inspectElement(tab, args.snapshot_id, args.element_id);
        if (inspected.error) return { error: inspected.error };
        if (!targetMatches(args.target, inspected.element.name)) return { error: targetError(inspected.element) };
        const refusal = keyRefusal(args.key, inspected.element);
        if (refusal) return { error: refusal };
      }
      const element = inspected.element;
      return {
        plan: {
          kind: 'key', tool: 'browser.press_key', action: 'key', tab, args, page, element,
          frame: inspected.frame,
          key: args.key,
          shift: args.shift === true,
          local: element ? localReading(item => classifyKey(args.key, item), element) : { risk: 'write', reason: null },
          domain: domainOf(tab.url || ''),
          snapshotId: named ? args.snapshot_id : null,
          elementId: inspected.local
        }
      };
    }

    // Run one key in its frame: on the named element, or on the focused one.
    async function runKey(tab, { key, shift, frame, elementId, snapshotId, expectName, keepWatch = false }) {
      let target = frame;
      if (!elementId) {
        const focus = await focusedFrame(tab);
        if (focus.error) return { error: focus.error };
        target = focus.frame;
        // The focused frame may never have been read: install the page kit there first.
        await execute(tab.id, pageSnapshot, { installOnly: true }, target);
      }
      const run = await execute(tab.id, performPageAction, {
        productKey, snapshotId, elementId, action: 'key', key, shift, expectName, keepWatch
      }, target);
      return { run, frame: target };
    }

    async function executeKey(plan, { signal, busy } = {}) {
      if (isCancelled(signal)) return toolError('paused', 'Stopped.');
      const live = await liveTab(plan);
      if (live.error) return live.error;
      const { tab } = live;
      const newTabs = watchNewTabs(tab.id);
      const before = { url: tab.url || '' };
      const pressed = await runKey(tab, {
        key: plan.key, shift: plan.shift, frame: plan.frame, elementId: plan.elementId,
        snapshotId: plan.snapshotId, expectName: plan.element?.name
      });
      if (pressed.error) {
        newTabs.stop();
        return pressed.error;
      }
      const { run, frame } = pressed;
      if (run.gone) {
        newTabs.stop();
        return toolError('stale_snapshot', 'This frame changed since the read. Read the page again.');
      }
      if (!run.ok && !navigatedDuring(run)) {
        newTabs.stop();
        return toolError('page_unavailable', 'Chrome cannot act on this page.');
      }
      if (run.ok && !run.result?.ok) {
        newTabs.stop();
        const code = run.result?.code || 'internal';
        return toolError(code, run.result?.message || code);
      }
      const outcome = await verify(tab.id, before, { targets: [{ frame, elementId: null }], signal, newTabs, busy });
      newTabs.stop();
      if (outcome.verification.url_changed) latestSnapshots.delete(tab.id);
      if (outcome.verification.field_state === null && run.result?.field_state) outcome.verification.field_state = run.result.field_state;
      return attachPage(ok({
        tab: outcome.tab || toTab(tab),
        done: true,
        verification: outcome.verification,
        snapshot_stale: outcome.snapshot_stale,
        // The element that has the focus now: its role and name, never its value.
        focused: run.result?.focused ?? null
      }), tab.id, plan.page, signal);
    }

    // ---------------------------------------------------------------- uploads (TEAM-751)

    async function prepareUpload(args) {
      const page = pageOptions(args);
      if (page.error) return { error: page.error };
      const checked = checkUploadFiles(args.files);
      if (checked.error) return { error: checked.error };
      if (typeof args.snapshot_id !== 'string' || !args.snapshot_id) return { error: toolError('invalid_args', 'snapshot_id is required') };
      if (!parseElementId(args.element_id)) return { error: toolError('invalid_args', ELEMENT_ID_HELP) };
      if (typeof args.target !== 'string' || !args.target.trim() || args.target.length > 300) return { error: toolError('invalid_args', 'target must name the element') };
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return { error };
      const unavailable = pageError(tab);
      if (unavailable) return { error: unavailable };
      const known = knownSnapshot(tab.id);
      if (known && known !== args.snapshot_id) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };
      const inspected = await inspectElement(tab, args.snapshot_id, args.element_id, { upload: true });
      if (inspected.error) return { error: inspected.error };
      const { element } = inspected;
      if (!targetMatches(args.target, element.name)) return { error: targetError(element) };
      const field = element.upload || { kind: 'drop' };
      if (field.kind === 'input') {
        if (field.disabled) return { error: toolError('element_not_found', 'This file field is disabled.') };
        if (checked.files.length > 1 && !field.multiple) {
          return { error: toolError('invalid_args', 'This file field takes one file only (no `multiple`).') };
        }
        const refused = checked.files.find(file => !acceptAllows(field.accept, file));
        if (refused) {
          return { error: toolError('invalid_args', `« ${refused.name.slice(0, 80)} » is not a type this field accepts (${field.accept.slice(0, 120)}).`) };
        }
      }
      return {
        plan: {
          kind: 'upload', tool: 'browser.upload', action: 'upload', tab, args, page, element,
          frame: inspected.frame,
          field,
          local: localReading(item => classifyAction('browser.upload', item), element),
          domain: domainOf(tab.url || ''),
          snapshotId: args.snapshot_id,
          elementId: inspected.local
        }
      };
    }

    // The files' bytes leave the call's args as soon as the page has them.
    function dropFileData(args) {
      for (const file of Array.isArray(args?.files) ? args.files : []) {
        if (file && typeof file === 'object') file.data = null;
      }
    }

    async function executeUpload(plan, { signal, busy } = {}) {
      try {
        if (isCancelled(signal)) return toolError('paused', 'Stopped.');
        const live = await liveTab(plan);
        if (live.error) return live.error;
        const { tab } = live;
        const newTabs = watchNewTabs(tab.id);
        const before = { url: tab.url || '' };
        const files = plan.args.files.map(file => ({ name: file.name, mime: typeof file.mime === 'string' ? file.mime : '', data: file.data }));
        dropFileData(plan.args);
        const run = await execute(tab.id, performPageAction, {
          productKey, snapshotId: plan.snapshotId, elementId: plan.elementId, action: 'upload', files, expectName: plan.element.name
        }, plan.frame);
        files.length = 0;
        if (run.gone) {
          newTabs.stop();
          return toolError('stale_snapshot', 'This frame changed since the read. Read the page again.');
        }
        if (!run.ok && !navigatedDuring(run)) {
          newTabs.stop();
          return toolError('page_unavailable', 'Chrome cannot act on this page.');
        }
        if (run.ok && !run.result?.ok) {
          newTabs.stop();
          const code = run.result?.code || 'internal';
          return toolError(code, run.result?.message || code);
        }
        const outcome = await verify(tab.id, before, {
          targets: [{ frame: plan.frame, elementId: plan.field.kind === 'input' && plan.element.is_file ? plan.elementId : null }],
          signal, newTabs, busy
        });
        newTabs.stop();
        if (outcome.verification.url_changed) latestSnapshots.delete(tab.id);
        if (outcome.verification.field_state === null && run.result?.field_state) outcome.verification.field_state = run.result.field_state;
        return attachPage(ok({
          tab: outcome.tab || toTab(tab),
          done: true,
          verification: outcome.verification,
          snapshot_stale: outcome.snapshot_stale,
          // What the field holds now: names and sizes, never bytes.
          files: (run.result?.files || []).slice(0, UPLOAD_MAX_FILES).map(file => ({ name: String(file.name || '').slice(0, 200), size: Number(file.size) || 0 }))
        }), tab.id, plan.page, signal);
      } finally {
        dropFileData(plan.args);
      }
    }

    // ---------------------------------------------------------------- batch (TEAM-726)

    function stepError(index, error) {
      return toolError(error.error.code, `Étape ${index + 1} : ${error.error.message}`);
    }

    // Every step is checked before the first one runs: a bad step fails the whole call.
    async function prepareBatch(args) {
      const page = pageOptions(args);
      if (page.error) return { error: page.error };
      if (typeof args.snapshot_id !== 'string' || !args.snapshot_id) return { error: toolError('invalid_args', 'snapshot_id is required') };
      if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > BATCH_MAX_STEPS) {
        return { error: toolError('invalid_args', `steps must hold 1 to ${BATCH_MAX_STEPS} steps`) };
      }
      for (const [index, step] of args.steps.entries()) {
        const fail = message => ({ error: toolError('invalid_args', `Étape ${index + 1} : ${message}`) });
        if (!step || typeof step !== 'object' || Array.isArray(step)) return fail('a step must be an object');
        if (!BATCH_ACTIONS.includes(step.action)) return fail('action must be fill, select, check, click or key');
        if (step.action === 'key') {
          // TEAM-751: element_id and target are optional, except for Enter and Space.
          const problem = keyArgsError(step, { needElement: false });
          if (problem) return fail(problem);
          continue;
        }
        if (!parseElementId(step.element_id)) return fail(ELEMENT_ID_HELP);
        if (typeof step.target !== 'string' || !step.target.trim() || step.target.length > 300) return fail('target must name the element');
        if (step.action === 'fill') {
          if (typeof step.value !== 'string') return fail('value must be text');
          if (step.value.length > 5000) return { error: toolError('too_large', `Étape ${index + 1} : value is limited to 5000 characters`) };
        }
        if (step.action === 'select' && (typeof step.option !== 'string' || !step.option.trim())) return fail('option must name the choice');
        if (step.action === 'check' && typeof step.checked !== 'boolean') return fail('checked must be true or false');
      }
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return { error };
      const unavailable = pageError(tab);
      if (unavailable) return { error: unavailable };
      const known = knownSnapshot(tab.id);
      if (known && known !== args.snapshot_id) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };

      const steps = [];
      const readings = [];
      for (const [index, step] of args.steps.entries()) {
        if (step.action === 'key' && (step.element_id === undefined || step.element_id === null)) {
          readings.push({ risk: 'write', reason: null });
          steps.push({ ...step, element: null, frame: null, local: null });
          continue;
        }
        const inspected = await inspectElement(tab, args.snapshot_id, step.element_id);
        if (inspected.error) return { error: stepError(index, inspected) };
        const { element } = inspected;
        if (!targetMatches(step.target, element.name)) {
          return { error: stepError(index, toolError('stale_snapshot', `This id now names « ${String(element.name).slice(0, 60)} », not the target.`)) };
        }
        if (element.is_file) return { error: stepError(index, toolError('invalid_args', 'This is a file field: use browser.upload.')) };
        if (step.action === 'key') {
          const refusal = keyRefusal(step.key, element);
          if (refusal) return { error: stepError(index, refusal) };
          readings.push(localReading(item => classifyKey(step.key, item), element));
          steps.push({ ...step, element, frame: inspected.frame, local: inspected.local });
          continue;
        }
        if (step.action === 'fill') {
          if (element.sensitive) return { error: stepError(index, toolError('sensitive_field', 'Limova never types passwords, card numbers or codes. Ask the person to take over.')) };
          if (!element.editable) return { error: stepError(index, toolError('invalid_args', 'This element is not a text field.')) };
        }
        if (step.action === 'select' && !element.is_select) return { error: stepError(index, toolError('invalid_args', 'This element is not a list of choices.')) };
        if (step.action === 'check' && !element.is_checkable && !['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(element.role)) {
          return { error: stepError(index, toolError('invalid_args', 'This element is not a checkbox.')) };
        }
        if (step.action === 'click') {
          if (element.href && classifyUrl(element.href, { fromAgent: true }).code === 'blocked_site') {
            return { error: stepError(index, toolError('blocked_site', 'This link leads to a site Limova does not act on.')) };
          }
          if (element.submits && element.form?.action_origin && classifyUrl(element.form.action_origin, { fromAgent: true }).code === 'blocked_site') {
            return { error: stepError(index, toolError('blocked_site', 'This form sends to a site Limova does not act on.')) };
          }
        }
        readings.push(localReading(item => classifyAction(step.action === 'click' ? 'browser.click' : 'browser.fill', item), element));
        steps.push({ ...step, element, frame: inspected.frame, local: inspected.local });
      }
      const local = strictestOf(readings);
      // The element the approval window names: the riskiest step, else the last one with an element.
      const riskiest = steps[readings.findIndex(reading => reading.reason && reading.reason === local.reason)];
      const named = riskiest?.element ? riskiest : [...steps].reverse().find(step => step.element) || null;
      return {
        plan: {
          kind: 'batch', tool: 'browser.batch', tab, args, steps, local, page,
          element: named?.element || null,
          domain: domainOf(tab.url || ''),
          snapshotId: args.snapshot_id
        }
      };
    }

    async function executeBatch(plan, { signal, busy } = {}) {
      if (isCancelled(signal)) return toolError('paused', 'Stopped.');
      const live = await liveTab(plan);
      if (live.error) return live.error;
      const { tab } = live;
      const newTabs = watchNewTabs(tab.id);
      const before = { url: tab.url || '' };
      const results = [];
      // One watcher per frame across the steps, so the verification sees every change.
      const touched = [];
      let done = 0;
      let navigated = false;
      let lastFieldState = null;
      const stepResult = (step, extra) => ({ element_id: step.element_id ?? null, ...(step.action === 'key' ? { key: step.key } : {}), ...extra });
      for (const [index, step] of plan.steps.entries()) {
        if (isCancelled(signal)) {
          newTabs.stop();
          return toolError('paused', 'Stopped.');
        }
        let run;
        let frame = step.frame;
        const keepWatch = touched.some(item => sameFrame(item, frame));
        if (step.action === 'key') {
          const pressed = await runKey(tab, {
            key: step.key, shift: step.shift === true, frame: step.frame, elementId: step.local,
            snapshotId: plan.snapshotId, expectName: step.element?.name,
            keepWatch: step.local ? keepWatch : false
          });
          if (pressed.error) {
            results.push(stepResult(step, { ok: false, error: pressed.error.error }));
            break;
          }
          ({ run, frame } = pressed);
        } else {
          run = await execute(tab.id, performPageAction, {
            productKey,
            snapshotId: plan.snapshotId,
            elementId: step.local,
            action: step.action,
            value: step.action === 'fill' ? step.value : undefined,
            option: step.action === 'select' ? step.option : undefined,
            checked: step.action === 'check' ? step.checked : undefined,
            expectName: step.element.name,
            keepWatch
          }, frame);
        }
        if (!touched.some(item => sameFrame(item, frame))) touched.push(frame);
        if (run.gone) {
          results.push(stepResult(step, { ok: false, error: { code: 'stale_snapshot', message: 'This frame changed since the read.' } }));
          break;
        }
        if (!run.ok) {
          if (navigatedDuring(run)) {
            // The page went away while this step ran: it did run, and it ends the batch.
            results.push(stepResult(step, { ok: true }));
            done += 1;
            navigated = true;
            break;
          }
          results.push(stepResult(step, { ok: false, error: { code: 'page_unavailable', message: 'Chrome cannot act on this page.' } }));
          break;
        }
        if (!run.result?.ok) {
          const code = run.result?.code || 'internal';
          results.push(stepResult(step, { ok: false, error: { code, message: run.result?.message || code } }));
          break;
        }
        results.push(stepResult(step, { ok: true }));
        done += 1;
        lastFieldState = run.result.field_state ?? lastFieldState;
        if ((step.action === 'click' || step.action === 'key') && index < plan.steps.length - 1) {
          // A click or a key (Enter) may navigate: a quick look, and a new page ends the batch.
          await sleep(BATCH_NAVIGATION_PEEK_MS);
          const peek = await chromeApi.tabs.get(tab.id).catch(() => null);
          if (!peek || peek.status === 'loading' || (peek.url || '') !== before.url) {
            navigated = true;
            break;
          }
        }
      }
      if (navigated) {
        for (const step of plan.steps.slice(results.length)) {
          results.push(stepResult(step, { ok: false, error: { code: 'stale_snapshot', message: 'The page changed before this step.' } }));
        }
      }
      const outcome = await verify(tab.id, before, {
        targets: (touched.length ? touched : [null]).map(frame => ({ frame, elementId: null })),
        signal, newTabs, busy
      });
      newTabs.stop();
      if (outcome.verification.url_changed || navigated) latestSnapshots.delete(tab.id);
      if (outcome.verification.field_state === null && lastFieldState) outcome.verification.field_state = lastFieldState;
      return attachPage(ok({
        tab: outcome.tab || toTab(tab),
        done,
        steps: results,
        verification: outcome.verification,
        snapshot_stale: navigated || outcome.snapshot_stale
      }), tab.id, plan.page, signal);
    }

    // ---------------------------------------------------------------- vault (TEAM-729)

    /**
     * `browser.fill_secret`: open the sealed login, check, in this order, the group, the
     * seal, the LIVE origin, the elements and the password form's target, then type.
     * docs/login-vault.md « What the device checks ». The plaintext lives in this
     * function's locals and the injected call's arguments only, and is dropped before
     * the answer is built; the answer carries `filled` flags, never a value.
     * @param {object} args the call's args (tab_id, snapshot_id, origin, fields, sealed, include_page)
     * @param {{callId: string, vault: {privateKey: CryptoKey, deviceId: string}|null, signal?: AbortSignal, busy?: boolean}} context
     */
    async function fillSecret(args, { callId, vault, signal, busy } = {}) {
      const page = pageOptions(args);
      if (page.error) return page.error;
      if (!isTabId(args.tab_id)) return toolError('invalid_args', 'tab_id must be a tab number');
      if (typeof args.snapshot_id !== 'string' || !args.snapshot_id) return toolError('invalid_args', 'snapshot_id is required');
      if (typeof args.origin !== 'string' || !originOf(args.origin) || originOf(args.origin) !== args.origin) {
        return toolError('invalid_args', 'origin must be a bare origin such as https://example.com');
      }
      const fields = args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields) ? args.fields : null;
      const wanted = fields ? SECRET_FIELDS.filter(role => fields[role] !== undefined && fields[role] !== null) : [];
      if (!wanted.length) return toolError('invalid_args', 'fields needs username, password or otp');
      if (wanted.some(role => typeof fields[role] !== 'string' || !/^e\d{1,4}$/.test(fields[role]))) {
        return toolError('invalid_args', 'field ids must look like e12');
      }
      if (new Set(wanted.map(role => fields[role])).size !== wanted.length) return toolError('invalid_args', 'each field needs its own element');

      // 1. The tab is in this product's group (pause and take-over: the controller).
      const { tab, error } = await groupTab(args.tab_id);
      if (error) return error;

      // 2. The seal opens, is this call's and this device's, and has not expired.
      const opened = await openSeal({
        sealed: args.sealed, callId, deviceId: vault?.deviceId, privateKey: vault?.privateKey, now: now()
      });
      if (!opened.ok) return toolError('secret_unreadable', 'The saved login could not be opened on this device.');
      const secret = opened.payload;
      const drop = () => { for (const role of SECRET_FIELDS) secret[role] = null; };
      if (wanted.some(role => typeof secret[role] !== 'string' || !secret[role])) {
        drop();
        return toolError('secret_unreadable', 'The saved login does not hold every asked field.');
      }
      const secrets = wanted.filter(role => role !== 'username').map(role => secret[role]);

      try {
        // 3. The live top-frame origin, from Chrome now, not from the snapshot.
        const live = await chromeApi.tabs.get(tab.id).catch(() => null);
        if (!live) return toolError('tab_not_found', 'This tab was closed.');
        const liveOrigin = originOf(live.url || '');
        const pendingOrigin = live.pendingUrl ? originOf(live.pendingUrl) : liveOrigin;
        if (!liveOrigin || !liveOrigin.startsWith('https://') || liveOrigin !== args.origin
          || pendingOrigin !== liveOrigin || !secret.origins.includes(liveOrigin)) {
          return toolError('origin_mismatch', 'This page is not the saved login’s site.');
        }
        const unavailable = pageError(live);
        if (unavailable) return unavailable;

        // 4. The ids come from the latest read of this tab.
        const known = knownSnapshot(tab.id);
        if (known && known !== args.snapshot_id) return toolError('stale_snapshot', 'These ids come from an older read. Read the page again.');
        if (isCancelled(signal)) return toolError('paused', 'Stopped.');

        // 3 to 5 again, in the page, right before typing (see fillSecretInPage).
        const newTabs = watchNewTabs(tab.id);
        const before = { url: live.url || '' };
        const values = {};
        for (const role of wanted) values[role] = secret[role];
        const run = await execute(tab.id, fillSecretInPage, {
          productKey,
          snapshotId: args.snapshot_id,
          expectedOrigin: args.origin,
          origins: secret.origins,
          site: secret.site,
          fields: Object.fromEntries(wanted.map(role => [role, fields[role]])),
          values
        });
        for (const role of wanted) values[role] = null;
        drop();
        if (!run.ok || !run.result) {
          newTabs.stop();
          return toolError('page_unavailable', 'Chrome cannot act on this page.');
        }
        const filled = {
          username: run.result.filled?.username === true,
          password: run.result.filled?.password === true,
          otp: run.result.filled?.otp === true
        };
        if (!run.result.ok) {
          newTabs.stop();
          const code = run.result.code || 'internal';
          const messages = {
            origin_mismatch: 'This page is not the saved login’s site, or its form sends elsewhere.',
            stale_snapshot: 'Read the page again.',
            element_not_found: 'A field is gone, hidden, disabled or read-only.',
            invalid_args: 'A field is not of the right kind (password, username or code).'
          };
          return toolError(code, messages[code] || code);
        }
        const outcome = await verify(tab.id, before, {
          elementId: wanted.includes('password') ? fields.password : fields[wanted[0]], signal, newTabs, busy
        });
        newTabs.stop();
        if (outcome.verification.url_changed) latestSnapshots.delete(tab.id);
        const result = await attachPage(ok({
          tab: outcome.tab || toTab(live),
          done: true,
          verification: outcome.verification,
          snapshot_stale: outcome.snapshot_stale,
          filled
        }), tab.id, page, signal);
        return scrubSecrets(result, secrets);
      } finally {
        drop();
        secrets.length = 0;
      }
    }

    // ---------------------------------------------------------------- access

    // The person's own tabs they may share (never LinkedIn, Limova or chrome:// pages).
    async function shareableTabs() {
      const groupId = await currentGroupId();
      const all = await chromeApi.tabs.query({});
      return all
        .filter(tab => tab.groupId !== groupId || groupId === null)
        .filter(tab => classifyUrl(tab.url || '').ok)
        .map(toTab);
    }

    async function adoptTab(tabId, busy) {
      let tab;
      try {
        tab = await chromeApi.tabs.get(tabId);
      } catch {
        return toolError('tab_not_found', 'This tab was closed.');
      }
      if (!classifyUrl(tab.url || '').ok) return toolError('blocked_site', 'Limova does not act on this site.');
      await addToGroup(tab.id, busy);
      const fresh = await chromeApi.tabs.get(tab.id).catch(() => tab);
      return ok({ tab: toTab(fresh) });
    }

    return {
      product,
      listTabs,
      openTab,
      closeTab,
      readPage,
      screenshot,
      navigate,
      scroll,
      prepareAction,
      executeAction,
      fillSecret,
      shareableTabs,
      adoptTab,
      // TEAM-731: the person's click on « Montrer à Limova » is the consent to bring
      // this tab (or a new tab) into the group; the recorder checks the site itself.
      joinGroup: (tabId, busy = false) => addToGroup(tabId, busy),
      setRecordingTitle,
      setGroupTitle,
      currentGroupId,
      runRead(tool, args, options) {
        switch (tool) {
          case 'browser.list_tabs': return listTabs(args, options);
          case 'browser.open_tab': return withPage(args, () => openTab(args, options), result => result?.data?.tab?.tab_id, options?.signal);
          case 'browser.close_tab': return closeTab(args, options);
          case 'browser.read_page': return readPage(args, options);
          case 'browser.screenshot': return screenshot(args, options);
          case 'browser.navigate': return withPage(args, () => navigate(args, options), () => args.tab_id, options?.signal);
          case 'browser.scroll': return withPage(args, () => scroll(args, options), () => args.tab_id, options?.signal);
          default: return Promise.resolve(toolError('unsupported', `Unknown tool ${tool}`));
        }
      }
    };
  }

  return { forProduct };
}
