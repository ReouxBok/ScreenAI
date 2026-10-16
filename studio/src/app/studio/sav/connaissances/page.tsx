import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSavStaff } from "@/lib/sav/auth";
import { paginateSavKnowledge } from "@/lib/knowledge/workspace";
import type { SavKnowledgeTab } from "@/lib/knowledge/workspace-contract";
import { formatParisDateTime } from "@/lib/paris-date";
import { knowledgeDetailUrl, knowledgeErrorMessage, knowledgeState, knowledgeTabs } from "./workspace-labels";
import styles from "./workspace.module.css";

export const dynamic = "force-dynamic";
const statuses = { all: "Tous les états", pending: "À valider", draft: "Brouillons internes", needs_completion: "Compléments demandés", approved: "Validées · à publier", published_inactive: "Publiées · à activer", needs_revalidation: "À revalider", unavailable: "Index indisponible", index_error: "Indexation en erreur", rejected: "Écartées" };

export default async function SavKnowledgeLibrary({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; status?: string; page?: string; candidate?: string; batch?: string; result?: string }> }) {
  await requireSavStaff();
  const query = await searchParams;
  if (query.candidate && /^[a-f0-9-]{36}$/i.test(query.candidate)) redirect(`/studio/sav/connaissances/${query.candidate}?kind=candidate`);
  if (query.batch && /^[a-f0-9-]{36}$/i.test(query.batch)) redirect(`/studio/sav/connaissances/imports?batch=${query.batch}`);
  const tab: SavKnowledgeTab = query.tab === "automatic" || query.tab === "human" ? query.tab : "production";
  const q = (query.q ?? "").trim().slice(0, 200);
  const status = tab !== "production" && query.status && Object.hasOwn(statuses, query.status) ? query.status : "all";
  const requestedPage = Math.max(1, Math.min(100000, Number(query.page) || 1));
  const catalog = await paginateSavKnowledge({ tab, q, status, page: requestedPage, pageSize: 20 }).catch(() => null);
  function url(nextTab = tab, page = 1) { const params = new URLSearchParams({ tab: nextTab, page: String(page) }); if (q) params.set("q", q); if (nextTab === tab && nextTab !== "production" && status !== "all") params.set("status", status); return `/studio/sav/connaissances?${params}`; }
  const returnUrl = url(tab, catalog?.page ?? requestedPage);
  const pages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.pageSize)) : 1;
  return <div className={styles.workspace}>
    <div className={styles.heading}><div><span className="eyebrow">SAV IA · Connaissances</span><h1>Bibliothèque des connaissances</h1><p className={styles.subtle}>Les procédures utilisées par l’agent et les propositions à relire.</p></div>
      <Link className="button secondary" href="/studio/sav/connaissances/apprentissage">Apprentissage</Link><Link className="button secondary" href="/studio/sav/connaissances/playbook">Master prompt SAV</Link><Link className="button secondary" href="/studio/sav/connaissances/diagnostic">Enrichir les fiches actives</Link><Link className="button primary" href="/studio/sav/connaissances/proposer">Proposer une connaissance</Link></div>
    <nav className={styles.tabs} aria-label="Vues de la bibliothèque">{Object.entries(knowledgeTabs).map(([key, label]) => <Link key={key} href={url(key as SavKnowledgeTab)} className={styles.tab} aria-current={tab === key ? "page" : undefined}>{label}<strong>{catalog?.counts[key as SavKnowledgeTab] ?? "—"}</strong></Link>)}</nav>
    <form method="get" className={styles.toolbar} aria-label="Rechercher les connaissances"><input type="hidden" name="tab" value={tab}/>
      <label>Rechercher une connaissance<input name="q" type="search" placeholder="Titre, thème ou procédure…" defaultValue={q} maxLength={200}/></label>
      {tab !== "production" && <label>État<select name="status" defaultValue={status}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      <button className="secondary">Rechercher</button><Link href="/studio/sav/connaissances/imports">Imports et couverture des sources</Link>
    </form>
    {query.result && <p className={styles.alert} role="status">{/^[A-Z_]+$/.test(query.result) ? knowledgeErrorMessage(query.result) : "L’action a été enregistrée. Consultez la fiche pour vérifier son état courant ; une validation seule ne publie ni n’active la connaissance."}</p>}
    {!catalog ? <section className={`${styles.panel} ${styles.empty}`} role="alert"><h2>La bibliothèque n’a pas pu être chargée</h2><p>Les versions déjà actives restent conservées. Réessayez pour consulter les propositions.</p><Link className="button secondary" href={returnUrl}>Réessayer</Link></section>
      : catalog.rows.length === 0 ? <section className={`${styles.panel} ${styles.empty}`}><h2>{q || status !== "all" ? "Aucune connaissance pour ces filtres" : tab === "production" ? "Aucune connaissance active" : "Aucune proposition à afficher"}</h2><p>{tab === "production" ? "Une connaissance apparaît ici après validation, publication et activation, avec son index prêt." : "Les brouillons, compléments et propositions déjà validées restent accessibles avec les filtres d’état."}</p><Link className="button secondary" href={q || status !== "all" ? `/studio/sav/connaissances?tab=${tab}` : "/studio/sav/connaissances/proposer"}>{q || status !== "all" ? "Effacer les filtres" : "Proposer une connaissance"}</Link></section>
      : <div className={styles.table}><table><caption className="sr-only">{knowledgeTabs[tab]}</caption><thead><tr><th scope="col">Connaissance</th><th scope="col">Origine et source</th><th scope="col">Version et état</th><th scope="col">Prochaine action</th></tr></thead><tbody>
        {catalog.rows.map(row => <tr key={`${row.kind}:${row.id}`}><td><Link href={knowledgeDetailUrl(row, returnUrl)}>{row.title}</Link><p className={styles.subtle}>{row.summary}</p></td><td>{row.origin === "human" ? "Proposition humaine" : row.origin === "automatic" ? "Apprentissage automatique" : "Origine à qualifier"}<p className={styles.subtle}>{row.sourceLabel}</p></td>
          <td><span className={styles.badge}>{knowledgeState(row.state)}</span>{row.version !== null && <p>Version {row.version}</p>}{row.hasPendingUpdate && <p><span className={`${styles.badge} ${styles.warning}`}>Mise à jour à valider</span></p>}<p className={styles.subtle}>{formatParisDateTime(row.updatedAt)}</p></td><td><Link href={knowledgeDetailUrl(row, returnUrl)}>{row.nextAction}</Link></td></tr>)}
      </tbody></table></div>}
    {catalog && <div className={styles.footer}><span>{catalog.total} connaissance{catalog.total > 1 ? "s" : ""} · Page {catalog.page} sur {pages}</span><nav className={styles.row} aria-label="Pagination de la bibliothèque">{catalog.page > 1 && <Link className="button secondary" href={url(tab, catalog.page - 1)}>← Précédente</Link>}{catalog.page < pages && <Link className="button secondary" href={url(tab, catalog.page + 1)}>Suivante →</Link>}</nav></div>}
  </div>;
}
