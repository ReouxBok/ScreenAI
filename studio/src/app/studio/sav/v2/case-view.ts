import { describeCaseModelTransportDiagnostic } from "@/lib/sav/cases/investigation-transport-diagnostic";
import { caseAwaitsV2Attribution, caseRequestSubject, currentCaseFacts, SAV_CASE_ADMISSION_REASON_LABELS, type CaseAdmissionReason, type CaseEvent, type CaseSnapshot, type CaseTimer, type KnowledgeRef } from "@/lib/sav/cases/case-types";
import { caseDecisionProposalSchema, caseDecisionRejectionLabels, caseDecisionSignalLabels, caseDecisionUnverifiedLabels, type CaseDecisionProposal } from "@/lib/sav/cases/decision-contract";
import { caseDecisionNextStepLabels } from "@/lib/sav/cases/decision-recovery";
import { readCaseInvestigationProgress } from "@/lib/sav/cases/investigation-record";
import { latestInvestigationInput } from "@/lib/sav/cases/investigation-runner";
import { caseInvestigationWaitLabels } from "@/lib/sav/cases/investigation-waits";
import { describeJ2Timer } from "@/lib/sav/cases/timer-lifecycle";
import { j2PausesFromAgentPause } from "@/lib/sav/cases/timer-store";
import type { SavAgentPauseState } from "@/lib/sav/intake/agent-pause";

// Supervised V2 pilot (SAV-48/55): a pure projection of what poles A/B/C already store and read.
// It never calls a model, CRM or Gmail and invents no state: what has no backend yet says so.

export const caseOwnerLabels = { agent: "Agent V2", human: "Une personne de l’équipe", system_hold: "En suspens (pause technique ou organisationnelle)" } as const;
export const casePhaseLabels: Record<CaseSnapshot["phase"], string> = {
  queued: "En file", acting: "L’agent travaille", awaiting_customer: "Attente du client", closed_no_reply: "Clos sans réponse du client", resolved: "Résolu",
  handoff_pending: "Transfert à l’équipe en cours", human_owned: "Repris par l’équipe", deferred_budget: "Reporté : budget", technical_wait: "Attente technique",
  reconciling: "Vérification d’un résultat incertain", needs_review: "À relire", blocked_technical: "Bloqué : technique", blocked_reconcile: "Bloqué : vérification impossible",
};
const waitingKindLabels = { customer: "Attente du client", team: "Attente de l’équipe", technical: "Attente technique" } as const;
const familyLabels: Record<string, string> = { access: "Accès", usage: "Utilisation", technical: "Technique", integration: "Intégration", telephony: "Téléphonie", other: "Autre",
  finance: "Finance", cancellation: "Résiliation", subscription: "Abonnement", rights: "Droits", identity: "Identité" };
// v10: why a request has no searchable subject (pole A's reasons, worded for the team).
const subjectAbsenceLabels = {
  not_recorded: "sujet non enregistré (demande antérieure ou ouverte par une personne)", source_missing: "aucune analyse V1 acceptée ne liste cette demande",
  source_invalid: "analyse V1 stockée invalide", source_ambiguous: "deux analyses V1 acceptées se contredisent", not_in_summary: "le résumé V1 ne couvre pas cette demande",
  summary_shared: "le résumé V1 regroupe plusieurs demandes", redacted_empty: "rien ne reste une fois les données masquées",
} as const;
// Pole B coverage (CONTRACT_B_TO_UX): only `no_applicable_knowledge` is a gap of the knowledge base. `not_searched` and every
// `subject_*` limitation say the request was not searched (no searchable subject, budget): never shown nor counted as a gap.
const notSearchedLabels: Record<string, string> = {
  subject_unavailable: "sujet indisponible", subject_too_short: "sujet trop court pour une recherche", request_or_query_budget: "limite de budget de la recherche",
  subject_not_recorded: "sujet non enregistré (demande antérieure ou ouverte par une personne)", subject_source_missing: "aucune analyse V1 acceptée ne liste cette demande",
  subject_source_invalid: "analyse V1 non vérifiable", subject_source_ambiguous: "deux analyses V1 se contredisent", subject_not_in_summary: "le résumé V1 ne couvre pas cette demande",
  subject_summary_shared: "le résumé V1 regroupe plusieurs demandes", subject_redacted_empty: "rien à chercher une fois les données masquées", subject_generic: "seul le libellé générique était disponible",
};
export type CasePilotKnowledge = { label: string; gap: boolean };
function describeCoverage(row: { status?: unknown; knowledge?: unknown; limitations?: unknown }): CasePilotKnowledge {
  if (row.status === "covered") {
    const n = Array.isArray(row.knowledge) ? row.knowledge.length : 0;
    // Scope-first knowledge (11/11): the cards left out for this request, by fixed code (`investigation-knowledge-ranking.ts`).
    const codes = Array.isArray(row.limitations) ? row.limitations.filter((code): code is string => typeof code === "string") : [];
    const low = codes.filter(code => code.startsWith("knowledge_dropped:low_relevance:")).length, budget = codes.filter(code => code.startsWith("knowledge_dropped:input_budget:")).length;
    const floor = codes.filter(code => code.startsWith("knowledge_dropped:below_floor:")).length;
    const added = codes.filter(code => code.startsWith("block_scope_source_added:")).length;
    // K3 (12/11): a scope card may now be left out too (floor, budget), so the wording no longer says « hors bloc ».
    const notes = [floor ? `${floor} fiche(s) écartée(s) : sous le seuil de pertinence` : null, low ? `${low} fiche(s) écartée(s) : pertinence faible` : null,
      budget ? `${budget} fiche(s) écartée(s) : taille du contexte` : null, added ? `${added} fiche(s) du bloc ajoutée(s)` : null].filter(Boolean);
    return { label: `Fiche trouvée${n > 1 ? ` (${n})` : ""}${notes.length ? ` · ${notes.join(" · ")}` : ""}`, gap: false };
  }
  if (row.status === "no_applicable_knowledge") return { label: "Aucune fiche publiée applicable : vrai manque de la base de connaissances", gap: true };
  if (row.status === "not_searched") {
    // Records written before d71b077 carry no limitations: the reason is unknown, still not a gap.
    const codes = Array.isArray(row.limitations) ? row.limitations.filter((code): code is string => typeof code === "string") : [];
    // v10 sends `subject_unavailable` then A's precise reason: show the most precise one known.
    const precise = [...codes].reverse().find(code => notSearchedLabels[code]);
    const reason = precise ? notSearchedLabels[precise] : codes.length ? `raison non reconnue (${codes.join(", ")})` : "raison inconnue";
    return { label: `Non recherché : ${reason}. Ce n’est pas un manque de la base.`, gap: false };
  }
  return { label: "État de recherche non reconnu par cette version", gap: false };
}

const requestStatusLabels = { open: "ouverte", resolved: "résolue", handed_off: "transférée à l’équipe" } as const;
const nextActionLabels: Record<CaseDecisionProposal["nextAction"]["kind"], string> = {
  ask: "Poser une question au client", answer: "Répondre au client", confirm_resolution: "Confirmer la résolution", handoff: "Transférer à l’équipe", observe_only: "Observer seulement, sans action",
};
const timerStatusLabels = { following: "Relance J2 programmée", suspended_technically: "Relance J2 suspendue (pause), conservée", fired: "Relance J2 échue : revalidation avant tout envoi", cancelled: "Relance J2 annulée" } as const;
const pauseLabels = { actions_paused: "Agent V2 en pause des actions : l’analyse continue, aucun effet externe.", fully_paused: "Agent V2 en pause complète : ni analyse ni effet." } as const;

// Pole B's check of the latest decision (CONTRACT_B_TO_UX), read from the stored record as it is: an older or unknown shape is
// unreadable, an unknown code is shown as unknown. It is a rules check in observation, never an approval nor a permission to send.
export type CasePilotCheck =
  | { state: "none" }
  | { state: "unreadable" }
  | { state: "found"; decidedOn: number; stale: boolean; accepted: boolean; verdict: string; refusals: string[]; nextStep: string | null; unverified: string[]; signals: string[];
      actionsPaused: boolean; provenance: { knowledgeRevision: string | null; cards: number; modelCalls: number | null; revisions: { rules: string; playbookId: string; model: string; prompt: string } | null } };
const labelOf = (labels: Record<string, string>, code: unknown, what: string) => typeof code === "string" ? labels[code] ?? `${what} non reconnu par cette version (${code})` : `${what} illisible`;
function readCheck(decision: unknown, version: number): CasePilotCheck {
  if (decision === null || decision === undefined) return { state: "none" };
  const d = decision as Record<string, unknown>, validation = d.validation as Record<string, unknown> | undefined;
  if (typeof d.caseVersion !== "number" || !validation || (validation.outcome !== "accepted" && validation.outcome !== "needs_review")) return { state: "unreadable" };
  const list = (value: unknown) => Array.isArray(value) ? value : [];
  const refusal = d.refusal as { nextStep?: unknown } | null | undefined;
  const revisions = d.revisions as Record<string, unknown> | undefined;
  const accepted = validation.outcome === "accepted";
  return {
    state: "found", decidedOn: d.caseVersion, stale: d.caseVersion !== version, accepted,
    verdict: accepted ? "Conforme aux règles vérifiées (observation) : ce n’est ni une validation humaine ni une autorisation d’envoi."
      : "Refusée par les règles : à relire. Le refus est conservé, rien n’est présenté comme proposé à l’envoi.",
    refusals: accepted ? [] : list(validation.rejections).map(row => labelOf(caseDecisionRejectionLabels, (row as { code?: unknown })?.code, "Motif de refus")),
    nextStep: refusal && refusal.nextStep !== undefined ? labelOf(caseDecisionNextStepLabels, refusal.nextStep, "Étape suivante") : null,
    unverified: list(validation.unverified).map(code => labelOf(caseDecisionUnverifiedLabels, code, "Point non vérifié")),
    signals: list(validation.signals).map(code => labelOf(caseDecisionSignalLabels, code, "Signal")),
    actionsPaused: d.actionsPaused === true,
    provenance: { knowledgeRevision: typeof d.knowledgeRevision === "string" ? d.knowledgeRevision : null, cards: list(d.knowledge).length, modelCalls: typeof d.modelCalls === "number" ? d.modelCalls : null,
      revisions: revisions && ["rules", "playbookId", "model", "prompt"].every(key => typeof revisions[key] === "string") ? revisions as { rules: string; playbookId: string; model: string; prompt: string } : null },
  };
}

// Admission as stored (pole A/B), never inferred: no record is "unknown", not refused; identity and CRM read "unknown" when they were not proven.
const identityLabels = { confirmed: "identité confirmée", ambiguous: "identité ambiguë", absent: "aucun compte retrouvé", unknown: "identité inconnue (non prouvée)" } as const;
const crmLabels = { complete: "contexte CRM complet", incomplete: "contexte CRM incomplet", unknown: "contexte CRM inconnu (lecture absente ou partielle)" } as const;
export type CasePilotAdmission =
  | { state: "unknown"; label: string }
  | { state: "admitted" | "refused"; label: string; reasons: string[]; policyRevision: string | null; decidedAt: string; version: number; stale: boolean; identity: string; crm: string };
function readAdmission(snapshot: CaseSnapshot): CasePilotAdmission {
  const admission = snapshot.admission;
  if (!admission) return { state: "unknown", label: "Admission inconnue : aucune admission enregistrée pour ce dossier. Ce n’est pas un refus ; l’agent ne peut pas le prendre." };
  const admitted = admission.target === "agent", q = admission.qualification;
  return {
    state: admitted ? "admitted" : "refused", label: admitted ? "Admis pour l’agent V2" : "Non admis pour l’agent V2",
    reasons: admission.reasons.map(reason => SAV_CASE_ADMISSION_REASON_LABELS[reason as CaseAdmissionReason] ?? `motif non reconnu par cette version (${reason})`),
    policyRevision: admission.policyRevision ?? null, decidedAt: admission.decidedAt, version: admission.version, stale: snapshot.admissionInputVersion > admission.version,
    identity: identityLabels[q?.identity?.status as keyof typeof identityLabels] ?? "identité illisible", crm: crmLabels[q?.crmContext as keyof typeof crmLabels] ?? "contexte CRM illisible",
  };
}

// Pole B's `context_invalid` (lot 2, dc7bc67): `waiting.problem` is a closed code and `waiting.embeddingCalls` the embeddings sent in that pass, when known.
// Records written by cadc971 kept a free-text `detail` ("<problem>: <detail>"): only its leading code is read, through the same closed list, and the rest is
// never shown (schema messages, internal ids). Anything outside the list is said to be unknown, never echoed.
const contextProblemLabels: Record<string, string> = {
  contract_revision: "le dossier est enregistré dans une version de contrat que cette version ne lit pas",
  body_invalid: "le contenu enregistré du dossier ne respecte pas son format",
  event_other_case: "le journal contient un événement d’un autre dossier",
  event_after_snapshot: "le journal contient un événement postérieur à la version lue",
  event_duplicate: "le journal contient deux fois le même événement",
  event_direction_invalid: "un événement du journal a une direction incohérente",
  source_duplicate: "une même source apparaît deux fois",
};
const UNKNOWN_PROBLEM = "motif technique non reconnu par cette version (détail réservé au rapport technique)";
const knownProblem = (code: unknown) => typeof code === "string" && Object.hasOwn(contextProblemLabels, code) ? contextProblemLabels[code]! : null;
/** The stored closed `problem` first; otherwise the leading code of a legacy `detail`; otherwise "unknown". Never the raw text. */
export function safeContextProblem(waiting: Readonly<{ problem?: unknown; detail?: unknown }> | string | null | undefined): string {
  const w = typeof waiting === "string" || waiting == null ? { detail: waiting } : waiting;
  return knownProblem(w.problem) ?? knownProblem(typeof w.detail === "string" ? w.detail.split(":")[0]!.trim() : null) ?? UNKNOWN_PROBLEM;
}
/** A count is shown only when stored as a non-negative integer: undefined, null or anything else is "not recorded", never 0. */
export function storedCount(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
/** Who holds a ticket the agent does not: only a recorded personal takeover (`handoff.humanSince`) is "a person took it"; awaiting the V2
 * attribution or a handoff nobody took yet stays the team's queue. None of these gives the agent any right to act. */
export type CasePilotHumanHold = { state: "taken"; since: string } | { state: "awaiting_attribution" } | { state: "team_not_taken" } | null;
function readHumanHold(snapshot: CaseSnapshot): CasePilotHumanHold {
  if (snapshot.owner !== "human") return null;
  if (snapshot.body.handoff?.humanSince) return { state: "taken", since: snapshot.body.handoff.humanSince };
  return caseAwaitsV2Attribution(snapshot) ? { state: "awaiting_attribution" } : { state: "team_not_taken" };
}

/** What an investigation wait asks for, derived from pole B's own wording (never a resolution): a pass to resume, a technical block a person examines,
 * or a business handover to the team. */
export type CasePilotWaitKind = "resume" | "technical" | "team";
const waitKindLabels: Record<CasePilotWaitKind, string> = {
  resume: "À reprendre par un nouveau passage d’investigation (aucune reprise automatique n’est branchée dans cette version).",
  technical: "Blocage technique : une personne examine ; ce n’est pas une remise du dossier à l’équipe.",
  team: "Remise à l’équipe (métier) : ce n’est pas une résolution de la demande.",
};
// Pole B lot 5 (contract announced, NOT COMPOSED here): a stored `knowledge_changed` wait, written through the existing progress under the claim. Its own
// sentence lives here until B's labels carry it; no revision id or schema message is ever shown, and nothing about cost is inferred from it.
const uxWaitLabels: Record<string, { label: string; unblock: string; needsPerson: boolean }> = {
  knowledge_changed: { label: "Les connaissances ont changé, une nouvelle vérification est nécessaire.", unblock: "Les citations de la proposition seront revérifiées sur les connaissances actuelles avant tout usage.", needsPerson: false },
};
// B5's closed codes of a knowledge_changed wait (never a revision id).
const knowledgeChangedProblemLabels: Readonly<Record<string, string>> = {
  revision_moved: "une fiche a été publiée, archivée ou désactivée pendant l’investigation",
  revision_unreadable: "la version des connaissances n’a pas pu être lue",
};
/** Where the case stands, in one sentence, from the stored phase and handoff only. A closure is never called a resolution, and a handoff is not a takeover. */
export type CasePilotSituation = { kind: "customer" | "closed" | "team_required" | "taken" | "agent" | "attribution" | "technical"; title: string; detail: string | null; tone: "neutral" | "warning" | "success" };
function readSituation(snapshot: CaseSnapshot): CasePilotSituation {
  const { phase, body } = snapshot, handoff = body.handoff;
  if (caseAwaitsV2Attribution(snapshot)) return { kind: "attribution", title: "En attente du propriétaire V2", detail: "Le ticket reste à l’équipe tant que son propriétaire HubSpot n’est pas lu comme V2.", tone: "neutral" };
  if (handoff?.humanSince) return { kind: "taken", title: "Pris en charge par une personne", detail: `Depuis ${handoff.humanSince}. L’agent V2 n’agit plus sur ce dossier.`, tone: "neutral" };
  // The team is required; whether anyone was told is the notice's ledger (describeHandoffNotice), never this record.
  if (handoff) return { kind: "team_required", title: "Équipe requise", detail: "Pas encore pris en charge par une personne.", tone: "warning" };
  if (snapshot.owner === "human") return { kind: "taken", title: "Tenu par une personne", detail: "L’agent V2 n’agit pas sur ce dossier.", tone: "neutral" };
  if (phase === "awaiting_customer") return { kind: "customer", title: "En attente du client", detail: body.waiting?.dueAt ? `Relance possible à partir du ${body.waiting.dueAt}.` : null, tone: "neutral" };
  if (phase === "resolved") return { kind: "closed", title: "Fermé : résolu", detail: null, tone: "success" };
  if (phase === "closed_no_reply") return { kind: "closed", title: "Fermé sans réponse du client", detail: "Cette fermeture ne prouve pas que la demande est résolue.", tone: "neutral" };
  if (phase === "queued" || phase === "acting") return { kind: "agent", title: casePhaseLabels[phase], detail: null, tone: "neutral" };
  return { kind: "technical", title: casePhaseLabels[phase], detail: "Aucune réponse n’est présentée comme envoyée tant que la cause n’est pas levée.", tone: "warning" };
}

/** How a mail came from V1 to V2, as recorded on the journal (`detail.relay`). An unknown or absent proof says so; it is never read as V1's confirmation. */
const relayLabels: Record<string, string> = {
  intake_effects_confirmed: "V1 a traité ce mail et confirmé ses effets, puis l’a transmis à V2.",
  acknowledgement_on_case_thread: "V1 l’a classé comme simple accusé de réception, sur un fil déjà suivi par V2.",
  v2_customer_return: "Retour du client sur un dossier V2 ouvert : repris par V2.",
};
const returnRouteLabels: Record<string, string> = { continue: "le dossier continue", reopen: "le dossier est rouvert", hand_to_team: "le dossier passe à l’équipe" };
export type CasePilotEngines = { v1: { label: string; at: string }[]; v2: string };
function readEngines(snapshot: CaseSnapshot, events: readonly CaseEvent[]): CasePilotEngines {
  const v1 = events.filter(event => event.kind === "inbound_confirmed").sort((a, b) => a.caseVersion - b.caseVersion).map(event => {
    const relay = event.detail?.relay as { kind?: unknown; route?: unknown } | undefined;
    if (!relay) return { label: "Aucune preuve de relais V1 enregistrée pour ce mail.", at: event.occurredAt };
    const known = typeof relay.kind === "string" && Object.hasOwn(relayLabels, relay.kind) ? relayLabels[relay.kind]! : "Preuve de relais non reconnue par cette version.";
    const route = typeof relay.route === "string" && Object.hasOwn(returnRouteLabels, relay.route) ? ` Suite : ${returnRouteLabels[relay.route]}.` : "";
    return { label: `${known}${route}`, at: event.occurredAt };
  });
  return { v1, v2: snapshot.owner === "agent" ? "L’agent V2 est responsable de ce dossier." : snapshot.owner === "human" ? "L’agent V2 n’est pas responsable de ce dossier : il n’y investigue et n’y répond pas." : "Dossier V2 en suspens : aucun effet tant que la pause dure." };
}

/** What the agent or the customer already checked, from the stored record only: a trial's outcome, an answered question, the rule checks. Nothing here is inferred. */
const trialOutcomeLabels: Record<string, string> = { pending: "Essai demandé : résultat attendu", failed: "Essai fait : échec", succeeded: "Essai fait : réussi", unknown: "Essai : résultat inconnu" };
const attemptLabel = (attempt: { result: string; outcome?: string; plan?: string; purpose?: string; uncertain?: boolean }) =>
  attempt.result === "validated" ? (attempt.outcome === "accepted" ? "Décision contrôlée : conforme aux règles" : "Décision contrôlée : refusée, à relire")
    : attempt.result === "checked" ? `Résolution contrôlée : ${closurePlanLabels[attempt.plan ?? ""] ?? "résultat non reconnu"}`
    : attempt.uncertain ? "Appel de contrôle au résultat incertain" : "Appel de contrôle échoué";
const closurePlanLabels: Record<string, string> = { soft_close: "fermeture possible", no_close_transfer_thanks: "ne pas fermer, simple remerciement après transfert", no_close_not_resolved: "ne pas fermer, demande non résolue", ask_confirmation: "demander confirmation au client" };
export type CasePilotCards = { state: "none" } | { state: "unreadable" } | { state: "found"; chosen: KnowledgeRef[]; consulted: KnowledgeRef[]; scope: { revision: string; policyRevision: string } | null };
const refKey = (ref: KnowledgeRef) => `${ref.knowledgeId}/${ref.contentVersionId}`;
const uniqueRefs = (refs: readonly KnowledgeRef[]) => [...new Map(refs.map(ref => [refKey(ref), { knowledgeId: ref.knowledgeId, contentVersionId: ref.contentVersionId }])).values()];

export type CasePilotWait = { label: string; detail?: string; needsPerson: boolean; kind?: CasePilotWaitKind };
export type CasePilotProposal =
  | { state: "none" }
  | { state: "unreadable"; recordedOn: number }
  | { state: "found"; proposedOn: number; stale: boolean; action: string; reply: string | null; citations: number; missingInformation: string[]; handoffNeed: string | null; chosen: KnowledgeRef[] };

/** SAV-18: the closed reasons of a case held by its block's switch, as the Studio says them. */
export const caseBlockHoldLabels: Record<string, string> = {
  block_off: "Bloc éteint : l’agent ne propose ni n’envoie rien pour ce bloc. Le dossier attend et reprend quand un administrateur rallume le bloc.",
  block_paused: "Bloc en pause : l’agent ne propose ni n’envoie rien pour ce bloc. Le dossier attend et reprend à la fin de la pause.",
  block_setting_invalid: "Réglage du bloc illisible : traité comme un bloc éteint jusqu’à un nouvel enregistrement.",
};
export type CasePilotBlockHold = Readonly<{ blockId: string; reason: string; since: string }> | null;
export function buildCasePilotView(input: { snapshot: CaseSnapshot; events: readonly CaseEvent[]; timers: readonly CaseTimer[]; pause: SavAgentPauseState; now: Date; blockHold?: CasePilotBlockHold }) {
  const { snapshot, events, timers, pause, now } = input, body = snapshot.body;
  const firstInbound = [...events].sort((a, b) => a.caseVersion - b.caseVersion).find(event => event.kind === "inbound_confirmed") ?? null;

  const progressKey = latestInvestigationInput([...events]);
  const read = progressKey ? readCaseInvestigationProgress(events, progressKey) : { state: "none" as const };
  let proposal: CasePilotProposal = { state: "none" };
  if (read.state === "unreadable") proposal = { state: "unreadable", recordedOn: read.caseVersion };
  else if (read.state === "found" && read.record.progress.proposal) {
    const parsed = caseDecisionProposalSchema.safeParse(read.record.progress.proposal.output);
    const proposedOn = read.record.progress.proposal.proposedOn;
    proposal = !parsed.success ? { state: "unreadable", recordedOn: read.caseVersion } : {
      state: "found", proposedOn, stale: proposedOn !== snapshot.version, action: nextActionLabels[parsed.data.nextAction.kind],
      reply: parsed.data.reply?.text ?? null, citations: parsed.data.reply?.citations.length ?? 0,
      missingInformation: parsed.data.nextAction.kind === "handoff" ? parsed.data.nextAction.report.missingInformation : [],
      handoffNeed: parsed.data.nextAction.kind === "handoff" ? parsed.data.nextAction.report.need : null,
      // The sheets the proposal itself relies on: cited in the reply and behind each step.
      chosen: uniqueRefs([...(parsed.data.reply?.citations ?? []), ...(parsed.data.nextAction.kind === "answer" ? parsed.data.nextAction.steps.map(step => step.knowledge) : [])]),
    };
  }

  // Coverage of the latest decision, per request (pole B). An unreadable decision gives none, never a gap.
  const decision = read.state === "found" ? read.record.decision as { coverage?: unknown } | null : null;
  const coverage = new Map<string, CasePilotKnowledge>();
  if (decision && Array.isArray(decision.coverage)) for (const row of decision.coverage as Array<{ requestId?: unknown; status?: unknown; knowledge?: unknown; limitations?: unknown }>)
    if (row && typeof row.requestId === "string") coverage.set(row.requestId, describeCoverage(row));

  // Every recorded reason the case is not moving, from the most binding; none is hidden behind another.
  const waits: CasePilotWait[] = [];
  if (pause.invalid) waits.push({ label: "Réglage de pause V2 illisible : traité comme une pause complète.", needsPerson: true });
  else if (pause.level !== "running") waits.push({ label: pauseLabels[pause.level], detail: pause.setting ? `Depuis ${pause.setting.setAt} par ${pause.setting.setBy}` : undefined, needsPerson: false });
  if (input.blockHold) waits.push({ label: caseBlockHoldLabels[input.blockHold.reason] ?? caseBlockHoldLabels.block_setting_invalid,
    detail: `Bloc ${input.blockHold.blockId}, motif ${input.blockHold.reason}${input.blockHold.since ? `, depuis ${input.blockHold.since}` : ""}.`, needsPerson: input.blockHold.reason === "block_setting_invalid" });
  // A relayed case waits for the V2 owner read on the ticket (no V1 attribution needed since 4/11); that is not a handoff to the team.
  const awaitingAttribution = caseAwaitsV2Attribution(snapshot);
  if (awaitingAttribution) waits.push({ label: "En attente du propriétaire V2 : l’agent prend le dossier dès que le propriétaire actuel du ticket HubSpot est lu comme V2. Ticket sans propriétaire ou tenu par une personne : il reste à l’équipe, rien n’est écrit.", needsPerson: false });
  else if (snapshot.owner !== "agent") waits.push({ label: `Responsable : ${caseOwnerLabels[snapshot.owner]}. L’agent n’agit pas sur ce dossier.`, needsPerson: snapshot.owner === "human" });
  if (body.handoff && !awaitingAttribution) waits.push({ label: body.handoff.humanSince ? "Transféré à l’équipe, pris en charge." : "Équipe requise, pas encore pris en charge.",
    detail: `Motif ${body.handoff.reason}${body.handoff.humanSince ? `, pris le ${body.handoff.humanSince}` : ""}`, needsPerson: !body.handoff.humanSince });
  const admission = snapshot.admission;
  if (!admission) waits.push({ label: "Aucune admission enregistrée : l’agent ne peut pas prendre ce dossier.", needsPerson: true });
  else {
    if (admission.target !== "agent") waits.push({ label: admission.reasons.map(reason => SAV_CASE_ADMISSION_REASON_LABELS[reason as CaseAdmissionReason] ?? reason).join(" "), needsPerson: true });
    if (snapshot.admissionInputVersion > admission.version) waits.push({ label: "Une entrée plus récente est arrivée : admission à réévaluer avant toute décision.", needsPerson: false });
  }
  if (body.waiting) waits.push({ label: waitingKindLabels[body.waiting.kind], detail: `Motif ${body.waiting.reasonCode}, depuis ${body.waiting.since}${body.waiting.dueAt ? `, échéance ${body.waiting.dueAt}` : ""}`, needsPerson: body.waiting.kind === "team" });
  if (read.state === "found" && read.record.progress.waiting) {
    const waiting = read.record.progress.waiting as { reason: string; since: string; caseVersion?: unknown; problem?: unknown; detail?: unknown; embeddingCalls?: unknown; diagnostic?: unknown };
    const generation = storedCount(read.record.progress.modelCalls), embeddings = storedCount(waiting.embeddingCalls);
    // Two different costs: a generation (model) call and a knowledge-search embedding. "No generation call" never means "no embedding".
    const calls = `Appels de génération (modèle) enregistrés : ${generation ?? "non enregistré"}. Embeddings envoyés pendant ce passage : ${embeddings ?? "non enregistré"}.`;
    const since = `Depuis ${waiting.since}, version ${typeof waiting.caseVersion === "number" ? waiting.caseVersion : "non enregistrée"}.`;
    const kindOf = (reason: string, needsPerson: boolean): CasePilotWaitKind => reason === "decision_refused" ? "team" : needsPerson ? "technical" : "resume";
    const push = (wait: { label: string; body: string; needsPerson: boolean; kind: CasePilotWaitKind }) =>
      waits.push({ label: wait.label, detail: `${waitKindLabels[wait.kind]} ${wait.body} ${calls} ${since}`, needsPerson: wait.needsPerson, kind: wait.kind });
    const transport = describeCaseModelTransportDiagnostic(waiting.diagnostic);
    if (transport) push({ label: transport.label, body: transport.detail, needsPerson: waiting.reason === "technical_exhausted", kind: "technical" });
    else if (waiting.reason === "context_invalid") push({ label: "Contexte de décision impossible à construire depuis le dossier : aucun appel de génération (modèle) de décision.",
      body: `Motif : ${safeContextProblem(waiting)}.`, needsPerson: true, kind: "technical" });
    else {
      // Own keys only: a stored reason such as "constructor" or "__proto__" is unknown, never an inherited property.
      const own = <T,>(labels: Readonly<Record<string, T>>, key: string) => Object.hasOwn(labels, key) ? labels[key] : undefined;
      const wait = own(uxWaitLabels, waiting.reason) ?? own(caseInvestigationWaitLabels as Readonly<Record<string, { label: string; unblock: string; needsPerson: boolean }>>, waiting.reason);
      const changed = waiting.reason === "knowledge_changed" && typeof waiting.problem === "string" ? own(knowledgeChangedProblemLabels, waiting.problem) : undefined;
      const motive = waiting.reason !== "knowledge_changed" || waiting.problem === undefined ? "" : `Motif : ${changed ?? "motif non reconnu par cette version"}. `;
      push(wait ? { label: wait.label, body: `${motive}${wait.unblock}`, needsPerson: wait.needsPerson, kind: kindOf(waiting.reason, wait.needsPerson) }
        : { label: `Attente d’investigation non reconnue par cette version (${waiting.reason.slice(0, 40)}).`, body: "", needsPerson: true, kind: "technical" });
    }
  }
  if (read.state === "unreadable") waits.push({ label: "Dernier enregistrement d’investigation illisible : problème technique, pas un nouveau départ.", needsPerson: true });
  const timer = [...timers].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
  let followUp: { label: string; dueAt: string; resumesAt: string | null; reason: string | null } | null = null;
  if (timer) {
    const diagnostic = describeJ2Timer({ timer, pauses: j2PausesFromAgentPause(pause), now });
    followUp = { label: timerStatusLabels[diagnostic.status], dueAt: timer.dueAt, resumesAt: diagnostic.resumesAt, reason: diagnostic.reason };
  }

  const stored = read.state === "found" ? read.record.decision as { knowledge?: unknown; accessScope?: { revision?: unknown; policyRevision?: unknown } } | null : null;
  const consulted = uniqueRefs(Array.isArray(stored?.knowledge) ? (stored.knowledge as unknown[]).filter((ref): ref is KnowledgeRef => typeof (ref as KnowledgeRef)?.knowledgeId === "string" && typeof (ref as KnowledgeRef)?.contentVersionId === "string") : []);
  const stamp = stored?.accessScope;
  const cards: CasePilotCards = read.state === "unreadable" || proposal.state === "unreadable" ? { state: "unreadable" }
    : read.state !== "found" || (proposal.state === "none" && !stored) ? { state: "none" }
    : { state: "found", chosen: proposal.state === "found" ? proposal.chosen : [], consulted, scope: typeof stamp?.revision === "string" && typeof stamp.policyRevision === "string" ? { revision: stamp.revision, policyRevision: stamp.policyRevision } : null };
  const verifications = {
    trials: body.trials.map(trial => ({ label: trialOutcomeLabels[trial.outcome] ?? "Essai : état non reconnu", procedure: trial.procedure, askedAt: trial.askedAt, resultAt: trial.resultAt, result: trial.result?.text ?? null })),
    answered: body.questions.filter(question => question.answeredBy).map(question => ({ text: question.text, askedAt: question.askedAt })),
    checks: read.state === "found" ? read.record.progress.attempts.map(attempt => attemptLabel(attempt as Parameters<typeof attemptLabel>[0])) : [],
    closure: read.state === "found" && read.record.progress.closure ? closurePlanLabels[read.record.progress.closure.plan] ?? "résultat non reconnu" : null,
  };

  const check: CasePilotCheck = read.state === "found" ? readCheck(read.record.decision, snapshot.version) : read.state === "unreadable" ? { state: "unreadable" } : { state: "none" };

  return {
    ticketId: snapshot.ticketId, caseId: snapshot.caseId, version: snapshot.version, updatedAt: snapshot.updatedAt, threadIds: snapshot.threadIds,
    owner: caseOwnerLabels[snapshot.owner], phase: casePhaseLabels[snapshot.phase], sensitive: snapshot.sensitivity !== "none",
    original: firstInbound ? { at: firstInbound.occurredAt, threadId: snapshot.threadIds[0] ?? null } : null,
    requests: body.openRequests.map(request => {
      const subject = caseRequestSubject(request);
      return { knowledge: coverage.get(request.id) ?? null, summary: request.summary, family: familyLabels[request.family] ?? request.family, status: requestStatusLabels[request.status], openedAt: request.openedAt,
        subject: subject.status === "available" ? { text: subject.text, acceptedAt: subject.provenance.acceptedAt } : { missing: subjectAbsenceLabels[subject.reason] } };
    }),
    facts: currentCaseFacts(body).map(fact => ({ text: fact.text, kind: fact.kind === "observed" ? "Constaté" : "Dit par le client", source: fact.source.type, at: fact.at })),
    openQuestions: body.questions.filter(question => !question.answeredBy).map(question => ({ text: question.text, askedAt: question.askedAt })),
    waits, followUp, proposal, check, admission: readAdmission(snapshot), situation: readSituation(snapshot), engines: readEngines(snapshot, events), cards, verifications,
    // Product rule (Ugo): a ticket a person owns gets no V2 work at all, even after a new customer mail. Read-only notice, nothing is triggered.
    humanHold: readHumanHold(snapshot),
    /** True only for a recorded personal takeover (the review's probe contract): the "no V2 work" notice of a person holding the ticket. */
    humanOwned: readHumanHold(snapshot)?.state === "taken",
    // Observed outbound messages are facts read from the thread, not effects this page triggered.
    observedOutbound: events.filter(event => event.kind === "outbound_observed").map(event => ({ at: event.occurredAt, by: event.direction === "agent_outbound" ? "Agent" : "Équipe" })),
  };
}
export type CasePilotView = ReturnType<typeof buildCasePilotView>;
