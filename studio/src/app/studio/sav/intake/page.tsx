import Link from "next/link";
import { z } from "zod";
import { formatParisDateTime } from "@/lib/paris-date";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { listIntakeConsole } from "@/lib/sav/intake/console-store";
import { savIntakeViewLabels, savIntakeViewSchema } from "@/lib/sav/intake/contract";
import { intakeStatusLabel, intakeReasonLabel } from "@/lib/sav/intake/console-presentation";
import styles from "./intake.module.css";
export const dynamic = "force-dynamic";
export default async function IntakeConsolePage({ searchParams }: { searchParams: Promise<{ view?: string; mailbox?: string; q?: string; page?: string }> }) {
  const staff=await requireIntakeConsoleStaff();
  const query = await searchParams, selected = savIntakeViewSchema.safeParse(query.view);
  const view = selected.success ? selected.data : "processing", mailbox = z.uuid().safeParse(query.mailbox);
  const data = await listIntakeConsole({ view, mailboxId: mailbox.success ? mailbox.data : undefined, search: query.q, page: Number(query.page) || 1 });
  const href = (nextView: string, page = 1) => `/studio/sav/intake?${new URLSearchParams({ view: nextView, q: (query.q ?? "").slice(0, 120),
    ...(mailbox.success ? { mailbox: mailbox.data } : {}), page: String(page) })}`;
  return <div className={styles.console}>
    <header className={styles.heading}><div><span className="eyebrow">SAV · nouveaux dossiers</span><h1>Suivre le traitement</h1>
      <p>Les actions confirmées et le suivi réel déterminent l’avancement.</p></div><div className={styles.actions}>{["admin","owner"].includes(staff.role)&&<Link className="button secondary" href="/studio/sav/intake/launch">Administration du lancement</Link>}<Link className="button secondary" href="/studio/sav?legacy=1">Archives supervisées</Link></div></header>
    {!data.installed ? <section className={styles.notice}><h2>Console non préparée</h2><p>Les données de ce parcours ne sont pas encore disponibles. La file supervisée reste accessible.</p></section> : <>
      <nav aria-label="Vues des nouveaux dossiers" className={styles.views}>
        {Object.entries(savIntakeViewLabels).map(([key, label]) => <Link key={key} href={href(key)} aria-current={view === key ? "page" : undefined}>
          <span>{label}</span><b>{data.counts[key] ?? 0}</b></Link>)}
      </nav>
      <div className={styles.controls}><Link className={styles.processing} href={href("processing")} aria-current={view === "processing" ? "page" : undefined}>
        En cours et attentes techniques <b>{data.counts.processing ?? 0}</b></Link>
        <form method="get" className={styles.search}><input type="hidden" name="view" value={view}/>{mailbox.success && <input type="hidden" name="mailbox" value={mailbox.data}/>}
          <label className={styles.srOnly} htmlFor="intake-search">Rechercher un expéditeur ou un objet</label>
          <input id="intake-search" type="search" name="q" maxLength={120} defaultValue={query.q ?? ""} placeholder="Expéditeur ou objet"/>
          <button type="submit" className="secondary">Rechercher</button></form></div>
      <section aria-label={view === "processing" ? "Traitements en cours" : savIntakeViewLabels[view]} className={styles.list}>
        {data.rows.length ? data.rows.map(row => <Link key={row.threadId} href={`/studio/sav/intake/${row.threadId}`} className={styles.row}>
          <div><strong>{row.subject || "Nouvelle demande"}</strong><span>{row.fromEmail ?? "Expéditeur en cours de préparation"}</span></div>
          <div><span className={styles.status}>{intakeStatusLabel(row.status)}</span>{row.reason && <small>{intakeReasonLabel(row.reason)}</small>}</div>
          <div><span>Version {row.version ?? "en attente"}</span><time dateTime={row.receivedAt?.toISOString()}>{row.receivedAt ? formatParisDateTime(row.receivedAt) : "Nouvelle entrée"}</time></div>
        </Link>) : <div className={styles.empty}><h2>Aucun dossier dans cette vue</h2><p>{query.q ? "Aucun objet ou expéditeur ne correspond à la recherche." : "Les prochains dossiers apparaîtront ici selon leur avancement confirmé."}</p></div>}
      </section>
      <footer className={styles.pagination}><span>{data.total} dossier{data.total > 1 ? "s" : ""} · page {data.page} sur {data.pages}</span>
        <div>{data.page > 1 && <Link href={href(view, data.page - 1)}>Précédente</Link>}{data.page < data.pages && <Link href={href(view, data.page + 1)}>Suivante</Link>}</div></footer>
    </>}
  </div>;
}
