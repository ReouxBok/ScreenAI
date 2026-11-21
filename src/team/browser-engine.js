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
// Approvals and autonomy are not decided here (see team-controller.js). For actions the
// engine splits the work in two: `prepareAction` checks everything and reads the live
// element (so the controller can judge risk and ask the person), then `executeAction`
// acts and verifies what happened.
//
// `renderCapture(dataUrl, {viewportWidth, viewportHeight, masks, markers})` is injected
// (background.js's renderSilentVisualCapture) to avoid a circular import.

import { classifyUrl, domainOf, safeFavicon, safeUrl } from './products.js';
import { classifyAction, riskHint, strictestOf, targetMatches } from './risk.js';
import { inspectPageElement, pageSnapshot, preparePageCapture } from './page-snapshot.js';
import { collectPageVerification, performPageAction, scrollPage } from './page-actions.js';

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
const BATCH_ACTIONS = ['fill', 'select', 'check', 'click'];
const OPEN_TAB_WAIT_MS = 10_000;
const TEXT_LIMITS = { min: 500, max: 20000, fallback: 8000 };
// `include_page` reads a shorter page by default (TEAM-726).
const INCLUDED_TEXT_LIMITS = { min: 500, max: 20000, fallback: 4000 };
const ELEMENT_LIMITS = { min: 1, max: 400, fallback: 200 };

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

  async function execute(tabId, func, args) {
    try {
      const results = await chromeApi.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func,
        args: [args]
      });
      const first = Array.isArray(results) ? results[0] : null;
      return { ok: true, result: first?.result ?? null, documentId: first?.documentId ?? null };
    } catch (error) {
      return { ok: false, message: String(error?.message || '') };
    }
  }

  function forProduct(product) {
    const productKey = product.id;
    // tab id -> latest snapshot id read by this product
    const latestSnapshots = new Map();

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

    async function setGroupTitle(busy) {
      const groupId = await currentGroupId();
      if (groupId === null) return;
      await chromeApi.tabGroups.update(groupId, {
        title: busy ? product.groupBusyTitle : product.groupTitle,
        color: product.groupColor
      }).catch(() => {});
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
      latestSnapshots.set(tab.id, snapshotId);
      const fresh = await chromeApi.tabs.get(tab.id).catch(() => tab);
      const raw = run.result;
      const formsById = new Map((raw.forms || []).map(form => [form.id, form]));
      const elements = (raw.elements || []).map(item => {
        // Whitelist: only these fields leave the browser.
        const entry = { id: item.id, role: item.role, tag: item.tag };
        if (item.type) entry.type = item.type;
        entry.name = item.name;
        if (item.state) entry.state = item.state;
        if (typeof item.checked === 'boolean') entry.checked = item.checked;
        if (item.selected !== undefined && item.state !== 'sensitive') entry.selected = item.selected;
        if (Array.isArray(item.options) && item.state !== 'sensitive') entry.options = item.options;
        if (item.form) entry.form = item.form;
        if (item.href) entry.href = item.href;
        entry.in_viewport = Boolean(item.in_viewport);
        if (item.disabled) entry.disabled = true;
        const hint = riskHint({ name: item.name, role: item.role, submits: item.submits, form: formsById.get(item.form) });
        if (hint) entry.risk_hint = hint;
        return entry;
      });
      const forms = (raw.forms || []).map(form => ({
        id: form.id,
        method: form.method,
        action_origin: form.action_origin,
        external: Boolean(form.external)
      }));
      return ok({
        tab: toTab(fresh),
        snapshot_id: snapshotId,
        elements,
        forms,
        text: String(raw.text || ''),
        text_truncated: Boolean(raw.text_truncated),
        elements_truncated: Boolean(raw.elements_truncated),
        suspicious: (raw.suspicious || []).slice(0, 5).map(item => ({ kind: 'hidden_instructions', text: String(item.text || '').slice(0, 300) }))
      });
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

    async function verify(tabId, before, { elementId = null, signal, newTabs, busy } = {}) {
      const started = now();
      await sleep(VERIFY_FIRST_CHECK_MS);
      let tab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (tab?.status === 'loading') tab = await waitForLoad(tabId, NAVIGATION_SETTLE_MAX_MS, signal);
      let info = null;
      while (tab && !isCancelled(signal)) {
        const run = await execute(tabId, collectPageVerification, { productKey, elementId, finish: false });
        info = run.ok ? run.result : null;
        const elapsed = now() - started;
        if (!info || !info.same_document || elapsed >= VERIFY_MAX_MS) break;
        if (elapsed >= VERIFY_MIN_MS && (info.quiet_ms ?? 0) >= VERIFY_QUIET_MS) break;
        await sleep(VERIFY_POLL_MS);
        tab = await chromeApi.tabs.get(tabId).catch(() => null);
        if (tab?.status === 'loading') tab = await waitForLoad(tabId, NAVIGATION_SETTLE_MAX_MS, signal);
      }
      if (tab) await execute(tabId, collectPageVerification, { productKey, elementId: null, finish: true });
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
          field_state: elementId && info?.same_document ? info.field_state ?? null : null,
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
      if (usesElement) {
        const known = latestSnapshots.get(tab.id);
        if (known && known !== args.snapshot_id) return toolError('stale_snapshot', 'Read the page again.');
      }
      const run = await execute(tab.id, scrollPage, {
        productKey, direction: args.direction,
        snapshotId: usesElement ? args.snapshot_id : null,
        elementId: usesElement ? args.element_id : null
      });
      if (!run.ok || !run.result) return toolError('page_unavailable', 'Chrome cannot scroll this page.');
      if (!run.result.ok) return toolError(run.result.code, run.result.code);
      const outcome = await verify(tab.id, { url: tab.url || '' }, { signal, busy });
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

    /**
     * Check an action and read its live element. Returns {error} or {plan}.
     * plan.element holds the facts risk.classifyAction needs (never a value).
     */
    async function prepareAction(tool, args) {
      if (tool === 'browser.batch') return prepareBatch(args);
      const page = pageOptions(args);
      if (page.error) return { error: page.error };
      const action = ACTIONS[tool];
      if (!action) return { error: toolError('unsupported', `Unknown tool ${tool}`) };
      if (typeof args.snapshot_id !== 'string' || !args.snapshot_id) return { error: toolError('invalid_args', 'snapshot_id is required') };
      if (typeof args.element_id !== 'string' || !/^e\d{1,4}$/.test(args.element_id)) return { error: toolError('invalid_args', 'element_id must look like e12') };
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
      const known = latestSnapshots.get(tab.id);
      if (known && known !== args.snapshot_id) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };
      const run = await executeWhenReady(tab.id, inspectPageElement, { productKey, snapshotId: args.snapshot_id, elementId: args.element_id });
      if (!run.ok || !run.result) return { error: toolError('page_unavailable', 'Chrome cannot read this page.') };
      if (!run.result.ok) return { error: toolError(run.result.code, run.result.code === 'stale_snapshot' ? 'Read the page again.' : 'The element is gone, hidden or disabled.') };
      const element = { ...run.result.element, page: run.result.page };
      if (!targetMatches(args.target, element.name)) {
        return { error: toolError('stale_snapshot', `This id now names « ${String(element.name).slice(0, 60)} », not the target. Read the page again.`) };
      }
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
          domain: domainOf(tab.url || ''),
          snapshotId: args.snapshot_id,
          elementId: args.element_id
        }
      };
    }

    async function executeAction(plan, options = {}) {
      if (plan.kind === 'batch') return executeBatch(plan, options);
      const { signal, busy } = options;
      if (isCancelled(signal)) return toolError('paused', 'Stopped.');
      const tab = await chromeApi.tabs.get(plan.tab.id).catch(() => null);
      if (!tab) return toolError('tab_not_found', 'This tab was closed.');
      const groupId = await currentGroupId();
      if (groupId === null || tab.groupId !== groupId) return toolError('not_in_group', 'This tab left the group.');
      if (safeUrl(tab.url) !== safeUrl(plan.tab.url)) return toolError('stale_snapshot', 'The page changed. Read it again.');
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
      });
      if (!run.ok) {
        // The frame went away while the action ran: it navigated, so it did run.
        if (!/removed|navigat|closed|unloaded|No frame/i.test(run.message)) {
          newTabs.stop();
          return toolError('page_unavailable', 'Chrome cannot act on this page.');
        }
      } else if (!run.result?.ok) {
        newTabs.stop();
        const code = run.result?.code || 'internal';
        return toolError(code, run.result?.message || code);
      }
      const outcome = await verify(tab.id, before, {
        elementId: plan.action === 'fill' || plan.action === 'select' ? plan.elementId : null,
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
        if (!BATCH_ACTIONS.includes(step.action)) return fail('action must be fill, select, check or click');
        if (typeof step.element_id !== 'string' || !/^e\d{1,4}$/.test(step.element_id)) return fail('element_id must look like e12');
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
      const known = latestSnapshots.get(tab.id);
      if (known && known !== args.snapshot_id) return { error: toolError('stale_snapshot', 'These ids come from an older read. Read the page again.') };

      const steps = [];
      const readings = [];
      for (const [index, step] of args.steps.entries()) {
        const run = await executeWhenReady(tab.id, inspectPageElement, { productKey, snapshotId: args.snapshot_id, elementId: step.element_id });
        if (!run.ok || !run.result) return { error: toolError('page_unavailable', 'Chrome cannot read this page.') };
        if (!run.result.ok) {
          return { error: stepError(index, toolError(run.result.code, run.result.code === 'stale_snapshot' ? 'Read the page again.' : 'The element is gone, hidden or disabled.')) };
        }
        const element = { ...run.result.element, page: run.result.page };
        if (!targetMatches(step.target, element.name)) {
          return { error: stepError(index, toolError('stale_snapshot', `This id now names « ${String(element.name).slice(0, 60)} », not the target.`)) };
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
        readings.push(classifyAction(step.action === 'click' ? 'browser.click' : 'browser.fill', element));
        steps.push({ ...step, element });
      }
      const local = strictestOf(readings);
      // The element the approval window names: the riskiest step, else the last one.
      const riskiest = steps[readings.findIndex(reading => reading.reason && reading.reason === local.reason)] || steps.at(-1);
      return {
        plan: {
          kind: 'batch', tool: 'browser.batch', tab, args, steps, local, page,
          element: riskiest.element,
          domain: domainOf(tab.url || ''),
          snapshotId: args.snapshot_id
        }
      };
    }

    async function executeBatch(plan, { signal, busy } = {}) {
      if (isCancelled(signal)) return toolError('paused', 'Stopped.');
      const tab = await chromeApi.tabs.get(plan.tab.id).catch(() => null);
      if (!tab) return toolError('tab_not_found', 'This tab was closed.');
      const groupId = await currentGroupId();
      if (groupId === null || tab.groupId !== groupId) return toolError('not_in_group', 'This tab left the group.');
      if (safeUrl(tab.url) !== safeUrl(plan.tab.url)) return toolError('stale_snapshot', 'The page changed. Read it again.');
      const newTabs = watchNewTabs(tab.id);
      const before = { url: tab.url || '' };
      const results = [];
      let done = 0;
      let navigated = false;
      let lastFieldState = null;
      for (const [index, step] of plan.steps.entries()) {
        if (isCancelled(signal)) {
          newTabs.stop();
          return toolError('paused', 'Stopped.');
        }
        const run = await execute(tab.id, performPageAction, {
          productKey,
          snapshotId: plan.snapshotId,
          elementId: step.element_id,
          action: step.action,
          value: step.action === 'fill' ? step.value : undefined,
          option: step.action === 'select' ? step.option : undefined,
          checked: step.action === 'check' ? step.checked : undefined,
          expectName: step.element.name,
          keepWatch: index > 0
        });
        if (!run.ok) {
          if (/removed|navigat|closed|unloaded|No frame/i.test(run.message)) {
            // The page went away while this step ran: it did run, and it ends the batch.
            results.push({ element_id: step.element_id, ok: true });
            done += 1;
            navigated = true;
            break;
          }
          results.push({ element_id: step.element_id, ok: false, error: { code: 'page_unavailable', message: 'Chrome cannot act on this page.' } });
          break;
        }
        if (!run.result?.ok) {
          const code = run.result?.code || 'internal';
          results.push({ element_id: step.element_id, ok: false, error: { code, message: run.result?.message || code } });
          break;
        }
        results.push({ element_id: step.element_id, ok: true });
        done += 1;
        lastFieldState = run.result.field_state ?? lastFieldState;
        if (step.action === 'click' && index < plan.steps.length - 1) {
          // A click may navigate: a quick look at the tab, and a new page ends the batch.
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
          results.push({ element_id: step.element_id, ok: false, error: { code: 'stale_snapshot', message: 'The page changed before this step.' } });
        }
      }
      const outcome = await verify(tab.id, before, { signal, newTabs, busy });
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
      shareableTabs,
      adoptTab,
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
