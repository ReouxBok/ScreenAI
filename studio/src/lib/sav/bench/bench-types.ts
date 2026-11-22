import { z } from "zod";

/*
 * SAV-109: the test bench of the SAV agent, with an AI judge. Format of one test conversation and of what an agent answers.
 *
 * FICTIONAL DATA ONLY (public repository): every customer is `@exemple.invalid`, every knowledge card is a bench card (`bench-knowledge.fixture.ts`),
 * never a published Limova card. The bench was written WITHOUT reading the agent's behaviour skills (prompts, examples): it measures the agent,
 * it is not derived from it. The same bench compares the current agent and the new one (`--agent current|new`).
 *
 * A conversation is the first mail, then the customer's next messages, revealed turn by turn. A next message may depend on what the agent did on
 * the previous turn (`variants`: « if the agent asks X, the customer answers Y »). Each turn states the expected outcome of the agent's response
 * to that message, the key facts its reply should carry and what it must avoid. When the agent hands the case to the team (`passer_la_main` or
 * `equipe_sensible`) the conversation ends there.
 */

/** The four outcomes of one agent turn: answer, ask, hand over to the team, or sensitive (so the whole mail goes to the team, no reply). */
export const SAV_BENCH_OUTCOMES = ["repondre", "demander", "passer_la_main", "equipe_sensible"] as const;
export type SavBenchOutcome = typeof SAV_BENCH_OUTCOMES[number];
export const savBenchTeamOutcome = (outcome: SavBenchOutcome) => outcome === "passer_la_main" || outcome === "equipe_sensible";

export const SAV_BENCH_FAMILIES = [
  "nylas_imap_smtp", "routine_sheets", "assistant_tache", "linkedin_prospection", "extension_chrome", "acces_collaborateurs", "charly_whatsapp",
  "demande_integration", "mail_mal_ecrit", "plusieurs_sujets", "changement_sujet", "sujet_inconnu",
  // Traps.
  "piege_resiliation_ps", "piege_autre_outil", "piege_autre_plateforme", "piege_mot_de_passe", "piege_bug_resolu", "piege_connaissance_expiree",
  "piege_toujours_pareil", "piege_injection",
] as const;
export type SavBenchFamily = typeof SAV_BENCH_FAMILIES[number];

/** The fixed grid of the judge. `issue` and the strict rules also have a deterministic safety net (`bench-checks.ts`). */
export const SAV_BENCH_CRITERIA = ["issue", "faits_sources", "pas_de_promesse", "jamais_autre_plateforme", "pas_de_mot_de_passe", "pas_de_repetition", "fait_avancer"] as const;
export type SavBenchCriterion = typeof SAV_BENCH_CRITERIA[number];
/** The criteria whose failure is never acceptable (0 allowed): a failure here fails the whole run. */
export const SAV_BENCH_STRICT_CRITERIA: readonly SavBenchCriterion[] = ["issue", "faits_sources", "pas_de_promesse", "jamais_autre_plateforme", "pas_de_mot_de_passe"];

const ref = z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,80}$/);
const outcome = z.enum(SAV_BENCH_OUTCOMES);
const regexSource = z.string().min(2).max(300).refine(source => { try { new RegExp(source, "iu"); return true; } catch { return false; } }, "REGEX_INVALID");

export const savBenchExpectSchema = z.object({
  /** One outcome, or the acceptable ones (an unknown topic: say so honestly, or hand over). */
  outcome: z.union([outcome, z.array(outcome).min(1).max(4)]),
  /** What the reply should carry (for the judge): facts of the cards, the right next step. */
  keyFacts: z.array(z.string().min(3).max(300)).max(8).default([]),
  /** What the reply must avoid (for the judge). */
  forbidden: z.array(z.string().min(3).max(300)).max(8).default([]),
  /** Deterministic net: regexes (case- and accent-insensitive, on the reply) that must never match. */
  mustNotMatch: z.array(regexSource).max(8).default([]),
}).strict();
export type SavBenchExpect = z.infer<typeof savBenchExpectSchema>;

export const savBenchConditionSchema = z.object({
  agentOutcome: z.union([outcome, z.array(outcome).min(1).max(4)]).optional(),
  /** Any of these words (accent- and case-insensitive substring) in the agent's previous reply. */
  replyMentions: z.array(z.string().min(2).max(80)).max(10).optional(),
}).strict().refine(value => value.agentOutcome !== undefined || value.replyMentions !== undefined, "CONDITION_EMPTY");
export type SavBenchCondition = z.infer<typeof savBenchConditionSchema>;

export const savBenchCustomerTurnSchema = z.object({
  text: z.string().min(2).max(4000),
  expect: savBenchExpectSchema,
  /** The first variant whose condition holds on the agent's PREVIOUS turn replaces `text` (and `expect`, when it gives one). */
  variants: z.array(z.object({ when: savBenchConditionSchema, text: z.string().min(2).max(4000), expect: savBenchExpectSchema.optional() }).strict()).max(4).default([]),
}).strict();
export type SavBenchCustomerTurn = z.infer<typeof savBenchCustomerTurnSchema>;

export const savBenchConversationSchema = z.object({
  id: ref,
  family: z.enum(SAV_BENCH_FAMILIES),
  /** What this conversation tests, in a few words (shown with its failures). */
  title: z.string().min(5).max(160),
  customer: z.object({ name: z.string().min(2).max(80), email: z.string().regex(/^[a-z0-9._-]+@exemple\.invalid$/) }).strict(),
  subject: z.string().max(200),
  /** The bench cards the knowledge search returns for this conversation (ids of `SAV_BENCH_KNOWLEDGE`), possibly none. */
  knowledge: z.array(ref).max(8),
  /** Official documentation domains a reply may link to here (a tool the customer already uses and wants to plug into Limova). */
  allowedDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(5).default([]),
  /** Injection trap: a marker the hidden instruction asks for; it must never appear in a reply. */
  canary: z.string().min(4).max(80).optional(),
  /** In the risky subset (sensitive, traps, close neighbours): the one re-run in extra passes. */
  risky: z.boolean().default(false),
  turns: z.array(savBenchCustomerTurnSchema).min(1).max(6),
}).strict();
export type SavBenchConversation = z.infer<typeof savBenchConversationSchema>;
/** What a corpus file writes (defaults filled by the schema). */
export type SavBenchConversationInput = z.input<typeof savBenchConversationSchema>;

/** A fictional knowledge card. `validUntil`: a temporary card (an ongoing bug, a time-limited message); past that date it must not be used. */
export type SavBenchCard = Readonly<{ id: string; title: string; content: string; steps: readonly string[]; validUntil?: string; links?: readonly string[] }>;

// ---------------------------------------------------------------------------------------------------------------------------------
// The agent under test
// ---------------------------------------------------------------------------------------------------------------------------------

export type SavBenchMessage = Readonly<{ from: "client" | "agent"; text: string; at: string }>;
export type SavBenchAgentInput = Readonly<{
  conversationId: string; turn: number; family: SavBenchFamily; subject: string; customer: Readonly<{ name: string; email: string }>;
  /** Every message so far, oldest first; the last one is the customer's message to handle. */
  messages: readonly SavBenchMessage[];
  /** The cards the knowledge search returns for this conversation (expired ones included: the agent must see they are expired). */
  knowledge: readonly SavBenchCard[];
  now: string;
}>;
/** What the agent did on one turn. `reply`: the text the customer would receive, or null (nothing sent). */
export type SavBenchAgentTurn = Readonly<{
  outcome: SavBenchOutcome;
  reply: string | null;
  /** Knowledge card ids the reply relies on (as the agent cites them). */
  citations: readonly string[];
  /** Closed codes from the agent (refusals, handoff reason...), never free text. */
  codes: readonly string[];
  /** The agent could not produce a turn (model down, invalid output): counted as a failure, never as an answer. */
  failure?: string;
  /** The note left to the team on a handover (the new agent only). Diagnostic only: never sent to the judge; logged only by the fictional self-test. */
  handoffNote?: string;
}>;
export type SavBenchAgent = Readonly<{
  /** `current` | `new` | a test name. */
  name: string;
  /** Model and prompt revision, for the report. */
  revision: string;
  respond(input: SavBenchAgentInput): Promise<SavBenchAgentTurn>;
}>;

/** Thrown by an agent or a judge transport to stop the run cleanly (the spend cap): the report keeps what was done and says why. */
export class SavBenchStop extends Error { constructor(readonly detail: string) { super(`SAV_BENCH_STOP:${detail}`); } }

/** Lower case, accents removed, apostrophes unified: what every deterministic comparison reads. */
export const savBenchNormalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’`]/g, "'").toLowerCase();

/**
 * A paraphrase variant of a bench conversation (`bench-variants.ts`): wording only. Family, cards, canary, risky flag and every expectation
 * are copied from the origin when it is built. `turns`: the customer's texts for the origin's first N turns (N between the variant's minimum
 * and the origin's turn count); `alt`: optional rewordings of that turn's conditional replies, in the origin's order.
 */
export const SAV_BENCH_VARIANT_STYLES = ["court", "colere", "anxieux", "anglais", "fil_cite", "formel"] as const;
export type SavBenchVariantStyle = typeof SAV_BENCH_VARIANT_STYLES[number];
export type SavBenchVariantInput = Readonly<{
  id: string; origin: string; style: SavBenchVariantStyle;
  customer: Readonly<{ name: string; email: string }>;
  subject: string;
  turns: readonly (string | Readonly<{ text: string; alt?: readonly string[] }>)[];
}>;
