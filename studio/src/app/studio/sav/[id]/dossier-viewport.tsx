"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

type Position = { left: number; top: number; hash: string; path: string; at: number };
const storageKey = "sav-dossier-viewport:v1";
function currentPosition(): Position {
  return { left: window.scrollX, top: window.scrollY, hash: window.location.hash, path: window.location.pathname, at: Date.now() };
}
function savePosition(position: Position) {
  try { sessionStorage.setItem(storageKey, JSON.stringify(position)); } catch { /* Memory restoration still works without storage. */ }
}
function savedPosition(): Position | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (value && value.path === window.location.pathname && typeof value.hash === "string"
      && Number.isFinite(value.top) && value.top >= 0 && Number.isFinite(value.left) && value.left >= 0
      && Number.isFinite(value.at) && Date.now() - value.at >= 0 && Date.now() - value.at < 300_000) return value;
  } catch { /* An unavailable or invalid record must not block the dossier. */ }
  return null;
}

/** Keep the reading position when an action replaces this dossier's server
 * payload. The page keys this boundary by dossier, so normal navigation and
 * the browser's own history restoration remain in charge on entry. */
export function DossierViewport({ children }: { children: ReactNode }) {
  const position = useRef<Position | null>(null);
  const restoring = useRef(false);
  const leaving = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const remember = () => {
      if (restoring.current || leaving.current) return;
      position.current = currentPosition();
      clearTimeout(timer);
      // One small, tab-local record; no mail text, query parameters or form data.
      timer = setTimeout(() => { if (position.current && !leaving.current) savePosition(position.current); }, 200);
    };
    const save = () => {
      if (leaving.current || restoring.current) return;
      position.current = currentPosition();
      savePosition(position.current);
    };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (new URL(link.href).pathname !== window.location.pathname) {
        leaving.current = true;
        clearTimeout(timer);
        try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
      }
    };
    remember();
    window.addEventListener("scroll", remember, { passive: true });
    window.addEventListener("pagehide", save);
    document.addEventListener("submit", save, true);
    document.addEventListener("click", navigate, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", remember);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("submit", save, true);
      document.removeEventListener("click", navigate, true);
    };
  }, []);

  useLayoutEffect(() => {
    const previous = position.current ?? savedPosition();
    // A deliberate link to another section must still reach its destination.
    if (leaving.current || !previous || window.location.hash && window.location.hash !== previous.hash) return;
    restoring.current = true;
    position.current = previous;
    // Next applies redirect scrolling in its own layout effects. Restore after
    // that commit, using the captured position rather than its scroll event.
    let frame = requestAnimationFrame(() => {
      window.scrollTo({ left: previous.left, top: previous.top, behavior: "instant" });
      position.current = currentPosition();
      savePosition(position.current);
      frame = requestAnimationFrame(() => { restoring.current = false; });
    });
    return () => { cancelAnimationFrame(frame); restoring.current = false; };
  }, [children]);

  return children;
}
