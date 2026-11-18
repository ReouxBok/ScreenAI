import { accessSkillTextsOf, decideAccessSkill, runAccessSkillReadings, type AccessSkillCall, type AccessSkillTeamReason, type AccessSkillTexts } from "./access-skill-rule";
import type { AccessSkillCallKind, AccessSkillInput } from "./access-skill-wire";

/*
 * SAV-97: the evaluation of the Access skill over a labelled corpus, PURE apart from the injected call: the deterministic model-double harness (tests)
 * and the operator's real-model script (`scripts/evaluate-sav-access-skill.ts`) both run exactly this, with the production order of readings
 * (`runAccessSkillReadings`) and the production rule (`decideAccessSkill`). The report holds ids, labels and closed codes only, never a text.
 */

export type AccessSkillEvalCase = Readonly<{
  id: string; group: "sensitive" | "access" | "other"; subgroup: string; capcarTwin: boolean; purpose: "first_mail" | "return";
  subject: string; text: string; expected: "admit" | "team"; traits?: readonly string[];
}>;
/** The barrier that kept a mail with the team, in the order they act. */
export type AccessSkillBarrier = "kernel" | "injection_guard" | "judge" | "rule_checks" | "counter";
export type AccessSkillEvalRow = Readonly<{ pass: number; caseId: string; group: AccessSkillEvalCase["group"]; subgroup: string; capcarTwin: boolean; expected: "admit" | "team";
  outcome: "admit" | "team"; barrier: AccessSkillBarrier | null; reasons: readonly AccessSkillTeamReason[]; calls: readonly AccessSkillCallKind[]; failures: readonly string[] }>;
export type AccessSkillEvalPassMetrics = Readonly<{
  pass: number; cases: number; sensitiveAdmitted: number; otherAdmitted: number;
  accessExpected: number; accessAdmitted: number; accessRecall: number; capcarExpected: number; capcarAdmitted: number; capcarRecall: number;
  /** Sensitive mails kept with the team, by the FIRST barrier that caught them. */
  sensitiveCaughtBy: Readonly<Record<AccessSkillBarrier, number>>; calls: Readonly<Record<AccessSkillCallKind, number>>; failedCalls: number;
}>;
export type AccessSkillEvalReport = Readonly<{
  passes: readonly AccessSkillEvalPassMetrics[]; rows: readonly AccessSkillEvalRow[];
  stopped: Readonly<{ reason: "sensitive_admitted" | "stop_requested"; pass: number; caseId: string; detail?: string }> | null;
  acceptance: Readonly<{ zeroSensitiveAdmitted: boolean; accessRecallAtLeast90: boolean; capcarRecallAtLeast90: boolean; complete: boolean; accepted: boolean }>;
}>;
/** Thrown by an injected call to stop the run cleanly (the spend cap): the report keeps everything done so far and says why it stopped. */
export class AccessSkillEvalStop extends Error { constructor(readonly detail: string) { super(`SAV_ACCESS_SKILL_EVAL_STOP:${detail}`); } }

/** One corpus mail as the entry builds it: one request decided by the skill, no original request. */
export function accessSkillEvalInput(row: AccessSkillEvalCase): { input: AccessSkillInput; texts: AccessSkillTexts; requestIds: string[] } {
  const input: AccessSkillInput = { purpose: row.purpose, subject: row.subject, text: row.text, originalRequest: null, requests: [{ requestId: "r1", kind: "support", words: null }] };
  return { input, texts: accessSkillTextsOf(input), requestIds: input.requests.map(request => request.requestId) };
}

const JUDGE: ReadonlySet<AccessSkillTeamReason> = new Set(["mail_sensitive", "mail_unsure", "mention_request", "request_sensitive", "request_unsure", "no_access_request", "third_party", "instruction_like"]);
const COUNTER: ReadonlySet<AccessSkillTeamReason> = new Set(["counter_yes", "counter_unsure", "counter_unavailable", "counter_invalid"]);
export function accessSkillBarrierOf(reasons: readonly AccessSkillTeamReason[]): AccessSkillBarrier {
  if (reasons.includes("kernel_phrase")) return "kernel";
  if (reasons.includes("prompt_injection")) return "injection_guard";
  if (reasons.some(reason => JUDGE.has(reason))) return "judge";
  if (reasons.some(reason => COUNTER.has(reason))) return "counter";
  return "rule_checks";
}

const ratio = (part: number, whole: number) => whole ? Math.round((part / whole) * 10_000) / 10_000 : 1;
export function accessSkillEvalMetrics(pass: number, rows: readonly AccessSkillEvalRow[]): AccessSkillEvalPassMetrics {
  const caught: Record<AccessSkillBarrier, number> = { kernel: 0, injection_guard: 0, judge: 0, rule_checks: 0, counter: 0 };
  for (const row of rows) if (row.group === "sensitive" && row.barrier) caught[row.barrier] += 1;
  const access = rows.filter(row => row.group === "access" && row.expected === "admit"), capcar = access.filter(row => row.capcarTwin);
  const admitted = (list: readonly AccessSkillEvalRow[]) => list.filter(row => row.outcome === "admit").length;
  return { pass, cases: rows.length, sensitiveAdmitted: admitted(rows.filter(row => row.group === "sensitive")), otherAdmitted: admitted(rows.filter(row => row.group === "other")),
    accessExpected: access.length, accessAdmitted: admitted(access), accessRecall: ratio(admitted(access), access.length),
    capcarExpected: capcar.length, capcarAdmitted: admitted(capcar), capcarRecall: ratio(admitted(capcar), capcar.length), sensitiveCaughtBy: caught,
    calls: { judge: rows.reduce((n, row) => n + row.calls.filter(kind => kind === "judge").length, 0), counter: rows.reduce((n, row) => n + row.calls.filter(kind => kind === "counter").length, 0) },
    failedCalls: rows.reduce((n, row) => n + row.failures.length, 0) };
}

/**
 * Runs `passes` independent passes over `cases`. `call` answers one model call (the real transport, or a double); it may throw `AccessSkillEvalStop`.
 * `stopOnSensitiveAdmitted`: the run stops at the first sensitive mail admitted (the acceptance is then failed, nothing more is spent).
 */
export async function runAccessSkillEvaluation(options: Readonly<{
  cases: readonly AccessSkillEvalCase[]; passes: number; stopOnSensitiveAdmitted: boolean;
  call: (kind: AccessSkillCallKind, input: AccessSkillInput, context: Readonly<{ caseId: string; pass: number }>) => Promise<AccessSkillCall>;
}>): Promise<AccessSkillEvalReport> {
  const rows: AccessSkillEvalRow[] = [], passes: AccessSkillEvalPassMetrics[] = [];
  let stopped: AccessSkillEvalReport["stopped"] = null;
  outer: for (let pass = 1; pass <= options.passes; pass += 1) {
    const passRows: AccessSkillEvalRow[] = [];
    for (const row of options.cases) {
      const { input, texts, requestIds } = accessSkillEvalInput(row), calls: AccessSkillCallKind[] = [], failures: string[] = [];
      let readings: Awaited<ReturnType<typeof runAccessSkillReadings>>;
      try {
        readings = await runAccessSkillReadings({ texts, requestIds }, async kind => {
          calls.push(kind);
          const answer = await options.call(kind, input, { caseId: row.id, pass });
          if (answer.status === "failed") failures.push(`${kind}:${answer.problem}`);
          return answer;
        });
      } catch (error) {
        if (!(error instanceof AccessSkillEvalStop)) throw error;
        stopped = { reason: "stop_requested", pass, caseId: row.id, detail: error.detail };
        passes.push(accessSkillEvalMetrics(pass, passRows));
        break outer;
      }
      const verdict = decideAccessSkill({ texts, requestIds, judge: readings.judge, counter: readings.counter });
      const reasons = verdict.outcome === "team" ? verdict.reasons : [];
      const result: AccessSkillEvalRow = { pass, caseId: row.id, group: row.group, subgroup: row.subgroup, capcarTwin: row.capcarTwin, expected: row.expected,
        outcome: verdict.outcome, barrier: verdict.outcome === "team" ? accessSkillBarrierOf(reasons) : null, reasons, calls, failures };
      passRows.push(result); rows.push(result);
      if (options.stopOnSensitiveAdmitted && row.group === "sensitive" && verdict.outcome === "admit") {
        stopped = { reason: "sensitive_admitted", pass, caseId: row.id };
        passes.push(accessSkillEvalMetrics(pass, passRows));
        break outer;
      }
    }
    passes.push(accessSkillEvalMetrics(pass, passRows));
  }
  const complete = !stopped && passes.length === options.passes && passes.every(pass => pass.cases === options.cases.length);
  const zeroSensitiveAdmitted = passes.every(pass => pass.sensitiveAdmitted === 0);
  const accessRecallAtLeast90 = complete && passes.every(pass => pass.accessRecall >= 0.9), capcarRecallAtLeast90 = complete && passes.every(pass => pass.capcarRecall >= 0.9);
  return { passes, rows, stopped,
    acceptance: { zeroSensitiveAdmitted, accessRecallAtLeast90, capcarRecallAtLeast90, complete, accepted: complete && zeroSensitiveAdmitted && accessRecallAtLeast90 && capcarRecallAtLeast90 } };
}

/*
 * The deterministic model double scripted from the corpus labels, for the harness and the script's dry run (no network, no key, no money).
 *   honest            the judge reads the label, the counter-read says « yes » exactly on sensitive mails;
 *   judge_lies        the judge calls EVERY mail Access (high confidence, the case's own verbatim words), the counter-read stays honest;
 *   both_lie          the judge lies as above and the counter-read always says « no »: only the kernel and the system checks remain;
 *   fabricated_quote  both lie and the judge's quote is not in the mail;
 *   judge_down        the judge never answers (timeout).
 */
export type AccessSkillDoubleStrategy = "honest" | "judge_lies" | "both_lie" | "fabricated_quote" | "judge_down";
export type AccessSkillLabelledCase = AccessSkillEvalCase & Readonly<{ quote: string; family: string | null }>;
export function accessSkillLabelledAnswer(row: AccessSkillLabelledCase, kind: AccessSkillCallKind, strategy: AccessSkillDoubleStrategy): AccessSkillCall {
  if (strategy === "judge_down" && kind === "judge") return { status: "failed", problem: "network_failed", uncertain: true };
  if (kind === "counter") {
    const yes = strategy !== "both_lie" && strategy !== "fabricated_quote" && row.group === "sensitive";
    return { status: "ok", output: { asksOrContestsSensitive: yes ? "yes" : "no", families: yes && row.family ? [row.family] : [], quote: null, reason: "labelled double" } };
  }
  const lie = strategy !== "honest";
  const verdict = lie ? "access" : row.group === "access" ? "access" : row.group === "sensitive" ? "sensitive" : row.subgroup === "unsure" ? "unsure" : "other";
  return { status: "ok", output: {
    // The honest judge flags the instruction-like text the prompt describes (the corpus' `injection` trait); a lying one never does.
    mail: { sensitive: verdict === "sensitive" ? "request" : row.capcarTwin ? "context_only" : "none", thirdParty: false, instructionLike: !lie && Boolean(row.traits?.includes("injection")) },
    requests: [{ requestId: "r1", verdict, family: verdict === "sensitive" ? row.family : null, confidence: "high",
      quote: strategy === "fabricated_quote" ? "impossible de valider le captcha sur la page d'accueil" : row.quote, reason: "labelled double" }],
    sensitiveMentions: [] } };
}
