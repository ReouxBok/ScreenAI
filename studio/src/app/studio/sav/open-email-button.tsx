"use client";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import styles from "./inbox.module.css";

export function OpenEmailButton({ children, subject }: { children: ReactNode; subject: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={`decision-ledger-row ${styles.openButton}`} disabled={pending} aria-busy={pending}
    aria-label={pending ? "Ouverture de l’email en cours" : `Ouvrir l’email : ${subject}`}>
    {children}
  </button>;
}
