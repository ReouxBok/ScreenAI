import { randomUUID } from "node:crypto";
import Link from "next/link";
import { executionAdministrator } from "@/lib/sav/intake/execution-policy";
import { LaunchAdminForm } from "./launch-form";
import { ContinuityAdminForm } from "./continuity-form";
import styles from "../intake.module.css";
export const dynamic="force-dynamic";
export default async function IntakeLaunchPage() {
  await executionAdministrator();
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">Administration SAV</span><h1>Lancement des nouveaux mails</h1>
      <p>La confirmation conserve une frontière initiale immuable et une politique bornée. Elle ne change aucun interrupteur serveur et n’appelle aucun fournisseur.</p></div></header>
    <LaunchAdminForm commandId={randomUUID()}/>
    <ContinuityAdminForm/>
  </div>;
}
