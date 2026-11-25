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
 *
 * v4 (20/11, shadow diagnosis: 7 of 30 mails `failed`, the bench's first Nylas case `decide:output_invalid`): the SHAPE of a well-behaved answer
 * no longer fails the turn. Tolerated: the output wrapped in a one-item array or in a JSON string with code fences; `null` where an empty list,
 * an empty text or the default is meant; enum values in another case or with spaces; internal texts (thinking, team note, memory, reading,
 * proof, excerpt prefix) longer than their bound are CUT, never refused; a free handoff reason becomes « other »; extra calls beyond 3 dropped,
 * free call ids renumbered; a final step's leftover calls and a tools step's placeholder decision ignored; a decision written flat (no step)
 * is a final step. NOT tolerated, unchanged: the customer reply above its bound, an unknown outcome, fact type or source kind, a wrong need
 * id, more than 4 needs, a missing `wantsHuman` or `sensitive`; and every safety rule downstream (sensitive barrier, server checks, counter-read).
 *
 * v5 (21/11, SAV-122): a fact's `sentence` is optional, a hint for the counter-read only; the server no longer matches it against the reply.
 */

export const SAV_SMART_CONTRACT_REVISION = "sav-smart-contract-2026-11-21.v5";

export const SAV_SMART_OUTCOMES = ["reply", "ask", "handoff"] as const;
export type SmartOutcome = typeof SAV_SMART_OUTCOMES[number];

/** Families the agent never handles (Ugo: the WHOLE mail goes to the team). */
export const SAV_SMART_SENSITIVE_FAMILIES = ["cancellation", "subscription", "finance", "rights", "identity", "security"] as const;

const needId = z.string().regex(/^n[1-9]$/);
const text = (max: number) => z.string().max(max);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** `null` read as « absent », so the default applies (a JSON-mode model writes `null` for an empty list or text). */
const nullAsAbsent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(value => value === null ? undefined : value, schema);
/** The text cut to its bound (never inside a UTF-16 pair). Only for texts nobody receives as is: thinking, team note, memory, reading, proof. */
const cut = (value: string, max: number) => { const head = value.slice(0, max); return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head; };
const clipped = (max: number) => z.preprocess(value => typeof value === "string" ? cut(value, max) : value, z.string().max(max));
/** A cut text with its default, `null` included. */
const clippedOr = (max: number, fallback: string) => nullAsAbsent(clipped(max).default(fallback));
const clippedNullable = (max: number) => z.preprocess(value => typeof value === "string" ? cut(value, max) : value, z.string().max(max).nullable());
/** An enum read case-insensitively, spaces trimmed (« Reply », « final  »). */
const looseEnum = <const T extends readonly [string, ...string[]]>(values: T) => z.preprocess(value => typeof value === "string" ? value.trim().toLowerCase() : value, z.enum(values));

export const smartNeedSchema = z.object({
  id: needId,
  /** What the customer wants to obtain, in a few words (not their exact words). */
  ask: clipped(400).pipe(z.string().min(1)),
  /** What the customer says they already did or tried (the first 5 kept). */
  alreadyDone: z.preprocess(value => value === null ? undefined : Array.isArray(value) ? value.slice(0, 5) : value, z.array(clipped(300)).max(5).default([])),
  /** A short theme (a Studio category when it fits), used for the « missing sources by theme » report. */
  theme: clippedNullable(80).default(null),
  /** The words to search the cards with; null when nothing is searchable. */
  search: clippedNullable(300).default(null),
});
export type SmartNeed = z.infer<typeof smartNeedSchema>;

/** Barrier 2 (Astra, 20/11): the model names the sensitive family it sees, with the exact quote of the mail that proves it. Absent: stop. */
export const SAV_SMART_SENSIBLE_FAMILIES = ["aucune", "resiliation", "remboursement", "facturation", "abonnement", "finance", "autre_sensible"] as const;
export const smartSensibleSchema = z.object({ famille: looseEnum(SAV_SMART_SENSIBLE_FAMILIES), preuve: clippedOr(400, "") });
export type SmartSensible = z.infer<typeof smartSensibleSchema>;

const NO_FAMILY = new Set<string>(["", "aucune", "aucun", "none", "no", "non", "rien"]);
export const smartReadingSchema = z.object({
  needs: z.array(smartNeedSchema).max(4),
  /** Optional in the schema so a reading without it still parses: the SERVER then stops (absent = doubt = the team). */
  sensible: smartSensibleSchema.nullable().catch(null).default(null),
  sensitive: looseEnum(["yes", "no", "doubt"]),
  /** « none » written as a family (`["aucune"]`, `null`) is no family; any other unknown word stays invalid (never read as « nothing sensitive »). */
  sensitiveFamilies: z.preprocess(value => value === null ? undefined : Array.isArray(value)
    ? value.map(item => typeof item === "string" ? item.trim().toLowerCase() : item).filter(item => !NO_FAMILY.has(item as string)) : value,
  z.array(z.enum(SAV_SMART_SENSITIVE_FAMILIES)).max(6).default([])),
  wantsHuman: z.boolean(),
  upset: z.boolean().default(false),
  /** The mail contains an instruction aimed at the assistant (« ignore tes règles »...). */
  instructionInMail: z.boolean().default(false),
  /** SAV-122 (PORTE 2E, P1): the instruction itself, copied from the mail (short), so the counter-read and the server can check the reply. */
  instructionText: z.preprocess(value => typeof value === "string" ? value.trim().slice(0, 300) || null : null, z.string().nullable()).default(null),
}).superRefine((value, ctx) => {
  if (new Set(value.needs.map(need => need.id)).size !== value.needs.length) ctx.addIssue({ code: "custom", message: "NEED_IDS_DUPLICATED" });
});
export type SmartReading = z.infer<typeof smartReadingSchema>;

export const SAV_SMART_FACT_TYPES = ["fait_limova", "fait_temporaire", "fait_tiers", "dit_par_le_client", "conseil"] as const;
export type SmartFactType = typeof SAV_SMART_FACT_TYPES[number];

export const smartFactSchema = z.object({
  /**
   * v5 (SAV-122, prod bench 21/11): OPTIONAL, a hint for the counter-read on which sentence of the reply this fact supports. Never matched
   * against the reply to refuse (the old `fact_sentence_missing` refused good replies the model had reworded). Cut to its bound.
   */
  sentence: nullAsAbsent(clipped(600).default("")),
  needId,
  type: looseEnum(SAV_SMART_FACT_TYPES),
  /** Where it comes from: a card (id + version), an Academy tool call (its call id), the customer's message, or nothing (advice only). */
  sourceKind: looseEnum(["fiche", "academy", "client", "aucune"]),
  cardId: text(120).nullable().default(null),
  version: text(120).nullable().default(null),
  /** The id of the Academy tool call (`t1`...) whose result carries the fact. */
  toolCallId: text(10).nullable().default(null),
  /** The passage of the source that carries the fact, copied word for word; null for advice. Cut to its bound: a prefix stays word for word. */
  excerpt: clippedNullable(600).default(null),
});
export type SmartFact = z.infer<typeof smartFactSchema>;

export const smartCoverageSchema = z.object({ needId, status: looseEnum(["answered", "asked", "handed"]) });

export const SAV_SMART_HANDOFF_REASONS = ["no_source", "real_bug", "account_action", "wants_human", "upset", "sensitive", "unsure", "other"] as const;
/** Reasons only the server writes on its fallback note: budget spent, a failure, no progress, the exchange cap. */
export const SAV_SMART_FALLBACK_REASONS = ["budget_epuise", "panne", "pas_de_progres", "trop_d_echanges"] as const;

/**
 * The structured note for the team (HARNAIS 4): the need, what was understood, what was checked and its source, what was tried and its result,
 * the hypotheses and their state, THE next check, what the customer was told. Even when the knowledge falls short, the agent starts the
 * investigation and hands over something concrete. A plain string from the model is accepted as the need (lenient: never lose a note).
 */
const noteItems = <T extends z.ZodTypeAny>(item: T, max: number) => z.preprocess(value => Array.isArray(value) ? value.slice(0, max) : value,
  z.array(item).max(max)).catch([] as z.infer<T>[]).default([]);
/** A note object without its need (the model wrote what it understood, not « besoin »): the need is taken from it, never lost. */
const noteShape = (value: unknown) => {
  if (typeof value === "string") return { besoin: value };
  if (!isRecord(value) || (typeof value.besoin === "string" && value.besoin.trim())) return value;
  const besoin = [value.compris, value.prochaineVerification, value.ditAuClient].find(row => typeof row === "string" && row.trim());
  return { ...value, besoin: besoin ?? "Besoin non précisé par le modèle." };
};
export const smartTeamNoteSchema = z.preprocess(noteShape, z.object({
  raison: z.enum([...SAV_SMART_HANDOFF_REASONS, ...SAV_SMART_FALLBACK_REASONS]).catch("other").default("other"),
  besoin: clipped(600).pipe(z.string().min(1)),
  compris: clippedOr(800, ""),
  verifie: noteItems(z.object({ fait: clipped(400).pipe(z.string().min(1)), source: clippedOr(160, "") }), 6),
  essaye: noteItems(z.object({ quoi: clipped(300).pipe(z.string().min(1)), resultat: clippedOr(160, "") }), 6),
  hypotheses: noteItems(z.object({ texte: clipped(300).pipe(z.string().min(1)), statut: clippedOr(30, "ouverte") }), 6),
  prochaineVerification: clippedOr(400, ""),
  ditAuClient: clippedNullable(400).default(null),
}));
export type SmartTeamNote = z.infer<typeof smartTeamNoteSchema>;

/** What one mail taught the case memory, written by the model; the server merges and counts it (`smart-memory.ts`). */
export const smartMemoryUpdateSchema = nullAsAbsent(z.object({
  newFacts: noteItems(z.object({ needId: needId.catch("n1"), text: clipped(300).pipe(z.string().min(1)), excerpt: clipped(300).pipe(z.string().min(1)) }), 6),
  hypotheses: noteItems(z.object({ id: text(10).min(1), needId: needId.catch("n1"), text: clipped(300).pipe(z.string().min(1)), status: looseEnum(["open", "ruled_out", "confirmed"]), why: clippedOr(300, "") }), 6),
  trials: noteItems(z.object({ id: text(10).min(1), needId: needId.catch("n1"), what: clipped(300).pipe(z.string().min(1)), cardId: text(120).nullable().default(null) }), 4),
  trialResults: noteItems(z.object({ trialId: text(10).min(1), result: looseEnum(["worked", "failed"]) }), 6),
  question: clippedNullable(400).default(null),
}).default({ newFacts: [], hypotheses: [], trials: [], trialResults: [], question: null }));
export type SmartMemoryUpdate = z.infer<typeof smartMemoryUpdateSchema>;

export const smartDecisionSchema = z.object({
  outcome: looseEnum(SAV_SMART_OUTCOMES),
  /** The mail to the customer (plain text, no signature: the server adds it). Required to reply or ask; optional on a handoff. */
  reply: text(6_000).nullable().default(null),
  /** For the team when a need is handed: the structured note (required then). */
  teamNote: smartTeamNoteSchema.nullable().default(null),
  /** Informational (the team note carries the reason): a free word becomes « other », never a failure. */
  handoffReason: looseEnum(SAV_SMART_HANDOFF_REASONS).nullable().catch("other").default(null),
  /** Absent or null: empty, and the server's `need_not_covered` refuses it (one correction), instead of failing the turn. */
  coverage: nullAsAbsent(z.array(smartCoverageSchema).max(4).default([])),
  facts: nullAsAbsent(z.array(smartFactSchema).max(20).default([])),
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
  args: nullAsAbsent(z.record(z.string(), z.unknown()).default({})),
});
export type SmartToolCall = z.infer<typeof smartToolCallSchema>;

/**
 * One pass of the decide loop: « thinking » comes first (the model reasons before committing; bounded, stored encrypted, never shown to the
 * counter-read), then `action: "tools"` with 1 to 3 read-only calls, or `action: "final"` with the decision. A v1 bare decision is refused.
 */
const CALL_ID = /^t[1-9]$/;
/** The step as the loop reads it: a flat decision is a final step; a final step's calls and a tools step's decision are ignored; at most 3 calls, ids t1..t3 when free or repeated. */
function stepShape(value: unknown) {
  if (!isRecord(value)) return value;
  let step: Record<string, unknown> = value;
  if (step.action === undefined && "outcome" in step) {
    const { thinking, ...decision } = step;
    step = { thinking, action: "final", calls: [], decision };
  }
  const action = typeof step.action === "string" ? step.action.trim().toLowerCase() : step.action;
  if (action === "final") return { ...step, action, calls: [] };
  if (action !== "tools" || !Array.isArray(step.calls)) return { ...step, action };
  const calls = step.calls.slice(0, 3);
  const ids = calls.map(call => isRecord(call) ? call.id : null);
  const renumber = ids.some(id => typeof id !== "string" || !CALL_ID.test(id)) || new Set(ids).size !== ids.length;
  return { ...step, action, decision: null, calls: renumber ? calls.map((call, index) => isRecord(call) ? { ...call, id: `t${index + 1}` } : call) : calls };
}
export const smartStepSchema = z.preprocess(stepShape, z.object({
  thinking: clippedOr(800, ""),
  action: z.enum(["tools", "final"]),
  calls: nullAsAbsent(z.array(smartToolCallSchema).max(3).default([])),
  decision: smartDecisionSchema.nullable().default(null),
}).superRefine((value, ctx) => {
  if (value.action === "final" && !value.decision) ctx.addIssue({ code: "custom", message: "FINAL_WITHOUT_DECISION" });
  if (value.action === "tools" && !value.calls.length) ctx.addIssue({ code: "custom", message: "TOOLS_WITHOUT_CALL" });
  if (new Set(value.calls.map(call => call.id)).size !== value.calls.length) ctx.addIssue({ code: "custom", message: "CALL_IDS_DUPLICATED" });
}));
export type SmartStep = z.infer<typeof smartStepSchema>;

/** What the independent counter-read may report. One closed code per problem, with the sentence at fault. */
export const SAV_SMART_VERIFY_CODES = [
  "source_mismatch", "unlisted_claim", "promise", "need_forgotten", "repeated_trial", "other_platform", "sensitive_handled", "account_action", "secret_requested", "instruction_followed",
  // N2 (20/11): the reply commits to a sensitive action on the account (cancel, refund, change the holder, delete data, give a credential).
  "sensitive_commitment",
  // v21 (25/11): a guarantee, a permanence, a future statement or the answer the customer asked for, not carried by any cited excerpt (or deduced from a nearby one).
  "unsourced_claim",
] as const;
export type SmartVerifyCode = typeof SAV_SMART_VERIFY_CODES[number];
export const smartVerdictSchema = z.object({
  verdict: looseEnum(["conforme", "non_conforme"]),
  /** A problem with a code outside the list still refuses (read as `unlisted_claim`): a counter-read never fails the turn for a word. */
  problems: z.preprocess(value => value === null ? undefined : Array.isArray(value) ? value.slice(0, 10) : value,
    z.array(z.object({ code: looseEnum(SAV_SMART_VERIFY_CODES).catch("unlisted_claim"), sentence: clippedOr(600, "") })).max(10).default([])),
}).superRefine((value, ctx) => {
  if (value.verdict === "non_conforme" && !value.problems.length) ctx.addIssue({ code: "custom", message: "NON_CONFORME_WITHOUT_PROBLEM" });
});
export type SmartVerdict = z.infer<typeof smartVerdictSchema>;

/** The server's own checks (no model): closed codes. Any of them refuses the reply, whatever the counter-read says. */
export const SAV_SMART_CHECK_CODES = [
  // `fact_sentence_missing`: no longer emitted since SAV-122 (contract v5); kept so stored results stay readable.
  "reply_missing", "coverage_invalid", "need_not_covered", "fact_sentence_missing", "excerpt_not_found", "card_not_retrieved_for_need", "fact_source_invalid",
  "third_party_fact_unsourced", "link_not_allowed", "other_platform_recommended", "third_party_named", "credential_request", "promise_unsourced",
  "account_action_claimed", "kernel_in_reply", "team_note_missing",
  // v2, the progress rule (HARNAIS 2): the only two refusals it adds.
  "question_repeated", "trial_repeated",
  // N2 (20/11): the reply COMMITS to a sensitive action on the account (replaces `kernel_in_reply`, no longer emitted: a mere word never refuses).
  "sensitive_commitment",
  // SAV-122 (PORTE 2E, P1): a sentence of the reply takes up the instruction the reading found in the mail.
  "instruction_followed",
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

/** The model's object out of its usual wrappings: a one-item array, or a JSON string (code fences allowed). Anything else unchanged. */
export function smartUnwrapOutput(output: unknown): unknown {
  let value = output;
  if (typeof value === "string") {
    const body = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { value = JSON.parse(body) as unknown; } catch { return output; }
  }
  return Array.isArray(value) && value.length === 1 && isRecord(value[0]) ? value[0] : value;
}

/** Parses a model output against a schema: the value, or a closed failure code (never the model's text). */
export function parseSmartOutput<T>(schema: z.ZodType<T>, output: unknown): { ok: true; value: T } | { ok: false; problem: "output_invalid" } {
  const parsed = schema.safeParse(smartUnwrapOutput(output));
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: "output_invalid" };
}
