import Link from "next/link";
import { getSavV0Cutover } from "@/lib/sav/cutover";
import { listSavActionIncidents, listSavInbox, listSavWebhookIncidents } from "@/lib/sav/service";
import { savActionLabels, savDecisionLabels, savLabel } from "@/lib/sav/labels";
import { retryWebhookAction } from "./actions";
import { openSavEmailAction } from "./open-email-actions";
import { OpenEmailButton } from "./open-email-button";
import styles from "./inbox.module.css";

export async function SavV0Inbox({ searchParams }: { searchParams: Promise<{ view?: string; q?: string; page?: string }> }) {
  const { view = "all", q = "", page = "1" } = await searchParams;
  const currentPage = Math.max(1, Math.min(2000, Math.trunc(Number(page)) || 1));
  const [cutover, rows, syncIncidents, actionIncidents] = await Promise.all([getSavV0Cutover(), listSavInbox(51, { offset: (currentPage - 1) * 50, view, query: q }), listSavWebhookIncidents(20), listSavActionIncidents(20)]);
  const href = (page: number) => `/studio/sav?${new URLSearchParams({ view, q, page: String(page) })}`;
  return <>
    <div className="page-intro compact"><div><span className="eyebrow">SAV IA · V0 supervisée</span><h1>Propositions à piloter</h1><p>Emails entrants de contact@limova.ai après activation. Brouillons dans le Studio uniquement ; création ou rattachement HubSpot par clic humain séparé.</p></div></div>
    <p className="login-notice">{cutover ? `Activation : ${new Date(cutover.receivedAfter).toLocaleString("fr-FR")}. Les anciens emails restent hors de cette file.` : "Activation non effectuée : aucun ancien email ne sera proposé rétroactivement."}{process.env.SAV_WRITES_DISABLED === "true" && " Écritures externes bloquées."}</p>
    <nav className="sav-tabs" aria-label="Vues SAV">{[["all", "Tous les emails"], ["pending", "À valider"], ["reviewed", "Revues faites"], ["human", "Reprise humaine"], ["errors", "Erreurs"], ["technical", "Exclusions techniques"]].map(([key, label]) => <Link key={key} className={view === key ? "active" : ""} href={`/studio/sav?view=${key}`}>{label}</Link>)}<Link href="/studio/sav/connaissances">Connaissances</Link><Link href="/studio/sav/resolutions">Résolutions</Link><Link href="/studio/sav/pilote">Laboratoire</Link><Link href="/studio/sav/evaluation">Évaluation et décision</Link></nav>
    <form className="sav-search" method="get"><input type="hidden" name="view" value={view}/><label htmlFor="sav-q">Rechercher dans toute la file</label><div><input id="sav-q" name="q" defaultValue={q} maxLength={200} placeholder="Expéditeur, objet ou extrait…"/><button>Rechercher</button></div></form>
    <section className="decision-ledger" aria-label="Emails synchronisés"><header><span>Email</span><span>Qualification</span><span>État de la proposition</span></header>
      {rows.slice(0, 50).map((row) => <form action={openSavEmailAction} key={row.messageId} className={styles.openForm}>
        <input type="hidden" name="threadId" value={row.threadId}/><input type="hidden" name="messageId" value={row.messageId}/>
        <OpenEmailButton subject={row.subject}>
        <span className="ledger-rail" aria-hidden="true"><i className={row.reviewId ? "decided" : "missing"}/></span>
        <span className="ledger-mail"><small>{row.receivedAt.toLocaleString("fr-FR")}</small><strong>{row.subject}</strong><span>{row.fromEmail}</span><p>{row.preview}</p></span>
        <span className="ledger-decision"><strong>{row.decisionKind ? savLabel(savDecisionLabels, row.decisionKind) : "Analyse en attente"}</strong><p>{row.explanation}</p>{row.confidence !== null && <small>Confiance IA : {Math.round(row.confidence / 10)} %</small>}</span>
        <span className={`ledger-action ${styles.state}`}><strong>{row.analysisErrorCode ? row.analysisStatus === "done" ? "Analyse dégradée" : "Erreur d’analyse" : row.aiPaused ? "Reprise humaine" : row.reviewStatus === "approved" ? "Validée" : row.reviewStatus === "rejected" ? "Refusée" : row.analysisStatus === "done" ? "À relire" : "Analyse en attente"}</strong>{row.analysisErrorCode && <><small>Revue humaine nécessaire</small><code>{row.analysisErrorCode}</code></>}{row.hubspotTicketId && <small>HubSpot #{row.hubspotTicketId}</small>}</span>
        </OpenEmailButton>
      </form>)}
      {!rows.length && <div className="empty card">Aucun email dans cette vue. Les exclusions restent consultables séparément.</div>}
    </section>
    <nav className="sav-tabs" aria-label="Pagination">{currentPage > 1 && <Link href={href(currentPage - 1)}>← Page précédente</Link>}<span>Page {currentPage}</span>{rows.length > 50 && <Link href={href(currentPage + 1)}>Page suivante →</Link>}</nav>
    {(syncIncidents.length > 0 || actionIncidents.length > 0) && <section className="sav-incidents card"><h2>Incidents techniques</h2><p>Une relance ne valide aucune proposition. Une création HubSpot au résultat incertain nécessite une réconciliation dans le dossier, jamais une nouvelle création automatique.</p><ol>
      {syncIncidents.map((incident) => <li key={incident.id}><div><strong>Synchronisation {incident.provider}</strong><small>{incident.receivedAt.toLocaleString("fr-FR")} · {incident.attempts} tentative(s)</small><code>{incident.errorCode || "Traitement bloqué"}</code></div><form action={retryWebhookAction}><input type="hidden" name="receiptId" value={incident.id}/><button className="button secondary" type="submit">Relancer la synchronisation</button></form></li>)}
      {actionIncidents.map((incident) => <li key={incident.id}><div><strong>{incident.subject}</strong><small>{savLabel(savActionLabels, incident.kind)}</small><code>{incident.errorCode}</code></div><Link href={`/studio/sav/${incident.threadId}`}>Vérifier le dossier</Link></li>)}
    </ol></section>}
    <section className="card" style={{ padding: 24 }}><h2>Évaluation des propositions</h2><p>Les résultats réels, tests et simulations sont séparés par modèle, prompt, connaissance, code et catégorie. Corriger une proposition ne modifie pas son verdict IA d’origine.</p><Link href="/studio/sav/evaluation">Ouvrir le dashboard d’évaluation</Link></section>
  </>;
}
