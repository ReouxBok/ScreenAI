// SAV-92 (Ugo 14/11): the handoff summary, the PURE part. When a V2 case goes to the team (any handoff: an accepted handoff decision or a decision
// refused twice), the team gets one structured synthesis of the case, built ONLY from the stored case body (never from a model output, never from a
// mail re-read), masked with `maskCaseCustomerText` and bounded in size:
//   - the problem as first raised, in the customer's own words (the oldest customer statement) or, without one, V1's subject of the first request;
//   - the questions the agent asked and the customer's answers (the facts recorded from the answering mail), or that none came;
//   - what the customer transmitted (screenshots / attachments cited by the case, links given: by host only in the Slack lines; SAV-92 16/11, the
//     full https links, cleaned by `customerLinkOf`, for the HubSpot handoff note only);
//   - what was tried (procedures and their outcome);
//   - the reason of the handoff.
// It is team-facing only: nothing here is ever sent to the customer. Today it is rendered in the existing Slack notice (`case-handoff-notice.ts`);
// the same lines are what a HubSpot handoff note would carry once such an effect is granted (see the SAV-92 report).
import type { CaseBody, CaseTrial, SourceRef } from "./case-types";
import { maskCaseCustomerText } from "./investigation-customer-context";

export const CASE_HANDOFF_SUMMARY_REVISION = "sav-v2-handoff-summary-2026-11-14.v1";
export const CASE_HANDOFF_SUMMARY_LIMITS = { problemChars: 400, questions: 5, questionChars: 200, answerChars: 240, trials: 5, trialResultChars: 160, linkHosts: 3, receivedFiles: 6, receivedNameChars: 80, totalChars: 2400,
  /** SAV-92 (Ugo 16/11): full links the customer sent, kept for the HubSpot handoff note (https only, cleaned, bounded). */ links: 5, linkChars: 300 } as const;

/** What the reader of the case's stored inbound mails hands the synthesis: the files received and, SAV-92 (16/11), the links found in the customer's own text. */
export type CaseHandoffReceived = Readonly<{ files: ReadonlyArray<Readonly<{ name: string; type: string; sizeKb: number }>>; omitted: number; links?: readonly string[] }>;

export type CaseHandoffSummary = Readonly<{
  revision: typeof CASE_HANDOFF_SUMMARY_REVISION;
  problem: Readonly<{ source: "customer_words" | "v1_subject" | "none"; text: string | null }>;
  exchanges: ReadonlyArray<Readonly<{ question: string; answer: string | null; answered: boolean }>>;
  exchangesOmitted: number;
  /** `urls` (SAV-92, 16/11): the customer's links in full, cleaned by `customerLinkOf`; absent from summaries sealed before it existed or without a safe link. */
  transmitted: Readonly<{ attachments: number; links: number; linkHosts: readonly string[]; urls?: readonly string[] }>;
  tried: ReadonlyArray<Readonly<{ knowledgeId: string; outcome: CaseTrial["outcome"]; result: string | null }>>;
  triedOmitted: number;
  /** SAV-92 (15/11): the files received on the case's stored mails (masked name, type, size; never content). Absent when not read. */
  received?: Readonly<{ files: ReadonlyArray<Readonly<{ name: string; type: string; sizeKb: number }>>; omitted: number }>;
}>;

const cut = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
const clean = (value: string, max: number) => cut(maskCaseCustomerText(value.replace(/\s+/g, " ").trim()), max);
const sameSource = (a: SourceRef, b: SourceRef) => a.type === b.type && a.id === b.id;
const URL_IN_TEXT = /\bhttps?:\/\/([A-Za-z0-9.-]{1,120})(?::\d+)?(?:[/?#][^\s<>"']*)?/gi;
const KNOWLEDGE_ID = /^[A-Za-z0-9._-]{1,80}$/;

// SAV-92 (Ugo 16/11): the full links a customer gave (a conversation, a page in error), for the team's HubSpot note. No list of allowed domains exists in
// the repository, so every https link is a candidate, cleaned: never http, never credentials (user:pass@), never a parameter or fragment that may carry a
// secret, never a path segment shaped like a token, bounded in length and in number. Anything doubtful is dropped, never repaired.
const RAW_LINK = /\bhttps?:\/\/[^\s<>"'«»[\]{}|\\^`]+/gi;
const SENSITIVE_NAME = /token|key|pass|pwd|code|auth|session|secret|sig|otp|jwt|nonce|credential|mail|phone|tel/i;
const SECRET_SEGMENT = /eyJ[A-Za-z0-9_-]{8,}|(?:sk-|ghp_|gho_|github_pat_|xox[abprs]-|xapp-|AKIA)[A-Za-z0-9_-]{6,}|[0-9a-f]{32,}/i;
/** One customer link made safe for the team's note, or null when it must not be kept. Idempotent. */
export function customerLinkOf(raw: string): string | null {
  const trimmed = raw.trim().replace(/[.,;:!?)»"'…]+$/u, "");
  if (!/^https:\/\//i.test(trimmed) || trimmed.length > 2_000) return null;
  let url: InstanceType<typeof globalThis.URL>;
  try { url = new globalThis.URL(trimmed); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /^[0-9.]+$/.test(host)) return null;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (SECRET_SEGMENT.test(path)) return null;
  for (const name of [...new Set(url.searchParams.keys())]) {
    if (SENSITIVE_NAME.test(name) || url.searchParams.getAll(name).some(value => SECRET_SEGMENT.test(value))) url.searchParams.delete(name);
  }
  if (url.hash && (url.hash.includes("=") || SENSITIVE_NAME.test(url.hash) || SECRET_SEGMENT.test(url.hash))) url.hash = "";
  const kept = url.toString();
  return kept.length <= CASE_HANDOFF_SUMMARY_LIMITS.linkChars ? kept : null;
}
/** The distinct safe links found in these texts, in order, at most `max`. */
export function customerLinksOf(texts: readonly string[], max: number = CASE_HANDOFF_SUMMARY_LIMITS.links): string[] {
  const links: string[] = [];
  for (const text of texts) {
    for (const match of String(text ?? "").matchAll(RAW_LINK)) {
      const link = customerLinkOf(match[0]);
      if (link && !links.includes(link)) links.push(link);
      if (links.length >= max) return links;
    }
  }
  return links;
}

/** The synthesis of the stored case, masked and bounded. Never throws on a valid body. */
export function buildCaseHandoffSummary(input: Partial<Pick<CaseBody, "openRequests" | "facts" | "questions" | "trials">>,
  received?: CaseHandoffReceived | null): CaseHandoffSummary {
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
  const said = byTime(body.facts.filter(row => row.kind === "customer_statement"));
  // SAV-92 (16/11): the links of the stored mails first (the customer's own text), then those the case's statements quote; cleaned again (idempotent), distinct, bounded.
  const urls = customerLinksOf([...(received?.links ?? []), ...said.map(fact => fact.text)]);
  for (const fact of said) {
    for (const match of fact.text.matchAll(URL_IN_TEXT)) {
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
    transmitted: { attachments, links, linkHosts: hosts.slice(0, L.linkHosts), ...(urls.length ? { urls } : {}) }, tried, triedOmitted: Math.max(0, body.trials.length - tried.length),
    ...(received?.files.length ? { received: { files: received.files.slice(0, L.receivedFiles).map(file => ({ name: clean(file.name, L.receivedNameChars), type: file.type, sizeKb: file.sizeKb })),
      omitted: received.omitted + Math.max(0, received.files.length - L.receivedFiles) } } : {}) };
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
  if (summary.received?.files.length) {
    const size = (kb: number) => kb >= 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} Mo` : `${kb} Ko`;
    lines.push(`• Pièces reçues : ${summary.received.files.map(file => `${clean(file.name, L.receivedNameChars)} (${file.type}, ${size(file.sizeKb)})`).join(" ; ")}${summary.received.omitted ? ` ; et ${summary.received.omitted} autre(s)` : ""}`);
  }
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
