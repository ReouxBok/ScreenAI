// SAV-92 (Ugo 14/11): the handoff summary, the PURE part. When a V2 case goes to the team (any handoff: an accepted handoff decision or a decision
// refused twice), the team gets one structured synthesis of the case, built ONLY from the stored case body (never from a model output, never from a
// mail re-read), masked with `maskCaseCustomerText` and bounded in size:
//   - the problem as first raised, in the customer's own words (the oldest customer statement) or, without one, V1's subject of the first request;
//   - the questions the agent asked and the customer's answers (the facts recorded from the answering mail), or that none came;
//   - what the customer transmitted (screenshots / attachments cited by the case, links given, by host only);
//   - what was tried (procedures and their outcome);
//   - the reason of the handoff.
// It is team-facing only: nothing here is ever sent to the customer. Today it is rendered in the existing Slack notice (`case-handoff-notice.ts`);
// the same lines are what a HubSpot handoff note would carry once such an effect is granted (see the SAV-92 report).
import type { CaseBody, CaseTrial, SourceRef } from "./case-types";
import { maskCaseCustomerText } from "./investigation-customer-context";

export const CASE_HANDOFF_SUMMARY_REVISION = "sav-v2-handoff-summary-2026-11-14.v1";
export const CASE_HANDOFF_SUMMARY_LIMITS = { problemChars: 400, questions: 5, questionChars: 200, answerChars: 240, trials: 5, trialResultChars: 160, linkHosts: 3, totalChars: 2400 } as const;

export type CaseHandoffSummary = Readonly<{
  revision: typeof CASE_HANDOFF_SUMMARY_REVISION;
  problem: Readonly<{ source: "customer_words" | "v1_subject" | "none"; text: string | null }>;
  exchanges: ReadonlyArray<Readonly<{ question: string; answer: string | null; answered: boolean }>>;
  exchangesOmitted: number;
  transmitted: Readonly<{ attachments: number; links: number; linkHosts: readonly string[] }>;
  tried: ReadonlyArray<Readonly<{ knowledgeId: string; outcome: CaseTrial["outcome"]; result: string | null }>>;
  triedOmitted: number;
}>;

const cut = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
const clean = (value: string, max: number) => cut(maskCaseCustomerText(value.replace(/\s+/g, " ").trim()), max);
const sameSource = (a: SourceRef, b: SourceRef) => a.type === b.type && a.id === b.id;
const URL = /\bhttps?:\/\/([A-Za-z0-9.-]{1,120})(?::\d+)?(?:[/?#][^\s<>"']*)?/gi;
const KNOWLEDGE_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** The synthesis of the stored case, masked and bounded. Never throws on a valid body. */
export function buildCaseHandoffSummary(input: Partial<Pick<CaseBody, "openRequests" | "facts" | "questions" | "trials">>): CaseHandoffSummary {
  const L = CASE_HANDOFF_SUMMARY_LIMITS;
  // A partial body (an older caller) reads as empty lists, never as a crash.
  const body = { openRequests: input.openRequests ?? [], facts: input.facts ?? [], questions: input.questions ?? [], trials: input.trials ?? [] };
  const byTime = <T extends { at: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const statements = byTime(body.facts.filter(fact => fact.kind === "customer_statement" && fact.source.type === "email"));
  const firstRequest = [...body.openRequests].sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
  const subject = firstRequest?.subject?.status === "available" ? firstRequest.subject.text : null;
  const problem = statements[0] ? { source: "customer_words" as const, text: clean(statements[0].text, L.problemChars) }
    : subject ? { source: "v1_subject" as const, text: clean(subject, L.problemChars) } : { source: "none" as const, text: null };

  const asked = [...body.questions].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  const exchanges = asked.slice(-L.questions).map(question => {
    const answered = Boolean(question.answeredBy);
    const said = question.answeredBy ? byTime(body.facts.filter(fact => sameSource(fact.source, question.answeredBy!))).map(fact => fact.text).join(" ; ") : "";
    return { question: clean(question.text, L.questionChars), answered, answer: said ? clean(said, L.answerChars) : null };
  });

  // What the customer gave: attachments cited by the case's facts (screenshots...), and links found in the customer's statements (host only).
  const attachments = new Set(body.facts.filter(fact => fact.source.type === "attachment").map(fact => fact.source.id)).size;
  const hosts: string[] = [];
  let links = 0;
  for (const fact of body.facts.filter(row => row.kind === "customer_statement")) {
    for (const match of fact.text.matchAll(URL)) {
      links += 1;
      const host = match[1]!.toLowerCase().replace(/\.$/, "");
      if (!hosts.includes(host)) hosts.push(host);
    }
  }

  const tried = body.trials.slice(-L.trials).map(trial => ({
    knowledgeId: KNOWLEDGE_ID.test(trial.procedure.knowledgeId) ? trial.procedure.knowledgeId : "[identifiant masqué]", outcome: trial.outcome,
    result: trial.result ? clean(trial.result.text, L.trialResultChars) : null,
  }));
  return { revision: CASE_HANDOFF_SUMMARY_REVISION, problem, exchanges, exchangesOmitted: Math.max(0, asked.length - exchanges.length),
    transmitted: { attachments, links, linkHosts: hosts.slice(0, L.linkHosts) }, tried, triedOmitted: Math.max(0, body.trials.length - tried.length) };
}

const OUTCOME: Record<CaseTrial["outcome"], string> = { pending: "en attente de retour du client", failed: "échec", succeeded: "réussie", unknown: "résultat inconnu" };
/**
 * The synthesis as plain lines (French, team-facing), the same for the Slack notice and a future HubSpot note. `clean` is the channel's own
 * last cleaning (Slack: `sanitizeNoticeText`); the whole is bounded by `totalChars`.
 */
export function caseHandoffSummaryLines(summary: CaseHandoffSummary, reasonLabel: string, clean: (value: string, max: number) => string = (value, max) => cut(value, max)): string[] {
  const L = CASE_HANDOFF_SUMMARY_LIMITS;
  const lines: string[] = [];
  lines.push(summary.problem.text
    ? `• ${summary.problem.source === "customer_words" ? "Problème, mots du client" : "Problème, d'après l'analyse V1"} : « ${clean(summary.problem.text, L.problemChars)} »`
    : "• Problème : non relevé dans le dossier");
  if (!summary.exchanges.length) lines.push("• Questions de l'agent : aucune");
  for (const row of summary.exchanges) {
    lines.push(`• Question : ${clean(row.question, L.questionChars)}`);
    lines.push(row.answer ? `• Réponse : ${clean(row.answer, L.answerChars)}` : row.answered ? "• Réponse : reçue, sans fait relevé" : "• Réponse : aucune pour l'instant");
  }
  if (summary.exchangesOmitted) lines.push(`• et ${summary.exchangesOmitted} question(s) plus ancienne(s)`);
  const { attachments, links, linkHosts } = summary.transmitted;
  lines.push(`• Éléments transmis : ${attachments ? `${attachments} pièce(s) jointe(s) ou capture(s) d'écran` : "aucune capture d'écran ni pièce jointe"}, ${links
    ? `${links} lien(s)${linkHosts.length ? ` (${linkHosts.join(", ")})` : ""}` : "aucun lien"}`);
  if (!summary.tried.length) lines.push("• Essais : aucun");
  for (const trial of summary.tried) lines.push(`• Essai ${trial.knowledgeId} : ${OUTCOME[trial.outcome]}${trial.result ? ` (${clean(trial.result, L.trialResultChars)})` : ""}`);
  if (summary.triedOmitted) lines.push(`• et ${summary.triedOmitted} essai(s) plus ancien(s)`);
  // The reason is never cut: the middle lines give way first.
  const reason = `• Raison du transfert : ${reasonLabel}`;
  const kept: string[] = [];
  let size = reason.length + 1;
  for (const line of lines) {
    if (size + line.length + 1 > L.totalChars) { kept.push("• (synthèse coupée)"); break; }
    kept.push(line); size += line.length + 1;
  }
  return [...kept, reason];
}
