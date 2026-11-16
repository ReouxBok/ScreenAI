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

/**
 * What the reader of the case's stored inbound mails hands the synthesis: the files received and, SAV-92 (16/11), the customer's own text of those mails
 * (quoted history left out), only scanned here for links by `customerLinkScan`; never stored (only the cleaned links and the masked count are).
 */
export type CaseHandoffReceived = Readonly<{ files: ReadonlyArray<Readonly<{ name: string; type: string; sizeKb: number }>>; omitted: number; linkTexts?: readonly string[] }>;

export type CaseHandoffSummary = Readonly<{
  revision: typeof CASE_HANDOFF_SUMMARY_REVISION;
  problem: Readonly<{ source: "customer_words" | "v1_subject" | "none"; text: string | null }>;
  exchanges: ReadonlyArray<Readonly<{ question: string; answer: string | null; answered: boolean }>>;
  exchangesOmitted: number;
  /**
   * `urls` (SAV-92, 16/11): the customer's links in full, cleaned by `customerLinkOf`; `urlsMasked`: how many distinct links were rejected (never their text).
   * Both absent from summaries sealed before they existed, or when zero.
   */
  transmitted: Readonly<{ attachments: number; links: number; linkHosts: readonly string[]; urls?: readonly string[]; urlsMasked?: number }>;
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

// SAV-92 (Ugo 16/11; reviews Astra of 1289893 and 54694e4): the full links a customer gave, for the team's HubSpot note. A STRICT ALLOW-LIST: a link is shown
// only on a host listed in `CUSTOMER_LINK_HOSTS` (or one of its subdomains), i.e. a page of the Limova app such as a conversation; any other link is masked
// (the note says one was sent, never its text). A deny-list never holds (short tokens, shorteners, payment links...). Anything doubtful is dropped whole:
//   - https only, no credentials (user:pass@), no port, an allowed host whose labels name no sign-in or account service (auth., sso., id., account.);
//   - the path, decoded until stable (3 passes), is exactly /conversation|chat|thread|share/<id>; anything else is masked;
//   - an AUTHENTICATION link (a path segment, a parameter name or the fragment evokes login, reset, magic, token...) is rejected whole: it may open the account;
//   - the fragment is always removed;
//   - a path segment shaped like a token (16+ characters mixing letters and digits, long hex, a provider token, a UUID) rejects the link; a UUID is allowed
//     only right after conversation / chat / thread / share (a conversation id, what the team wants);
//   - parameters: only a short safe list is kept (lang, page, tab, a short numeric id), and only with a short plain value; every other one is removed;
//   - bounded in length (300) and in number (5). A rejected link is counted, so the note can say one was sent and masked;
//   - nothing here may throw: an error while judging a link masks that link, the synthesis (hence the note) is still written.
/**
 * The hosts whose links may appear in full in the team's note: the host itself and its subdomains (`app.limova.ai`). To allow another product's links, add
 * its registrable domain here (lower case, no scheme, no path), after checking its links never carry a sign-in or a secret. Not configurable on purpose.
 */
export const CUSTOMER_LINK_HOSTS: readonly string[] = Object.freeze(["limova.ai"]);
const allowedHost = (host: string) => CUSTOMER_LINK_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
const RAW_LINK = /\bhttps?:\/\/[^\s<>"'«»[\]{}|\\^`]+/gi;
const AUTH_WORD = /login|log-in|log_in|signin|sign-in|sign_in|auth|callback|reset|password|passwd|magic|verify|verif|confirm|invite|invitation|token|otp|session|sso|activate|activation|unlock/i;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_SEGMENT = /^(?:conversations?|chats?|threads?|share|shared)$/i;
const TOKEN_LIKE = (value: string) => /eyJ[A-Za-z0-9_-]{8,}|(?:sk-|ghp_|gho_|github_pat_|xox[abprs]-|xapp-|AKIA)[A-Za-z0-9_-]{6,}|[0-9a-f]{24,}/i.test(value)
  || value.split(/[^A-Za-z0-9+/=_]+/).some(part => part.length >= 16 && /[A-Za-z]/.test(part) && /[0-9]/.test(part));
// A Map, never an object literal: `constructor` or `__proto__` must not resolve to an inherited property (review Astra of 54694e4).
const SAFE_PARAMS: ReadonlyMap<string, RegExp> = new Map([["lang", /^[a-z]{2}(?:-[A-Za-z]{2})?$/], ["page", /^[0-9]{1,4}$/], ["tab", /^[a-z][a-z-]{0,19}$/i], ["id", /^[0-9]{1,9}$/]]);
/** Host labels that name an identity or account service even without an authentication word. */
const AUTH_HOST_LABEL = /^(?:id|ids|idp|identity|account|accounts|compte|comptes|secure|connect|oidc|saml|mfa|2fa|admin)$/i;
/** Percent-decoding until the text no longer changes, 3 passes at most; null when a pass fails. */
function decodeStable(value: string): string | null {
  let current = value;
  for (let pass = 0; pass < 3; pass++) {
    let next: string;
    try { next = decodeURIComponent(current); } catch { return null; }
    if (next === current) return current;
    current = next;
  }
  return current;
}
type LinkVerdict = Readonly<{ ok: true; link: string }> | Readonly<{ ok: false }>;
function judgeCustomerLink(raw: string): LinkVerdict {
  try { return judgeCustomerLinkUnsafe(raw); } catch { return { ok: false }; }
}
function judgeCustomerLinkUnsafe(raw: string): LinkVerdict {
  const no = { ok: false } as const;
  const trimmed = raw.trim().replace(/[.,;:!?)»"'…]+$/u, "");
  if (!/^https:\/\//i.test(trimmed) || trimmed.length > 2_000) return no;
  let url: InstanceType<typeof globalThis.URL>;
  try { url = new globalThis.URL(trimmed); } catch { return no; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return no;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /^[0-9.]+$/.test(host) || !allowedHost(host)) return no;
  // Review Astra of e9f2f89: an authentication host (auth.limova.ai, sso., id., account.) is masked like an authentication path.
  if (host.split(".").some(label => AUTH_WORD.test(label) || AUTH_HOST_LABEL.test(label))) return no;
  // Decoded until stable (3 passes at most): `%256cogin` is `login`. A `%` left after that is masked, never guessed.
  const path = decodeStable(url.pathname), fragment = decodeStable(url.hash);
  if (path === null || fragment === null || path.includes("%")) return no;
  const segments = path.split("/").filter(Boolean);
  if (segments.some(segment => AUTH_WORD.test(segment)) || AUTH_WORD.test(fragment) || [...url.searchParams.keys()].some(name => AUTH_WORD.test(name))) return no;
  // Only the one useful shape of a Limova link: /conversation|chat|thread|share/<id>. Any other path is masked.
  if (segments.length !== 2 || !CONVERSATION_SEGMENT.test(segments[0]!)) return no;
  const id = segments[1]!;
  if (!UUID_SEGMENT.test(id) && (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || TOKEN_LIKE(id))) return no;
  url.hash = "";
  for (const name of [...new Set(url.searchParams.keys())]) {
    const values = url.searchParams.getAll(name), safe = SAFE_PARAMS.get(name.toLowerCase());
    if (!safe || values.length !== 1 || !safe.test(values[0]!)) url.searchParams.delete(name);
  }
  const kept = url.toString();
  return kept.length <= CASE_HANDOFF_SUMMARY_LIMITS.linkChars ? { ok: true, link: kept } : no;
}
/** One customer link made safe for the team's note, or null when it must not be kept (masked). Idempotent. */
export function customerLinkOf(raw: string): string | null {
  const verdict = judgeCustomerLink(raw);
  return verdict.ok ? verdict.link : null;
}
/** The distinct safe links found in these texts, in order, at most `max`, and how many distinct links were masked (rejected). */
export function customerLinkScan(texts: readonly string[], max: number = CASE_HANDOFF_SUMMARY_LIMITS.links): { links: string[]; masked: number } {
  const links: string[] = [], masked = new Set<string>();
  for (const text of texts) {
    let found: string[];
    try { found = [...String(text ?? "").matchAll(RAW_LINK)].map(match => match[0]); } catch { masked.add(`unreadable:${masked.size}`); continue; }
    for (const raw of found) {
      const verdict = judgeCustomerLink(raw);
      if (!verdict.ok) masked.add(raw.replace(/[.,;:!?)»"'…]+$/u, ""));
      else if (!links.includes(verdict.link) && links.length < max) links.push(verdict.link);
    }
  }
  return { links, masked: masked.size };
}
/** The distinct safe links found in these texts, in order, at most `max`. */
export const customerLinksOf = (texts: readonly string[], max: number = CASE_HANDOFF_SUMMARY_LIMITS.links): string[] => customerLinkScan(texts, max).links;

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
  const { links: urls, masked: urlsMasked } = customerLinkScan([...(received?.linkTexts ?? []), ...said.map(fact => fact.text)]);
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
    transmitted: { attachments, links, linkHosts: hosts.slice(0, L.linkHosts), ...(urls.length ? { urls } : {}), ...(urlsMasked ? { urlsMasked } : {}) }, tried, triedOmitted: Math.max(0, body.trials.length - tried.length),
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
