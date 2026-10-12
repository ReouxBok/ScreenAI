import type { getSavObservations } from "@/lib/sav/observations";
import { savContentHash } from "@/lib/sav/crypto";
import styles from "./proposal-review.module.css";
import { qualifyObservationAction } from "../actions";
const labels: Record<string, string> = { waiting_ticket: "En attente de ticket confirmé", active: "Suivi actif", sources_incomplete: "Sources incomplètes", closed_to_analyze: "Clôturé · bilan à qualifier", candidate_ready: "Candidat prêt · revue séparée requise" };
export function ResolutionObservation({ rows, isUgo }: {
    rows: Awaited<ReturnType<typeof getSavObservations>>;
    isUgo: boolean;
}) {
    if (!rows.length)
        return null;
    return <section className={`card ${styles.review} ${styles.observation}`} aria-labelledby="observation-title"><span className="eyebrow">Résolution humaine après refus</span><h2 id="observation-title">Journal du suivi</h2><p>Notifications HubSpot puis rattrapage quotidien par lots. Aucune action CRM ou Gmail déclenchée par ce suivi.</p>{rows.map(row => <article key={row.id}>
  <h3>{labels[row.state] ?? row.state} · cycle {row.cycle}</h3><p>Refus enregistré le {row.createdAt.toLocaleString("fr-FR")}.</p><p>Ticket : {row.hubspotTicketId ? `#${row.hubspotTicketId}` : "aucun lien fiable"}. Dernière synchronisation réussie : {row.lastSyncAt?.toLocaleString("fr-FR") ?? "jamais"}. Prochain rattrapage : {row.nextSyncAt.getUTCFullYear() === 9999 ? "terminé après clôture · notifications toujours prises en compte" : row.nextSyncAt.toLocaleString("fr-FR")}{row.nextSyncAt < new Date() ? " · en retard" : ""}.</p>
  {row.sourceErrors.length > 0 && <p role="alert">Sources à vérifier : {row.sourceErrors.join(" ; ")}</p>}
  {row.qualifications.length>0 && <details><summary>Historique des qualifications Ugo</summary>{row.qualifications.map((q,index)=><article key={index}><p>{new Date(q.occurredAt).toLocaleString("fr-FR")} · {q.author}</p><pre>{q.text}</pre></article>)}</details>}
            {row.cycles.map(c => <details key={c.id} open={c.cycle === row.cycle}><summary>Cycle {c.cycle} · {c.status} · {c.qualification ?? "non qualifié"}</summary>
   <p>{c.summary.coverage}</p><p>Motif du refus : {c.summary.refusalReason || "Non renseigné"}.</p><details><summary>Brouillon refusé</summary><pre>{c.summary.draftRefused}</pre></details>
   <p>Confirmation client explicite repérée : {c.summary.customerConfirmation.length ? "à vérifier dans les sources" : "aucune"}. Fermer le ticket ne prouve pas sa résolution.</p>
   <ol>{c.summary.events.map((event, index) => <li key={`${event.sourceRef}:${index}`}><p>{new Date(event.occurredAt).toLocaleString("fr-FR")} · {event.kind} · {event.author ?? "auteur non fourni"} · {event.provenance} · {event.sourceRef}</p><pre>{event.text}</pre></li>)}</ol>
   {c.candidateId && <p>Candidat préparé. Sa validation et sa publication restent distinctes dans les résolutions.</p>}
   {row.closed && c.cycle === row.cycle && isUgo && <form action={qualifyObservationAction}>
    <input type="hidden" name="threadId" value={row.threadId}/><input type="hidden" name="observationId" value={row.id}/><input type="hidden" name="cycleId" value={c.id}/><input type="hidden" name="sourceHash" value={c.sourceHash}/>
    <label>Qualification du résultat<select name="outcome"><option value="closed_without_resolution">Clôture sans résolution attestée</option><option value="resolved">Résolution attestée · proposer un candidat</option><option value="abandoned">Abandon</option><option value="duplicate">Doublon</option><option value="finance">Finance · cas supervisé</option><option value="cancellation">Résiliation</option><option value="insufficient_sources">Sources insuffisantes</option></select></label>
    <label>Preuve humaine à qualifier<select name="evidence"><option value="">Aucune preuve retenue</option>{c.summary.events.filter(e => e.kind === "human_reply" || e.kind === "note").map(e => <option key={e.sourceRef} value={JSON.stringify({ sourceRef: e.sourceRef, contentHash: savContentHash(e) })}>{e.sourceRef} · {e.kind} · {e.text.slice(0, 80)}</option>)}</select></label>
    <label>Confirmation client vérifiée par Ugo<select name="customerConfirmationRef"><option value="">Aucune confirmation retenue</option>{c.summary.customerConfirmation.map(ref=><option key={ref} value={ref}>{ref}</option>)}</select></label>
    <label>Justification d’Ugo<textarea name="justification" required minLength={20} maxLength={2000}/></label><label>Procédure générique proposée (sans donnée client)<textarea name="resolution" maxLength={10000}/></label><label><input type="checkbox" name="unconfirmedAcknowledged"/> J’ai vérifié la preuve humaine malgré l’absence de confirmation explicite du client.</label>
    <button className="primary">Qualifier le bilan</button><p>Seule une résolution attestée, suffisamment sourcée et réutilisable prépare un candidat non publié. Une note doit être vérifiée comme preuve effective ; une tâche terminée seule ne suffit pas.</p>
   </form>}
  </details>)}
 </article>)}</section>;
}
