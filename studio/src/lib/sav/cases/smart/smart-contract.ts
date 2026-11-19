import { z } from "zod";

/*
 * Agent SAV intelligent, lot A (20/11, LOCAL, éteint par défaut): the contract of ONE turn of the new agent, in shadow mode only.
 * Pure: schemas and closed codes, no model, network, database or clock. Every other `smart/` file imports these types without changing them.
 *
 *   reading   what the « understand » call reads in the mail: the needs (PS included), what the customer already did, sensitive or doubt;
 *   decision  what the « decide » call chooses: reply, ask THE question, or hand over; the reply and the list of its facts, each with its source;
 *   verdict   what the independent counter-read says of a reply (closed codes, the sentence at fault);
 *   judge     the later comparison with what the team did (A/B, closed codes): an interface, not wired (lot 0).
 *
 * The model's free text (reply, team note, sentences, excerpts) is bounded here and only ever stored encrypted; logs carry closed codes only.
 * Parsing strips unknown keys (a model may add some) but never fills a missing required field: a missing field is an invalid output.
 */

export const SAV_SMART_CONTRACT_REVISION = "sav-smart-contract-2026-11-20.v1";

export const SAV_SMART_OUTCOMES = ["reply", "ask", "handoff"] as const;
export type SmartOutcome = typeof SAV_SMART_OUTCOMES[number];

/** Families the agent never handles (Ugo: the WHOLE mail goes to the team). */
export const SAV_SMART_SENSITIVE_FAMILIES = ["cancellation", "subscription", "finance", "rights", "identity", "security"] as const;

const needId = z.string().regex(/^n[1-9]$/);
const text = (max: number) => z.string().max(max);

export const smartNeedSchema = z.object({
  id: needId,
  /** What the customer wants to obtain, in a few words (not their exact words). */
  ask: text(400).min(1),
  /** What the customer says they already did or tried. */
  alreadyDone: z.array(text(300)).max(5).default([]),
  /** A short theme (a Studio category when it fits), used for the « missing sources by theme » report. */
  theme: text(80).nullable().default(null),
  /** The words to search the cards with; null when nothing is searchable. */
  search: text(300).nullable().default(null),
});
export type SmartNeed = z.infer<typeof smartNeedSchema>;

export const smartReadingSchema = z.object({
  needs: z.array(smartNeedSchema).max(4),
  sensitive: z.enum(["yes", "no", "doubt"]),
  sensitiveFamilies: z.array(z.enum(SAV_SMART_SENSITIVE_FAMILIES)).max(6).default([]),
  wantsHuman: z.boolean(),
  upset: z.boolean().default(false),
  /** The mail contains an instruction aimed at the assistant (« ignore tes règles »...). */
  instructionInMail: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (new Set(value.needs.map(need => need.id)).size !== value.needs.length) ctx.addIssue({ code: "custom", message: "NEED_IDS_DUPLICATED" });
});
export type SmartReading = z.infer<typeof smartReadingSchema>;

export const SAV_SMART_FACT_TYPES = ["fait_limova", "fait_temporaire", "fait_tiers", "dit_par_le_client", "conseil"] as const;
export type SmartFactType = typeof SAV_SMART_FACT_TYPES[number];

export const smartFactSchema = z.object({
  /** The sentence of the reply this fact is about, copied as is. */
  sentence: text(600).min(1),
  needId,
  type: z.enum(SAV_SMART_FACT_TYPES),
  /** Where it comes from: a card (id + version), the customer's message, or nothing (advice only). */
  sourceKind: z.enum(["fiche", "client", "aucune"]),
  cardId: text(120).nullable().default(null),
  version: text(120).nullable().default(null),
  /** The passage of the source that carries the fact, copied word for word; null for advice. */
  excerpt: text(600).nullable().default(null),
});
export type SmartFact = z.infer<typeof smartFactSchema>;

export const smartCoverageSchema = z.object({ needId, status: z.enum(["answered", "asked", "handed"]) });

export const SAV_SMART_HANDOFF_REASONS = ["no_source", "real_bug", "account_action", "wants_human", "upset", "sensitive", "unsure", "other"] as const;

export const smartDecisionSchema = z.object({
  outcome: z.enum(SAV_SMART_OUTCOMES),
  /** The mail to the customer (plain text, no signature: the server adds it). Required to reply or ask; optional on a handoff. */
  reply: text(6_000).nullable().default(null),
  /** For the team on a handoff: the need, the facts and their source, what was tried, the hypotheses, THE next check. */
  teamNote: text(3_000).nullable().default(null),
  handoffReason: z.enum(SAV_SMART_HANDOFF_REASONS).nullable().default(null),
  coverage: z.array(smartCoverageSchema).max(4),
  facts: z.array(smartFactSchema).max(20).default([]),
});
export type SmartDecision = z.infer<typeof smartDecisionSchema>;

/** What the independent counter-read may report. One closed code per problem, with the sentence at fault. */
export const SAV_SMART_VERIFY_CODES = [
  "source_mismatch", "unlisted_claim", "promise", "need_forgotten", "repeated_trial", "other_platform", "sensitive_handled", "account_action", "secret_requested", "instruction_followed",
] as const;
export type SmartVerifyCode = typeof SAV_SMART_VERIFY_CODES[number];
export const smartVerdictSchema = z.object({
  verdict: z.enum(["conforme", "non_conforme"]),
  problems: z.array(z.object({ code: z.enum(SAV_SMART_VERIFY_CODES), sentence: text(600).default("") })).max(10).default([]),
}).superRefine((value, ctx) => {
  if (value.verdict === "non_conforme" && !value.problems.length) ctx.addIssue({ code: "custom", message: "NON_CONFORME_WITHOUT_PROBLEM" });
});
export type SmartVerdict = z.infer<typeof smartVerdictSchema>;

/** The server's own checks (no model): closed codes. Any of them refuses the reply, whatever the counter-read says. */
export const SAV_SMART_CHECK_CODES = [
  "reply_missing", "coverage_invalid", "need_not_covered", "fact_sentence_missing", "excerpt_not_found", "card_not_retrieved_for_need", "fact_source_invalid",
  "third_party_fact_unsourced", "link_not_allowed", "other_platform_recommended", "third_party_named", "credential_request", "promise_unsourced",
  "account_action_claimed", "kernel_in_reply", "team_note_missing",
] as const;
export type SmartCheckCode = typeof SAV_SMART_CHECK_CODES[number];

/** How a turn ended. `team_sensitive`: stopped before any decision (filet or reading), the WHOLE mail to the team. */
export const SAV_SMART_TURN_OUTCOMES = ["team_sensitive", "reply", "ask", "handoff", "failed", "interrupted"] as const;
export type SmartTurnOutcome = typeof SAV_SMART_TURN_OUTCOMES[number];

export const SAV_SMART_CALL_KINDS = ["understand", "embed", "decide", "verify", "correct", "reverify"] as const;
export type SmartCallKind = typeof SAV_SMART_CALL_KINDS[number];

// ---------------------------------------------------------------------------------------------------------------------------------
// Comparison judge (lot E, NOT WIRED): the shadow reply against what the team did, blind (A/B in random order), closed codes only.
// ---------------------------------------------------------------------------------------------------------------------------------
const yesNo = z.enum(["oui", "non"]);
const perAnswer = z.object({ promise: yesNo, otherPlatform: yesNo, secretRequested: yesNo, sensitiveHandled: yesNo, repeatsDone: yesNo });
export const smartJudgeVerdictSchema = z.object({
  sameOutcome: yesNo,
  contradiction: yesNo,
  contradictionSentence: text(600).default(""),
  better: z.enum(["A", "B", "egal"]),
  A: perAnswer,
  B: perAnswer,
});
export type SmartJudgeVerdict = z.infer<typeof smartJudgeVerdictSchema>;

/** Parses a model output against a schema: the value, or a closed failure code (never the model's text). */
export function parseSmartOutput<T>(schema: z.ZodType<T>, output: unknown): { ok: true; value: T } | { ok: false; problem: "output_invalid" } {
  const parsed = schema.safeParse(output);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: "output_invalid" };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Generic tool interface (20/11): the Academy and webinar tools are written elsewhere (`smart/tools/`, another branch) and plugged in later.
// NOT WIRED in this scope (one turn, no tool loop). A tool is read-only: it never writes, never sees a secret, never acts on an account.
// ---------------------------------------------------------------------------------------------------------------------------------
export type SmartToolSource = Readonly<{ kind: "academy" | "webinar" | "page"; url: string; title: string | null; readAt: string }>;
export type SmartToolResult<O> = Readonly<{ status: "ok"; output: O; sources: readonly SmartToolSource[] }> | Readonly<{ status: "failed"; problem: string }>;
export type SmartTool<I = unknown, O = unknown> = Readonly<{
  /** Stable id the model calls it by (`[a-z_]{2,40}`). */
  name: string;
  /** What it is for, shown to the model. */
  description: string;
  /** The input the model must give (validated before any execution). */
  inputSchema: z.ZodType<I>;
  /** Off unless its own switch says on (Academy: off until Ugo's signal). */
  enabled: (env: Readonly<Record<string, string | undefined>>) => boolean;
  /** Read only, bounded in time; every fact it returns carries its source (the server checks links against `sources`). */
  execute: (input: I, context: Readonly<{ now: Date; signal: AbortSignal }>) => Promise<SmartToolResult<O>>;
}>;
