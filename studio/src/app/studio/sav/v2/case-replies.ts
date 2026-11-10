// SAV-10 raccord (UX side): what the V2 case page may say about the replies pole C's registry holds. Pure: the readers are a port,
// bound in case-replies-port.ts. Every state is distinct: no reader in this build (absent), a read that failed (unavailable), a page link
// that is not ours (invalid), and a real empty list. A reply is only "sent" with a confirmed receipt; a started send is "maybe", never "no".
// Nothing here approves, declines, revokes or queues: no such action exists in the Studio yet.
import { readCaseReplyDisclosure } from "@/lib/sav/cases/case-reply-outbound";
import { ACCESS_AUTO_APPROVAL_BASIS } from "@/lib/sav/cases/customer-return";

/** The subset of pole C's read contract (case-reply-registry.ts) the page uses. Codes stay strings: an unknown one is shown as unknown, not guessed. */
export type CaseReplyStatusRead = Readonly<{
  code: string; sent: string; terminal: boolean; hold: string | null; cancel: string | null; endedBy: string | null;
  j2: Readonly<{ state: string; dueAt: string | null }>;
}>;
export type CaseReplyItem = Readonly<{
  id: string; caseId: string; purpose: string; validation: string; caseVersion: number; createdAt: string; decidedAt: string | null; revokedAt: string | null;
  /** The stored hash of the exact proposal a person reads and approves (pole C); shown, never recomputed or trusted as an approval. */
  payloadHash: string;
  approvability: Readonly<{ ok: boolean; reason?: string }>;
  status: CaseReplyStatusRead;
  effect: Readonly<{ reply: Readonly<{ state: string; dispatchedAt: string | null; confirmedAt: string | null; reconcileAttempts: number; nextReconcileAt: string | null }> | null }> | null;
}>;
export type CaseReplyDetail = CaseReplyItem & Readonly<{
  recipient: string; decidedBy: string | null; authorizationBasis: string | null;
  proposal: Readonly<{ subject: string; text: string; question: Readonly<{ id: string; text: string }> | null }>;
}>;
export type CaseReplyCursor = Readonly<{ createdAt: string; id: string }>;
type ReadDeps = Readonly<{ env: () => Record<string, string | undefined> }>;
export type CaseReplyReaders = Readonly<{
  /** Pole C 48e3e8a: with `caseId`, a reply of another case is filtered in SQL, so it is neither read nor decrypted. */
  get: (input: Readonly<{ validationId: string; caseId: string }>, deps: ReadDeps) => Promise<CaseReplyDetail | null>;
  list: (input: Readonly<{ caseId: string; limit: number; before?: CaseReplyCursor }>, deps: ReadDeps) => Promise<{ items: readonly CaseReplyItem[]; next: CaseReplyCursor | null }>;
}>;

export const CASE_REPLIES_PAGE_SIZE = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env = () => process.env;

export const encodeCaseReplyCursor = (cursor: CaseReplyCursor) => Buffer.from(`${cursor.createdAt}|${cursor.id}`).toString("base64url");
/** Only a cursor this page made is accepted: an exact ISO instant and a UUID. Anything else is invalid and reaches no reader. */
export function parseCaseReplyCursor(value: string): CaseReplyCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  const [createdAt = "", id = "", extra] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !UUID.test(id) || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return null;
  return { createdAt, id };
}

export type CaseRepliesRead =
  | { state: "absent" } | { state: "invalid" } | { state: "unavailable" }
  | { state: "ok"; items: readonly CaseReplyItem[]; next: string | null };

/** Called only after the page's access check: pole C's list decrypts each stored proposal to read its purpose. */
export async function readCaseReplies(readers: CaseReplyReaders | null, input: Readonly<{ caseId: string; cursor?: string }>): Promise<CaseRepliesRead> {
  if (!readers) return { state: "absent" };
  const before = input.cursor ? parseCaseReplyCursor(input.cursor) : undefined;
  if (before === null) return { state: "invalid" };
  try {
    const page = await readers.list({ caseId: input.caseId, limit: CASE_REPLIES_PAGE_SIZE, ...(before ? { before } : {}) }, { env });
    // A row of another case is a reader fault, not something to show here.
    if (page.items.some(item => item.caseId !== input.caseId)) return { state: "unavailable" };
    return { state: "ok", items: page.items, next: page.next ? encodeCaseReplyCursor(page.next) : null };
  } catch { return { state: "unavailable" }; }
}

export type CaseReplyRead =
  | { state: "none" } | { state: "absent" } | { state: "invalid" } | { state: "unavailable" } | { state: "not_found" }
  | { state: "ok"; reply: CaseReplyDetail };

/** One reply with its exact text and recipient, read for the open case only (the reader filters on it before decrypting); the check is kept here too. */
export async function readCaseReply(readers: CaseReplyReaders | null, input: Readonly<{ caseId: string; id?: string }>): Promise<CaseReplyRead> {
  if (!input.id) return { state: "none" };
  if (!readers) return { state: "absent" };
  if (!UUID.test(input.id)) return { state: "invalid" };
  try {
    const reply = await readers.get({ validationId: input.id.toLowerCase(), caseId: input.caseId }, { env });
    return !reply || reply.caseId !== input.caseId ? { state: "not_found" } : { state: "ok", reply };
  } catch { return { state: "unavailable" }; }
}

const purposeLabels: Record<string, string> = { question: "Question au client", answer: "Réponse au client", reminder: "Relance du client" };
const holdLabels: Record<string, string> = {
  effects_off: "envois désactivés sur cet environnement", paused: "agent en pause", lease_expired: "reprise après une interruption", policy_changed: "politique d’admission modifiée, à revalider",
  recipient_unreadable: "destinataire illisible",
};
const cancelLabels: Record<string, string> = {
  approval_invalid: "validation invalide", approval_revoked: "validation retirée", payload_changed: "texte différent de celui validé", version_changed: "dossier modifié depuis la validation",
  recipient_changed: "destinataire différent de celui validé", owner_changed: "dossier repris par une personne", new_input: "nouveau message du client", admission_withdrawn: "admission retirée",
};
const statusLabels: Record<string, string> = {
  awaiting_validation: "En attente de validation humaine", declined: "Refusée par l’équipe", superseded: "Remplacée par une proposition plus récente", revoked: "Validation retirée avant l’envoi",
  approved_not_queued: "Validée, pas encore en file", queued: "Validée, en file d’envoi", held: "Validée, en attente", sending: "Envoi commencé, pas encore confirmé",
  send_unconfirmed: "Envoi incertain : vérification en cours", sent_recording: "Envoyée, reçu confirmé (enregistrement en cours)", sent_confirmed: "Envoyée, reçu confirmé", cancelled: "Annulée avant l’envoi",
};
const j2Labels: Record<string, string> = { scheduled: "Relance J2 prévue", fired: "Relance J2 échue", cancelled: "Relance J2 annulée" };

export type CaseReplyDisplay = Readonly<{ purpose: string; status: string; sent: string; tone: "neutral" | "warning" | "success" | "danger"; j2: Readonly<{ label: string; dueAt: string | null }> | null; validation: string }>;
export function describeCaseReply(item: CaseReplyItem): CaseReplyDisplay {
  const { status } = item;
  let label = statusLabels[status.code] ?? `État non reconnu par cette version (${status.code})`;
  if (status.code === "held" && status.hold) label += ` : ${holdLabels[status.hold] ?? status.hold}`;
  if (status.code === "cancelled") { const why = status.cancel ? cancelLabels[status.cancel] ?? status.cancel : status.endedBy; if (why) label += ` : ${why}`; }
  // Fail closed on the one fact that matters: only "yes" is sent, only "no" is not; anything else may have left.
  const sent = status.sent === "yes" ? "Partie chez le client : reçu Gmail confirmé." : status.sent === "no" ? "Rien n’est parti vers le client."
    : "Peut-être partie : l’envoi a commencé sans reçu confirmé. Seule une vérification aura lieu, rien ne sera renvoyé.";
  const tone = status.sent === "yes" ? "success" : status.sent === "no" ? (status.code === "cancelled" ? "danger" : "neutral") : "warning";
  const j2 = j2Labels[status.j2.state] ? { label: j2Labels[status.j2.state]!, dueAt: status.j2.dueAt } : null;
  // The registry's flag only says the state would accept a decision; who may decide is not settled, so the Studio offers none.
  const validation = item.approvability.ok ? "Le registre accepterait une décision, mais aucune validation n’est possible depuis le Studio : qui peut valider n’est pas encore décidé."
    : item.approvability.reason === "effects_off" ? "Aucune validation possible : envois de l’agent désactivés sur cet environnement."
    : "Déjà décidée.";
  return { purpose: purposeLabels[item.purpose] ?? item.purpose, status: label, sent, tone, j2, validation };
}

/** The first thing an operator wants to know, from the reply list only. A registry that cannot be read says nothing about what left; an uncertain send anywhere on the page stays visible. */
export type CaseRepliesSummary = Readonly<{ line: string; tone: CaseReplyDisplay["tone"]; uncertain: number }>;
export function summarizeCaseReplies(replies: CaseRepliesRead): CaseRepliesSummary {
  if (replies.state === "absent") return { line: "Réponses : registre non branché sur cette version, on ne sait pas si une réponse existe.", tone: "warning", uncertain: 0 };
  if (replies.state === "unavailable") return { line: "Réponses : lecture impossible, on ne sait pas si une réponse est partie.", tone: "danger", uncertain: 0 };
  if (replies.state === "invalid") return { line: "Réponses : lien de page invalide.", tone: "warning", uncertain: 0 };
  const latest = replies.items[0];
  if (!latest) return { line: "Aucune réponse préparée enregistrée pour ce dossier.", tone: "neutral", uncertain: 0 };
  const shown = describeCaseReply(latest);
  return { line: `Dernière réponse : ${shown.status}. ${shown.sent}`, tone: shown.tone, uncertain: replies.items.filter(item => item.status.sent !== "yes" && item.status.sent !== "no").length };
}

/**
 * The selected reply as an operator must read it, from what pole C stored and nothing else. The text is the stored one: its AI mention is READ
 * (sav-v2-reply-outbound.v1), never added or fixed here. A validation is shown only when one is recorded; queued, started, uncertain and confirmed
 * stay distinct; a Gmail receipt proves the mail left, not that the customer's request is solved.
 */
export type CaseReplyDetailDisplay = Readonly<{ mention: string; mentionOk: boolean; fingerprint: string; decision: string; timeline: readonly string[]; languageProof: string }>;
const decisionLabels: Record<string, string> = {
  proposed: "Aucune validation enregistrée : proposition en attente", declined: "Refus enregistré", approved: "Validation enregistrée",
  revoked: "Validation retirée", superseded: "Remplacée avant toute décision : aucune validation enregistrée",
};
export function describeCaseReplyDetail(reply: CaseReplyDetail, date: (value: string) => string): CaseReplyDetailDisplay {
  const disclosure = readCaseReplyDisclosure(reply.proposal.text), automaticBasis = reply.authorizationBasis === ACCESS_AUTO_APPROVAL_BASIS; // the persisted authority (rule of pole A): read to word the page, never a permission
  const mention = !disclosure ? "Texte sans la mention IA attendue : le registre refuse de le valider ou de l’envoyer tel quel. Rien n’est ajouté par cette page."
    : disclosure.mode === "manual_reviewed" && automaticBasis ? "Texte « validé par une personne » sous une autorisation automatique : incohérent, le registre doit le refuser. Rien n’est ajouté par cette page."
    : disclosure.mode === "manual_reviewed" ? `Mention IA présente (${disclosure.language === "en" ? "anglais" : "français"}) : réponse préparée avec l’aide d’une IA, à valider par une personne. Ce texte est celui qui serait validé, haché et envoyé, sans retouche.`
    : automaticBasis ? `Mention « envoyée automatiquement par une IA » (${disclosure.language === "en" ? "anglais" : "français"}), avec une base d’autorisation enregistrée par le registre. Ce texte est celui qui est haché et envoyé, sans retouche.`
    : "Mention « envoyée automatiquement » sans autorisation automatique enregistrée : le texte seul ne donne aucun droit, le registre doit le refuser.";
  const base = decisionLabels[reply.validation] ?? `Décision dans un état non reconnu par cette version (${reply.validation})`;
  const decided = reply.decidedAt && ["approved", "declined", "revoked"].includes(reply.validation) ? ` le ${date(reply.revokedAt ?? reply.decidedAt)}` : "";
  const decision = `${base}${decided}${reply.validation === "approved" || reply.validation === "declined" ? " (enregistrée par le registre ; cette page n’en crée aucune)" : ""}.`;
  const timeline: string[] = [];
  const effect = reply.effect?.reply ?? null;
  if (!reply.effect) timeline.push("Pas en file d’envoi : aucune exécution enregistrée.");
  else if (!effect) timeline.push("En file d’envoi : aucun envoi commencé.");
  else {
    if (effect.dispatchedAt) timeline.push(`Envoi commencé le ${date(effect.dispatchedAt)}.`);
    if (reply.status.sent === "yes") timeline.push(effect.confirmedAt ? `Reçu Gmail confirmé le ${date(effect.confirmedAt)}.` : "Reçu Gmail confirmé (date non enregistrée).");
    else if (reply.status.sent !== "no") timeline.push(`Envoi incertain : vérification seule, aucun renvoi. ${effect.reconcileAttempts} vérification${effect.reconcileAttempts > 1 ? "s" : ""} faite${effect.reconcileAttempts > 1 ? "s" : ""}${effect.nextReconcileAt ? `, prochaine le ${date(effect.nextReconcileAt)}` : ""}.`);
    else timeline.push("Rien n’est parti vers le client.");
  }
  if (reply.status.sent === "yes") timeline.push("Un reçu Gmail prouve que le mail est parti, pas que la demande du client est résolue.");
  // How the reply's language was chosen (proven or French fallback) is decided when the proposal is prepared and is not stored by pole C's registry.
  const languageProof = "Provenance de la langue : non enregistrée par cette version (seule la langue de la mention est lisible).";
  return { mention, mentionOk: disclosure?.mode === "automated" ? automaticBasis : disclosure?.mode === "manual_reviewed" && !automaticBasis, fingerprint: `${reply.payloadHash.slice(0, 12)}…`, decision, timeline, languageProof };
}

