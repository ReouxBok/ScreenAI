import Link from "next/link";
import { formatParisDateTime } from "@/lib/paris-date";
import { notFound } from "next/navigation";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { synPreviewEnabled } from "@/lib/sav/local-syn";
import styles from "../intake.module.css";
import { readPassage } from "./passage";
export const dynamic = "force-dynamic";
export default async function PilotPassagePage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  if (!synPreviewEnabled()) notFound();
  await requireIntakeConsoleStaff();
  const query = await searchParams, read = readPassage();
  if (!read.ok) return <div className={styles.console}><Link href="/studio/sav/intake">← Retour aux demandes</Link><h1>Pilote connexion · SYN</h1><section role="alert"><h2>Parcours non disponible</h2><p>{read.reason}</p><p>Aucun résultat n’est déduit d’une preuve absente ou illisible.</p></section></div>;
  const data = read.data, selected = query.ref ? data.scenarios.find(c => c.ref === query.ref) : null;
  if (query.ref && !selected) notFound();
  return <div className={styles.console}>
    <Link className={styles.back} href={selected ? `/studio/sav/intake/pilot#${selected.ref}` : "/studio/sav/intake"}>{selected ? "← Retour aux trois scénarios" : "← Retour aux demandes"}</Link>
    <header className={styles.heading}><div><span className="eyebrow">Studio · simulation locale SYN</span><h1>{selected ? selected.label : "Pilote connexion : trois scénarios"}</h1><p>Compte existant · aucune connexion à un service réel · aucun envoi</p></div></header>
    <section className={styles.notice} aria-label="Portée de la simulation"><h2>Ce qui a été exécuté localement</h2><p>{data.provenance}</p><p>Les transports CRM, la connaissance et la réponse du modèle sont synthétiques. La prise du ticket face à une intervention humaine n’est pas garantie atomiquement.</p></section>
    {!selected ? <section className={styles.list} aria-label="Trois scénarios du pilote">{data.scenarios.map(c => <Link id={c.ref} key={c.ref} className={styles.row} href={`/studio/sav/intake/pilot?ref=${c.ref}`}><div><strong>{c.label}</strong><span>{c.ref} · données inventées</span></div><div><strong>{c.responsible}</strong><span>{c.reason}</span></div><div>{c.draft ? "Brouillon IA à valider" : "Aucun brouillon"}<span>Envois : {c.counters.mailsSent}</span></div></Link>)}</section> : <>
      <section className={styles.decision}><h2>Du mail V1 à l’admission V2</h2><ol>{selected.flow.map(step => <li key={step.label}><strong>{step.label}</strong><p>{step.text}</p><small>{step.basis}</small></li>)}</ol></section>
      <section className={styles.decision}><h2>Qui a la main</h2><p><strong>{selected.responsible}</strong></p><p>{selected.reason}</p><p>Lecture CRM synthétique : {selected.ownerReading}</p></section>
      <section className={styles.decision}><h2>Fiche et preuves consultées</h2>{selected.scope && <p>Périmètre injecté dans la simulation, sans approbation réelle : {selected.scope}</p>}{selected.sources.length ? selected.sources.map(source => <div key={`${source.id}/${source.version}`}><h3>{source.title}</h3><p>{source.content}</p><dl><div><dt>Référence</dt><dd>{source.id}</dd></div><div><dt>Version</dt><dd style={{ overflowWrap: "anywhere" }}>{source.version}</dd></div><div><dt>Vérification lue dans la fixture</dt><dd><time dateTime={source.verifiedAt}>{formatParisDateTime(new Date(source.verifiedAt))}</time></dd></div><div><dt>État lu chez le producteur</dt><dd>{source.verification === "fresh" ? "Vérification récente" : "Nouvelle vérification à prévoir"} · évalué le <time dateTime={source.evaluatedAt}>{formatParisDateTime(new Date(source.evaluatedAt))}</time></dd></div><div><dt>Provenance</dt><dd>Fixture SYN injectée au contrat local de recherche ; aucune fiche réelle publiée</dd></div></dl></div>) : <p>Aucune connaissance consultée : le dossier reste à l’équipe avant investigation.</p>}</section>
      <section className={styles.decision}><h2>{selected.draft ? "Brouillon avec mention IA · à valider" : "Suite pour l’équipe"}</h2>{selected.draft ? <><p>Texte prévu après validation. Aucune validation humaine n’est acquise dans cet extrait.</p><p style={{ whiteSpace: "pre-wrap" }}>{selected.draft}</p><p><strong>Non envoyé.</strong> La réponse est produite par une fixture de modèle. Sa qualité sur une demande réelle n’est pas évaluée ici.</p></> : <p>{selected.reason} Aucun brouillon ni envoi par l’agent.</p>}</section>
      <section className={styles.decision}><h2>Résultats de ce scénario local</h2><dl><div><dt>Appels du modèle simulé</dt><dd>{selected.counters.modelCalls}</dd></div><div><dt>Requêtes POST CRM simulées</dt><dd>{selected.counters.posts}</dd></div><div><dt>Écritures de propriétaire simulées</dt><dd>{selected.counters.ownerWrites}</dd></div><div><dt>Envois</dt><dd>{selected.counters.mailsSent}</dd></div></dl></section>
    </>}
    <details className={styles.decision}><summary>Version et preuve de reproduction</summary><p>SHA du producteur C : <code style={{ overflowWrap: "anywhere" }}>{data.producerSha}</code></p><p>Empreinte de l’artefact : <code style={{ overflowWrap: "anywhere" }}>{data.artifactHash}</code></p><p>{data.evidence}</p></details>
  </div>;
}
