import type { RequestRoute } from "../../../skills/corpus-contract";
import { savEvidenceContains } from "../../../evidence-text";
import { accessSkillContextHits, accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { collaboratorsEntryJudgmentSchema, collaboratorsEntrySkillPrompt, SAV_COLLABORATORS_BLOCK_ID } from "./collaborators-entry-skill";

/*
 * Collaborators block (19/11): the system limits around the confirmation skill. PURE (no model, network, database or clock), not wired.
 * The model reads the mail; this file only refuses. It never admits a mail the model did not confirm, and every doubt sends the WHOLE mail
 * to the team: malformed output, a quote not found in the mail, a mail cut by the read bound, a kernel phrase (shared exclude-only kernel,
 * reused read-only from Access), a consigne hidden in the mail, a sensitive, commercial or unsure line, or a context word without a « no »
 * from the shared counter-read.
 */

/** Read bound of the confirmation stage. Lower than Access (12 000) so the stage stays under 85 % of the input ceiling; a longer mail goes to the team. */
export const SAV_COLLABORATORS_CONFIRM_TEXT_MAX = 4_000;
/** A longer subject, more than 4 requests or longer request words also send the whole mail to the team (complex mails stay with people). */
export const SAV_COLLABORATORS_CONFIRM_BOUNDS = Object.freeze({ subject: 200, requests: 4, words: 300 });
const SUBJECT_MAX = SAV_COLLABORATORS_CONFIRM_BOUNDS.subject, WORDS_MAX = SAV_COLLABORATORS_CONFIRM_BOUNDS.words, REQUESTS_MAX = SAV_COLLABORATORS_CONFIRM_BOUNDS.requests;

export type CollaboratorsEntryInput = Readonly<{
  purpose: "first_mail" | "return";
  subject: string;
  text: string;
  requests: ReadonlyArray<Readonly<{ requestId: string; words: string | null }>>;
}>;

/** Anything the bound would hide. Non-empty: the whole mail goes to the team before any call (a sensitive PS after the cut stays visible to a person). */
export function collaboratorsEntryTruncations(input: CollaboratorsEntryInput): Array<"subject" | "text" | "request_count" | "request_words"> {
  const cut: ReturnType<typeof collaboratorsEntryTruncations> = [];
  if (input.subject.length > SUBJECT_MAX) cut.push("subject");
  if (input.text.length > SAV_COLLABORATORS_CONFIRM_TEXT_MAX) cut.push("text");
  if (input.requests.length > REQUESTS_MAX) cut.push("request_count");
  if (input.requests.some(row => row.words !== null && row.words.length > WORDS_MAX)) cut.push("request_words");
  return cut;
}

/** The exact body of the confirmation call (same envelope as the Access skill call). Used to measure the prompt budget. */
export function collaboratorsEntryWireBody(input: CollaboratorsEntryInput, maxOutputTokens: number): string {
  const payload = {
    purpose: input.purpose, subject: input.subject.slice(0, SUBJECT_MAX), text: input.text.slice(0, SAV_COLLABORATORS_CONFIRM_TEXT_MAX),
    requests: input.requests.slice(0, REQUESTS_MAX).map(row => ({ requestId: row.requestId, words: row.words === null ? null : row.words.slice(0, WORDS_MAX) })),
  };
  return JSON.stringify({
    systemInstruction: { parts: [{ text: collaboratorsEntrySkillPrompt() }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens },
  });
}

/** Rights and seats words the Access context list does not hold. They never decide: they only require the counter-read's « no ». */
const RIGHTS_CONTEXT = /\b(?:admin\w*|role|roles|droits?|retir\w*|enlev\w*|propri\w*|titulaire|siege|sieges|licences?|quota|formule|seats?|owner\w*|remove\w*|rights?|acces|access|comptes?|account|e-?mails?|adresses?|au nom|effac\w*|recuper\w*|coup\w*|quitt\w*|parti|partie|sans mon accord)\b/;
export function collaboratorsContextHits(subject: string, text: string): string[] {
  const hits = accessSkillContextHits(subject, text);
  const value = `${subject}\n${text}`.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
  if (RIGHTS_CONTEXT.test(value)) hits.push("context_rights_or_seats");
  return hits;
}

export type CollaboratorsTeamReason =
  | "input_truncated" | "kernel_phrase" | "judgment_malformed" | "requests_mismatch" | "quote_not_found"
  | "instruction_like" | "sensitive" | "commercial" | "unsure" | "counter_read_required";

export type CollaboratorsEntryOutcome = Readonly<{
  routes: ReadonlyArray<Readonly<{ requestId: string; route: RequestRoute }>>;
  /** Empty when every line kept its own route. Otherwise the whole mail went to the team for these reasons. */
  teamReasons: readonly CollaboratorsTeamReason[];
}>;

const BLOCK_OF = { collaborators: SAV_COLLABORATORS_BLOCK_ID, access: "access", charly_max: "charly_max", integrations: "integrations" } as const;

/** From the model's raw reading to one route per request. `counterRead` is the shared counter-read's answer, or null when it was not asked. */
export function collaboratorsEntryRoutes(input: CollaboratorsEntryInput, raw: unknown, counterRead: "yes" | "no" | "unsure" | null): CollaboratorsEntryOutcome {
  const reasons = new Set<CollaboratorsTeamReason>();
  const team = () => ({ routes: input.requests.map(({ requestId }) => ({ requestId, route: { kind: "team" } as const })), teamReasons: [...reasons].sort() });
  if (collaboratorsEntryTruncations(input).length > 0) reasons.add("input_truncated");
  if (accessSkillKernelHits(input.subject, input.text).length > 0) reasons.add("kernel_phrase");
  const parsed = collaboratorsEntryJudgmentSchema.safeParse(raw);
  if (!parsed.success) {
    reasons.add("judgment_malformed");
    return team();
  }
  const { mail, requests } = parsed.data;
  const wanted = new Set(input.requests.map(row => row.requestId));
  if (requests.length !== wanted.size || requests.some(row => !wanted.has(row.requestId)) || new Set(requests.map(row => row.requestId)).size !== requests.length) {
    reasons.add("requests_mismatch");
  }
  if (requests.some(row => !savEvidenceContains(input.text, row.quote) && !savEvidenceContains(input.subject, row.quote))) reasons.add("quote_not_found");
  if (mail.instructionLike) reasons.add("instruction_like");
  if (mail.sensitive === "request" || mail.sensitive === "unsure" || requests.some(row => row.verdict === "sensitive" || row.family !== null)) reasons.add("sensitive");
  if (mail.commercial === "request" || requests.some(row => row.verdict === "commercial")) reasons.add("commercial");
  if (requests.some(row => row.verdict === "unsure")) reasons.add("unsure");
  if (collaboratorsContextHits(input.subject, input.text).length > 0 && counterRead !== "no") reasons.add("counter_read_required");
  if (reasons.size > 0) return team();
  return {
    routes: requests.map(({ requestId, verdict }) => ({
      requestId,
      route: verdict in BLOCK_OF ? { kind: "block", blockId: BLOCK_OF[verdict as keyof typeof BLOCK_OF] } as const : { kind: "team" } as const,
    })),
    teamReasons: [],
  };
}
