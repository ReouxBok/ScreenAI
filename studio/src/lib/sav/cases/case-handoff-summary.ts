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
  /**
   * One row per DISTINCT question (Ugo 25/11: a reminder repeating a question is not a second question). `customerWroteAfter`: a customer mail of the case
   * (a statement or a request it opened) is dated after the last time this question was asked, whether or not a fact was matched to it. Absent from
   * summaries sealed before it existed (read as « not known »).
   */
  exchanges: ReadonlyArray<Readonly<{ question: string; answer: string | null; answered: boolean; customerWroteAfter?: boolean }>>;
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
function hasAuthenticationSuffix(url: URL): boolean {
  const fragment = decodeStable(url.hash);
  return fragment === null || AUTH_WORD.test(fragment) || [...url.searchParams.keys()].some(name => AUTH_WORD.test(name));
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
  const path = decodeStable(url.pathname);
  if (path === null || path.includes("%")) return no;
  const segments = path.split("/").filter(Boolean);
  if (segments.some(segment => AUTH_WORD.test(segment)) || hasAuthenticationSuffix(url)) return no;
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

function customerLinkTexts(said: readonly { text: string }[], received?: CaseHandoffReceived | null) {
  return [...(received?.linkTexts ?? []), ...said.map(fact => fact.text)];
}

/** The first conversation UUID from the same customer texts as the handoff link scan. */
export function handoffConversationId(input: Pick<CaseBody, "facts">, received?: CaseHandoffReceived | null): string | null {
  try {
    const said = input.facts.filter(fact => fact.kind === "customer_statement").sort((a, b) => a.at.localeCompare(b.at));
    for (const text of customerLinkTexts(said, received)) {
      for (const match of text.matchAll(RAW_LINK)) {
        const raw = match[0].replace(/[.,;:!?)»"'…]+$/u, "");
        if (raw.length > 2_000 || text[match.index + match[0].length] === "\\") continue;
        // Match the raw authority and path: URL normalization can erase :443 and dot segments.
        const parts = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^?#]*)(?:[?#].*)?$/i.exec(raw);
        if (!parts) continue;
        const [, host, path] = parts;
        if (!allowedHost(host!.toLowerCase()) || host!.split(".").some(label => AUTH_WORD.test(label) || AUTH_HOST_LABEL.test(label)) || AUTH_WORD.test(path!)) continue;
        const segments = path!.slice(1).split("/");
        const legacy = segments.length === 2 && /^(?:conversation|chat|thread|share)$/.test(segments[0]!);
        const v3 = segments.length === 6 && segments[0] === "organizations" && UUID_SEGMENT.test(segments[1]!)
          && segments[2] === "workspaces" && UUID_SEGMENT.test(segments[3]!) && segments[4] === "conversations";
        const id = segments.at(-1)!;
        if ((legacy || v3) && UUID_SEGMENT.test(id) && !hasAuthenticationSuffix(new URL(raw))) return id;
      }
    }
  } catch { return null; }
  return null;
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
  // When the customer last wrote: a statement from one of their mails, or a request one of their mails opened. Only dates already in the case.
  const customerDates = [...body.facts.filter(fact => fact.kind === "customer_statement" && fact.source.type === "email").map(fact => Date.parse(fact.at)),
    ...body.openRequests.map(row => Date.parse(row.openedAt))].filter(Number.isFinite);
  const lastCustomerAt = customerDates.length ? Math.max(...customerDates) : null;
  const answerOf = (question: typeof asked[number]) => {
    const batch = body.questions.filter(other => other.askedInEffect === question.askedInEffect).length > 1;
    return question.answeredBy ? byTime(body.facts.filter(fact => batch
      ? fact.key !== null && question.factKeys.includes(fact.key) && Date.parse(fact.at) > Date.parse(question.askedAt)
      : sameSource(fact.source, question.answeredBy!))).map(fact => fact.text).join(" ; ") : "";
  };
  // Ugo (25/11): the same question asked twice (an automatic reminder) is one exchange, dated at its LAST asking (a reminder means the first got no answer).
  const distinct = new Map<string, { question: typeof asked[number]; answered: boolean; said: string }>();
  for (const question of asked) {
    const textKey = sameQuestionKey(question.text), said = answerOf(question), seen = distinct.get(textKey);
    distinct.delete(textKey);
    distinct.set(textKey, { question, answered: Boolean(question.answeredBy) || Boolean(seen?.answered), said: said || seen?.said || "" });
  }
  const rows = [...distinct.values()];
  const exchanges = rows.slice(-L.questions).map(({ question, answered, said }) => ({
    question: clean(question.text, L.questionChars), answered, answer: said ? clean(said, L.answerChars) : null,
    customerWroteAfter: answered || (lastCustomerAt !== null && lastCustomerAt > Date.parse(question.askedAt)),
  }));

  // What the customer gave: attachments cited by the case's facts (screenshots...), and links found in the customer's statements (host only).
  const attachments = new Set(body.facts.filter(fact => fact.source.type === "attachment").map(fact => fact.source.id)).size;
  const hosts: string[] = [];
  let links = 0;
  const said = byTime(body.facts.filter(row => row.kind === "customer_statement"));
  // SAV-92 (16/11): the links of the stored mails first (the customer's own text), then those the case's statements quote; cleaned again (idempotent), distinct, bounded.
  const { links: urls, masked: urlsMasked } = customerLinkScan(customerLinkTexts(said, received));
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
  return { revision: CASE_HANDOFF_SUMMARY_REVISION, problem, exchanges, exchangesOmitted: Math.max(0, rows.length - exchanges.length),
    transmitted: { attachments, links, linkHosts: hosts.slice(0, L.linkHosts), ...(urls.length ? { urls } : {}), ...(urlsMasked ? { urlsMasked } : {}) }, tried, triedOmitted: Math.max(0, body.trials.length - tried.length),
    ...(received?.files.length ? (() => {
      // Ugo (25/11): the same file in several mails (a signature logo, a re-sent capture) is listed once: same name and same size.
      const files = distinctFiles(received.files.map(file => ({ name: clean(file.name, L.receivedNameChars), type: file.type, sizeKb: file.sizeKb })));
      return { received: { files: files.slice(0, L.receivedFiles), omitted: received.omitted + Math.max(0, files.length - L.receivedFiles) } };
    })() : {}) };
}

/** The key two askings of the same question share: case, spaces and final punctuation ignored. */
const sameQuestionKey = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[\s?.!…]+$/u, "").toLocaleLowerCase("fr");
/** Files listed once per name and size, in order of first appearance. */
export function distinctFiles<T extends Readonly<{ name: string; sizeKb: number }>>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  return files.filter(file => { const key = `${file.name.toLocaleLowerCase("fr")}\u0000${file.sizeKb}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * Ugo (25/11): the « Échanges » lines of the Slack notice, from the synthesis only. One line per DISTINCT question the agent sent (an older sealed synthesis
 * may still list a reminder twice: merged here too), with what the customer did after it; then the files they sent, once per name and size.
 * The customer « replied » only when the case says so (an answer matched, or a customer mail dated after the question); never guessed. `clean` is the
 * channel's own last cleaning (Slack: `sanitizeNoticeText`).
 */
export function caseHandoffExchangeLines(summary: CaseHandoffSummary, clean: (value: string, max: number) => string = (value, max) => cut(value, max)): string[] {
  const L = CASE_HANDOFF_SUMMARY_LIMITS;
  const merged = new Map<string, { question: string; answer: string | null; answered: boolean; customerWroteAfter?: boolean }>();
  for (const row of summary.exchanges) {
    const key = sameQuestionKey(row.question), seen = merged.get(key);
    merged.delete(key);
    // The later asking decides whether the customer wrote after it; an answer already matched to the earlier one is kept.
    merged.set(key, { ...row, answer: row.answer ?? seen?.answer ?? null, answered: row.answered || Boolean(seen?.answered) });
  }
  const lines = [...merged.values()].map(row => {
    const after = row.answer ? `réponse du client : ${clean(row.answer, L.answerChars)}`
      : row.answered || row.customerWroteAfter ? "le client a répondu (voir son dernier mail)"
      : row.customerWroteAfter === false ? "pas encore de réponse du client" : "aucune réponse relevée dans le dossier";
    return `• Agent : ${clean(row.question, L.questionChars)} → ${after}`;
  });
  if (summary.exchangesOmitted) lines.push(`• et ${summary.exchangesOmitted} question(s) plus ancienne(s)`);
  const files = distinctFiles(summary.received?.files ?? []);
  if (files.length) {
    const size = (kb: number) => kb >= 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} Mo` : `${kb} Ko`;
    const omitted = summary.received?.omitted ?? 0;
    lines.push(`• Pièces jointes du client : ${files.map(file => `${clean(file.name, L.receivedNameChars)} (${file.type}, ${size(file.sizeKb)})`).join(" ; ")}${omitted ? ` ; et ${omitted} autre(s)` : ""}`);
  }
  return lines;
}
