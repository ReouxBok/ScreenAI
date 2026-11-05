import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import styles from "./ui.module.css";

// SAV-51, second part. These wrap native elements and pass every prop through,
// so existing forms keep their exact `name`, `action` and hidden fields.

export function Card({ title, description, actions, children, ...props }: Omit<ComponentProps<"section">, "title"> & { title?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <section className={styles.card} {...props}>
    {title || actions ? <div className={styles.cardHeader}><div>{title ? <h2>{title}</h2> : null}{description ? <p>{description}</p> : null}</div>{actions}</div> : null}
    {children}
  </section>;
}

/** Label, hint and error tied to the control by id, so screen readers read them. */
export function Field({ id, label, hint, error, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return <div className={styles.field}>
    <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
    {children}
    {hint ? <span className={styles.fieldHint} id={`${id}-hint`}>{hint}</span> : null}
    {error ? <span className={styles.fieldError} id={`${id}-error`} role="alert">{error}</span> : null}
  </div>;
}

/** aria-describedby for a control placed in <Field id hint error>. */
export const describedBy = (id: string, { hint, error }: { hint?: unknown; error?: unknown }) =>
  [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={[styles.input, className].filter(Boolean).join(" ")} {...props}/>;
}

export function TextArea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={[styles.input, className].filter(Boolean).join(" ")} {...props}/>;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={[styles.input, className].filter(Boolean).join(" ")} {...props}/>;
}

/** A radio presented as a card; the whole card is the label. */
export function RadioCard({ label, description, ...props }: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; description?: ReactNode }) {
  return <label className={styles.choice}><input type="radio" {...props}/><span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span></label>;
}

export function Checkbox({ label, ...props }: Omit<ComponentProps<"input">, "type"> & { label: ReactNode }) {
  return <label className={styles.check}><input type="checkbox" {...props}/><span>{label}</span></label>;
}

/** Native disclosure: works without JavaScript and keeps its content in the page. */
export function Collapsible({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return <details className={styles.disclosure} open={defaultOpen}><summary>{summary}</summary><div className={styles.disclosureBody}>{children}</div></details>;
}

export type MenuLink = { key: string; label: string; href: string };

/** "Autres vues": secondary views behind one button, the current one marked. */
export function OverflowMenu({ label, links, current }: { label: string; links: MenuLink[]; current?: string }) {
  if (!links.length) return null;
  const active = links.find(link => link.key === current);
  return <details className={styles.menu}>
    <summary className={styles.button} aria-label={active ? `${label} : ${active.label}` : label}>{label}{active ? ` · ${active.label}` : ""} <span aria-hidden="true">▾</span></summary>
    <ul className={styles.menuList}>
      {links.map(link => <li key={link.key}><Link href={link.href} aria-current={link.key === current ? "page" : undefined}>{link.label}</Link></li>)}
    </ul>
  </details>;
}
