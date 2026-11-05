import Link from "next/link";
import { isDatabaseConfigured } from "@/db";
import { formatParisDateTime } from "@/lib/paris-date";
import { requireSavStaff } from "@/lib/sav/auth";
import { getSavV0Cutover } from "@/lib/sav/cutover";
import { savDecisionLabels, savLabel, savThreadStatusLabels } from "@/lib/sav/labels";
import { listSavInbox } from "@/lib/sav/service";
import { legacyCommandNotice } from "@/lib/ui/legacy-notice";
import { Button, ButtonLink, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { TextInput } from "@/components/ui/forms";
import styles from "./archives.module.css";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

// SAV-60: list of V0 dossiers, strictly read-only. listSavInbox only selects
// (audited 28/10); the V0 dashboard loader is avoided because it refreshes its cache.
export default async function SavArchivesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; notice?: string }> }) {
  await requireSavStaff("admin");
  const { q = "", page = "1", notice } = await searchParams;
  const refused = legacyCommandNotice(notice);
  const query = q.trim().slice(0, 120), current = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), 10_000);
  // The list only holds mail received after the active V0 cutover (savV0EligibleMessageFilter, unchanged). Without that
  // boundary, or without a database, the list cannot be established: saying "no dossier" would be false. A failed read throws (error.tsx).
  const database = isDatabaseConfigured(), boundary = database ? await getSavV0Cutover() : null;
  const rows = boundary ? await listSavInbox(PAGE_SIZE + 1, { offset: (current - 1) * PAGE_SIZE, query: query || undefined }) : [];
  const visible = rows.slice(0, PAGE_SIZE), hasNext = rows.length > PAGE_SIZE;
  const href = (target: number) => `/studio/sav/archives?${new URLSearchParams({ ...query ? { q: query } : {}, ...target > 1 ? { page: String(target) } : {} })}`.replace(/\?$/, "");
  return <>
    <PageHeader title="Archives de l’ancien circuit" description="Dossiers traités par la première version de l’agent. Consultation seulement : rien ici ne lance d’analyse, d’envoi ni de mise à jour HubSpot."/>
    {refused ? <p className={styles.notice} role="status">{refused}</p> : null}
    <form className={styles.search} role="search" action="/studio/sav/archives">
      <TextInput type="search" name="q" defaultValue={query} maxLength={120} placeholder="Rechercher un client, un objet…" aria-label="Rechercher dans les archives"/>
      <Button type="submit">Rechercher</Button>
    </form>
    {!boundary ? <ErrorState title="Archives non lisibles">{database ? "La frontière de l’ancien circuit n’est pas active" : "Aucune base de données n’est configurée sur cet environnement"} : la liste ne peut pas être établie. Ce n’est pas une liste vide, et rien n’a été modifié.</ErrorState>
      : visible.length ? <ul className={styles.list} aria-label="Dossiers archivés">{visible.map(row => <li key={row.threadId}>
      <Link href={`/studio/sav/archives/${row.threadId}?${new URLSearchParams({ returnTo: `${href(current)}#archive-${row.threadId}` })}`} id={`archive-${row.threadId}`}>
        <span><strong>{row.subject}</strong><span className={styles.small}>{row.fromEmail}</span></span>
        <span className={styles.small}>{savLabel(savThreadStatusLabels, row.threadStatus)}{row.decisionKind ? ` · ${savLabel(savDecisionLabels, row.decisionKind)}` : ""}</span>
        <time className={styles.small} dateTime={row.receivedAt.toISOString()}>{formatParisDateTime(row.receivedAt)}</time>
      </Link>
    </li>)}</ul> : <EmptyState title={query ? "Aucun dossier archivé ne correspond" : "Aucun dossier archivé"}>{query ? "Essayez un autre mot ou effacez la recherche." : "Aucun dossier de l’ancien circuit n’est enregistré."}</EmptyState>}
    {current > 1 || hasNext ? <nav className={styles.pagination} aria-label="Pages des archives">
      <span>Page {current}</span>
      <span style={{ display: "flex", gap: 8 }}>{current > 1 ? <ButtonLink href={href(current - 1)}>Précédente</ButtonLink> : null}{hasNext ? <ButtonLink href={href(current + 1)}>Suivante</ButtonLink> : null}</span>
    </nav> : null}
  </>;
}
