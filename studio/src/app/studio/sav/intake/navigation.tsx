"use client";
import Link from "next/link";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { INTAKE_LIST_MEMORY, INTAKE_LIST_PATH, intakeListDestination, parseIntakeListMemory } from "@/lib/sav/intake-ux/navigation";

export function IntakeDossierLink({ href, origin, id, className, children }: { href: string; origin: string; id: string; className: string; children: ReactNode }) {
  return <Link href={href} id={`dossier-${id}`} className={className} onClick={() => {
    try { sessionStorage.setItem(INTAKE_LIST_MEMORY, JSON.stringify({ href: origin, y: window.scrollY, focusId: `dossier-${id}` })); } catch { /* The explicit return URL still works without storage. */ }
  }}>{children}</Link>;
}
export function IntakeListPosition({ origin }: { origin: string }) {
  useEffect(() => {
    let frame: number | undefined;
    try {
      const saved = parseIntakeListMemory(sessionStorage.getItem(INTAKE_LIST_MEMORY));
      if (saved && saved.href.split("#")[0] === origin.split("#")[0]) frame = requestAnimationFrame(() => {
        window.scrollTo({ top: saved.y, behavior: "instant" });
        document.getElementById(saved.focusId)?.focus({ preventScroll: true });
      });
    } catch { /* Native link/hash and browser history remain available. */ }
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [origin]);
  return null;
}
export function IntakeBackLink({ returnTo, className }: { returnTo?: string; className: string }) {
  const explicit = intakeListDestination(returnTo);
  const remembered = useSyncExternalStore(() => () => {}, () => {
    try { return parseIntakeListMemory(sessionStorage.getItem(INTAKE_LIST_MEMORY))?.href ?? null; } catch { return null; }
  }, () => null);
  return <Link href={explicit ?? remembered ?? INTAKE_LIST_PATH} className={className}>← Retour à la liste SAV</Link>;
}
