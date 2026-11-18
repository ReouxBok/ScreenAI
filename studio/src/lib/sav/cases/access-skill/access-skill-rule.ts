import { savEvidenceContains } from "../../evidence-text";
import { containsPromptInjection } from "../../policy";
import { accessSkillKernelHits } from "./access-skill-kernel";
import { accessSkillCounterReadSchema, accessSkillJudgmentSchema, accessSkillPromptPinned } from "./access-skill-guidelines";
import { accessSkillInputTruncations, type AccessSkillInput } from "./access-skill-wire";

/*
 * SAV-97: the PURE rule that turns the model's stored readings into an admission verdict. No model, network, database or clock.
 * It only checks system limits on what the model said: strict schema, every request answered, verbatim quotes, high confidence, no third
 * party, no instruction-like text, the exclude-only kernel, and the independent counter-read when it is required. It never reads the
 * customer's wording to ADMIT: that is the model's judgment. Anything it cannot prove leaves the mail to the team.
 */

export { readAccessSkillMode, SAV_V2_ACCESS_SKILL_ENV, type AccessSkillMode } from "./access-skill-mode";

/** The texts the readings are checked against: the stored mail, and the original request mail when the stored one answers an identification. */
export type AccessSkillTexts = Readonly<{ subject: string; text: string; original?: Readonly<{ subject: string; text: string }> | null;
  /** What bounding hid from the model (`accessSkillInputTruncations`): non-empty, the whole mail goes to the team, unread. */
  truncated?: readonly string[] }>;
/** The texts of a model input, with what bounding would hide from the model. */
export const accessSkillTextsOf = (input: AccessSkillInput): AccessSkillTexts =>
  ({ subject: input.subject, text: input.text, original: input.originalRequest, truncated: accessSkillInputTruncations(input) });
/** One stored model call: its output (to be validated here, never trusted) or why it gave none. */
export type AccessSkillCall = Readonly<{ status: "ok"; output: unknown }> | Readonly<{ status: "failed"; problem: string; uncertain: boolean }> | Readonly<{ status: "skipped"; problem: string }>;

export const SAV_ACCESS_SKILL_TEAM_REASONS = [
  "skill_unpinned", "kernel_phrase", "input_truncated", "judgment_unavailable", "judgment_invalid", "request_set_mismatch", "prompt_injection", "instruction_like", "third_party",
  "mail_sensitive", "mail_unsure", "mention_request", "mention_unverified", "request_sensitive", "request_unsure", "request_not_high", "quote_unverified",
  "no_access_request", "counter_unavailable", "counter_invalid", "counter_yes", "counter_unsure",
] as const;
export type AccessSkillTeamReason = typeof SAV_ACCESS_SKILL_TEAM_REASONS[number];

export type AccessSkillVerdict =
  /** The mail may be V2's: `access` requests are admitted, `other` ones are the team's part (never sensitive, never unsure). */
  | Readonly<{ outcome: "admit"; requests: Readonly<Record<string, "access" | "other">>; counterRead: "no" }>
  /** The WHOLE mail stays with the team. `family`: a sensitive family when one was named (kernel or model), for the return path. */
  | Readonly<{ outcome: "team"; reasons: readonly AccessSkillTeamReason[]; family: "cancellation" | "subscription" | "finance" | "rights" | "identity" | null; kernel: readonly string[] }>;

const team = (reasons: AccessSkillTeamReason[], family: Extract<AccessSkillVerdict, { outcome: "team" }>["family"] = null, kernel: readonly string[] = []): AccessSkillVerdict =>
  ({ outcome: "team", reasons: [...new Set(reasons)], family, kernel });

/** What every text of the mail says (subject, whole body including quoted history, signature and PS, the original request). */
const allTexts = (texts: AccessSkillTexts) => [texts.subject, texts.text, texts.original?.subject, texts.original?.text];
const verified = (texts: AccessSkillTexts, words: string) => allTexts(texts).some(value => typeof value === "string" && savEvidenceContains(value, words));
const KERNEL_FAMILY: Readonly<Record<string, Extract<AccessSkillVerdict, { outcome: "team" }>["family"]>> = {
  resilier: "cancellation", desabonner: "cancellation", rembourser: "finance", supprimer_compte: "cancellation", fermer_compte: "cancellation",
  arreter_abonnement: "subscription", rgpd: "rights", opposition_bancaire: "finance", en_cancel: "cancellation", en_refund: "finance",
};

/** The kernel, before any model call: a hit sends the whole mail to the team and nothing is paid. */
export function accessSkillKernelVerdict(texts: AccessSkillTexts): AccessSkillVerdict | null {
  const kernel = accessSkillKernelHits(...allTexts(texts));
  return kernel.length ? team(["kernel_phrase"], KERNEL_FAMILY[kernel[0]!] ?? null, kernel) : null;
}

/*
 * The counter-read must answer « no » before ANY admission. The model-double harness showed why (`access-skill-corpus.test.ts`): a judge
 * that wrongly calls a sensitive mail Access with no context word in it (« passer à la version Pro », « transférer le compte à mon associé ») was admitted
 * when the counter-read depended on a word list. One more call per admissible mail buys an independent second reading of every admission.
 * The context words (`accessSkillContextHits`) decide nothing here any more.
 */

/**
 * The verdict on the stored readings. `requestIds`: the requests the entry must decide (V1's requests, or a return's open requests), each exactly once.
 * `counter`: absent when it was not called. Order: pinned prompt, kernel, judge (schema, coverage, mail-level, each request), counter-read.
 */
export function decideAccessSkill(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[]; judge: AccessSkillCall | null; counter: AccessSkillCall | null }>): AccessSkillVerdict {
  if (!accessSkillPromptPinned()) return team(["skill_unpinned"]);
  const kernel = accessSkillKernelVerdict(input.texts);
  if (kernel) return kernel;
  if (input.texts.truncated?.length) return team(["input_truncated"]);
  if (!input.judge || input.judge.status !== "ok") return team(["judgment_unavailable"]);
  const parsed = accessSkillJudgmentSchema.safeParse(input.judge.output);
  if (!parsed.success) return team(["judgment_invalid"]);
  const judgment = parsed.data, reasons: AccessSkillTeamReason[] = [];
  let family: Extract<AccessSkillVerdict, { outcome: "team" }>["family"] = null;
  const ids = judgment.requests.map(row => row.requestId), expected = new Set(input.requestIds);
  if (!input.requestIds.length || ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) reasons.push("request_set_mismatch");
  if (allTexts(input.texts).some(value => typeof value === "string" && containsPromptInjection(value))) reasons.push("prompt_injection");
  if (judgment.mail.instructionLike) reasons.push("instruction_like");
  if (judgment.mail.thirdParty) reasons.push("third_party");
  if (judgment.mail.sensitive === "request") reasons.push("mail_sensitive");
  if (judgment.mail.sensitive === "unsure") reasons.push("mail_unsure");
  for (const mention of judgment.sensitiveMentions) {
    if (mention.role !== "context") { reasons.push("mention_request"); family ??= mention.family; }
    if (!verified(input.texts, mention.quote)) reasons.push("mention_unverified");
  }
  const requests: Record<string, "access" | "other"> = {};
  for (const row of judgment.requests) {
    if (row.verdict === "sensitive") { reasons.push("request_sensitive"); family ??= row.family; continue; }
    if (row.verdict === "unsure") { reasons.push("request_unsure"); continue; }
    if (row.confidence !== "high") { reasons.push("request_not_high"); continue; }
    if (!verified(input.texts, row.quote)) { reasons.push("quote_unverified"); continue; }
    requests[row.requestId] = row.verdict;
  }
  if (!Object.values(requests).includes("access")) reasons.push("no_access_request");
  if (reasons.length) return team(reasons, family);
  if (!input.counter || input.counter.status !== "ok") return team(["counter_unavailable"]);
  const counter = accessSkillCounterReadSchema.safeParse(input.counter.output);
  if (!counter.success) return team(["counter_invalid"]);
  if (counter.data.asksOrContestsSensitive === "yes") return team(["counter_yes"], counter.data.families[0] ?? null);
  if (counter.data.asksOrContestsSensitive === "unsure") return team(["counter_unsure"], counter.data.families[0] ?? null);
  return { outcome: "admit", requests, counterRead: "no" };
}

/** The verdict BEFORE the counter-read (same rule, counter-read taken as « no »): whether paying for the counter-read can still change anything. */
export function accessSkillAdmissibleBeforeCounter(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[]; judge: AccessSkillCall | null }>): boolean {
  return decideAccessSkill({ ...input, counter: { status: "ok", output: { asksOrContestsSensitive: "no", families: [], quote: null, reason: "pre-check" } } }).outcome === "admit";
}

/**
 * The readings of one mail, in the production order, with the calls injected (the V2 transport behind the spend gate in production; a scripted double in
 * the evaluation harness): the kernel first (an excluded mail is never sent to a model, nothing is paid), then the judge, then the counter-read only when it
 * can still change the verdict. The production judge (`access-skill-judge.ts`) and the evaluation run exactly this function.
 */
export async function runAccessSkillReadings(input: Readonly<{ texts: AccessSkillTexts; requestIds: readonly string[] }>, call: (kind: "judge" | "counter") => Promise<AccessSkillCall>):
  Promise<{ judge: AccessSkillCall; counter: AccessSkillCall | null }> {
  if (accessSkillKernelVerdict(input.texts)) return { judge: { status: "skipped", problem: "kernel_phrase" }, counter: null };
  if (input.texts.truncated?.length) return { judge: { status: "skipped", problem: "input_truncated" }, counter: null };
  const judge = await call("judge");
  const counter = judge.status === "ok" && accessSkillAdmissibleBeforeCounter({ ...input, judge })
    ? await call("counter") : null;
  return { judge, counter };
}
