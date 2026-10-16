import type { ReactNode } from "react";
import styles from "./dossier.module.css";

/** Numbered, collapsible reading step of a SAV dossier. Native <details>: no client JS. */
export function DossierSection({ id, number, title, subtitle, badge, tone = "neutral", open = true, children }: {
  id: string; number: number; title: string; subtitle?: string; badge?: string; tone?: "neutral" | "todo" | "done"; open?: boolean; children: ReactNode;
}) {
  return <details id={id} className={`card ${styles.section}`} open={open}>
    <summary className={styles.sectionHeader}>
      <span className={styles.sectionNumber} aria-hidden="true">{number}</span>
      <span className={styles.sectionTitle}><h2>{title}</h2>{subtitle && <small>{subtitle}</small>}</span>
      {badge && <span className={`${styles.badge} ${styles[tone]}`}>{badge}</span>}
      <span className={styles.sectionToggle} aria-hidden="true"/>
    </summary>
    <div className={styles.sectionBody}>{children}</div>
  </details>;
}
