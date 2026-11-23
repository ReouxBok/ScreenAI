// V1 routing (Ugo, 23/11). The PURE part: the switch, the model's routing class, the recipients and the rule that turns one analysed mail into
// « forward to a colleague », « archive » or « keep the current human path ». The class itself belongs to the model (`routing-guidelines.ts`); this file adds
// only system limits. Nothing here reads, writes or sends.
//   lead_commercial, candidature, investisseur → forward the original mail to sacha@; partenariat → nathan@; then close the dossier, no reply to the sender.
//   demarchage, notification_auto → archive and close, no human, no reply.
//   support, finance, cancellation, acknowledgement, mixed, unknown, or any doubt → nothing changes (today's path).
import { z } from "zod";
import { SAV_INTAKE_ROUTING_REVISION } from "./routing-guidelines";
export { SAV_INTAKE_ROUTING_REVISION };

export const SAV_INTAKE_ROUTING_MODES = ["off", "shadow", "live"] as const;
export type SavIntakeRoutingMode = typeof SAV_INTAKE_ROUTING_MODES[number];
/** Absent, or any value other than exactly shadow|live, is off: a typo can never forward a mail nor stop V1. */
export function savIntakeRoutingMode(env: Record<string, string | undefined>): SavIntakeRoutingMode {
  const value = env.SAV_INTAKE_ROUTING_MODE;
  return value === "shadow" || value === "live" ? value : "off";
}

export const SAV_INTAKE_ROUTING_CLASSES = ["support", "finance", "cancellation", "acknowledgement", "mixed", "unknown",
  "lead_commercial", "candidature", "investisseur", "partenariat", "demarchage", "notification_auto"] as const;
export type SavIntakeRoutingClass = typeof SAV_INTAKE_ROUTING_CLASSES[number];
export const savIntakeRoutingClassLabels: Record<SavIntakeRoutingClass, string> = {
  support: "Support", finance: "Facturation", cancellation: "Résiliation", acknowledgement: "Accusé de réception", mixed: "Mixte", unknown: "Indéterminé",
  lead_commercial: "Lead commercial", candidature: "Candidature", investisseur: "Investisseur", partenariat: "Partenariat",
  demarchage: "Démarchage / newsletter", notification_auto: "Notification automatique",
};

/** The only recipients a routed mail can ever go to (team addresses, one place). A class absent from this map is never forwarded. */
export const SAV_INTAKE_ROUTING_RECIPIENTS: Readonly<Partial<Record<SavIntakeRoutingClass, string>>> = Object.freeze({
  lead_commercial: "sacha@limova.ai", candidature: "sacha@limova.ai", investisseur: "sacha@limova.ai", partenariat: "nathan@limova.ai",
});
export const SAV_INTAKE_ROUTING_ARCHIVED: readonly SavIntakeRoutingClass[] = ["demarchage", "notification_auto"];
/** The only mailbox whose mails may be routed. */
export const SAV_INTAKE_ROUTING_MAILBOX = "contact@limova.ai";
/** The V1 execution right the live effect needs; granted by no existing policy (a renewal adds it explicitly). */
export const SAV_INTAKE_ROUTING_PERMISSION = "route_intake_mail" as const;

/** The model's routing class, stored beside V1's accepted analysis (requested only with the switch on). */
export const savIntakeRoutingAnalysisSchema = z.object({
  class: z.enum(SAV_INTAKE_ROUTING_CLASSES),
  confidence: z.enum(["high", "medium", "low"]),
  justification: z.string().trim().min(1).max(300),
}).strict();
export type SavIntakeRoutingAnalysis = z.infer<typeof savIntakeRoutingAnalysisSchema>;

export type SavIntakeRoutingFacts = Readonly<{
  messageId: string;
  /** The analysis ended waiting (technical wait or missing proofs): no routing on an unfinished analysis. */
  analysisWaiting?: boolean;
  model: SavIntakeRoutingAnalysis | null;
  /** V1's accepted plan for this very mail (decision classification, request kinds, disposition and progress kinds). Null: no plan. */
  plan: Readonly<{ classification: string; requestKinds: readonly string[]; disposition: string; progress: string }> | null;
  thread: Readonly<{
    /** Messages of the Gmail conversation V1 saw; a routed mail must be the first and only one (a new contact, never an ongoing exchange). */
    conversationLength: number;
    ticketId: string | null;
    /** Operator information, a person's choice, a pause or a human request on the thread. */
    humanContext: boolean;
    /** The mail quotes a mail of the mailbox or of a colleague: it continues an exchange. */
    quotedReply: boolean;
    /** Live only (re-read right before the effect). */
    v2Case?: boolean; newerMessage?: boolean; handledExternally?: boolean;
  }>;
}>;
export type SavIntakeRoutingAction = "forward" | "archive" | "keep";
export type SavIntakeRoutingDecision = Readonly<{
  revision: typeof SAV_INTAKE_ROUTING_REVISION;
  messageId: string;
  class: SavIntakeRoutingClass | null;
  confidence: "high" | "medium" | "low" | null;
  action: SavIntakeRoutingAction;
  recipient: string | null;
  /** Why the mail keeps the current path (null when routed). */
  reason: string | null;
}>;

const NEVER_ROUTED: readonly string[] = ["support", "finance", "cancellation", "acknowledgement", "mixed", "unknown"];
const SENSITIVE: readonly string[] = ["finance", "cancellation"];

/**
 * The whole rule. Any refusal wins and keeps today's behaviour: finance and cancellation first (never routed, whatever the model says), then support,
 * mixed, a V1 ticket path, any doubt of the model, and every sign of an ongoing exchange or of a person on the thread.
 */
export function decideIntakeRouting(facts: SavIntakeRoutingFacts): SavIntakeRoutingDecision {
  const model = facts.model, plan = facts.plan, thread = facts.thread;
  const base = { revision: SAV_INTAKE_ROUTING_REVISION, messageId: facts.messageId, class: model?.class ?? null, confidence: model?.confidence ?? null } as const;
  const keep = (reason: string): SavIntakeRoutingDecision => ({ ...base, action: "keep", recipient: null, reason });
  if (facts.analysisWaiting) return keep("analysis_waiting");
  if (!plan) return keep("plan_missing");
  if (SENSITIVE.includes(plan.classification) || plan.requestKinds.some(kind => SENSITIVE.includes(kind))) return keep("sensitive_request");
  if (model && SENSITIVE.includes(model.class)) return keep("sensitive_request");
  if (plan.classification === "support" || plan.requestKinds.includes("support")) return keep("support_request");
  if (plan.classification === "mixed") return keep("mixed_request");
  if (plan.disposition === "ticket" || plan.disposition === "request_identification") return keep("v1_ticket_path");
  if (!model) return keep("model_routing_missing");
  if (NEVER_ROUTED.includes(model.class)) return keep(`class_${model.class}`);
  if (model.confidence !== "high") return keep(`confidence_${model.confidence}`);
  if (thread.ticketId) return keep("thread_ticket");
  if (thread.conversationLength !== 1) return keep("thread_history");
  if (thread.humanContext) return keep("human_context");
  if (thread.quotedReply) return keep("reply_to_team");
  if (thread.v2Case) return keep("v2_case");
  if (thread.newerMessage) return keep("newer_message");
  if (thread.handledExternally) return keep("handled_externally");
  const recipient = SAV_INTAKE_ROUTING_RECIPIENTS[model.class];
  if (recipient) return { ...base, action: "forward", recipient, reason: null };
  if (SAV_INTAKE_ROUTING_ARCHIVED.includes(model.class)) return { ...base, action: "archive", recipient: null, reason: null };
  return keep(`class_${model.class}`);
}

/** The plan facts of a V1 plan (decision classification, request kinds, disposition, progress), or null. */
export function intakeRoutingPlanFacts(plan: { decision: { classification: string; requests: readonly { kind: string }[]; disposition: { kind: string } }; progress: { kind: string } } | undefined | null) {
  return plan ? { classification: plan.decision.classification, requestKinds: plan.decision.requests.map(r => r.kind), disposition: plan.decision.disposition.kind, progress: plan.progress.kind } : null;
}

/** The model's routing class from the accepted understanding of THIS mail (latest accepted record wins), or null. */
export function intakeRoutingModelFromSemantics(semantics: { records: readonly { method: string; result?: unknown }[] } | undefined | null, messageId: string): SavIntakeRoutingAnalysis | null {
  for (const record of [...(semantics?.records ?? [])].reverse()) {
    if (record.method !== "analyseMessage") continue;
    const result = record.result as { messageId?: unknown; routing?: unknown } | null | undefined;
    if (result?.messageId !== messageId) continue;
    const parsed = savIntakeRoutingAnalysisSchema.safeParse(result.routing);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/** One log line, codes and team addresses only (no subject, sender or text). */
export function savIntakeRoutingLogLine(mode: Exclude<SavIntakeRoutingMode, "off">, decision: SavIntakeRoutingDecision, performed = false) {
  return JSON.stringify({ event: "sav_intake_routing", revision: decision.revision, mode, messageId: decision.messageId, class: decision.class,
    confidence: decision.confidence, action: decision.action, recipient: decision.recipient, reason: decision.reason, performed });
}

/** What the console says about a shadow decision: what the routing WOULD have done (nothing was done). Null when the mail keeps its path. */
export function intakeRoutingShadowLabel(decision: Pick<SavIntakeRoutingDecision, "action" | "recipient" | "class"> | null | undefined) {
  if (!decision || decision.action === "keep" || !decision.class) return null;
  const label = savIntakeRoutingClassLabels[decision.class];
  return decision.action === "forward" ? `Routage (test, aucune action) : aurait transféré à ${decision.recipient} (${label})` : `Routage (test, aucune action) : aurait archivé (${label})`;
}

/** Allow-listed public projection for diagnostics (no justification text). */
export function publicIntakeRoutingDecision(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const cls = (SAV_INTAKE_ROUTING_CLASSES as readonly string[]).includes(String(value.class)) ? String(value.class) as SavIntakeRoutingClass : null;
  const action = ["forward", "archive", "keep"].includes(String(value.action)) ? String(value.action) as SavIntakeRoutingAction : null;
  const recipient = Object.values(SAV_INTAKE_ROUTING_RECIPIENTS).includes(String(value.recipient)) ? String(value.recipient) : null;
  return {
    mode: value.mode === "shadow" || value.mode === "live" ? value.mode : null,
    class: cls, confidence: ["high", "medium", "low"].includes(String(value.confidence)) ? String(value.confidence) : null,
    action, recipient, reason: typeof value.reason === "string" && /^[a-z_]{1,60}$/.test(value.reason) ? value.reason : null,
    label: value.mode === "shadow" ? intakeRoutingShadowLabel({ action: action ?? "keep", recipient, class: cls }) : null,
  };
}
