import { describe, it, expect } from 'vitest';
import {
  buildFrameTree, frameTextHeader, MAX_FRAME_DEPTH, MAX_READ_FRAMES, parseElementId, publicFrames
} from '../../../src/team/frame-tree.js';
import { classifyUrl } from '../../../src/team/products.js';

// TEAM-751: which frames read_page reads, and the ids it gives them.

const TOP = 'https://shop.example.com';
const box = { left: 10, top: 20, width: 300, height: 100 };
const holder = (index, extra = {}) => ({ index, title: '', rendered: true, rect: box, src_origin: null, ...extra });

function probe(path, origin, children = [], documentId = `doc-${path.join('-') || 'top'}`) {
  return { ok: true, path, origin, children, documentId, viewport: { width: 1200, height: 800 } };
}

function tree(frames, probes) {
  return buildFrameTree({ frames, probes: new Map(probes), classify: url => classifyUrl(url), topOrigin: TOP });
}

describe('frame tree', () => {
  it('parses top-frame and frame-scoped element ids', () => {
    expect(parseElementId('e12')).toEqual({ frame: null, local: 'e12' });
    expect(parseElementId('fr2.e12')).toEqual({ frame: 'fr2', local: 'e12' });
    for (const bad of ['fr2', 'fr2.', 'x.e1', 'fr100.e1', 'e', 'fr2.e12.e3', 12, null]) expect(parseElementId(bad)).toBeNull();
  });

  it('numbers frames fr1, fr2… in document order, with path, parent, origin and name', () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, url: `${TOP}/checkout`, documentId: 'doc-top' },
      // Chrome's frame ids say nothing of the order in the page.
      { frameId: 9, parentFrameId: 0, url: 'https://js.stripe.com/v3/card', documentId: 'doc-0' },
      { frameId: 4, parentFrameId: 0, url: `${TOP}/address`, documentId: 'doc-1' },
      { frameId: 12, parentFrameId: 4, url: `${TOP}/address/map`, documentId: 'doc-1-0' }
    ];
    const list = tree(frames, [
      [0, probe([], TOP, [holder(0, { title: 'Secure card payment input frame' }), holder(1, { title: 'Adresse' })])],
      [9, probe([0], 'https://js.stripe.com')],
      [4, probe([1], TOP, [holder(0, { title: 'Carte' })])],
      [12, probe([1, 0], TOP)]
    ]);
    expect(publicFrames(list)).toEqual([
      { id: 'fr1', parent: null, origin: 'https://js.stripe.com', name: 'Secure card payment input frame', path: [0], cross_origin: true, readable: true, elements: 0 },
      { id: 'fr2', parent: null, origin: TOP, name: 'Adresse', path: [1], cross_origin: false, readable: true, elements: 0 },
      { id: 'fr3', parent: 'fr2', origin: TOP, name: 'Carte', path: [1, 0], cross_origin: false, readable: true, elements: 0 }
    ]);
    expect(list.map(entry => [entry.frameId, entry.documentId])).toEqual([[9, 'doc-0'], [4, 'doc-1'], [12, 'doc-1-0']]);
    // The nested frame sits inside its parent's box, in the top frame's coordinates.
    expect(list[2].offset).toEqual({ left: 20, top: 40 });
    expect(frameTextHeader(list[0])).toBe('[Cadre fr1 · js.stripe.com]');
  });

  it('lists blocked and unscriptable frames without reading them, and skips hidden ones', () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, url: `${TOP}/`, documentId: 'doc-top' },
      { frameId: 2, parentFrameId: 0, url: 'https://www.linkedin.com/embed/feed', documentId: 'li' },
      { frameId: 3, parentFrameId: 0, url: 'chrome-extension://abc/page.html', documentId: 'ext' },
      { frameId: 5, parentFrameId: 0, url: 'https://pixel.example.net/t', documentId: 'px' },
      { frameId: 6, parentFrameId: 2, url: 'https://www.linkedin.com/inner', documentId: 'li-inner' }
    ];
    const list = tree(frames, [
      [0, probe([], TOP, [
        holder(0, { src_origin: 'https://www.linkedin.com' }),
        holder(1),
        holder(2, { rendered: false })
      ])],
      // The blocked frame only says where it is.
      [2, { ok: true, path: [0], blocked: true, documentId: 'li' }],
      [5, probe([2], 'https://pixel.example.net')]
    ]);
    expect(publicFrames(list)).toEqual([
      { id: 'fr1', parent: null, origin: 'https://www.linkedin.com', name: '', path: [0], cross_origin: true, readable: false, reason: 'blocked_site', elements: 0 },
      { id: 'fr2', parent: null, origin: 'null', name: '', path: [1], cross_origin: true, readable: false, reason: 'page_unavailable', elements: 0 }
    ]);
  });

  it(`reads at most ${MAX_READ_FRAMES} frames and ${MAX_FRAME_DEPTH} levels`, () => {
    const frames = [{ frameId: 0, parentFrameId: -1, url: `${TOP}/`, documentId: 'doc-top' }];
    const probes = [[0, probe([], TOP, Array.from({ length: 22 }, (_, index) => holder(index)))]];
    for (let index = 0; index < 22; index += 1) {
      frames.push({ frameId: 100 + index, parentFrameId: 0, url: `${TOP}/w${index}`, documentId: `w${index}` });
      probes.push([100 + index, probe([index], TOP, [], `w${index}`)]);
    }
    const wide = tree(frames, probes);
    expect(wide.filter(entry => entry.readable)).toHaveLength(MAX_READ_FRAMES);
    expect(wide.slice(MAX_READ_FRAMES).map(entry => entry.reason)).toEqual(['too_many', 'too_many']);

    const deep = [{ frameId: 0, parentFrameId: -1, url: `${TOP}/`, documentId: 'doc-top' }];
    const deepProbes = [[0, probe([], TOP, [holder(0)])]];
    for (let depth = 1; depth <= 6; depth += 1) {
      const path = Array(depth).fill(0);
      deep.push({ frameId: depth, parentFrameId: depth - 1, url: `${TOP}/d${depth}`, documentId: `d${depth}` });
      deepProbes.push([depth, probe(path, TOP, [holder(0)], `d${depth}`)]);
    }
    const nested = tree(deep, deepProbes);
    expect(nested.map(entry => entry.path.length)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(nested.at(-1)).toEqual(expect.objectContaining({ readable: false, reason: 'too_deep' }));
  });

  it('has nothing to list for a page without frames', () => {
    expect(tree([{ frameId: 0, parentFrameId: -1, url: `${TOP}/` }], [])).toEqual([]);
    expect(tree([], [])).toEqual([]);
  });
});
