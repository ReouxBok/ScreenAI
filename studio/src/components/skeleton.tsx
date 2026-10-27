import type { CSSProperties, ReactNode } from "react";
import styles from "./skeleton.module.css";

/** Placeholder shapes only: a skeleton never shows a count, a status or a result
 * before the server has confirmed it. Sizes are fixed so content swaps in place. */
export function SkeletonLine({ width = "100%", height = 12, inline = false, style }: { width?: number | string; height?: number; inline?: boolean; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`${styles.bone} ${inline ? styles.inline : ""}`} style={{ width, height, ...style }}/>;
}

export function SkeletonBlock({ height, style }: { height: number; style?: CSSProperties }) {
  return <div aria-hidden="true" className={`${styles.bone} ${styles.block}`} style={{ height, ...style }}/>;
}

/** Busy region announced once to assistive technology; children stay decorative. */
export function SkeletonRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <div className={className} role="status" aria-busy="true" aria-live="polite">
    <span className={styles.status}>{label}</span>
    {children}
  </div>;
}

/** Generic Studio page: title area then content cards. */
export function StudioPageSkeleton({ label = "Chargement de la page", eyebrow, cards = 3 }: { label?: string; eyebrow?: string; cards?: number }) {
  return <SkeletonRegion label={label} className={styles.page}>
    <div>
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : <SkeletonLine width={90} height={10}/>}
      <SkeletonLine width="min(420px, 80%)" height={34} style={{ margin: "10px 0" }}/>
      <SkeletonLine width="min(560px, 95%)" height={12}/>
    </div>
    <div className={styles.cards}>{Array.from({ length: cards }, (_, i) => <SkeletonBlock key={i} height={140}/>)}</div>
    <SkeletonBlock height={260}/>
  </SkeletonRegion>;
}
