import { z } from "zod";
import {
  SAV_CASE_QUALIFICATION_BLOCKS, SAV_CASE_QUALIFICATION_BLOCK_NATURES, caseRelayProofSchema,
  type CaseEvent, type CaseJournalQualificationBlock, type CaseQualificationBlock, type CaseQualificationBlockNature, type CaseRelayProof, type CaseSnapshot,
} from "./case-types";
import { latestInvestigationInput } from "./investigation-runner";

/*
 * Lot A6 (OBS1 phase 1), pure: no database, no I/O. The checks a re-qualification makes on the case's own journal before
 * reading anything, shared by `qualify` (admission-investigation-ports.ts) and the read-only diagnostic (case-store.ts),
 * and the typed error `qualify` throws when it cannot run, with its strict guard and serialiser for B's runner.
 * The error carries closed codes only: never a raw message, a customer text, or a Gmail or CRM id.
 */

/** The runner's canonical input key (B's `SAV_CASE_INPUT_KEY`, same pattern; the test pins both). */
export const SAV_CASE_QUALIFICATION_INPUT_KEY = /^(in|back):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The only error codes of A's sources kept as a cause: exact constants, never a pattern a message could match. */
export const SAV_CASE_QUALIFICATION_CAUSE_CODES = [
  "SAV_CASE_QUALIFY_HANDBACK_UNPROVEN", "SAV_CASE_QUALIFY_RELAY_INVALID", "SAV_CASE_QUALIFY_REQUESTS_MISMATCH",
  "SAV_V1_QUALIFICATION_TARGET_MISSING", "SAV_V1_QUALIFICATION_SOURCE_MISMATCH",
  "SAV_CASE_RULE_PROVENANCE_INVALID", "SAV_CASE_QUALIFICATION_REQUEST_UNKNOWN",
  "SAV_V1_CONTEXT_MESSAGE_INVALID", "SAV_V1_CONTEXT_MESSAGE_MISSING", "SAV_V1_CONTEXT_SOURCE_INVALID", "SAV_V1_CONTEXT_THREAD_MISMATCH",
  "SAV_V1_CONTEXT_RUN_MISSING", "SAV_V1_CONTEXT_RUN_VERSION_MISMATCH", "SAV_V1_CONTEXT_DECISION_MISSING", "SAV_V1_CONTEXT_DECISION_MESSAGE_MISMATCH",
  "SAV_V1_CONTEXT_DECISION_INVALID", "SAV_V1_CONTEXT_TICKET_MISSING",
] as const;
export type CaseQualificationCauseCode = typeof SAV_CASE_QUALIFICATION_CAUSE_CODES[number];

/** The cause code of an error when its message is exactly one of the constants above; anything else is null. */
export function caseQualificationCauseCode(error: unknown): CaseQualificationCauseCode | null {
  const message = error instanceof Error ? error.message : null;
  return message !== null && (SAV_CASE_QUALIFICATION_CAUSE_CODES as readonly string[]).includes(message) ? message as CaseQualificationCauseCode : null;
}

/** What B's runner may keep or show of a typed refusal: closed fields only. */
export const caseQualificationUnavailableSchema = z.object({
  code: z.enum(SAV_CASE_QUALIFICATION_BLOCKS),
  nature: z.enum(["contract_blocked", "technical"]),
  inputKey: z.string().regex(SAV_CASE_QUALIFICATION_INPUT_KEY).nullable(),
  inputVersion: z.number().int().min(0),
  causeCode: z.enum(SAV_CASE_QUALIFICATION_CAUSE_CODES).nullable(),
}).strict().refine(value => SAV_CASE_QUALIFICATION_BLOCK_NATURES[value.code] === value.nature, "NATURE_MISMATCH");
export type CaseQualificationUnavailable = z.infer<typeof caseQualificationUnavailableSchema>;

const messageOf = (value: Pick<CaseQualificationUnavailable, "code" | "causeCode">) =>
  `SAV_CASE_QUALIFICATION_UNAVAILABLE:${value.code}${value.causeCode ? `:${value.causeCode}` : ""}`;

/** Instances this module built: an object made from the prototype elsewhere is not one. */
const issued = new WeakSet<object>();

/** Thrown by `qualify` when the re-qualification cannot run. Its message is built from closed constants only; the
 * original error is not kept (no `cause`), so no raw text can travel with it. */
export class CaseQualificationUnavailableError extends Error {
  readonly code: CaseQualificationBlock;
  readonly nature: CaseQualificationBlockNature;
  readonly inputKey: string | null;
  readonly inputVersion: number;
  readonly causeCode: CaseQualificationCauseCode | null;
  constructor(input: { code: CaseQualificationBlock; inputKey: string | null; inputVersion: number; causeCode?: CaseQualificationCauseCode | null }) {
    const value = caseQualificationUnavailableSchema.parse({ code: input.code, nature: SAV_CASE_QUALIFICATION_BLOCK_NATURES[input.code], inputKey: input.inputKey,
      inputVersion: input.inputVersion, causeCode: input.causeCode ?? null });
    super(messageOf(value));
    this.name = "CaseQualificationUnavailableError";
    this.code = value.code; this.nature = value.nature; this.inputKey = value.inputKey; this.inputVersion = value.inputVersion; this.causeCode = value.causeCode;
    issued.add(this);
  }
}

const fieldsOf = (error: CaseQualificationUnavailableError) =>
  ({ code: error.code, nature: error.nature, inputKey: error.inputKey, inputVersion: error.inputVersion, causeCode: error.causeCode });

/** Strict guard for B: an instance this module built (not a look-alike object, nor one made from the prototype), whose fields still pass the closed
 * schema and whose message still matches them. A mutated or forged error is not one. */
export function isCaseQualificationUnavailable(error: unknown): error is CaseQualificationUnavailableError {
  if (typeof error !== "object" || error === null || !issued.has(error) || Object.getPrototypeOf(error) !== CaseQualificationUnavailableError.prototype) return false;
  if (!(error instanceof CaseQualificationUnavailableError)) return false;
  const parsed = caseQualificationUnavailableSchema.safeParse(fieldsOf(error));
  return parsed.success && error.message === messageOf(parsed.data) && error.name === "CaseQualificationUnavailableError";
}

/** The closed fields of a typed refusal, for a runner report or a log; throws on anything that is not one. */
export function serializeCaseQualificationUnavailable(error: unknown): CaseQualificationUnavailable {
  if (!isCaseQualificationUnavailable(error)) throw Error("SAV_CASE_QUALIFICATION_UNAVAILABLE_INVALID");
  return caseQualificationUnavailableSchema.parse(fieldsOf(error));
}

export type CaseQualificationPrecheck =
  | { outcome: "eligible"; inputKey: string; inputVersion: number; event: CaseEvent; relay: Extract<CaseRelayProof, { kind: "intake_effects_confirmed" }>; gmailMessageId: string }
  | { outcome: "null"; state: "no_customer_input" | "input_not_current"; inputKey: string | null; inputVersion: number }
  | { outcome: "blocked"; block: CaseJournalQualificationBlock; inputKey: string; inputVersion: number };

const JOURNAL_CAUSES: Record<CaseJournalQualificationBlock, CaseQualificationCauseCode | null> = {
  handback_unproven: "SAV_CASE_QUALIFY_HANDBACK_UNPROVEN", relay_proof_invalid: "SAV_CASE_QUALIFY_RELAY_INVALID", acknowledgement_input: null,
};

/** The case's own journal, before any read (contract B §2, steps 1-2). The latest input must be a relayed V1 mail that
 * is the current admission input; no input, or another one, is no canonical event (null). A hand-back designates no V1
 * entry, a proof that does not read is no proof, and an acknowledgement has no execution: blocked, never qualified. */
export function caseQualificationPrecheck(snapshot: Pick<CaseSnapshot, "admissionInputVersion">, events: readonly CaseEvent[]): CaseQualificationPrecheck {
  const inputVersion = snapshot.admissionInputVersion;
  const inputKey = latestInvestigationInput(events);
  if (!inputKey) return { outcome: "null", state: "no_customer_input", inputKey: null, inputVersion };
  if (inputKey.startsWith("back:")) return { outcome: "blocked", block: "handback_unproven", inputKey, inputVersion };
  const event = events.find(row => `in:${row.id}` === inputKey);
  if (!event || event.kind !== "inbound_confirmed" || event.direction !== "customer_inbound" || event.caseVersion !== inputVersion)
    return { outcome: "null", state: "input_not_current", inputKey, inputVersion };
  const relay = caseRelayProofSchema.safeParse(event.detail?.relay);
  if (!relay.success || event.detail?.messageId !== relay.data.messageId || event.sourceRef?.type !== "email")
    return { outcome: "blocked", block: "relay_proof_invalid", inputKey, inputVersion };
  if (relay.data.kind !== "intake_effects_confirmed") return { outcome: "blocked", block: "acknowledgement_input", inputKey, inputVersion };
  return { outcome: "eligible", inputKey, inputVersion, event, relay: relay.data, gmailMessageId: event.sourceRef.id };
}

/** The typed refusal of a blocked precheck. */
export function caseQualificationBlockedError(precheck: Extract<CaseQualificationPrecheck, { outcome: "blocked" }>) {
  return new CaseQualificationUnavailableError({ code: precheck.block, inputKey: precheck.inputKey, inputVersion: precheck.inputVersion, causeCode: JOURNAL_CAUSES[precheck.block] });
}
