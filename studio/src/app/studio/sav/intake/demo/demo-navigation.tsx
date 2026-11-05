"use client";
import Link from "next/link";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { DEMO_LIST_MEMORY, DEMO_LIST_PATH, demoListDestination, parseDemoListMemory } from "./demo-cases";

// Same pattern as the real console's navigation.tsx, under its own key: the demonstration never writes the real list's memory.
export function DemoCaseLink({ href, origin, id, className, children }: { href: string; origin: string; id: string; className: string; children: ReactNode }) {
  return <Link href={href} id={id} className={className} onClick={() => {
    try { sessionStorage.setItem(DEMO_LIST_MEMORY, JSON.stringify({ href: origin, y: window.scrollY, focusId: id })); } catch { /* The explicit return URL still works without storage. */ }
  }}>{children}</Link>;
}
export function DemoListPosition({ origin }: { origin: string }) {
  useEffect(() => {
    let frame: number | undefined;
    try {
      const saved = parseDemoListMemory(sessionStorage.getItem(DEMO_LIST_MEMORY));
      if (saved && saved.href.split("#")[0] === origin.split("#")[0]) frame = requestAnimationFrame(() => {
        window.scrollTo({ top: saved.y, behavior: "instant" });
        document.getElementById(saved.focusId)?.focus({ preventScroll: true });
      });
    } catch { /* Native link/hash and browser history remain available. */ }
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [origin]);
  return null;
}
export function DemoBackLink({ returnTo, className }: { returnTo?: string; className: string }) {
  const explicit = demoListDestination(returnTo);
  const remembered = useSyncExternalStore(() => () => {}, () => {
    try { return parseDemoListMemory(sessionStorage.getItem(DEMO_LIST_MEMORY))?.href ?? null; } catch { return null; }
  }, () => null);
  return <Link href={explicit ?? remembered ?? DEMO_LIST_PATH} className={className}>← Retour à la démonstration</Link>;
}
