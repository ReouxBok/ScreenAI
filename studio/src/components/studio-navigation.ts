import { canCreateTraining, canManageProduction, type StaffRole } from "@/lib/access";
import { canAccessSav } from "@/lib/sav/access";

// Menu of the redesigned shell (SAV-52), grouped like the Paper mockup. Each
// entry keeps the exact visibility rule of the previous menu; the server guards
// of each page are unchanged. No counter is shown: none has a server source yet.

export type NavIcon = "overview" | "contents" | "trainings" | "template" | "validations" | "quality" | "requests" | "knowledge" | "evaluation" | "resolutions" | "health";
/** Serializable so the client menu can mark the current page itself. */
export type NavItem = { key: string; label: string; href: string; icon: NavIcon; match: "exact" | "prefix" | "sav-requests" };
export type NavGroup = { key: string; label?: string; items: NavItem[] };

const under = (prefix: string, pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
/** Console, dossiers and the legacy entry all belong to "Demandes"; sibling SAV sections do not. */
export function isNavItemActive(item: Pick<NavItem, "href" | "match">, pathname: string) {
  if (item.match === "exact") return pathname === item.href;
  if (item.match === "prefix") return under(item.href, pathname);
  return pathname === "/studio/sav" || under("/studio/sav/intake", pathname)
    || /^\/studio\/sav\/(?!connaissances$|evaluation$|resolutions$|pilote$)[^/]+$/.test(pathname);
}

export function studioNavigation(staff: { email: string; role: StaffRole }): NavGroup[] {
  const production = canManageProduction(staff.role);
  const extension: NavItem[] = [
    { key: "contents", label: "Contenus par agent", href: "/studio/contenus", icon: "contents", match: "prefix" },
    ...canCreateTraining(staff.role) ? [{ key: "trainings", label: "Entraînements", href: "/studio/entrainements", icon: "trainings", match: "prefix" } as const] : [],
    ...production ? [{ key: "template", label: "Trame d’onboarding", href: "/studio/trame", icon: "template", match: "prefix" } as const] : [],
    ...production ? [{ key: "validations", label: "Validations", href: "/studio/validations", icon: "validations", match: "prefix" } as const] : [],
    { key: "quality", label: "Qualité", href: "/studio/tests", icon: "quality", match: "prefix" },
  ];
  const groups: NavGroup[] = [
    { key: "home", items: [{ key: "overview", label: "Vue d’ensemble", href: "/studio", icon: "overview", match: "exact" }] },
    { key: "extension", label: "Extension Chrome", items: extension },
  ];
  if (canAccessSav(staff.email, staff.role)) groups.push({ key: "sav", label: "Agent SAV", items: [
    // Same entry as the previous "SAV IA" link: /studio/sav keeps routing to the active console.
    { key: "requests", label: "Demandes", href: "/studio/sav", icon: "requests", match: "sav-requests" },
    { key: "knowledge", label: "Connaissances", href: "/studio/sav/connaissances", icon: "knowledge", match: "prefix" },
    { key: "evaluation", label: "Évaluation", href: "/studio/sav/evaluation", icon: "evaluation", match: "prefix" },
    // Not in the mockup; reachable today only from the V0 page retired by SAV-60 (open question for Ugo).
    ...production ? [{ key: "resolutions", label: "Résolutions", href: "/studio/sav/resolutions", icon: "resolutions", match: "prefix" } as const] : [],
  ] });
  if (production) groups.push({ key: "footer", items: [{ key: "health", label: "Santé", href: "/studio/sante", icon: "health", match: "prefix" }] });
  return groups;
}
