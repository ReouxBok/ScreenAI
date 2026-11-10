import type { CasePhase } from "@/lib/sav/cases/case-types";
// Unified operator line: one V1 intake row + the V2 case of its EXACT confirmed ticket.
// Pure, no I/O. Never joins by contact or sender; never treats a created ticket as resolved;
// an unreadable source stays "unknown", never a false zero or a guessed state.
export type UnifiedV1Row = Readonly<{ threadId: string; view: string | null; status: string; blockedCause?: string | null; uncertainty?: unknown }>;
export type UnifiedTicket =
  | { state: "none" } | { state: "unavailable" }
  | { state: "confirmed" | "uncertain"; ticketId: string };
export type UnifiedCase =
  | { state: "absent" } | { state: "unavailable" }
  | { state: "found"; ticketId: string; owner: "agent" | "human" | "system_hold"; phase: string; updatedAt: string; reply?: UnifiedReply };
/** Latest reply of the exact case, from pole C's registry list (one list read per case, never one read per reply).
 * Only a confirmed Gmail receipt is "sent"; a started send without receipt is "uncertain", never "not sent". */
export type UnifiedReply =
  | { state: "absent" } | { state: "unavailable" } | { state: "none" }
  | { state: "prepared" | "sent" | "ended" | "uncertain"; code: string; uncertainCount: number };
export const replyFromItems = (items: readonly Readonly<{ status: Readonly<{ code: string; sent: string }> }>[]): UnifiedReply => {
  const latest = items[0];
  if (!latest) return { state: "none" };
  const uncertainCount = items.filter(item => item.status.sent !== "yes" && item.status.sent !== "no").length;
  const { code, sent } = latest.status;
  const state = sent === "yes" ? "sent" : sent !== "no" ? "uncertain" : ["declined", "cancelled", "revoked", "superseded"].includes(code) ? "ended" : "prepared";
  return { state, code, uncertainCount };
};
const replyLabel = (reply: UnifiedReply | undefined): string | null => {
  if (!reply) return null;
  switch (reply.state) {
    case "absent": return "Réponses : registre non branché, inconnu";
    case "unavailable": return "Réponses : lecture impossible, on ne sait pas si une réponse est partie";
    case "none": return "Aucune réponse préparée";
    case "prepared": return reply.code === "awaiting_validation" ? "Réponse préparée, en attente de validation humaine" : "Réponse préparée, pas encore envoyée";
    case "sent": return "Réponse envoyée (reçu Gmail confirmé)";
    case "ended": return "Réponse non envoyée : refusée, annulée, retirée ou remplacée";
    case "uncertain": return "Envoi incertain : vérification en cours, rien ne sera renvoyé";
  }
};
export type UnifiedBucket = "to_handle" | "ticket_linked" | "agent" | "reply" | "awaiting_customer" | "team" | "completed" | "to_verify";
export const unifiedBucketLabels: Record<UnifiedBucket, string> = {
  to_handle: "À traiter", ticket_linked: "Ticket créé ou lié", agent: "Attribué à l’agent", reply: "Réponse préparée / envoyée", awaiting_customer: "Attente client",
  team: "Équipe", completed: "Terminés", to_verify: "À vérifier",
};
export type UnifiedLine = Readonly<{
  bucket: UnifiedBucket; stage: string; ticket: string; owner: string; next: string; reply: string | null;
  v2Href: string | null; paused: boolean;
}>;
// Exhaustive over pole A's real phases (compile error if one is added): a wait is never shown as active follow-up.
const PHASES = {
  queued: { bucket: "to_handle", stage: "En file V2 — pas encore pris en charge par l’agent", next: "Attendre la prise en charge ; signaler si l’attente dure." },
  acting: { bucket: "agent", stage: "Dossier V2 suivi par l’agent", next: "Suivre le dossier V2 ; aucune action manuelle requise." },
  awaiting_customer: { bucket: "awaiting_customer", stage: "Attente du client", next: "Attendre le retour du client." },
  closed_no_reply: { bucket: "completed", stage: "Clos sans réponse du client", next: "Aucune action." },
  resolved: { bucket: "completed", stage: "Résolu (dossier V2)", next: "Aucune action." },
  handoff_pending: { bucket: "team", stage: "Transfert à l’équipe en cours", next: "Laisser l’équipe reprendre ; l’agent n’intervient pas." },
  human_owned: { bucket: "team", stage: "Pris en charge par l’équipe", next: "Laisser l’équipe répondre ; l’agent n’intervient pas." },
  deferred_budget: { bucket: "to_verify", stage: "Reporté : budget", next: "Rien ne repart seul avant le budget ; ne pas relancer ni réinitialiser." },
  technical_wait: { bucket: "to_verify", stage: "Attente technique", next: "Lire la cause dans le dossier V2 ; ne rien renvoyer." },
  reconciling: { bucket: "to_verify", stage: "Vérification d’un résultat incertain", next: "Attendre la vérification ; ne rien renvoyer." },
  needs_review: { bucket: "team", stage: "À relire par l’équipe", next: "Ouvrir le dossier V2 et relire." },
  blocked_technical: { bucket: "to_verify", stage: "Bloqué : technique", next: "Ouvrir le dossier V2 et lire son diagnostic." },
  blocked_reconcile: { bucket: "to_verify", stage: "Bloqué : vérification impossible", next: "Ouvrir le dossier V2 et lire son diagnostic." },
} as const satisfies Record<CasePhase, { bucket: UnifiedBucket; stage: string; next: string }>;
const V1_TEAM = new Set(["human_hold", "human_refused", "human_review", "human_choice", "identity_pending_approval"]);
const V1_VERIFY = new Set(["uncertain", "context_changed", "external_completion_pending"]);

export function unifiedConsoleLine(row: UnifiedV1Row, ticket: UnifiedTicket, kase: UnifiedCase): UnifiedLine {
  const paused = row.blockedCause === "agent_paused" || row.status === "paused" || row.status === "human_hold";
  // A case is shown only when it carries the very ticket V1 confirmed: no contact-level join to an older ticket.
  const exact = kase.state === "found" && ticket.state === "confirmed" && kase.ticketId === ticket.ticketId ? kase : null;
  const ticketLine = ticket.state === "confirmed" ? `Ticket ${ticket.ticketId} confirmé`
    : ticket.state === "uncertain" ? `Ticket ${ticket.ticketId} à vérifier (création ou rattachement non confirmé)`
    : ticket.state === "unavailable" ? "Ticket : lecture indisponible" : "Aucun ticket confirmé";
  const owner = paused || V1_TEAM.has(row.status) || row.view === "to_validate" || row.view === "sensitive" ? "Équipe (protection V1)" : exact ? (exact.owner === "agent" ? "Agent V2" : exact.owner === "human" ? "Équipe" : "En suspens")
    : ticket.state === "confirmed" && kase.state === "unavailable" ? "Dossier V2 : lecture indisponible"
    : ticket.state === "confirmed" && kase.state === "absent" ? "Pas de dossier V2 pour ce ticket" : "—";
  const v2Href = exact ? `/studio/sav/v2/${encodeURIComponent(exact.ticketId)}` : null;
  const reply = exact ? replyLabel(exact.reply) : null;
  const line = (bucket: UnifiedBucket, stage: string, next: string): UnifiedLine => ({ bucket, stage, ticket: ticketLine, owner, next, reply, v2Href, paused });
  if (ticket.state === "uncertain" || ticket.state === "unavailable" || V1_VERIFY.has(row.status) || (ticket.state === "confirmed" && kase.state === "unavailable"))
    return line("to_verify", "Résultat à vérifier", "Vérifier le résultat existant avant toute nouvelle action ; ne rien renvoyer.");
  // V1 human protections come first: a pause, a hold or a pending team decision is never shown as agent follow-up.
  if (paused) return line(row.status === "human_hold" ? "team" : "to_handle", row.status === "human_hold" ? "L’équipe garde la main (V1)" : "Pause active",
    "Rien ne repart sans reprise humaine via la commande de pause existante.");
  if (V1_TEAM.has(row.status) || row.view === "to_validate" || row.view === "sensitive") return line("team", "Décision de l’équipe attendue", "Ouvrir le dossier et décider.");
  if (exact) {
    const known = (PHASES as Record<string, { bucket: UnifiedBucket; stage: string; next: string }>)[exact.phase];
    if (!known) return line("to_verify", "Phase V2 non reconnue par cette version", "Ouvrir le dossier V2 ; ne rien déduire.");
    // I-C3/I-C4: an uncertain send, or a reply registry that is unwired or unreadable, outranks every phase and owner
    // (a resolved or team case must not hide a send without receipt; unknown replies are never "no action").
    if (exact.reply && "uncertainCount" in exact.reply && exact.reply.uncertainCount > 0) return line("to_verify", "Envoi d’une réponse incertain", "Attendre la vérification du reçu ; ne rien renvoyer.");
    if (exact.reply?.state === "unavailable" || exact.reply?.state === "absent") return line("to_verify", "Réponses du dossier V2 non vérifiables", "Lire les réponses dans le dossier V2 avant toute conclusion ; ne rien renvoyer.");
    if (exact.owner === "human" && known.bucket !== "completed") return line("team", "Pris en charge par l’équipe", "Laisser l’équipe répondre ; l’agent n’intervient pas.");
    if (exact.owner === "system_hold" && known.bucket !== "completed") return line("to_verify", "Dossier V2 en suspens", "Lire la cause de la suspension dans le dossier V2.");
    if (exact.phase === "acting" && exact.reply?.state === "prepared") return line("reply", "Réponse préparée", exact.reply.code === "awaiting_validation" ? "Relire la réponse dans le dossier V2 ; la validation depuis le Studio n’existe pas encore." : "Laisser la file d’envoi aboutir.");
    if (exact.phase === "acting" && exact.reply?.state === "sent") return line("reply", "Réponse envoyée", "Attendre le retour du client ; un envoi ne résout pas la demande.");
    return line(known.bucket, known.stage, known.next);
  }
  if (row.view === "completed") return line("completed", "Terminé côté V1", "Aucune action.");
  // A confirmed ticket is a created/linked ticket, not a treated or resolved request.
  if (ticket.state === "confirmed") return line("ticket_linked", "Ticket créé ou lié — traitement non terminé", "Suivre le traitement ; ne pas considérer la demande comme résolue.");
  return line("to_handle", "Prise en charge V1 en cours", "Laisser l’analyse se terminer.");
}
