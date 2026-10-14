function probeContext(nonce) {
  const key = '__limovaContextFollowV1';
  const dialogs = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')].filter(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      && !element.closest('[hidden],[inert],[aria-hidden="true"]');
  });
  const previous = globalThis[key];
  const changed = !previous || previous.nonce !== nonce || previous.url !== location.href
    || previous.dialogs.length !== dialogs.length || dialogs.some((element, index) => previous.dialogs[index] !== element);
  globalThis[key] = { nonce, url: location.href, dialogs };
  return changed;
}

export function createContextFollow({ chrome, isBusy, isAllowed, observe, onStop, cancel }) {
  let target, targetWindow, nonce, timer, generation = 0, observing = false;
  const stop = () => {
    ++generation; clearTimeout(timer); target = undefined; targetWindow = undefined;
    if (observing) { observing = false; void cancel(); }
    onStop();
  };
  async function tick(current, initial = false) {
    if (current !== generation || target === undefined) return;
    let needsBaseline = initial;
    try {
      if (!await isAllowed()) { if (current === generation) stop(); return; }
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (current !== generation) return;
      if (active?.id !== target) { stop(); return; }
      targetWindow = active.windowId;
      const url = new URL(active.url);
      if (url.protocol !== 'https:' || !await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) {
        if (current === generation) stop(); return;
      }
      if (current !== generation) return;
      if (!isBusy() && !active.pendingUrl && active.status === 'complete') {
        const [result] = await chrome.scripting.executeScript({ target: { tabId: target }, world: 'ISOLATED', func: probeContext, args: [nonce] });
        if (current !== generation) return;
        needsBaseline = false;
        if (result?.result === true && !initial) {
          observing = true;
          const ok = await observe(target);
          if (current !== generation) return;
          observing = false;
          if (!ok) { stop(); return; }
        }
      }
    } catch { if (current === generation) stop(); return; }
    if (current === generation) timer = setTimeout(() => { void tick(current, needsBaseline); }, 1500);
  }
  chrome.tabs.onActivated.addListener(({ tabId }) => { if (target !== undefined && tabId !== target) stop(); });
  chrome.tabs.onRemoved.addListener(tabId => { if (tabId === target) stop(); });
  chrome.windows.onFocusChanged.addListener(windowId => {
    if (target !== undefined && targetWindow !== undefined && windowId !== targetWindow) stop();
  });
  return {
    start(tabId) {
      ++generation; clearTimeout(timer); target = undefined; targetWindow = undefined;
      if (observing) { observing = false; void cancel(); }
      if (!Number.isSafeInteger(tabId) || tabId < 0) return;
      target = tabId; nonce = crypto.randomUUID();
      void tick(generation, true);
    },
    stop,
  };
}
