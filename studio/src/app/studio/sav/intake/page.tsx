import Link from "next/link";
import { z } from "zod";
import { formatParisDateTime } from "@/lib/paris-date";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { SAV_INTAKE_BUDGET_OWNER_EMAIL } from "@/lib/sav/intake/budget-amount";
import { listIntakeConsole } from "@/lib/sav/intake/console-store";
import { savIntakeViewLabels, savIntakeViewSchema } from "@/lib/sav/intake/contract";
import { intakeStatusLabel, intakeReasonLabel, intakeBlockedCauseLabel, intakeRetryLabel } from "@/lib/sav/intake/console-presentation";
import styles from "./intake.module.css";
import { intakeDossierHref } from "@/lib/sav/intake-ux/navigation";
import { IntakeDossierLink, IntakeListPosition } from "./navigation";
import { AgentPauseBanner } from "./agent-pause-banner";
export const dynamic = "force-dynamic";
export default async function IntakeConsolePage({ searchParams }: { searchParams: Promise<{ view?: string; mailbox?: string; q?: string; page?: string; sort?: string }> }) {
  const staff=await requireIntakeConsoleStaff();
  const query = await searchParams, selected = savIntakeViewSchema.safeParse(query.view);
  const view = selected.success ? selected.data : "processing", mailbox = z.uuid().safeParse(query.mailbox);
  const data = await listIntakeConsole({ view, mailboxId: mailbox.success ? mailbox.data : undefined, search: query.q, page: Number(query.page) || 1, ...(query.sort==="oldest"?{sort:"oldest" as const}:{}) });
  const href = (nextView: string, page = 1, search = query.q ?? "") => `/studio/sav/intake?${new URLSearchParams({ view: nextView, q: search.slice(0, 120),
    ...(mailbox.success ? { mailbox: mailbox.data } : {}), ...(["newest","oldest"].includes(query.sort??"")?{sort:query.sort!}:{}), page: String(page) })}`;
  const origin = href(view, data.page);
  return <div className={styles.console}>
    <IntakeListPosition origin={origin}/>
    <header className={styles.heading}><div><span className="eyebrow">SAV · nouveaux dossiers</span><h1>Suivre le traitement</h1>
      <p>Les actions confirmées et le suivi réel déterminent l’avancement.</p></div><div className={styles.actions}>{["admin","owner"].includes(staff.role)&&<Link className="button secondary" href="/studio/sav/intake/launch">Administration du lancement</Link>}{staff.role==="admin"&&<Link className="button secondary" href="/studio/sav/intake/comparison">Comparaison des lecteurs</Link>}{staff.email===SAV_INTAKE_BUDGET_OWNER_EMAIL&&<Link className="button secondary" href="/studio/sav/intake/budget">Budget IA</Link>}<Link className="button secondary" href="/studio/sav/intake/agents">Accès agents</Link><Link className="button secondary" href="/studio/sav?legacy=1">Archives supervisées</Link></div></header>
    <AgentPauseBanner role={staff.role}/>
    {!data.installed ? <section className={styles.notice}><h2>Console non préparée</h2><p>Les données de ce parcours ne sont pas encore disponibles. La file supervisée reste accessible.</p></section> : <>
      <nav aria-label="Vues des nouveaux dossiers" className={styles.views}>
        {Object.entries(savIntakeViewLabels).map(([key, label]) => <Link key={key} href={href(key)} aria-current={view === key ? "page" : undefined}>
          <span>{label}</span><b>{data.counts[key] ?? 0}</b></Link>)}
      </nav>
      <div className={styles.controls}><Link className={styles.processing} href={href("processing")} aria-current={view === "processing" ? "page" : undefined}>
        En cours et attentes techniques <b>{data.counts.processing ?? 0}</b>{(data.counts.blocked ?? 0) > 0 && <em className={styles.blockedCount}>{data.counts.blocked} bloqué{data.counts.blocked > 1 ? "s" : ""}</em>}</Link>
        <form method="get" className={styles.search}><input type="hidden" name="view" value={view}/>{mailbox.success && <input type="hidden" name="mailbox" value={mailbox.data}/>}
          <label className={styles.srOnly} htmlFor="intake-search">Rechercher un expéditeur ou un objet</label>
          <input id="intake-search" type="search" name="q" maxLength={120} defaultValue={query.q ?? ""} placeholder="Expéditeur ou objet"/>
          <label className={styles.srOnly} htmlFor="intake-sort">Trier les dossiers</label><select id="intake-sort" name="sort" defaultValue={query.sort==="oldest"?"oldest":"newest"}><option value="newest">Plus récents d’abord</option><option value="oldest">Plus anciens d’abord</option></select>
          <button type="submit" className="secondary">Rechercher</button></form></div>
      {(data.counts.blocked ?? 0) > 0 && <p role="alert" className={styles.blockedAlert}>{data.counts.blocked} dossier{data.counts.blocked > 1 ? "s" : ""} bloqué{data.counts.blocked > 1 ? "s" : ""} — à traiter par l’équipe. Chaque ligne indique la cause ; ils restent comptés jusqu’à leur résolution.</p>}
      <section aria-label={view === "processing" ? "Traitements en cours" : savIntakeViewLabels[view]} className={styles.list}>
        {data.rows.length ? data.rows.map(row => <IntakeDossierLink key={row.threadId} id={row.threadId} origin={origin} href={intakeDossierHref(row.threadId, origin)} className={styles.row}>
          <div><strong>{row.subject || "Nouvelle demande"}</strong><span>{row.fromEmail ?? "Expéditeur en cours de préparation"}</span></div>
          <div>{row.blockedCause ? <span className={row.blockedCause === "agent_paused" ? styles.status : styles.blocked}>{intakeBlockedCauseLabel(row.blockedCause)}</span> : row.retryAt ? <span className={styles.status}>{intakeRetryLabel(row.retryAt)}</span> : <span className={styles.status}>{intakeStatusLabel(row.status)}</span>}{row.reason && <small>{intakeReasonLabel(row.reason)}</small>}</div>
          <div><span>Version {row.version ?? "en attente"}</span><time dateTime={row.receivedAt?.toISOString()}>{row.receivedAt ? formatParisDateTime(row.receivedAt) : "Nouvelle entrée"}</time></div>
        </IntakeDossierLink>) : <div className={styles.empty}><h2>Aucun dossier dans cette vue</h2><p>{query.q ? "Aucun objet ou expéditeur ne correspond à la recherche." : "Les prochains dossiers apparaîtront ici selon leur avancement confirmé."}</p>{query.q && <Link href={href(view,1,"")}>Effacer la recherche</Link>}</div>}
      </section>
      <footer className={styles.pagination}><span>{data.total} dossier{data.total > 1 ? "s" : ""} · page {data.page} sur {data.pages}</span>
        <div>{data.page > 1 && <Link href={href(view, data.page - 1)}>Précédente</Link>}{data.page < data.pages && <Link href={href(view, data.page + 1)}>Suivante</Link>}</div></footer>
    </>}
  </div>;
}
