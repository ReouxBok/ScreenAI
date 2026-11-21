// Shared fakes for the Limova Team unit tests (TEAM-724).
import { vi } from 'vitest';

// jsdom has no layout: give every element a box, and let tests move one off screen.
export function installLayout() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect() {
    const top = this.dataset?.testTop !== undefined ? Number(this.dataset.testTop) : 10;
    const width = this.dataset?.testWidth !== undefined ? Number(this.dataset.testWidth) : 100;
    return { left: 10, top, width, height: 20, right: 10 + width, bottom: top + 20, x: 10, y: top };
  };
  const editable = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable');
  Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
    configurable: true,
    get() { return Boolean(this.closest('[contenteditable]:not([contenteditable="false"])')); }
  });
  return () => {
    Element.prototype.getBoundingClientRect = original;
    if (editable) Object.defineProperty(HTMLElement.prototype, 'isContentEditable', editable);
    else delete HTMLElement.prototype.isContentEditable;
  };
}

export function resetIsolatedWorld() {
  delete globalThis.__limovaBrowserKit;
  delete globalThis.__limovaBrowserMaps;
  delete globalThis.__limovaBrowserWatch;
}

// A chrome.* fake where executeScript runs the injected function against jsdom.
export function createChromeFake({ tabs = [], groupId = 7, windowId = 1 } = {}) {
  const tabsById = new Map(tabs.map(tab => [tab.id, { windowId, status: 'complete', active: true, ...tab }]));
  const createdListeners = [];
  let nextTabId = 900;
  const sessionData = { limova_tab_groups_v1: groupId === null ? {} : { limova_team: groupId } };
  const groups = new Map(groupId === null ? [] : [[groupId, { id: groupId, windowId }]]);
  const chromeApi = {
    tabs: {
      get: vi.fn(async id => {
        if (!tabsById.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabsById.get(id) };
      }),
      query: vi.fn(async () => [...tabsById.values()].map(tab => ({ ...tab }))),
      create: vi.fn(async ({ url, active }) => {
        const tab = { id: nextTabId += 1, windowId, url, title: '', status: 'complete', active: Boolean(active), groupId: -1 };
        tabsById.set(tab.id, tab);
        createdListeners.forEach(listener => listener({ ...tab }));
        return { ...tab };
      }),
      group: vi.fn(async ({ groupId: target, tabIds }) => {
        let id = target;
        if (id === undefined) {
          id = 50 + groups.size;
          groups.set(id, { id, windowId });
        }
        for (const tabId of tabIds) tabsById.get(tabId).groupId = id;
        return id;
      }),
      update: vi.fn(async (id, patch) => {
        Object.assign(tabsById.get(id), patch);
        return { ...tabsById.get(id) };
      }),
      remove: vi.fn(async id => { tabsById.delete(id); }),
      goBack: vi.fn(async () => {}),
      goForward: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
      onCreated: {
        addListener: fn => createdListeners.push(fn),
        removeListener: fn => {
          const index = createdListeners.indexOf(fn);
          if (index >= 0) createdListeners.splice(index, 1);
        }
      }
    },
    tabGroups: {
      get: vi.fn(async id => {
        if (!groups.has(id)) throw new Error('No group');
        return { ...groups.get(id) };
      }),
      update: vi.fn(async () => ({}))
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: windowId })),
      update: vi.fn(async () => ({}))
    },
    scripting: {
      executeScript: vi.fn(async ({ func, args }) => [{ result: func(...args), documentId: 'doc' }])
    },
    storage: {
      session: {
        get: vi.fn(async key => (key in sessionData ? { [key]: sessionData[key] } : {})),
        set: vi.fn(async values => { Object.assign(sessionData, values); }),
        remove: vi.fn(async key => { delete sessionData[key]; })
      }
    },
    _tabs: tabsById,
    _groups: groups
  };
  return chromeApi;
}

export const TEAM_PRODUCT = {
  id: 'limova_team',
  label: 'Limova Team',
  color: '#7C3AED',
  groupColor: 'purple',
  groupTitle: 'Limova Team',
  groupBusyTitle: 'Limova Team · en cours'
};

// A clock that moves forward on every read, so wait loops always end.
export function steppingClock(step = 500) {
  let value = 1_800_000_000_000;
  return () => (value += step);
}
