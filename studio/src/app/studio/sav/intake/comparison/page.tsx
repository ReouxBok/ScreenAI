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
      <ComparisonForm campaignId={report.campaignId} expectedMessageId={report.rows.slice(0, 10).find(r => r.state === "pending")?.messageId ?? null} stage="sentinels" ready={comparisonPhaseCanContinue(report, "sentinels")} complete={report.rows.slice(0, 10).every(r => r.state !== "pending")}/>
      <ComparisonForm campaignId={report.campaignId} expectedMessageId={report.rows.slice(10).find(r => r.state === "pending")?.messageId ?? null} stage="remaining" ready={comparisonSentinelsReady(report) && comparisonPhaseCanContinue(report, "remaining")} complete={report.rows.slice(10).every(r => r.state !== "pending")}/>
      <section className={styles.choice}><h2>Preuves privées par dossier</h2>
        <p>« Identique » compare deux projections du plan : ce n’est ni un jugement métier ni une qualification. Seule une attestation humaine d’un reçu complet face à l’attendu figé compte.</p>
        <ol>{report.rows.filter(row => row.state !== "pending").map(row => <li key={row.messageId}>
          <Link href={`/studio/sav/intake/comparison/${row.messageId}`}>{row.verdict ?? row.state} · preuve {row.qualificationEvidence ?? "absente"} · {row.attestation === null ? "non attesté" : row.attestation === "invalid" ? "attestation invalide" : row.attestation.outcome === "matches_oracle" ? "attesté conforme" : "attesté non conforme"}</Link>
        </li>)}</ol>
      </section>
      <details className={styles.choice}><summary>Résultats détaillés — administrateur</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
    </>}
  </div>;
}
