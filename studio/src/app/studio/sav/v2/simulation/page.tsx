import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { BackLink } from "@/components/ui/back-link";
import { Badge, PageHeader, Status } from "@/components/ui/primitives";
import { readSimulationReport, type SimulationReportRead } from "../simulation-report";
import { simulationReportSource } from "../simulation-report-port";
import styles from "../v2.module.css";

export const dynamic = "force-dynamic";
type Read = SimulationReportRead | { state: "absent" } | { state: "unavailable" };
const tone = (verdict: string) => verdict === "match" || verdict === "refused_as_expected" ? "neutral" : verdict === "mismatch" || verdict === "invalid" || verdict === "inconsistent" ? "danger" : "warning";

// Rehearsal of the V2 cases on pole B's synthetic report (common-1), strictly read-only: one source fixed in code, no URL
// parameter read, every text escaped by React, no link built from the report, no button, form or write.
export default async function SavV2SimulationPage() {
  await requireIntakeConsoleStaff();
  let read: Read;
  if (!simulationReportSource) read = { state: "absent" };
  else {
    let input: unknown;
    try { input = await simulationReportSource(); read = readSimulationReport(input); } catch { read = { state: "unavailable" }; }
  }
  return <>
    <PageHeader back={<BackLink fallback="/studio/sav/v2">Retour</BackLink>} title="Répétition V2 (simulation)" status={<><Badge>Lecture seule</Badge><Badge>Synthétique</Badge></>}
      description="Rapport de banc du pôle B sur des dossiers fictifs. Tous les envois sont simulés sur un Gmail synthétique : rien n’est parti, aucun client n’est concerné."/>
    {read.state === "absent" ? <p className={styles.notice} role="status">Aucun rapport de répétition n’est branché sur cette version : cela ne veut pas dire qu’aucun n’existe.</p>
      : read.state === "unavailable" ? <p className={styles.notice} role="alert">Rapport de répétition indisponible : la lecture a échoué. Ce n’est pas un rapport vide.</p>
      : read.state === "invalid" ? <p className={styles.notice} role="alert">{read.reason}</p>
      : <>
        <section className={styles.card} aria-labelledby="sim-run"><h2 id="sim-run">Passage {read.runId}</h2>
          <p>{read.phases}</p>
          <p>Code : {read.base}.</p>
          <p className={styles.small}>Empreinte du rapport relu : {read.sourceHash}</p>
          <ul>{read.provenance.map((line, i) => <li key={i} className={styles.small}>{line}</li>)}</ul>
        </section>
        <section className={styles.card} aria-labelledby="sim-totals"><h2 id="sim-totals">Résultats</h2>
          <ul>
            <li>Conformes : {read.totals.match} · refus attendus obtenus : {read.totals.refused_as_expected}</li>
            <li>Différents : {read.totals.mismatch} · incohérents : {read.totals.inconsistent}</li>
            <li>Non comparables : {read.totals.not_comparable} · non probants : {read.totals.not_probative} · invalides : {read.totals.invalid}</li>
          </ul>
          {read.doubleSends ? <p role="alert"><Status tone="danger">Double envoi simulé dans {read.doubleSends} dossier{read.doubleSends > 1 ? "s" : ""}</Status></p> : <p>Aucun double envoi simulé.</p>}
          <p className={styles.small}>Appels payants : {read.paidCalls} (un rapport avec un appel payant est refusé). Le texte des réponses n’est pas noté par la machine : une relecture humaine viendra plus tard.</p>
        </section>
        {read.cases.map(c => <section key={c.caseRef} className={styles.card} aria-labelledby={`sim-${c.caseRef}`}>
          <h2 id={`sim-${c.caseRef}`}>{c.caseRef} · {c.scenario}</h2>
          <p><Status tone={tone(c.verdict)}>{c.verdictLabel}</Status> <span className={styles.small}>Déclaré par le banc : {c.declared}.</span></p>
          {c.problems.length ? <ul>{c.problems.map((problem, i) => <li key={i}>{problem}</li>)}</ul> : null}
          {c.notComparable.length ? <><h3>Non comparable</h3><ul>{c.notComparable.map((line, i) => <li key={i}>{line}</li>)}</ul></> : null}
          {c.diff.length ? <><h3>Écarts</h3><ul>{c.diff.map((d, i) => <li key={i}>{d.field} : attendu {d.expected}, obtenu {d.proposed}</li>)}</ul></> : null}
          <p>{c.sends.double ? <Status tone="danger">Double envoi : {c.sends.label}</Status> : c.sends.label}</p>
          {c.sends.duplicateKeys.length ? <p role="alert"><Status tone="danger">Même clé de réponse envoyée plusieurs fois : {c.sends.duplicateKeys.join(", ")}</Status></p> : null}
          {c.sends.perKey.length ? <ul>{c.sends.perKey.map((line, i) => <li key={i} className={styles.small}>{line}</li>)}</ul> : null}
          {c.actions.length ? <ul>{c.actions.map((action, i) => <li key={i}>{action}</li>)}</ul> : <p>Aucune action simulée.</p>}
          {c.refusalLines.length ? <p>Refus : {c.refusalLines.join(" · ")}</p> : null}
          <p className={styles.small}>{c.expectation} {c.cost}.</p>
          <p className={styles.small}>Preuves : {c.proofs.join(" · ")}</p>
        </section>)}
      </>}
  </>;
}
