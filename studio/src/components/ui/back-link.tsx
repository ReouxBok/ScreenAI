"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { UI_HISTORY_KEY, parseHistory, previousEntry, replaceCurrent, safeStudioHref, visit } from "@/lib/ui/navigation-history";
import styles from "./ui.module.css";

const listeners = new Set<() => void>();
const readTrail = () => { try { return sessionStorage.getItem(UI_HISTORY_KEY) ?? "[]"; } catch { return "[]"; } };
const writeTrail = (trail: string[]) => {
  try { sessionStorage.setItem(UI_HISTORY_KEY, JSON.stringify(trail)); } catch { /* Links keep their fallback without storage. */ }
  listeners.forEach(listener => listener());
};
const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Mounted once in the Studio shell: records each page of the tab. */
export function NavigationTrail() {
  const pathname = usePathname(), search = useSearchParams()?.toString();
  useEffect(() => { writeTrail(visit(parseHistory(readTrail()), here())); }, [pathname, search]);
  useEffect(() => {
    const onHash = () => writeTrail(replaceCurrent(parseHistory(readTrail()), here()));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return null;
}

/** "Retour" goes to the page the user came from. Without in-tab history (new tab,
 * shared link) it goes to `fallback`, the parent list with its context. The
 * rendered href is always a real page, so it also works without JavaScript. */
export function BackLink({ fallback, children = "Retour", className }: { fallback: string; children?: ReactNode; className?: string }) {
  const router = useRouter(), pathname = usePathname(), search = useSearchParams()?.toString();
  const raw = useSyncExternalStore(subscribe, readTrail, () => "[]");
  const previous = previousEntry(parseHistory(raw), `${pathname}${search ? `?${search}` : ""}`);
  const target = previous ?? safeStudioHref(fallback) ?? "/studio";
  return <Link href={target} className={[styles.backLink, className].filter(Boolean).join(" ")} onClick={event => {
    if (!previous || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    // Browser back restores the list's scroll position and form state exactly.
    event.preventDefault(); router.back();
  }}><span aria-hidden="true">←</span> {children}</Link>;
}
