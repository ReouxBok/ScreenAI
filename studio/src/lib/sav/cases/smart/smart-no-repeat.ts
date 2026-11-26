import { createHash } from "node:crypto";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import type { SmartThreadMessage } from "./smart-agent";
import type { SmartCheckCode, SmartDecision } from "./smart-contract";
import type { SmartCheckResult, SmartSource } from "./smart-checks";
import { smartMask } from "./smart-net";
import { SAV_SMART_CORRECTION_INSTRUCTION, smartCorrectionPrompt, smartDecidePrompt, smartUnderstandPrompt, smartVerifyPrompt, type SmartPromptOptions } from "./smart-prompt";

/*
 * Incident 26/11 (a customer answered « oui, les agents que j'avais créés ! » and the agent sent back the same text and the SAME question): behind
 * `SAV_V2_SMART_NO_REPEAT=on` only. Absent or any other value: nothing here runs, the prompts and payloads are byte for byte the previous ones.
 *
 *   view     each continuation turn, the model (understand, decide, correct, verify) reads `alreadySent`: our replies already sent on the case (the
 *            confirmed reply mails, read from the case's own effects, plus any support message of the thread), each with the customer's answer that
 *            followed it and the passages of the given cards it already used (a card's diagnostic question already asked is shown as asked, with
 *            the answer next to it). Before, the model saw neither: our sent mails are not in the case's thread and the customer's quoted history is cut.
 *   guard    a server check (no model, no keyword): a reply or a question that largely copies a reply already sent (word overlap, thresholds below)
 *            is refused with `repeated_reply`; the existing correction loop gets it once, and a second refusal hands the case to the team.
 *   cards    the structured escalation and exceptions of each card (its `resolution`) are given with the card, labelled, when its text lacks them.
 * The measure is textual and closed: it never reads what the customer wants, it only compares our draft with what we already sent.
 */

export { SAV_SMART_NO_REPEAT_ENV, smartNoRepeatOn } from "../smart-entry-switch";

/** One reply already sent on the case: when it was confirmed (null when unknown) and its text as sent. */
export type SmartSentReply = Readonly<{ at: string | null; text: string }>;
/** The no-repeat input of a turn: its presence turns the feature on for that turn. */
export type SmartNoRepeat = Readonly<{ sent: readonly SmartSentReply[] }>;

export const SAV_SMART_NO_REPEAT_LIMITS = Object.freeze({ replies: 3, replyChars: 1_500, replyHeadChars: 400, answerChars: 600, passagesPerReply: 3, passageChars: 400, guidanceChars: 1_500 });
/** Share of the draft's words already present in ONE reply sent before: at or above it, the draft is a copy of that reply. */
export const SAV_SMART_REPEAT_REPLY_THRESHOLD = 0.8;
/** Word overlap (Jaccard) between a question of the draft and one QUESTION already sent: at or above it, the same question asked again. */
export const SAV_SMART_REPEAT_QUESTION_THRESHOLD = 0.7;
/** A repeated question is refused only when the rest of the draft brings fewer new words than this (a new procedure, an answer...). */
export const SAV_SMART_REPEAT_MIN_NEW_WORDS = 4;
/** Below this many words, a draft is never compared as a whole (a short courtesy reply resembles every other one). */
export const SAV_SMART_REPEAT_MIN_REPLY_WORDS = 16;
const MIN_SENTENCE_WORDS = 4, STEM = 6;

/** Words of more than 3 letters, case and accents folded, cut to their first 6 letters (« cherchez » and « cherchiez » are one word). */
export function smartRepeatWords(value: string): Set<string> {
  return new Set(String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length > 3).map(word => word.slice(0, STEM)));
}
const common = (a: ReadonlySet<string>, b: ReadonlySet<string>) => { let count = 0; for (const word of a) if (b.has(word)) count += 1; return count; };
/** Jaccard on `smartRepeatWords`. */
export function smartRepeatSimilarity(a: string, b: string): number {
  const left = smartRepeatWords(a), right = smartRepeatWords(b);
  if (!left.size || !right.size) return 0;
  const shared = common(left, right);
  return shared / (left.size + right.size - shared);
}
/** Share of the smaller text's words found in the other one: the view's « passage already used » mark (information for the model, never a refusal). */
export function smartRepeatOverlap(a: string, b: string): number {
  const left = smartRepeatWords(a), right = smartRepeatWords(b);
  return left.size && right.size ? common(left, right) / Math.min(left.size, right.size) : 0;
}
/** At or above it, a card passage is shown as already used by a sent reply. */
export const SAV_SMART_PASSAGE_USED_THRESHOLD = 0.6;
const sentencesOf = (value: string) => value.split(/(?<=[.!?…])\s+|\n+/).map(row => row.trim()).filter(Boolean);
const bounded = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
/** A long sent reply keeps its beginning and its end (where the question usually is). */
const headAndTail = (value: string) => {
  const L = SAV_SMART_NO_REPEAT_LIMITS;
  return value.length <= L.replyChars ? value : `${value.slice(0, L.replyHeadChars).trimEnd()} […] ${value.slice(value.length - (L.replyChars - L.replyHeadChars - 7)).trimStart()}`;
};

/**
 * The guard: `repeated_reply` when the draft (a reply or an ask, never a handoff) copies a reply already sent (at least 16 words, 80 % of them in one
 * sent reply), or asks again a question already sent (one of its questions, or `memory.question`, against each QUESTION of each sent reply) while
 * the rest of the draft brings fewer than 4 new words. Null otherwise. `sentence`: the passage in cause.
 */
export function smartRepeatedReply(decision: Pick<SmartDecision, "outcome" | "reply" | "memory">, sent: readonly string[]): Readonly<{ code: "repeated_reply"; sentence: string }> | null {
  const reply = decision.reply?.trim() ?? "";
  if (decision.outcome === "handoff" || !reply || !sent.length) return null;
  const draft = smartRepeatWords(reply);
  if (draft.size >= SAV_SMART_REPEAT_MIN_REPLY_WORDS && sent.some(text => common(draft, smartRepeatWords(text)) / draft.size >= SAV_SMART_REPEAT_REPLY_THRESHOLD))
    return { code: "repeated_reply", sentence: bounded(reply, 300) };
  const ownQuestions = sentencesOf(reply).filter(sentence => sentence.endsWith("?"));
  const questions = [decision.memory.question?.trim() ?? "", ...ownQuestions].filter(question => smartRepeatWords(question).size >= MIN_SENTENCE_WORDS);
  const before = sent.flatMap(sentencesOf).filter(sentence => sentence.endsWith("?") && smartRepeatWords(sentence).size >= MIN_SENTENCE_WORDS);
  const asked = questions.find(question => before.some(sentence => smartRepeatSimilarity(question, sentence) >= SAV_SMART_REPEAT_QUESTION_THRESHOLD));
  if (!asked) return null;
  // The rest of the draft (outside its questions) against everything already sent: a new procedure or answer around the question is progress.
  const known = new Set(sent.flatMap(text => [...smartRepeatWords(text)]));
  const rest = smartRepeatWords(sentencesOf(reply).filter(sentence => !sentence.endsWith("?")).join(" "));
  const fresh = [...rest].filter(word => !known.has(word)).length;
  return fresh < SAV_SMART_REPEAT_MIN_NEW_WORDS ? { code: "repeated_reply", sentence: bounded(asked, 300) } : null;
}

/** The server checks of a draft, plus `repeated_reply` (named with its passage, so the correction knows what to drop). */
export function smartWithRepeatCheck(server: SmartCheckResult, decision: Pick<SmartDecision, "outcome" | "reply" | "memory">, sent: readonly string[]): SmartCheckResult {
  const repeated = smartRepeatedReply(decision, sent);
  if (!repeated) return server;
  const code: SmartCheckCode = repeated.code;
  return { ok: false, codes: [...new Set([...server.codes, code])], factProblems: [...server.factProblems, { code, sentence: repeated.sentence }] };
}

type SentRow = Readonly<{ at: string | null; text: string }>;
/**
 * The turn's view of what was already sent. `sent`: the confirmed replies (port); the thread's support messages are added (threadless cases store
 * them), the same text once. Masked like every customer-facing text the model reads; bounded.
 */
export function smartNoRepeatContext(noRepeat: SmartNoRepeat, thread: readonly SmartThreadMessage[], latestMail: string) {
  const L = SAV_SMART_NO_REPEAT_LIMITS;
  const rows: SentRow[] = [];
  const keyOf = (text: string) => [...smartRepeatWords(text)].slice(0, 30).join(" ");
  for (const row of [...noRepeat.sent, ...thread.filter(message => message.from === "support").map(message => ({ at: message.at, text: message.text }))]) {
    const text = smartMask(row.text).trim();
    if (!text || rows.some(known => keyOf(known.text) === keyOf(text) || known.text.includes(text) || text.includes(known.text))) continue;
    rows.push({ at: row.at, text });
  }
  rows.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const shown = rows.slice(-L.replies);
  const customers = thread.filter(message => message.from === "customer").map(message => ({ at: message.at, text: smartMask(message.text) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = smartMask(latestMail);
  const answerTo = (row: SentRow) => {
    const next = row.at ? customers.find(message => message.at > row.at!) : undefined;
    return bounded((next?.text ?? latest).trim(), L.answerChars);
  };
  const base = shown.map(row => ({ ...(row.at ? { envoyeLe: row.at } : {}), texte: headAndTail(row.text), reponseDuClient: answerTo(row) }));
  /** The given cards' passages a sent reply already used (a diagnostic question already asked, a step already given): at most 3 per reply. */
  const passagesOf = (row: SentRow, cards: readonly SmartSource[]) => {
    const sentences = sentencesOf(row.text).filter(sentence => smartRepeatWords(sentence).size >= MIN_SENTENCE_WORDS);
    const out: Array<{ cardId: string; passage: string }> = [];
    for (const card of cards) for (const passage of [...card.content.split(/\n+/), ...card.steps].map(line => line.trim())) {
      if (out.length >= L.passagesPerReply) return out;
      if (smartRepeatWords(passage).size < MIN_SENTENCE_WORDS || out.some(known => known.passage === bounded(passage, L.passageChars))) continue;
      if (sentences.some(sentence => smartRepeatOverlap(sentence, passage) >= SAV_SMART_PASSAGE_USED_THRESHOLD)) out.push({ cardId: card.cardId, passage: bounded(passage, L.passageChars) });
    }
    return out;
  };
  return {
    /** Every sent text, whole (the guard compares against all of them, not the bounded view). */
    sentTexts: rows.map(row => row.text),
    /** For understand and verify: the replies and the customer's answers. */
    view: base,
    /** For decide and correct: the same, with the passages of the given cards each reply already used. */
    viewWithCards: (cards: readonly SmartSource[]) => base.map((row, index) => {
      const passages = passagesOf(shown[index]!, cards);
      return passages.length ? { ...row, passagesDejaUtilises: passages } : row;
    }),
  };
}
export type SmartNoRepeatContext = ReturnType<typeof smartNoRepeatContext>;

const UNDERSTAND_ADD = `DÉJÀ ENVOYÉ (alreadySent)
Nos réponses déjà envoyées dans ce fil, avec ce que le client a répondu ensuite (reponseDuClient). Lis le mail du client comme une réponse à ces messages : un « oui », « c'est ça » ou une précision répond à notre dernière question ; écris le besoin avec ce que cette réponse précise.`;
const DECIDE_ADD = `DÉJÀ ENVOYÉ (alreadySent)
Nos réponses déjà envoyées dans ce fil, chacune avec la réponse du client (reponseDuClient) et les passages des fiches qu'elle a déjà utilisés (passagesDejaUtilises : une question de diagnostic déjà posée, une étape déjà donnée).
- Ne renvoie jamais une réponse déjà envoyée, même reformulée. Ne repose jamais une question à laquelle le client a répondu.
- Sers-toi de sa réponse pour avancer : applique ce que la fiche prévoit pour cette réponse (étape suivante, escalade, exception), cherche une fiche plus précise, ou passe la main avec une note qui dit ce qu'il a répondu.`;
const CORRECT_ADD = "repeated_reply : ta réponse reprend une réponse déjà envoyée ou repose une question déjà posée (alreadySent). Ne la renvoie pas : avance avec la réponse du client (ce que la fiche prévoit pour elle) ou passe la main (handoff) avec ta meilleure note.";
const VERIFY_ADD = `13. repeated_reply : alreadySent liste nos réponses déjà envoyées au client dans ce fil, avec sa réponse (reponseDuClient). La réponse reprend largement une réponse déjà envoyée, ou repose une question à laquelle le client a déjà répondu, même reformulée. sentence copie le passage répété.`;

export const SAV_SMART_NO_REPEAT_PROMPT_REVISION = "sav-smart-no-repeat-2026-11-26.v1";
/** sha256 of `smartNoRepeatPromptSource()`. Pinned by `smart-no-repeat.test.ts`; change it only with the revision. */
export const SAV_SMART_NO_REPEAT_PROMPT_SHA256 = "6ae28f5b9189d3591fa456bb680ae08631dcfcec0b91210fdb7c8afce72ce537";
export const smartNoRepeatPromptSource = () => JSON.stringify([SAV_SMART_NO_REPEAT_PROMPT_REVISION, UNDERSTAND_ADD, DECIDE_ADD, CORRECT_ADD, VERIFY_ADD]);
export const smartNoRepeatPromptSha256 = () => createHash("sha256").update(smartNoRepeatPromptSource()).digest("hex");

/**
 * The prompts of a turn: exactly the pinned ones of the prompt set (`options`: the commercial split or today's) when off; each followed by its no-repeat
 * part when on. With the commercial split on too, its verify line already takes number 13: the no-repeat line follows it as 14 (same text otherwise).
 */
export function smartTurnPrompts(noRepeat: boolean, options?: SmartPromptOptions) {
  if (!noRepeat) return { understand: smartUnderstandPrompt(options), decide: smartDecidePrompt(options), correct: smartCorrectionPrompt(options), verify: smartVerifyPrompt(options) };
  const verifyAdd = options?.commercialSplit === true ? VERIFY_ADD.replace(/^13\. /, "14. ") : VERIFY_ADD;
  return { understand: `${smartUnderstandPrompt(options)}\n\n${UNDERSTAND_ADD}`, decide: `${smartDecidePrompt(options)}\n\n${DECIDE_ADD}`,
    correct: `${smartDecidePrompt(options)}\n\n${DECIDE_ADD}\n\n${SAV_SMART_CORRECTION_INSTRUCTION}\n${CORRECT_ADD}`, verify: `${smartVerifyPrompt(options)}\n\n${verifyAdd}` };
}

/** The labelled escalation and exceptions of a card's structured resolution (and of its procedure groups and steps), bounded. */
export function smartCardGuidanceLines(resolution: SavRetrievalCandidate["resolution"]): string[] {
  if (!resolution || typeof resolution !== "object") return [];
  const text = (value: unknown) => typeof value === "string" && value.trim() ? [value.trim()] : [];
  const list = (value: unknown) => Array.isArray(value) ? value.flatMap(text) : [];
  const delivery = resolution.delivery && typeof resolution.delivery === "object" ? resolution.delivery as { groups?: unknown; steps?: unknown } : null;
  const items = (value: unknown) => Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];
  const lines = [
    ...text(resolution.escalation).map(value => `Escalade : ${value}`), ...list(resolution.exceptions).map(value => `Exception : ${value}`),
    ...items(delivery?.groups).flatMap(group => [...text(group.escalation).map(value => `Escalade : ${value}`), ...list(group.exceptions).map(value => `Exception : ${value}`)]),
    ...items(delivery?.steps).flatMap(step => [...text(step.escalation).map(value => `Escalade : ${value}`), ...list(step.exceptions).map(value => `Exception : ${value}`)]),
  ];
  return [...new Set(lines)];
}

/** A card with its guidance lines that its text lacks, appended under a label (grounding reads them as part of the card). */
export function smartWithCardGuidance(source: SmartSource, resolution: SavRetrievalCandidate["resolution"]): SmartSource {
  const content = source.content, folded = content.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
  const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
  const missing = smartCardGuidanceLines(resolution).filter(line => !folded.includes(fold(line.slice(line.indexOf(" : ") + 3))));
  if (!missing.length) return source;
  return { ...source, content: `${content}\n\nConsignes de la fiche :\n${bounded(missing.join("\n"), SAV_SMART_NO_REPEAT_LIMITS.guidanceChars)}` };
}
