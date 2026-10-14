// Presentation only: the browser driver remains responsible for action authority.
export function createTabGuidance({ chrome, onChange }) {
  let target = null;
  let revision = 0;
  async function refresh() {
    const current = ++revision;
    const selected = target;
    if (selected === null) { onChange('idle'); return; }
    try {
      await chrome.tabs.get(selected);
      const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (current === revision) onChange(active[0]?.id === selected ? 'current' : 'away');
    } catch {
      if (current === revision) { target = null; onChange('idle'); }
    }
  }
  const clear = () => { target = null; ++revision; onChange('idle'); };
  chrome.tabs.onActivated.addListener(() => { void refresh(); });
  chrome.windows.onFocusChanged.addListener(() => { void refresh(); });
  chrome.tabs.onRemoved.addListener(tabId => { if (tabId === target) clear(); });
  return {
    bind(tabId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0) return;
      target = tabId;
      void refresh();
    },
    clear,
    async returnToTarget() {
      const selected = target;
      const current = revision;
      if (selected === null) return;
      try {
        const tab = await chrome.tabs.get(selected);
        if (current !== revision || selected !== target) return;
        await chrome.tabs.update(selected, { active: true });
        if (selected !== target) return;
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch { if (selected === target) clear(); }
      await refresh();
    },
  };
}
