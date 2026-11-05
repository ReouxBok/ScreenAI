import Link from "next/link";
import { listCasesPage, readCaseDiagnostics, savCaseRecordingEnabled, type CaseListItem } from "@/lib/sav/cases/case-store";
import { SAV_CASE_OWNERS, SAV_CASE_PHASES, type CaseOwner, type CasePhase } from "@/lib/sav/cases/case-types";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { Badge, Button, ButtonLink, EmptyState, ErrorState, PageHeader } from "@/components/ui/primitives";
import { Select, TextInput } from "@/components/ui/forms";
import { caseOwnerLabels, casePhaseLabels } from "./case-view";
import { PipelinePanel } from "./pipeline-panel";
import styles from "./v2.module.css";

export const dynamic = "force-dynamic";
type Search = { ticket?: string; phase?: string; owner?: string; cursor?: string };
type ListRead = { state: "ok"; items: CaseListItem[]; nextCursor: string | null } | { state: "invalid" } | { state: "unavailable" };

const ownerLabel = (owner: string) => caseOwnerLabels[owner as CaseOwner] ?? owner;
const phaseLabel = (phase: string) => casePhaseLabels[phase as CasePhase] ?? phase;
const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return search.size ? `/studio/sav/v2?${search}` : "/studio/sav/v2";
};

// Supervised V2 pilot, entry page. GET only reads: pole A's paged list (columns only, nothing decrypted)
// and readCaseDiagnostics by ticket. A list that cannot be read says so; it is never shown as empty.
export default async function SavV2PilotPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireIntakeConsoleStaff();
  const search = await searchParams, ticketId = (search.ticket ?? "").trim();
  const valid = /^\d{1,30}$/.test(ticketId);
  const found = valid ? await readCaseDiagnostics(ticketId) : null;
  // Unknown filter values are not silently dropped: the page says the filter is invalid.
  const phase = search.phase || undefined, owner = search.owner || undefined, cursor = search.cursor || null;
  let list: ListRead;
  if ((phase && !(SAV_CASE_PHASES as readonly string[]).includes(phase)) || (owner && !(SAV_CASE_OWNERS as readonly string[]).includes(owner))) list = { state: "invalid" };
  else {
    try { list = { state: "ok", ...await listCasesPage({ phase: phase as CasePhase | undefined, owner: owner as CaseOwner | undefined, cursor }) }; }
    catch (error) { list = { state: error instanceof Error && error.message === "SAV_CASE_PAGE_INVALID" ? "invalid" : "unavailable" }; }
  }
  const here = query({ phase, owner, cursor: cursor ?? undefined }), first = query({ phase, owner });
  const caseHref = (ticket: string, anchor: string) => `/studio/sav/v2/${ticket}?${new URLSearchParams({ returnTo: `${anchor}#case-${ticket}` })}`;
  return <>
    <PageHeader title="Pilote V2 supervisé" description="Dossiers suivis par l’agent V2. Consultation seulement : cette page n’envoie rien, ne lance aucune analyse et ne modifie aucun dossier."/>
    {!savCaseRecordingEnabled() ? <p className={styles.notice} role="status">Enregistrement des dossiers V2 désactivé sur cet environnement : aucun nouveau dossier n’est créé.</p> : null}

    <form className={styles.search} role="search" action="/studio/sav/v2">
      <TextInput type="search" name="ticket" inputMode="numeric" defaultValue={ticketId} maxLength={30} placeholder="Numéro de ticket HubSpot" aria-label="Numéro de ticket HubSpot"/>
      <Button type="submit">Ouvrir</Button>
    </form>
    {ticketId && !valid ? <p className={styles.notice} role="alert">Un numéro de ticket HubSpot ne contient que des chiffres.</p> : null}
    {valid && !found ? <EmptyState title="Aucun dossier V2 pour ce ticket">Le ticket n’a pas été relayé à l’agent V2, ou le numéro est incorrect.</EmptyState> : null}
    {found ? <Link className={styles.result} href={`/studio/sav/v2/${ticketId}?${new URLSearchParams({ returnTo: `/studio/sav/v2?ticket=${ticketId}` })}`}>
      <strong>Ticket {ticketId}</strong>
      <span>{ownerLabel(found.owner)} · {phaseLabel(found.phase)} · version {found.version}</span>
    </Link> : null}

    <section aria-labelledby="v2-list-heading">
      <h2 id="v2-list-heading" className={styles.heading}>Dossiers V2</h2>
      <form className={styles.filters} action="/studio/sav/v2" aria-label="Filtrer les dossiers V2">
        <Select name="phase" defaultValue={phase ?? ""} aria-label="Étape"><option value="">Toutes les étapes</option>{SAV_CASE_PHASES.map(value => <option key={value} value={value}>{casePhaseLabels[value]}</option>)}</Select>
        <Select name="owner" defaultValue={owner ?? ""} aria-label="Responsable"><option value="">Tous les responsables</option>{SAV_CASE_OWNERS.map(value => <option key={value} value={value}>{caseOwnerLabels[value]}</option>)}</Select>
        <Button type="submit">Filtrer</Button>
      </form>
      {list.state === "unavailable" ? <ErrorState title="Liste des dossiers V2 indisponible">La lecture a échoué : ce n’est pas une liste vide. Rien n’a été modifié. Rechargez la page, ou ouvrez un dossier par son numéro de ticket.</ErrorState>
        : list.state === "invalid" ? <ErrorState title="Filtre ou page invalide" actions={<ButtonLink href="/studio/sav/v2">Revenir à la liste complète</ButtonLink>}>Ce filtre ou ce lien de page n’est pas reconnu, ou il a été fait pour d’autres filtres.</ErrorState>
        : !list.items.length ? <EmptyState title={cursor ? "Plus aucun dossier sur cette page" : phase || owner ? "Aucun dossier V2 pour ces filtres" : "Aucun dossier V2 enregistré"}>{cursor ? <Link href={first}>Revenir au début</Link> : null}</EmptyState>
        : <>
          <ul className={styles.list}>{list.items.map(item => <li key={item.caseId} id={`case-${item.ticketId}`}>
            <Link className={styles.result} href={caseHref(item.ticketId, here)}>
              <strong>Ticket {item.ticketId}</strong>
              <span>{ownerLabel(item.owner)} · {phaseLabel(item.phase)} · version {item.version}{item.admission?.inputNewer ? " · admission à réévaluer" : ""}{item.contractSupported ? "" : " · contrat non lisible par cette version"}</span>
              {item.sensitivity !== "none" ? <Badge tone="danger">Sensible : équipe</Badge> : null}
            </Link>
          </li>)}</ul>
          <nav className={styles.pager} aria-label="Pages de dossiers V2">
            {cursor ? <Link href={first}>Revenir au début</Link> : null}
            {list.nextCursor ? <Link href={query({ phase, owner, cursor: list.nextCursor })}>Page suivante</Link> : <span className={styles.small}>Fin de la liste</span>}
          </nav>
          <p className={styles.small}>Les dossiers les plus récemment modifiés d’abord. Un dossier modifié pendant la lecture peut réapparaître en tête.</p>
        </>}
    </section>
    <PipelinePanel/>
  </>;
}
