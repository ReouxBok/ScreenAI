"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Activity, BookMarked, BookOpen, ClipboardCheck, GitBranch, Gauge, GraduationCap, Inbox, LineChart, ListChecks, ShieldCheck, type LucideIcon } from "lucide-react";
import { isNavItemActive, type NavGroup, type NavIcon } from "./studio-navigation";
import styles from "./studio-shell.module.css";

const icons: Record<NavIcon, LucideIcon> = {
  overview: Gauge, contents: BookOpen, trainings: GraduationCap, template: GitBranch, validations: ShieldCheck, quality: ClipboardCheck,
  requests: Inbox, knowledge: BookMarked, evaluation: LineChart, resolutions: ListChecks, health: Activity,
};

/** On phones the menu folds behind a button and closes after each navigation. */
export function StudioMenu({ groups, children }: { groups: NavGroup[]; children: ReactNode }) {
  // Remembering where it was opened closes it as soon as the page changes.
  const pathname = usePathname() ?? "", [openAt, setOpenAt] = useState<string | null>(null), open = openAt === pathname;
  return <div className={styles.menu} data-open={open ? "true" : "false"}>
    <button type="button" className={styles.menuToggle} aria-expanded={open} aria-controls="studio-menu" onClick={() => setOpenAt(open ? null : pathname)}>{open ? "Fermer" : "Menu"}</button>
    <div id="studio-menu" className={styles.menuPanel}><StudioNav groups={groups} pathname={pathname}/>{children}</div>
  </div>;
}

export function StudioNav({ groups, pathname }: { groups: NavGroup[]; pathname: string }) {
  return <nav className={styles.nav} aria-label="Navigation principale">
    {groups.map(group => <div key={group.key} className={group.key === "footer" ? `${styles.group} ${styles.footerGroup}` : styles.group}>
      {group.label ? <span className={styles.groupLabel} id={`nav-${group.key}`}>{group.label}</span> : null}
      <ul aria-labelledby={group.label ? `nav-${group.key}` : undefined}>
        {group.items.map(item => {
          const Icon = icons[item.icon], active = isNavItemActive(item, pathname);
          return <li key={item.key}><Link href={item.href} className={styles.navLink} aria-current={active ? "page" : undefined}><Icon size={18} aria-hidden="true"/><span>{item.label}</span></Link></li>;
        })}
      </ul>
    </div>)}
  </nav>;
}
