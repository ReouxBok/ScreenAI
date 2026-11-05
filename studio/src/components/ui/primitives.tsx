import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { UiTone } from "./tokens";
import styles from "./ui.module.css";

// Base components of the redesign (SAV-51). They only display what they are
// given: no default count, status or call to action is ever invented.

type Variant = "primary" | "secondary" | "ghost" | "danger";
const buttonClass = (variant: Variant, extra?: string) => [styles.button, variant === "secondary" ? "" : styles[variant], extra].filter(Boolean).join(" ");

/** A real form submit or click handler; the action itself stays the caller's.
 * `busy` announces work in progress; `disabledReason` says why it is unavailable
 * (pass `id` so the reason is linked to the button). */
export function Button({ variant = "secondary", className, type = "button", busy = false, disabledReason, id, disabled, children, ...props }: ComponentProps<"button"> & { variant?: Variant; busy?: boolean; disabledReason?: string }) {
  const reasonId = disabledReason && id ? `${id}-reason` : undefined;
  const button = <button type={type} id={id} className={buttonClass(variant, className)} disabled={disabled || busy || Boolean(disabledReason)}
    aria-busy={busy || undefined} aria-describedby={reasonId} {...props}>{children}</button>;
  return disabledReason ? <span style={{ display: "inline-grid", gap: 4 }}>{button}<span className={styles.busyReason} id={reasonId}>{disabledReason}</span></span> : button;
}

export function ButtonLink({ variant = "secondary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...props}/>;
}

const toneClass = (tone: UiTone) => tone === "neutral" ? "" : styles[`tone-${tone}`];

export function Badge({ tone = "neutral", children }: { tone?: UiTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${toneClass(tone)}`}>{children}</span>;
}

/** Server-provided number only; renders nothing while the value is unknown. */
export function Count({ value, label, tone = "neutral" }: { value: number | null | undefined; label: string; tone?: UiTone }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return <span className={`${styles.badge} ${styles.count} ${toneClass(tone)}`} aria-label={`${value} ${label}`}>{value}</span>;
}

/** Coloured dot plus words: the colour never carries the meaning alone. */
export function Status({ tone = "neutral", children }: { tone?: UiTone; children: ReactNode }) {
  return <span className={`${styles.status} ${toneClass(tone)}`}>{children}</span>;
}

export function PageHeader({ title, description, status, actions, back }: { title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return <>
    {back ? <div className={styles.pageHeaderBack}>{back}</div> : null}
    <header className={styles.pageHeader}>
      <div><div className={styles.pageHeaderTitle}><h1>{title}</h1>{status}</div>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className={styles.pageHeaderActions}>{actions}</div> : null}
    </header>
  </>;
}

export type ViewTab = { key: string; label: string; href: string; count?: number | null };

export function ViewTabs({ label, tabs, current }: { label: string; tabs: ViewTab[]; current: string }) {
  return <nav aria-label={label} className={styles.tabs}>
    {tabs.map(tab => <Link key={tab.key} href={tab.href} className={styles.tab} aria-current={tab.key === current ? "page" : undefined}>
      <span>{tab.label}</span><Count value={tab.count} label={tab.label} tone={tab.key === current ? "accent" : "neutral"}/>
    </Link>)}
  </nav>;
}

/** Empty list: a factual sentence, and an action only if a real one exists. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <section className={styles.state}><h2>{title}</h2>{children ? <p>{children}</p> : null}{action ? <div className={styles.stateActions}>{action}</div> : null}</section>;
}

/** Failure: says nothing was confirmed and offers retry and the way back. */
export function ErrorState({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return <section className={`${styles.state} ${styles.stateError}`} role="alert"><h2>{title}</h2>{children ? <p>{children}</p> : null}{actions ? <div className={styles.stateActions}>{actions}</div> : null}</section>;
}
