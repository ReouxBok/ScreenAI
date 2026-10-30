import "server-only";
import type { readIntakeConsoleDetail } from "./console-detail";
import { intakeHandoff, intakeRuntimeHandoffReasons } from "./console-presentation";
import { readManualOtherEligibility, type ManualOtherEligibility } from "./manual-other-classification";

export const intakeEffectLabels: Record<string, string> = { ticket_create: "Création du ticket", note_create: "Note de contexte", note_associate: "Rattachement de la note",
  email_create: "Conservation de l’email CRM", email_associate: "Rattachement de l’email", stage_new: "Statut Nouveau", identity_send: "Demande d’identification" };
export const intakeEffectStateLabels: Record<string, string> = { planned: "Prévu, sans départ", dispatched: "Départ enregistré, résultat à vérifier", acked: "Réponse fournisseur reçue, vérification en attente",
  confirmed: "Résultat vérifié", uncertain: "Résultat incertain, rapprochement requis" };
/** Heading of the effects section: current effects or effects retained from another run. */
export function intakeEffectsTitle(currentEffects: boolean) {
  return currentEffects ? "Actions réellement accomplies" : "Actions historiques conservées";
}
/** The « Parcours » line of the current decision. */
export function intakeRouteLabel(disposition: ReturnType<typeof intakeDossierView>["disposition"]) {
  const target = disposition?.kind === "ticket" ? disposition.target : null;
  return disposition?.kind === "ticket" ? target?.operation === "create" ? "Créer une fiche ticket" : target?.operation === "reopen" ? "Rouvrir le ticket" : "Rattacher au ticket"
    : disposition?.kind === "request_identification" ? "Demander l’adresse d’inscription" : disposition?.kind === "collect_context" ? "Compléter les preuves" : "Sans ticket";
}
export type IntakeConsoleDetail = NonNullable<Awaited<ReturnType<typeof readIntakeConsoleDetail>>>;
/** What the dossier page derives from the console detail, shared with the MCP read
 * tools so both state the same blocked flag, decision, question and handoff. Pure. */
export function intakeDossierView(data: IntakeConsoleDetail) {
  const current = data.current;
  const blocked = !data.handledExternally && !data.humanHeld && data.diagnostics?.messageId === data.latestMessageId && data.diagnostics.attemptsExhausted !== false
    && current && ["pending", "waiting"].includes(current.state) && !data.confirmedCurrent;
  const applicable = !data.handledExternally && !data.humanHeld && Boolean(data.confirmedCurrent || current && current.messageId === data.latestMessageId && current.sourceMatches);
  const plan = applicable ? current?.payload.plan : undefined, disposition = plan?.decision.disposition;
  const historicalPlan = !applicable ? current?.payload.plan : undefined;
  const contacts = [...(current?.candidateContactIds ?? [])].sort();
  const tickets = [...new Set([...(data.progress?.effects.filter(e=>e.kind==="ticket_create"&&e.state==="confirmed"&&e.ack?.id).map(e=>e.ack!.id!)??[]),...(plan?.decision.evidence.filter(e => e.source === "crm_ticket" && /^\d+$/.test(e.sourceId)).map(e => e.sourceId) ?? [])])];
  const target = disposition?.kind === "ticket" ? disposition.target : null;
  const historicalTarget=historicalPlan?.decision.disposition.kind==="ticket"?historicalPlan.decision.disposition.target:null;
  const dirty = data.projection.epoch !== data.projection.projectedEpoch;
  const canCorrect = !data.handledExternally && !data.humanHeld && data.projection.status !== "historical_outside_automation" && Boolean(current && current.messageId === data.latestMessageId && current.sourceMatches && current.candidateContactIds !== null && !data.progress?.confirmed && current.sourceHash && plan && !data.thread.paused
    && !data.choices.some(event => event.kind === "refuse" && event.parentVersion === current.version)
    && !data.choices.some(event => ["pending", "reading"].includes(event.state)));
  const currentEffects = Boolean(data.confirmedCurrent || applicable && data.progress?.runId === current?.id);
  const question = data.projection.view === "to_validate" || ["human_choice", "human_hold", "human_review"].includes(data.projection.status)
    ? plan?.progress?.kind === "human_choice" ? "Choisir la bonne fiche ou le ticket qui recevra ce mail"
      : disposition?.kind === "no_ticket" && disposition.nextAction === "supervised_investor" ? "Prendre en charge cette demande d’investissement"
        : disposition?.kind === "no_ticket" && disposition.nextAction === "supervised_partnership" ? "Prendre en charge cette demande de partenariat"
          : disposition?.kind === "no_ticket" && disposition.nextAction === "supervised_commercial" ? "Prendre en charge cette demande commerciale" : "Quelle suite l’équipe doit-elle donner à cette demande ?" : null;
  const judgement = (current?.payload.traces as { phase?: string }[] | undefined)?.findLast(t => t?.phase === "simple_judgement") as Parameters<typeof intakeHandoff>[0]["judgement"];
  const assessed = (current?.payload.semantics?.records.find(r => r.method === "assessIssues")?.result as { tickets?: { ticketId: string; relation: string }[] } | undefined)?.tickets;
  const handoffReasons = [...(disposition?.kind === "collect_context" ? disposition.reasons : []), ...intakeRuntimeHandoffReasons(current?.payload)];
  const handoff = !data.handledExternally && !data.confirmedCurrent && (blocked || handoffReasons.length > 0 || question)
    ? intakeHandoff({ reasons: handoffReasons, blockedCause: blocked ? "attempts_exhausted" : null, assessments: assessed, judgement }) : null;
  return { current, blocked, applicable, plan, disposition, historicalPlan, contacts, tickets, target, historicalTarget, dirty, canCorrect, currentEffects, question, handoff };
}
/** Which operator actions the dossier page offers to this staff member, with the page's own
 * conditions. Async availability (operator panel, manual Other binding) is read by the caller. */
export function intakeDossierActions(data: IntakeConsoleDetail, view: Pick<ReturnType<typeof intakeDossierView>, "current" | "canCorrect" | "plan">, staff: { email: string; role: string }) {
  const { current } = view, administrator = ["admin", "owner"].includes(staff.role), owner = staff.email === "ugo@limova.ai" && administrator;
  return {
    administrator,
    closeHandledOutside: Boolean((!data.handledExternally || data.projection.status === "human_review") && data.latestMessageId && owner),
    classifyInvalidSource: Boolean(!data.handledExternally && current?.sourceInvalid && current.messageId === data.latestMessageId && owner),
    releaseHold: Boolean(data.humanHeld && !data.handledExternally && data.latestMessageId && administrator),
    recordChoice: Boolean(view.canCorrect && current?.sourceHash && view.plan),
    // SAV-71: not offered (null), a reason known from the dossier, or "read" for the eligibility reader.
    manualOther: !(owner && data.latestMessageId && !data.handledExternally && !current?.sourceInvalid) ? null
      : data.humanHeld || data.thread.paused ? "paused" as const
        : data.confirmedCurrent || data.progress?.effects.some(effect => effect.state !== "planned") ? "effects_engaged" as const : "read" as const,
    operatorBinding: current?.sourceHash && current.messageId === data.latestMessageId
      ? { threadId: data.thread.id, messageId: current.messageId, runId: current.id, version: current.version, sourceHash: current.sourceHash } : null,
    administratorVerifications: Boolean(administrator && data.latestMessageId),
    noteReceipt: Boolean(data.progress?.effects.some(effect => effect.kind === "note_create" && effect.ack?.id)),
  };
}
/** Manual "Autres" eligibility shared by the dossier page and the MCP: binding, or a bounded reason. */
export async function readIntakeManualOther(data: IntakeConsoleDetail, manualOther: ReturnType<typeof intakeDossierActions>["manualOther"]): Promise<ManualOtherEligibility | null> {
  if (manualOther === null || !data.latestMessageId) return null;
  return manualOther === "read" ? readManualOtherEligibility(data.thread.id, data.latestMessageId, data.projection.epoch) : { binding: null, reason: manualOther };
}
