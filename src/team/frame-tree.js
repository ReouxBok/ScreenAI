// frame-tree.js — Which frames of a tab read_page reads, and what it calls them (TEAM-751).
//
// docs/browser-device-protocol.md « Iframes (`browser.v2+frames`) ». The engine
// (browser-engine.js) gathers two facts per tab and hands them here:
//   - Chrome's list of frames (chrome.webNavigation.getAllFrames): frame id, parent,
//     URL and documentId;
//   - what each scriptable frame says about itself (page-snapshot.js `probeFrame`): its
//     index chain from the top (`path`), its origin, and for each child frame its
//     element's title, whether it is shown and its box.
// `buildFrameTree` turns them into the `frames` list of the page map:
//   - ids `fr1`, `fr2`… numbered in document order (depth first, by index), new for every
//     snapshot, so an id is only valid with its `snapshot_id`;
//   - at most 20 frames read and 5 levels deep (`too_many`, `too_deep` for the rest);
//   - a frame on a blocked site is listed `blocked_site` and never read; a frame Chrome
//     does not let the extension script is listed `page_unavailable`;
//   - frames whose element is hidden (0 × 0, display: none: trackers, ad beacons) and
//     frames inside a frame that is not read are not listed at all.
// Pure: no Chrome API.

export const MAX_READ_FRAMES = 20;
export const MAX_FRAME_DEPTH = 5;
// The list itself is capped too: a page with a hundred ad frames must not flood the map.
export const MAX_LISTED_FRAMES = 50;
const FRAME_ID = /^fr(\d{1,2})$/;
const ELEMENT_ID = /^(?:(fr\d{1,2})\.)?(e\d{1,4})$/;
const FORM_ID = /^(?:(fr\d{1,2})\.)?(f\d{1,4})$/;

/**
 * Split an element id of a snapshot into its frame and its id inside that frame.
 * @param {string} value `e12` (top frame) or `fr2.e12` (child frame)
 * @returns {{frame: string|null, local: string}|null} null when it is not an element id
 */
export function parseElementId(value) {
  const match = typeof value === 'string' ? ELEMENT_ID.exec(value) : null;
  return match ? { frame: match[1] || null, local: match[2] } : null;
}

export function isFrameId(value) {
  return typeof value === 'string' && FRAME_ID.test(value);
}

export function isFormId(value) {
  return typeof value === 'string' && FORM_ID.test(value);
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function samePath(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

function comparePaths(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/**
 * @param {object} input
 * @param {Array<{frameId: number, parentFrameId: number, url: string, documentId?: string, errorOccurred?: boolean}>} input.frames getAllFrames
 * @param {Map<number, {path: number[]|null, origin?: string, children?: object[], documentId?: string}>} input.probes per frame id
 * @param {(url: string) => {ok: boolean, code?: string}} input.classify products.js classifyUrl
 * @param {string} input.topOrigin the tab's origin
 * @returns {Array<object>} listed frames, in document order, top excluded
 */
export function buildFrameTree({ frames = [], probes = new Map(), classify = () => ({ ok: true }), topOrigin = '' }) {
  const byId = new Map(frames.filter(frame => Number.isInteger(frame?.frameId)).map(frame => [frame.frameId, frame]));
  if (!byId.has(0)) return [];
  const childrenOf = new Map();
  for (const frame of byId.values()) {
    if (frame.frameId === 0) continue;
    if (!childrenOf.has(frame.parentFrameId)) childrenOf.set(frame.parentFrameId, []);
    childrenOf.get(frame.parentFrameId).push(frame);
  }

  // Place each child frame at its index in its parent: the probe's own path when it has
  // one that fits the parent's, else (an unscriptable or blocked frame) the first free
  // index of the parent whose element points at the same origin, else the first free one.
  function placeChildren(parentId, parentPath, parentProbe) {
    const kids = (childrenOf.get(parentId) || []).slice().sort((a, b) => a.frameId - b.frameId);
    const holders = Array.isArray(parentProbe?.children) ? parentProbe.children : [];
    const used = new Set();
    const placed = [];
    const unplaced = [];
    for (const kid of kids) {
      const path = probes.get(kid.frameId)?.path;
      if (Array.isArray(path) && path.length === parentPath.length + 1 && samePath(path.slice(0, -1), parentPath)
        && !used.has(path.at(-1))) {
        used.add(path.at(-1));
        placed.push({ frame: kid, index: path.at(-1) });
      } else {
        unplaced.push(kid);
      }
    }
    for (const kid of unplaced) {
      const origin = originOf(kid.url);
      const free = holders.filter(holder => !used.has(holder.index));
      const holder = free.find(item => origin && item.src_origin === origin) || free[0];
      if (!holder) continue;
      used.add(holder.index);
      placed.push({ frame: kid, index: holder.index });
    }
    return placed
      .map(item => ({ ...item, holder: holders.find(holder => holder.index === item.index) || null }))
      .sort((a, b) => a.index - b.index);
  }

  const listed = [];
  let readCount = 0;
  let counter = 0;
  const topProbe = probes.get(0) || null;
  const topBox = { left: 0, top: 0, right: Number(topProbe?.viewport?.width) || 1e6, bottom: Number(topProbe?.viewport?.height) || 1e6 };

  function walk(parentId, parentPath, parentProbe, parentEntryId, parentBox, parentOffset) {
    for (const { frame, index, holder } of placeChildren(parentId, parentPath, parentProbe)) {
      if (listed.length >= MAX_LISTED_FRAMES) return;
      // A parent we can read tells whether the frame is shown; hidden ones are not listed.
      if (holder && !holder.rendered) continue;
      const path = [...parentPath, index];
      const probe = probes.get(frame.frameId) || null;
      const origin = (probe?.origin && probe.origin !== 'null' ? probe.origin : null) || originOf(frame.url) || 'null';
      const rect = holder?.rect || null;
      const offset = rect ? { left: parentOffset.left + rect.left, top: parentOffset.top + rect.top } : null;
      const box = rect && offset ? {
        left: Math.max(parentBox.left, offset.left),
        top: Math.max(parentBox.top, offset.top),
        right: Math.min(parentBox.right, offset.left + rect.width),
        bottom: Math.min(parentBox.bottom, offset.top + rect.height)
      } : null;
      counter += 1;
      const entry = {
        id: `fr${counter}`,
        parent: parentEntryId,
        origin,
        name: String(holder?.title || '').slice(0, 100),
        path,
        cross_origin: origin !== topOrigin,
        readable: false,
        frameId: frame.frameId,
        documentId: probe?.documentId || frame.documentId || null,
        offset,
        clip: box && box.right > box.left && box.bottom > box.top ? box : null,
        in_viewport: Boolean(box && box.right > box.left && box.bottom > box.top)
      };
      const verdict = classify(frame.url || '');
      const blocked = verdict.code === 'blocked_site' || (origin !== 'null' && classify(`${origin}/`).code === 'blocked_site');
      if (blocked) entry.reason = 'blocked_site';
      else if (path.length > MAX_FRAME_DEPTH) entry.reason = 'too_deep';
      else if (!probe || !entry.documentId) entry.reason = 'page_unavailable';
      else if (readCount >= MAX_READ_FRAMES) entry.reason = 'too_many';
      else {
        entry.readable = true;
        readCount += 1;
      }
      listed.push(entry);
      // Only a frame that is read shows what is inside it.
      if (entry.readable && offset && entry.clip) walk(frame.frameId, path, probe, entry.id, entry.clip, offset);
      else if (entry.readable) walk(frame.frameId, path, probe, entry.id, { left: 0, top: 0, right: 0, bottom: 0 }, offset || { left: 0, top: 0 });
    }
  }

  walk(0, [], topProbe, null, topBox, { left: 0, top: 0 });
  return listed.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * The `frames` entries of the page map, as the server reads them (no Chrome ids).
 * @param {Array<object>} tree buildFrameTree's list, with `elements` counted
 */
export function publicFrames(tree) {
  return tree.map(entry => {
    const out = {
      id: entry.id,
      parent: entry.parent,
      origin: entry.origin,
      name: entry.name,
      path: entry.path,
      cross_origin: entry.cross_origin,
      readable: entry.readable,
      elements: entry.elements || 0
    };
    if (!entry.readable) out.reason = entry.reason || 'page_unavailable';
    return out;
  });
}

// The line that opens a frame's text in the page map: « [Cadre fr1 · js.stripe.com] ».
export function frameTextHeader(entry) {
  let host = '';
  try { host = new URL(entry.origin).host; } catch { host = ''; }
  return `[Cadre ${entry.id}${host ? ` · ${host}` : ''}]`;
}
