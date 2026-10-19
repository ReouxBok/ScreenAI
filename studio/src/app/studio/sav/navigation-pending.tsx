"use client";
import { useLinkStatus } from "next/link";
import styles from "./loading-state.module.css";

/** Link-local feedback when the destination shell has not been prefetched. */
export function SavNavigationPending({ label = "Chargement…" }: { label?: string }) {
  const { pending } = useLinkStatus();
  return <span className={`${styles.pendingSlot} ${pending ? styles.pendingVisible : ""}`} aria-hidden={!pending}>
    <span className={styles.pendingMessage} role={pending ? "status" : undefined}>{label}</span>
  </span>;
}
