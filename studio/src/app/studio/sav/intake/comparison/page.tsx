import Link from "next/link";
import { comparisonPhaseCanContinue, comparisonSentinelsReady, readIntakeComparisonPanel } from "@/lib/sav/intake/comparison-operator";
import { ComparisonForm } from "./comparison-form";
import styles from "../intake.module.css";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export default async function ComparisonPage() {
  const report = await readIntakeComparisonPanel();
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">Qualification séparée</span><h1>Comparer les lecteurs SAV</h1>
      <p>Aucun email ni ticket modifié. Le lecteur des nouveaux emails reste inchangé.</p></div></header>
    {!report.configured ? <p>Campagne non configurée : aucun appel payant possible.</p> : <>
      <section className={styles.choice}><h2>Avancement</h2>
        <p>{report.denominators.done} / {report.denominators.listed} dossiers avec résultat · {report.denominators.interrupted} interrompus.</p>
        <p>Compté : {(report.spend.nanoUsd / 1e9).toFixed(4)} USD. Plafond total : {(report.spend.maxNanoUsd / 1e9).toFixed(2)} USD. Expiration : {report.until}.</p>
        <p>Les réservations incertaines restent comptées. Un résultat identique ne prouve pas à lui seul une bonne décision.</p>
      </section>
      <ComparisonForm stage="sentinels" ready={comparisonPhaseCanContinue(report, "sentinels")} complete={report.rows.slice(0, 10).every(r => r.state !== "pending")}/>
      <ComparisonForm stage="remaining" ready={comparisonSentinelsReady(report) && comparisonPhaseCanContinue(report, "remaining")} complete={report.rows.slice(10).every(r => r.state !== "pending")}/>
      <details className={styles.choice}><summary>Résultats détaillés — administrateur</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
    </>}
  </div>;
}
