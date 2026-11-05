import { notFound } from "next/navigation";
import { requireDemoStaff } from "../demo-auth";
import { formatParisDateTime } from "@/lib/paris-date";
import styles from "../../intake.module.css";
import pilot from "../demo.module.css";
import { PILOT_EVIDENCE, demoBasisLabels, demoConsoleEnabled, demoOwnerLabels, demoSetLabels, findDemoCase } from "../demo-cases";
import { pilotHandLabels, pilotReadingLabels } from "../pilot-access-evidence";
import { DemoBackLink } from "../demo-navigation";

export const dynamic = "force-dynamic";

// Detail of one demonstration case, from the same object as its list row and its counter. 404 in production and for an unknown
// reference; the return link only accepts the demonstration list with a known filter.
export default async function SavDemoCasePage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams?: Promise<{ returnTo?: string }> }) {
  if (!demoConsoleEnabled()) notFound();
  await requireDemoStaff();
  const c = findDemoCase((await params).ref);
  if (!c) notFound();
  const query = await searchParams;
  return <div className={styles.console}>
    <DemoBackLink className={styles.back} returnTo={query?.returnTo}/>
    <header className={styles.heading}><div><span className="eyebrow">Démonstration · {demoSetLabels[c.set]} · dossier fictif</span><h1>{c.title}</h1><p>{c.state}</p></div></header>
    <div className={styles.detailGrid}><div>
      <section className={styles.decision} aria-labelledby="demo-message"><h2 id="demo-message">Mail fictif</h2>
        <dl><div><dt>Objet</dt><dd>{c.subject}</dd></div><div><dt>Expéditeur</dt><dd>{c.from}</dd></div>
          <div><dt>Reçu</dt><dd><time dateTime={c.receivedAt}>{formatParisDateTime(new Date(c.receivedAt))}</time></dd></div><div><dt>Ticket</dt><dd>{c.ticket}</dd></div></dl>
        <p>{c.message}</p></section>
      <section className={styles.decision} aria-labelledby="demo-owner"><h2 id="demo-owner">Responsable actuel</h2>
        <p><strong>{demoOwnerLabels[c.owner]}</strong></p>{!c.pilot && <p>{c.ownerWhy}</p>}</section>
      {c.pilot && <>
        <section className={styles.decision} aria-labelledby="demo-hand"><h2 id="demo-hand">Qui a la main</h2>
          <p><span className={pilot.hand} data-hand={c.pilot.hand}>{pilotHandLabels[c.pilot.hand]}</span></p>
          <dl><div><dt>Lecture du propriétaire</dt><dd>{pilotReadingLabels[c.pilot.reading]}</dd></div>
            <div><dt>{c.pilot.cause ? "Cause de non-prise" : "Pourquoi l’agent"}</dt><dd>{c.ownerWhy}</dd></div></dl></section>
        <section className={styles.decision} aria-labelledby="demo-flow"><h2 id="demo-flow">Parcours : mail V1, admission, puis SAV Pilote ou équipe</h2>
          <ol className={pilot.flow}>{c.pilot.flow.map(f => <li key={f.step}><div><strong>{f.step}</strong><p>{f.value}</p>
            <span className={pilot.basis} data-basis={f.basis}>{demoBasisLabels[f.basis]}</span></div></li>)}</ol></section>
        <section className={styles.decision} aria-labelledby="demo-today"><h2 id="demo-today">Production, raccord testé, suite de C</h2>
          <div className={pilot.compare}>
            <div><h3>Production aujourd’hui</h3><p><strong>{c.pilot.today}</strong></p></div>
            <div><h3>Raccord testé localement par A</h3><p><strong>{demoOwnerLabels[c.owner]}</strong></p><p>{c.state}</p></div>
            <div data-status={c.pilot.downstream.status}><h3>Suite de B et C</h3><p>{c.pilot.downstream.text}</p></div>
          </div></section>
        <section className={styles.decision} aria-labelledby="demo-identities"><h2 id="demo-identities">Trois identités, jamais confondues</h2>
          <dl><div><dt>Intégration qui appelle l’API</dt><dd>{c.pilot.identities.api}</dd></div><div><dt>Propriétaire HubSpot du ticket</dt><dd>{c.pilot.identities.ticketOwner}</dd></div>
            <div><dt>Auteur affiché des actions</dt><dd>{c.pilot.identities.author}</dd></div></dl></section>
      </>}
      {c.pilot && PILOT_EVIDENCE.ok ? <section className={styles.decision} aria-labelledby="demo-proofs"><h2 id="demo-proofs">Preuves du raccord (artefact SYN, révision {PILOT_EVIDENCE.evidence.revision})</h2>
        <ul className={styles.evidence}>
          <li>Pôle A · head {PILOT_EVIDENCE.evidence.sources.A.head?.slice(0, 7)} · {PILOT_EVIDENCE.evidence.sources.A.result}</li>
          {c.proofs.map(p => <li key={p}>{p}</li>)}
          <li>Pôle C · {PILOT_EVIDENCE.evidence.sources.C.result}</li>
        </ul>
        <details className={pilot.techRefs}><summary>Références techniques (titres des tests du pôle A)</summary>
          <ul className={styles.evidence}>{c.pilot.evidence.map(e => <li key={e.test}><code>{e.test}</code></li>)}</ul></details>
        {c.rules.map(r => <p key={r}>{r}</p>)}</section>
      : <section className={styles.decision} aria-labelledby="demo-proofs"><h2 id="demo-proofs">Preuves (déclarées par la démonstration)</h2>
        <ul className={styles.evidence}>{c.proofs.map(p => <li key={p}>{p}</li>)}</ul></section>}
      {c.machine && <section className={styles.decision} aria-labelledby="demo-agent"><h2 id="demo-agent">Ce que l’agent V2 a fait</h2>
        <ul><li>{c.machine.admitted ? "Dossier admis en V2." : "Dossier non admis en V2."}</li>
          <li>Consultations de connaissances : {c.machine.knowledgeReads}</li><li>Réponses générées : {c.machine.generations}</li><li>Envois : {c.machine.sends}</li></ul>
        <p>Chiffres écrits dans la démonstration : aucun n’est mesuré.</p>
        {c.rules.map(r => <p key={r}>{r}</p>)}</section>}
      <section className={styles.decision} aria-labelledby="demo-next"><h2 id="demo-next">Prochaine action</h2><p>{c.next}</p></section>
      <section className={styles.history} aria-labelledby="demo-real"><h2 id="demo-real">Suivi réel</h2>
        <p>Aucun : ce dossier est fictif. Le registre des effets, HubSpot et Gmail ne sont pas lus ici, et aucune commande n’est proposée.</p></section>
    </div></div>
  </div>;
}
