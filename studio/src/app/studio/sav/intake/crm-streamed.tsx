import { Suspense, use, type ComponentProps } from "react";
import { SkeletonBlock, SkeletonLine } from "@/components/skeleton";
import { crmDisplayFallback, type CrmDisplay, type CrmDisplayRecord } from "@/lib/sav/intake/crm-display";
import { IntakeChoiceForm } from "./choice-form";
import { IntakeCrmContext } from "./crm-context";
import styles from "./intake.module.css";

// HubSpot display names are a slow external read (up to 5 s) that only labels
// records already decided by the dossier. They stream in after the rest of the
// page; while pending, nothing claims a name is unavailable or confirmed.

type Kind = "contact" | "ticket";
const pick = (display: CrmDisplay, portal: string | undefined, kind: Kind, id: string) =>
  (kind === "contact" ? display.contacts : display.tickets)[id] ?? crmDisplayFallback(portal, kind, id);

export function RecordLink({ record }: { record: CrmDisplayRecord }) {
  return record.url ? <a href={record.url} target="_blank" rel="noopener noreferrer">{record.label}</a> : <span>{record.label}</span>;
}

function PendingName() {
  return <span><span className={styles.srOnly}>Nom HubSpot en cours de lecture</span><SkeletonLine inline width={160} height={13}/></span>;
}

function ResolvedRecord({ display, portal, kind, id }: { display: Promise<CrmDisplay>; portal: string | undefined; kind: Kind; id: string }) {
  return <RecordLink record={pick(use(display), portal, kind, id)}/>;
}

export function CrmRecord(props: ComponentProps<typeof ResolvedRecord>) {
  return <Suspense fallback={<PendingName/>}><ResolvedRecord {...props}/></Suspense>;
}

type ContextProps = Omit<ComponentProps<typeof IntakeCrmContext>, "contact" | "ticket" | "pending"> & {
  display: Promise<CrmDisplay>; portal: string | undefined; contactId?: string; ticketId?: string;
};

function ResolvedCrmContext({ display, portal, contactId, ticketId, ...rest }: ContextProps) {
  const resolved = use(display);
  return <IntakeCrmContext {...rest} contact={contactId ? pick(resolved, portal, "contact", contactId) : undefined}
    ticket={ticketId ? pick(resolved, portal, "ticket", ticketId) : undefined}/>;
}

export function StreamedCrmContext(props: ContextProps) {
  const { portal, contactId, ticketId, confirmed, creationPlanned, verifiedAt } = props;
  return <Suspense fallback={<IntakeCrmContext confirmed={confirmed} creationPlanned={creationPlanned} verifiedAt={verifiedAt} pending contact={contactId ? crmDisplayFallback(portal, "contact", contactId) : undefined}
    ticket={ticketId ? crmDisplayFallback(portal, "ticket", ticketId) : undefined}/>}>
    <ResolvedCrmContext {...props}/>
  </Suspense>;
}

type ChoiceProps = Omit<ComponentProps<typeof IntakeChoiceForm>, "display"> & { display: Promise<CrmDisplay> };

function ResolvedChoiceForm({ display, ...props }: ChoiceProps) {
  return <IntakeChoiceForm {...props} display={use(display)}/>;
}

/** The form waits for the labels of its options; its server-issued command key is unchanged. */
export function StreamedChoiceForm(props: ChoiceProps) {
  // Height measured on the rendered form (≈730 px) so the panels below do not jump.
  return <Suspense fallback={<section className={styles.choice} aria-label="Modifier l’orientation" aria-busy="true"><h2>Modifier l’orientation</h2>
    <span className={styles.srOnly}>Chargement des fiches HubSpot proposées</span>
    <SkeletonLine width="70%" height={12} style={{ margin: "14px 0" }}/><SkeletonBlock height={620}/></section>}>
    <ResolvedChoiceForm {...props}/>
  </Suspense>;
}
