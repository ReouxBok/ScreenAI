import { z } from "zod";

/*
 * Agent SAV intelligent, lot A (20/11, LOCAL, éteint par défaut): the contract of ONE turn of the new agent, in shadow mode only.
 * Pure: schemas and closed codes, no model, network, database or clock. Every other `smart/` file imports these types without changing them.
 *
 *   reading   what the « understand » call reads in the mail: the needs (PS included), what the customer already did, sensitive or doubt;
 *   step      one pass of the bounded decide loop (v2): « thinking » first, then either read-only tool calls or the final decision;
 *   decision  what the loop concludes: reply, ask THE question, or hand over; the reply and its facts, each with its source (a card, the customer,
 *             or an Academy tool call); the structured team note; what this mail taught the case memory;
 *   verdict   what the independent counter-read says of a reply (closed codes, the sentence at fault);
 *   judge     the later comparison with what the team did (A/B, closed codes): an interface, not wired (lot 0).
 *
 * The model's free text (reply, team note, sentences, excerpts) is bounded here and only ever stored encrypted; logs carry closed codes only.
 * Parsing strips unknown keys (a model may add some) but never fills a missing required field: a missing field is an invalid output.
 */

export const SAV_SMART_CONTRACT_REVISION = "sav-smart-contract-2026-11-20.v2";

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
  /** Where it comes from: a card (id + version), an Academy tool call (its call id), the customer's message, or nothing (advice only). */
  sourceKind: z.enum(["fiche", "academy", "client", "aucune"]),
  cardId: text(120).nullable().default(null),
  version: text(120).nullable().default(null),
  /** The id of the Academy tool call (`t1`...) whose result carries the fact. */
  toolCallId: text(10).nullable().default(null),
  /** The passage of the source that carries the fact, copied word for word; null for advice. */
  excerpt: text(600).nullable().default(null),
});
export type SmartFact = z.infer<typeof smartFactSchema>;

export const smartCoverageSchema = z.object({ needId, status: z.enum(["answered", "asked", "handed"]) });

export const SAV_SMART_HANDOFF_REASONS = ["no_source", "real_bug", "account_action", "wants_human", "upset", "sensitive", "unsure", "other"] as const;
/** Reasons only the server writes on its fallback note: budget spent, a failure, no progress, the exchange cap. */
export const SAV_SMART_FALLBACK_REASONS = ["budget_epuise", "panne", "pas_de_progres", "trop_d_echanges"] as const;

/**
 * The structured note for the team (HARNAIS 4): the need, what was understood, what was checked and its source, what was tried and its result,
 * the hypotheses and their state, THE next check, what the customer was told. Even when the knowledge falls short, the agent starts the
 * investigation and hands over something concrete. A plain string from the model is accepted as the need (lenient: never lose a note).
 */
const noteItems = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max).catch([] as z.infer<T>[]).default([]);
export const smartTeamNoteSchema = z.preprocess(value => typeof value === "string" ? { besoin: value } : value, z.object({
  raison: z.enum([...SAV_SMART_HANDOFF_REASONS, ...SAV_SMART_FALLBACK_REASONS]).catch("other").default("other"),
  besoin: text(600).min(1),
  compris: text(800).default(""),
  verifie: noteItems(z.object({ fait: text(400).min(1), source: text(160).default("") }), 6),
  essaye: noteItems(z.object({ quoi: text(300).min(1), resultat: text(160).default("") }), 6),
  hypotheses: noteItems(z.object({ texte: text(300).min(1), statut: text(30).default("ouverte") }), 6),
  prochaineVerification: text(400).default(""),
  ditAuClient: text(400).nullable().default(null),
}));
export type SmartTeamNote = z.infer<typeof smartTeamNoteSchema>;

/** What one mail taught the case memory, written by the model; the server merges and counts it (`smart-memory.ts`). */
export const smartMemoryUpdateSchema = z.object({
  newFacts: noteItems(z.object({ needId: needId.catch("n1"), text: text(300).min(1), excerpt: text(300).min(1) }), 6),
  hypotheses: noteItems(z.object({ id: text(10).min(1), needId: needId.catch("n1"), text: text(300).min(1), status: z.enum(["open", "ruled_out", "confirmed"]), why: text(300).default("") }), 6),
  trials: noteItems(z.object({ id: text(10).min(1), needId: needId.catch("n1"), what: text(300).min(1), cardId: text(120).nullable().default(null) }), 4),
  trialResults: noteItems(z.object({ trialId: text(10).min(1), result: z.enum(["worked", "failed"]) }), 6),
  question: text(400).nullable().default(null),
}).default({ newFacts: [], hypotheses: [], trials: [], trialResults: [], question: null });
export type SmartMemoryUpdate = z.infer<typeof smartMemoryUpdateSchema>;

export const smartDecisionSchema = z.object({
  outcome: z.enum(SAV_SMART_OUTCOMES),
  /** The mail to the customer (plain text, no signature: the server adds it). Required to reply or ask; optional on a handoff. */
  reply: text(6_000).nullable().default(null),
  /** For the team when a need is handed: the structured note (required then). */
  teamNote: smartTeamNoteSchema.nullable().default(null),
  handoffReason: z.enum(SAV_SMART_HANDOFF_REASONS).nullable().default(null),
  coverage: z.array(smartCoverageSchema).max(4),
  facts: z.array(smartFactSchema).max(20).default([]),
  memory: smartMemoryUpdateSchema,
});
export type SmartDecision = z.infer<typeof smartDecisionSchema>;

/** The tools a decide pass may call (the registry, `smart-tools.ts`, says which are on). */
export const SAV_SMART_TOOL_NAMES = ["chercher_fiches", "rechercher_integrations", "lister_actions_integration", "obtenir_guide_connexion"] as const;
export type SmartToolName = typeof SAV_SMART_TOOL_NAMES[number];
export const smartToolCallSchema = z.object({
  id: z.string().regex(/^t[1-9]$/),
  tool: text(60).min(1),
  needId: needId.catch("n1"),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type SmartToolCall = z.infer<typeof smartToolCallSchema>;

/**
 * One pass of the decide loop: « thinking » comes first (the model reasons before committing; bounded, stored encrypted, never shown to the
 * counter-read), then `action: "tools"` with 1 to 3 read-only calls, or `action: "final"` with the decision. A v1 bare decision is refused.
 */
export const smartStepSchema = z.object({
  thinking: text(800).default(""),
  action: z.enum(["tools", "final"]),
  calls: z.array(smartToolCallSchema).max(3).default([]),
  decision: smartDecisionSchema.nullable().default(null),
}).superRefine((value, ctx) => {
  if (value.action === "final" && !value.decision) ctx.addIssue({ code: "custom", message: "FINAL_WITHOUT_DECISION" });
  if (value.action === "tools" && !value.calls.length) ctx.addIssue({ code: "custom", message: "TOOLS_WITHOUT_CALL" });
  if (new Set(value.calls.map(call => call.id)).size !== value.calls.length) ctx.addIssue({ code: "custom", message: "CALL_IDS_DUPLICATED" });
});
export type SmartStep = z.infer<typeof smartStepSchema>;

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
  // v2, the progress rule (HARNAIS 2): the only two refusals it adds.
  "question_repeated", "trial_repeated",
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
