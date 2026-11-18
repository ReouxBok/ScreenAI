// SAV-95 (18/11): closing a HubSpot ticket after a customer's acknowledgement. The PURE part: the switch, the shape of the model's structured decision and
// the rule that turns it into « close » or « nothing ». The decision on the WORDING belongs to the model (framed by `ack-closure-guidelines.ts`); this file
// adds only system limits, never a rule on how the customer phrased things. Nothing here reads, writes or sends.
import { z } from "zod";
export { SAV_ACK_CLOSURE_REVISION } from "./ack-closure-guidelines";

/** The HubSpot note written with the stage (no customer email is ever sent). */
export const SAV_ACK_CLOSURE_NOTE = "Fermé : le client a confirmé la résolution (accusé)";
/** The V1 execution right this closure needs; granted by no existing policy (a renewal adds it explicitly). */
export const SAV_ACK_CLOSURE_PERMISSION = "close_acknowledged_ticket" as const;

/** OFF unless exactly `SAV_ACK_CLOSE=on`: shipping the code changes nothing (no prompt change, no launch hash change, no write). */
export const savAckClosureEnabled = (env: Record<string, string | undefined>) => env.SAV_ACK_CLOSE === "on";

/** The model's structured decision, stored beside V1's accepted analysis (only when the switch is on and our reply precedes the mail). */
export const savAckClosureAnalysisSchema = z.object({
  decision: z.enum(["close", "keep_open", "unsure"]),
  confidence: z.enum(["high", "medium", "low"]),
  lastOutboundMessageId: z.uuid(),
  lastOutboundState: z.enum(["conclusive", "open", "unknown"]),
  customerMessage: z.enum(["pure_ack", "confirms_resolved", "other"]),
  justification: z.string().trim().min(1).max(500),
  evidenceQuote: z.string().min(1).max(2000),
}).strict();
export type SavAckClosureAnalysis = z.infer<typeof savAckClosureAnalysisSchema>;

export type AckClosureFacts = Readonly<{
  /** V1's accepted plan for this very mail: no ticket, acknowledgement only, every request an acknowledgement, not an automatic reply, latest inbound. */
  v1Acknowledgement: boolean;
  customerMessageId: string;
  /** The message just before the customer's in the thread; null when none is stored. */
  previous: Readonly<{ messageId: string; direction: "inbound" | "outbound" }> | null;
  /** Any message stored after the customer's (a newer customer mail, or a person who wrote since). */
  newerMessage: boolean;
  ticketId: string | null;
  /** V1's sensitive dossier rule (finance or cancellation classified anywhere on the thread or its ticket, legacy legal/security included). */
  sensitiveDossier: boolean;
  /** The thread belongs to a V2 case: V2 owns its closures (`customer-return.ts`), this rule never touches it. */
  v2Case: boolean;
  model: SavAckClosureAnalysis | null;
}>;
export type AckClosureBasis = "conclusive_reply_acknowledged" | "customer_confirms_resolution";
export type AckClosureDecision = Readonly<{ close: true; basis: AckClosureBasis; ticketId: string }> | Readonly<{ close: false; reason: string }>;

/**
 * The whole rule. The model decides; the code checks the system limits and that the decision is coherent (a « close » whose own reading says the customer
 * asked something, or that our reply was open, is not a confident close). Any refusal wins; « unsure », medium or low confidence do nothing.
 */
export function decideAckClosure(facts: AckClosureFacts): AckClosureDecision {
  const no = (reason: string) => ({ close: false as const, reason });
  if (!facts.v1Acknowledgement) return no("v1_not_acknowledgement");
  if (!facts.ticketId || !/^[0-9]{1,30}$/.test(facts.ticketId)) return no("no_ticket");
  if (facts.v2Case) return no("v2_case");
  if (facts.sensitiveDossier) return no("sensitive_dossier");
  if (facts.newerMessage) return no("newer_message");
  if (!facts.previous || facts.previous.direction !== "outbound") return no("not_a_reply_to_our_outbound");
  const model = facts.model;
  if (!model) return no("model_decision_missing");
  if (model.lastOutboundMessageId !== facts.previous.messageId) return no("model_outbound_mismatch");
  if (model.decision !== "close") return no(`model_${model.decision}`);
  if (model.confidence !== "high") return no(`model_confidence_${model.confidence}`);
  if (model.customerMessage === "confirms_resolved") return { close: true, basis: "customer_confirms_resolution", ticketId: facts.ticketId };
  if (model.customerMessage === "pure_ack" && model.lastOutboundState === "conclusive") return { close: true, basis: "conclusive_reply_acknowledged", ticketId: facts.ticketId };
  return no("model_incoherent");
}
