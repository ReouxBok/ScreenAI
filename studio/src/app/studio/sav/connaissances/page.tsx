import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSavStaff } from "@/lib/sav/auth";
import { canReviewKnowledgeCandidate } from "@/lib/knowledge/contracts";
import { paginateSavKnowledge } from "@/lib/knowledge/workspace";
import type { SavKnowledgeRow, SavKnowledgeTab } from "@/lib/knowledge/workspace-contract";
import { formatParisDateTime } from "@/lib/paris-date";
import { knowledgeDetailUrl, knowledgeErrorMessage, knowledgeState } from "./workspace-labels";
import styles from "./workspace.module.css";
import library from "./library.module.css";

export const dynamic = "force-dynamic";
const base = "/studio/sav/connaissances";
type Tab = SavKnowledgeTab | "proposals";
const stages = { draft: "Brouillons", pending: "À valider", approved: "À publier", published_inactive: "À activer" };
const statuses = { all: "Tous les états", ...stages, needs_completion: "Compléments demandés", needs_revalidation: "À revalider", indexing: "Indexation en cours", unavailable: "Index indisponible", index_error: "Indexation en erreur", rejected: "Écartées", needs_recording: "Source à compléter", not_applicable: "Périmètre à qualifier" };
type Query = { tab?: string; q?: string; status?: string; page?: string; candidate?: string; batch?: string; result?: string };

function rowAction(row: SavKnowledgeRow, detail: string, email: string) {
  if (row.kind === "draft" && email !== "ugo@limova.ai") return { label: "Ouvrir le brouillon", href: detail };
  if (row.kind === "draft") return { label: "Reprendre le brouillon", href: `${base}/proposer?draft=${row.id}` };
  if (row.kind === "learning") return { label: "Préparer la fiche", href: `${base}/proposer?learning=${row.id}` };
  if (row.state === "production" && !row.hasPendingUpdate) return { label: "Modifier la fiche", href: `${base}/proposer?target=${row.id}` };
  if (row.state === "production") return { label: "Voir la modification", href: detail };
  if (row.kind === "candidate" && row.state === "pending" && canReviewKnowledgeCandidate(email, "sav")) return { label: "Examiner pour validation", href: detail };
  if (email === "ugo@limova.ai" && row.state === "approved") return { label: "Vérifier avant publication", href: detail };
  if (email === "ugo@limova.ai" && row.state === "published_inactive") return { label: "Vérifier avant activation", href: detail };
  if (["approved", "published_inactive", "pending", "index_error", "indexing"].includes(row.state)) return { label: "Ouvrir la version", href: detail };
  return { label: "Voir le détail", href: detail };
}

export default async function SavKnowledgeLibrary({ searchParams }: { searchParams: Promise<Query> }) {
  const staff = await requireSavStaff();
  const query = await searchParams;
  if (query.candidate && /^[a-f0-9-]{36}$/i.test(query.candidate)) redirect(`${base}/${query.candidate}?kind=candidate`);
  if (query.batch && /^[a-f0-9-]{36}$/i.test(query.batch)) redirect(`${base}/imports?batch=${query.batch}`);
  const tab: Tab = query.tab === "automatic" || query.tab === "human" || query.tab === "proposals" ? query.tab : "production";
  const active = tab === "production";
  const q = (query.q ?? "").trim().slice(0, 200);
  const status = !active && query.status && Object.hasOwn(statuses, query.status) ? query.status as keyof typeof statuses : "all";
  const requestedPage = Math.max(1, Math.min(100000, Math.floor(Number(query.page)) || 1));
  const catalog = await paginateSavKnowledge({ tab, q, status, page: requestedPage, pageSize: 20 }).catch(() => null);
  function url(nextTab: Tab, nextStatus = "all", page = 1) {
    const params = new URLSearchParams({ tab: nextTab });
    if (q) params.set("q", q);
    if (nextTab !== "production" && nextStatus !== "all") params.set("status", nextStatus);
    if (page > 1) params.set("page", String(page));
    return `${base}?${params}`;
  }
  const returnUrl = url(tab, status, catalog?.page ?? requestedPage);
  const pages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.pageSize)) : 1;
  return <div className={styles.workspace}>
    <header className={styles.heading}><div><span className="eyebrow">Studio SAV</span><h1>Bibliothèque des connaissances</h1></div>
      <Link className="button primary" href={`${base}/proposer`}>Créer une fiche</Link>
    </header>
    <nav className={library.queue} aria-label="Files de connaissances">
      <Link href={url("production")} aria-current={active ? "page" : undefined}>Fiches actives</Link>
      <Link href={url("proposals")} aria-current={!active && status === "all" ? "page" : undefined}>Toutes les propositions</Link>
      {Object.entries(stages).map(([key, label]) => <Link key={key} href={url("proposals", key)} aria-current={!active && status === key ? "page" : undefined}>{label}</Link>)}
    </nav>
    <form method="get" className={library.filters} aria-label="Rechercher les connaissances">
      <label>Rechercher<input name="q" type="search" placeholder="Titre, résumé ou source…" defaultValue={q} maxLength={200}/></label>
      {active ? <input type="hidden" name="tab" value="production"/> : <>
        <label>Origine<select name="tab" defaultValue={tab}><option value="proposals">Toutes les origines</option><option value="human">Humaine</option><option value="automatic">Automatique ou à qualifier</option></select></label>
        <label>État<select name="status" defaultValue={status}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </>}
      <button className="secondary">Rechercher</button>
      {(q || status !== "all" || (!active && tab !== "proposals")) && <Link href={active ? base : `${base}?tab=proposals`}>Effacer les filtres</Link>}
    </form>
    {query.result && <p className={styles.alert} role="status">{/^[A-Z_]+$/.test(query.result) ? knowledgeErrorMessage(query.result) : "Action enregistrée. Consultez la fiche pour vérifier son état courant."}</p>}
    {!catalog ? <section className={styles.panel} role="alert"><h2>La bibliothèque n’a pas pu être chargée</h2><Link className="button secondary" href={returnUrl}>Réessayer</Link></section>
      : <section className={library.results}><header className={library.resultsHeader}><h2>{active ? "Fiches actives" : status === "all" ? "Propositions" : statuses[status]}</h2><span>{catalog.total} résultat{catalog.total > 1 ? "s" : ""}</span></header>
        {!catalog.rows.length ? <div className={library.empty}><h3>{q || status !== "all" ? "Aucune connaissance pour ces filtres" : active ? "Aucune connaissance active" : "Aucune proposition à afficher"}</h3>
          {active && !q && <p>Une fiche apparaît ici après validation, publication et activation.</p>}</div>
          : <ul className={library.records}>{catalog.rows.map(row => {
            const detail = knowledgeDetailUrl(row, returnUrl);
            const action = rowAction(row, detail, staff.email);
            return <li key={`${row.kind}:${row.id}`}>
              <div className={library.identity}><Link href={detail}>{row.title}</Link>{row.summary && <p>{row.summary}</p>}<small>{row.sourceLabel} · {formatParisDateTime(row.updatedAt)}</small></div>
              <div className={library.meta}><span className={styles.badge}>{knowledgeState(row.state)}</span>
                {row.version !== null && <small>Version {row.version}</small>}{row.hasPendingUpdate && <small>Modification en cours</small>}</div>
              <Link className={library.action} href={action.href}>{action.label}</Link>
            </li>;
          })}</ul>}
      </section>}
    {catalog && pages > 1 && <nav className={styles.footer} aria-label="Pagination de la bibliothèque"><span>Page {catalog.page} sur {pages}</span><div className={styles.row}>
      {catalog.page > 1 && <Link className="button secondary" href={url(tab, status, catalog.page - 1)}>← Précédente</Link>}
      {catalog.page < pages && <Link className="button secondary" href={url(tab, status, catalog.page + 1)}>Suivante →</Link>}</div></nav>}
    <nav className={library.tools} aria-label="Outils de connaissance">
      <Link href={`${base}/apprentissage`}>Apprentissage</Link><Link href={`${base}/imports`}>Imports et couverture des sources</Link><Link href={`${base}/diagnostic`}>Enrichir les fiches actives</Link><Link href={`${base}/playbook`}>Master prompt SAV</Link>
    </nav>
  </div>;
}
