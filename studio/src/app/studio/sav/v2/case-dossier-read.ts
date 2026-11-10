// What an operator reads first on a V2 case: the customer's mails and the sheets the agent used. Pure: the readers are a port (case-dossier-port.ts), called by the page
// only after its staff check, once the case is known. Each state is distinct: no reader in this build (absent), a read that failed (unavailable), nothing to read (empty),
// and, per mail, a row that is not found or cannot be decrypted. A failure is never shown as "no mail" or "no sheet", and nothing is filled in.
import { splitSavMessageText } from "@/lib/sav/message-context";
import type { CaseEvent, KnowledgeRef } from "@/lib/sav/cases/case-types";

/** The viewer the console's own staff check returned, in the form pole A's and pole C's readers accept: built from that result only, never from a URL or a client value. */
export type CaseViewer = Readonly<{ kind: "staff_session_verified"; staffUserId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const caseViewerOf = (staff: Readonly<{ id?: unknown }> | null | undefined): CaseViewer | null =>
  typeof staff?.id === "string" && UUID.test(staff.id) ? { kind: "staff_session_verified", staffUserId: staff.id } : null;

export const CASE_MAILS_SHOWN = 5;
const MAIL_TEXT_MAX = 12_000;

export type CaseMailRow = Readonly<{ gmailMessageId: string; from: string | null; subject: string | null; receivedAt: string; text: string | null }>;
export type CaseCardRow = Readonly<{ knowledgeId: string; contentVersionId: string; title: string; version: number }>;
export type CaseHandoffNoticeRow = Readonly<{ execution: string; effect: string | null; ack: Readonly<{ ts?: unknown; channel?: unknown }> | null }>;
export type CaseDossierReaders = Readonly<{
  /** Inbound mails of these Gmail ids INSIDE the case's threads; `text` is null when the stored body cannot be decrypted. */
  mails: (input: Readonly<{ threadIds: readonly string[]; gmailMessageIds: readonly string[] }>, viewer: CaseViewer) => Promise<readonly CaseMailRow[]>;
  cards: (refs: readonly KnowledgeRef[], viewer: CaseViewer) => Promise<readonly CaseCardRow[]>;
  /** The latest handoff notice of the case on the effect ledger; null when none exists. `ack` is what Slack answered, null when absent or undecryptable. */
  handoffNotice: (caseId: string, viewer: CaseViewer) => Promise<CaseHandoffNoticeRow | null>;
}>;

export type CaseMailShown =
  | { state: "ok"; at: string; from: string | null; subject: string | null; text: string; truncated: boolean; quotedHidden: boolean }
  | { state: "unreadable"; at: string; from: string | null; subject: string | null }
  | { state: "missing"; at: string };
export type CaseMailsRead = { state: "absent" } | { state: "denied" } | { state: "empty" } | { state: "unavailable" } | { state: "ok"; items: readonly CaseMailShown[]; older: number };

/** The confirmed customer mails of the journal, most recent first; only the part the customer just wrote is shown, the stored original is not changed. */
export async function readCaseMails(readers: CaseDossierReaders | null, viewer: CaseViewer | null, input: Readonly<{ threadIds: readonly string[]; events: readonly CaseEvent[] }>): Promise<CaseMailsRead> {
  if (!readers) return { state: "absent" };
  if (!viewer) return { state: "denied" };
  const inbound = input.events.filter(event => event.kind === "inbound_confirmed" && event.sourceRef?.type === "email").sort((a, b) => b.caseVersion - a.caseVersion);
  if (!inbound.length) return { state: "empty" };
  const shown = inbound.slice(0, CASE_MAILS_SHOWN);
  try {
    const rows = await readers.mails({ threadIds: input.threadIds, gmailMessageIds: shown.map(event => event.sourceRef!.id) }, viewer);
    const byId = new Map(rows.map(row => [row.gmailMessageId, row]));
    return { state: "ok", older: inbound.length - shown.length, items: shown.map((event): CaseMailShown => {
      const row = byId.get(event.sourceRef!.id);
      if (!row) return { state: "missing", at: event.occurredAt };
      if (row.text === null) return { state: "unreadable", at: row.receivedAt, from: row.from, subject: row.subject };
      const split = splitSavMessageText(row.text), text = split.currentText.trim();
      return { state: "ok", at: row.receivedAt, from: row.from, subject: row.subject, text: text.slice(0, MAIL_TEXT_MAX), truncated: text.length > MAIL_TEXT_MAX, quotedHidden: Boolean(split.quotedText.trim()) };
    }) };
  } catch { return { state: "unavailable" }; }
}

export type CaseCardsRead = { state: "absent" } | { state: "denied" } | { state: "none" } | { state: "unavailable" } | { state: "ok"; titleOf: (ref: KnowledgeRef) => Pick<CaseCardRow, "title" | "version"> | null };
/** Titles of the sheets the decision names. A ref the base does not hold has no title (null): its ids stay the only thing shown, no title is guessed. */
export async function readCaseCards(readers: CaseDossierReaders | null, viewer: CaseViewer | null, refs: readonly KnowledgeRef[]): Promise<CaseCardsRead> {
  if (!readers) return { state: "absent" };
  if (!viewer) return { state: "denied" };
  if (!refs.length) return { state: "none" };
  try {
    const rows = await readers.cards(refs, viewer);
    const key = (ref: KnowledgeRef) => `${ref.knowledgeId}/${ref.contentVersionId}`;
    const byRef = new Map(rows.map(row => [key(row), row]));
    return { state: "ok", titleOf: ref => byRef.get(key(ref)) ?? null };
  } catch { return { state: "unavailable" }; }
}

export type CaseHandoffNoticeRead = { state: "absent" } | { state: "denied" } | { state: "unavailable" } | { state: "none" } | { state: "ok"; row: CaseHandoffNoticeRow };
export async function readCaseHandoffNotice(readers: CaseDossierReaders | null, viewer: CaseViewer | null, caseId: string): Promise<CaseHandoffNoticeRead> {
  if (!readers) return { state: "absent" };
  if (!viewer) return { state: "denied" };
  try { const row = await readers.handoffNotice(caseId, viewer); return row ? { state: "ok", row } : { state: "none" }; } catch { return { state: "unavailable" }; }
}

/**
 * What can be said about telling the team, from the effect ledger only. Only a confirmed effect with the message's channel and timestamp is "confirmed", and it proves a message
 * in a channel: never that Ugo received or read it, nor that anyone took the case. Everything else says what is known and what a person does next.
 */
export type CaseHandoffNoticeDisplay = Readonly<{ stage: "none" | "pending" | "uncertain" | "confirmed" | "ended" | "unknown"; tone: "neutral" | "warning" | "success" | "danger"; line: string; link: string | null; next: string }>;
const TELL_TEAM = "Prévenir l’équipe directement : elle n’a pas été prévenue par l’agent.";
const CHECK_CHANNEL = "Regarder le canal Slack de l’équipe ; si le message n’y est pas, la prévenir directement. Ne rien renvoyer depuis le Studio.";
const SLACK_CHANNEL = /^C[A-Z0-9]{8,14}$/, SLACK_TS = /^[0-9]{9,12}\.[0-9]{1,8}$/;
export function describeHandoffNotice(read: CaseHandoffNoticeRead, options: Readonly<{ enabled: boolean }>): CaseHandoffNoticeDisplay {
  if (read.state === "absent") return { stage: "unknown", tone: "warning", line: "Notification : lecture non branchée sur cette version, on ne sait pas si elle existe.", link: null, next: CHECK_CHANNEL };
  if (read.state === "denied") return { stage: "unknown", tone: "warning", line: "Notification : lecture refusée, identité de la session non vérifiée.", link: null, next: CHECK_CHANNEL };
  if (read.state === "unavailable") return { stage: "unknown", tone: "danger", line: "Notification : lecture impossible, on ne sait pas si elle est partie.", link: null, next: CHECK_CHANNEL };
  if (read.state === "none") return { stage: "none", tone: "warning", line: options.enabled ? "Aucune notification préparée pour ce dossier." : "Aucune notification préparée : elles sont désactivées sur cet environnement.", link: null, next: TELL_TEAM };
  const { execution, effect, ack } = read.row;
  if (effect === "confirmed") {
    if (typeof ack?.channel === "string" && SLACK_CHANNEL.test(ack.channel) && typeof ack.ts === "string" && SLACK_TS.test(ack.ts))
      return { stage: "confirmed", tone: "success", line: "Notification confirmée : message posté dans le canal Slack. Cela ne prouve ni qu’Ugo l’a lue, ni que quelqu’un a pris le dossier.", link: `https://slack.com/archives/${ack.channel}/p${ack.ts.replace(".", "")}`, next: "Une personne de l’équipe doit prendre le dossier." };
    return { stage: "uncertain", tone: "warning", line: "Notification marquée confirmée, mais sans lien lisible vers le message : à ne pas compter comme reçue.", link: null, next: CHECK_CHANNEL };
  }
  if (effect === "dispatched" || effect === "acked" || effect === "uncertain") return { stage: "uncertain", tone: "warning", line: "Notification incertaine : elle est peut-être partie, sans confirmation. Vérification seule, aucun renvoi.", link: null, next: CHECK_CHANNEL };
  if (effect !== null && effect !== "planned") return { stage: "unknown", tone: "warning", line: "Notification dans un état non reconnu par cette version : à ne pas compter comme reçue.", link: null, next: CHECK_CHANNEL };
  if (execution === "refused") return { stage: "ended", tone: "warning", line: "Notification arrêtée avant l’envoi : rien n’est parti.", link: null, next: TELL_TEAM };
  if (["pending", "running", "waiting", "uncertain"].includes(execution)) return { stage: "pending", tone: "neutral", line: "Notification en attente : rien n’est encore parti.", link: null, next: "Attendre son envoi, ou prévenir l’équipe directement si c’est urgent." };
  return { stage: "unknown", tone: "warning", line: "Notification dans un état non reconnu par cette version : à ne pas compter comme reçue.", link: null, next: CHECK_CHANNEL };
}
