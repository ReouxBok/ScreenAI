import { formatParisDateTime } from "@/lib/paris-date";
import Link from "next/link";
import { ArrowUpRight, BookOpen, CheckCheck, Inbox, ListChecks, RefreshCw, Search, FolderSearch } from "lucide-react";
import { getSavV0Cutover } from "@/lib/sav/cutover";
import { listSavActionIncidents, listSavWebhookIncidents } from "@/lib/sav/service";
import { listSavDossierDashboard } from "@/lib/sav/dashboard";
import { savDashboardLabels, savDashboardViews } from "@/lib/sav/dashboard-state";
import { retryWebhookAction } from "./actions";
import { openSavEmailAction } from "./open-email-actions";
import { OpenEmailButton } from "./open-email-button";
import styles from "./inbox.module.css";

const viewIcons = { to_process: Inbox, to_validate: ListChecks, learning: RefreshCw, completed: CheckCheck, other: FolderSearch };
const descriptions = { to_process: "Derniers emails non ouverts", to_validate: "Validation ou action à confirmer", learning: "Résolution humaine et apprentissage", completed: "Traitement Studio terminé", other: "Candidats en observation" };
const partnershipLabels = { succeeded: "Transféré à Nathan", pending: "Transfert à Nathan en attente", uncertain: "Transfert à Nathan à vérifier", failed: "Transfert à Nathan non confirmé" };
const ticketLabels = { not_required: "Sans ticket nécessaire", required: "Action ticket à confirmer", pending: "Action en attente", uncertain: "Résultat incertain", failed: "Action non confirmée", confirmed: "Action confirmée" };

export async function SavV0Inbox({ searchParams }: { searchParams: Promise<{ view?: string; q?: string; page?: string; sort?: string }> }) {
  const { view = "to_process", q = "", page = "1", sort = "newest" } = await searchParams;
  let data: Awaited<ReturnType<typeof listSavDossierDashboard>>;
  try { data = await listSavDossierDashboard({ view, query: q, page: Number(page), sort }); }
  catch { return <><div className="page-intro compact"><div><span className="eyebrow">SAV IA</span><h1>Piloter les demandes</h1></div></div><section className="card" role="alert"><h2>Les dossiers ne sont pas disponibles</h2><p>Le chargement a échoué. Aucun compteur ni résultat vide n’est présenté comme confirmé.</p><Link className="button secondary" href="/studio/sav">Réessayer</Link></section></>; }
  const cutover = await getSavV0Cutover();
  const [syncIncidents, actionIncidents] = data.view === "incidents" ? await Promise.all([listSavWebhookIncidents(20), listSavActionIncidents(20)]) : [[], []];
  const href = (selectedView: string, selectedPage = 1) => `/studio/sav?${new URLSearchParams({ view: selectedView, q: q.slice(0, 200), page: String(selectedPage), sort: sort === "oldest" ? "oldest" : "newest" })}`;
  return <div className={styles.dashboard}>
    <div className={`page-intro compact ${styles.intro}`}><div><span className="eyebrow">SAV IA</span><h1>Piloter les demandes</h1><p>Une ligne par dossier, avec la prochaine action à effectuer.</p></div><Link className="button secondary" href="/studio/sav/connaissances"><BookOpen size={16}/> Connaissances</Link></div>
    {!cutover && <p className="login-notice">La réception SAV n’est pas encore activée. Aucun ancien email n’est ajouté à cette file.</p>}
    <nav className={styles.views} aria-label="Vues SAV">{savDashboardViews.map(key => { const Icon = viewIcons[key]; return <Link key={key} href={href(key)} className={`${styles.view} ${data.view === key ? styles.active : ""}`} aria-current={data.view === key ? "page" : undefined}><span><Icon size={18}/>{savDashboardLabels[key]}<b>{data.counts[key]}</b></span><small>{descriptions[key]}</small></Link>; })}</nav>
    {data.view === "other" && <section className={styles.observation} aria-labelledby="sav-other-heading">
      <h2 id="sav-other-heading">Autre — observation</h2>
      <p>Ces candidats restent visibles dans leur vue habituelle. Ce repérage ne retire aucun email du support et ne décide pas si une réponse ou un ticket est nécessaire.</p>
      <ul><li>Avis Trustpilot 5 étoiles</li><li>Promotions Vistaprint</li><li>Prospection DataRevolution</li><li>Copies de campagnes Limova</li></ul>
      <p>Le contenu complet et l’authenticité restent à vérifier. Les réponses, transferts et dossiers clients identifiés restent prioritaires dans le support.</p>
      {data.otherConfigurationStatus !== "configured" && <p role="status">{data.otherConfigurationStatus === "invalid" ? "Le repérage est indisponible : ses règles doivent être vérifiées. Aucun candidat n’est présenté comme confirmé." : "Les modèles précis de repérage ne sont pas encore chargés. Aucun candidat n’est présenté comme confirmé."}</p>}
    </section>}
    <div className={styles.toolbar}><form method="get" className={styles.search}><input type="hidden" name="view" value={data.view}/><label htmlFor="sav-q"><Search size={16}/><span className={styles.visuallyHidden}>Rechercher un dossier</span><input id="sav-q" name="q" defaultValue={q} maxLength={200} placeholder="Rechercher un client, une demande, un ticket…"/></label><label className={styles.sort}>Trier<select name="sort" defaultValue={sort === "oldest" ? "oldest" : "newest"}><option value="newest">Plus récents</option><option value="oldest">Plus anciens</option></select></label><button className="secondary" type="submit">Rechercher</button></form><Link href={href("incidents")}>Incidents {data.counts.incidents > 0 && `(${data.counts.incidents})`}</Link><Link href={href("technical")}>Exclusions ({data.counts.technical})</Link></div>
    <section className={styles.ledger} aria-label="Dossiers SAV"><header className={styles.heading}><span>Demande / client</span><span>Revue et ticket</span><span>Prochaine action</span></header>
      {data.rows.map(row => <form action={openSavEmailAction} key={row.threadId} id={`dossier-${row.threadId}`} className={styles.openForm}>
        <input type="hidden" name="threadId" value={row.threadId}/><input type="hidden" name="messageId" value={row.messageId}/><input type="hidden" name="returnTo" value={`${href(data.view, data.page)}#dossier-${row.threadId}`}/>
        <OpenEmailButton subject={row.summary.title} compact>
          <span className={styles.demand}><span className={styles.date}>{formatParisDateTime(row.receivedAt)}{row.opening === "unopened" && <i className={styles.newDot} aria-label="Dernier email non ouvert"/>}</span><strong title={row.summary.title}>{row.summary.title}</strong><span className={styles.customer}>{row.fromEmail}</span><span className={styles.problem}>{row.summary.problem}</span>{data.view === "other" && row.otherObservation && <small>{row.otherObservation.label} · À vérifier · Également dans {row.technical ? "Exclusions" : savDashboardLabels[row.state]}</small>}{row.opening === "unknown" && <small>Consultation historique non connue</small>}</span>
          <span className={styles.state}><span className={styles.badges}><span className={row.reviewStatus === "approved" ? styles.approved : styles.badge}>{row.handledExternally ? "Traité hors Studio" : <>Dossier {row.reviewStatus === "approved" ? "validé" : row.reviewStatus === "rejected" ? "à corriger" : "à valider"}</>}</span><span className={styles.badge}>Brouillon : {row.draftStatus}</span></span><span>{row.ticket ? `${row.ticket.title} · ${row.ticket.status}` : row.ticketProgress === "not_required" ? "Aucun ticket nécessaire" : row.crmStatus === "error" ? "HubSpot indisponible" : row.crmStatus === "partial" ? "Contexte HubSpot incomplet" : row.crmStatus === "unknown" ? "Contexte HubSpot à vérifier" : "Aucun ticket lié"}</span><small>{row.handledExternally ? "Classement administratif" : ticketLabels[row.ticketProgress]} · {row.replyStatus}</small>{row.partnershipStatus && <small>{partnershipLabels[row.partnershipStatus]}</small>}{row.incident && <span className={styles.warning}>Vérification nécessaire</span>}</span>
          <span className={styles.nextAction}><strong>{row.nextAction}</strong><span>Ouvrir le dossier <ArrowUpRight size={15}/></span></span>
        </OpenEmailButton>
      </form>)}
      {!data.rows.length && <div className={styles.empty}><Inbox size={28}/><h2>{q.trim() ? "Aucun dossier ne correspond à cette recherche" : data.view === "other" ? "Aucun candidat dans Autre" : data.view === "completed" ? "Aucun dossier terminé" : data.view === "learning" ? "Aucun apprentissage en cours" : data.view === "to_validate" ? "Aucun dossier à valider" : data.view === "to_process" ? "Aucune nouvelle demande à ouvrir" : "Aucun dossier dans cette vue"}</h2><p>{q.trim() ? "Essayez un autre nom, thème ou numéro de ticket." : data.view === "other" ? "Un résultat vide ne signifie pas que tous les emails sont des demandes clients. Continuez à consulter les vues habituelles." : "Les dossiers apparaîtront ici dès que leur état le permettra."}</p>{q.trim() && <Link href={`/studio/sav?view=${data.view}`}>Effacer la recherche</Link>}</div>}
    </section>
    <nav className={styles.pagination} aria-label="Pagination"><span>{data.total} dossier{data.total > 1 ? "s" : ""}{q.trim() ? " correspondant à la recherche" : ""}</span><span>{data.page > 1 && <Link href={href(data.view, data.page - 1)}>← Précédente</Link>} Page {data.page} sur {data.totalPages} {data.page < data.totalPages && <Link href={href(data.view, data.page + 1)}>Suivante →</Link>}</span></nav>
    {data.view === "incidents" && (syncIncidents.length > 0 || actionIncidents.length > 0) && <section className="sav-incidents card"><h2>Journal des incidents</h2><p>Un résultat HubSpot incertain exige une vérification dans le dossier avant toute reprise.</p><ol>{syncIncidents.map(incident => <li key={incident.id}><div><strong>Synchronisation {incident.provider}</strong><small>{formatParisDateTime(incident.receivedAt)}</small></div><form action={retryWebhookAction}><input type="hidden" name="receiptId" value={incident.id}/><button className="button secondary" type="submit">Relancer la synchronisation</button></form></li>)}{actionIncidents.map(incident => <li key={incident.id}><strong>{incident.subject}</strong><Link href={`/studio/sav/${incident.threadId}`}>Vérifier le dossier</Link></li>)}</ol></section>}
    <nav className={styles.secondaryLinks} aria-label="Outils SAV"><Link href="/studio/sav/resolutions">Bilans de résolution</Link><Link href="/studio/sav/pilote">Laboratoire</Link><Link href="/studio/sav/evaluation">Évaluation</Link></nav>
  </div>;
}
