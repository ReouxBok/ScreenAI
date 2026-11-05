// UX lot 10: operator wording for pole C9's read-only operational state of the SELECTED reply and of its effects (readCaseReplyOperationalState,
// sav-v2-case-operational-read.v1), composed locally with C9 1c28928. The mapper is pure; `readOperationalState` is the only I/O, called by the page AFTER its
// staff check, for the case it read and the reply it already read for that case.
//
// Rules: the verification limit is C's `needsPerson` (no threshold or count of it is shown); a next check is shown only when C says one is scheduled; notes are
// what the effect ledger holds, never proof that a note was asked for nor that none exists in HubSpot; `unknown`, `needs_audit` and an incomplete read stay
// visible even when the reply is confirmed; a raw machine code is never shown.
import type { CaseOperationalEffect, CaseOperationalReadResult, CaseOperationalView } from "@/lib/sav/cases/case-operational-read";
import type { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";

export const OPERATIONAL_SCHEMA = "sav-v2-case-operational-read.v1";
type StaffSession = Awaited<ReturnType<typeof requireIntakeConsoleStaff>>;
export type OperationalReader = (input: Readonly<{ caseId: string; validationId: string }>, deps: Readonly<{ access: () => boolean }>) => Promise<CaseOperationalReadResult>;
export type OperationalRead =
  | { state: "absent" } | { state: "denied" } | { state: "invalid" } | { state: "not_found" } | { state: "unavailable" }
  | { state: "ok"; view: CaseOperationalView };

/**
 * The page's only call to pole C9. `staff` is what the existing staff check returned for this request: C9's access callback is built from it and from nothing
 * else (never a URL parameter, a body or a client flag). `caseId` is the case the page read for its ticket; `validationId` the reply it already read for that case.
 */
export async function readOperationalState(reader: OperationalReader | null, staff: StaffSession, caseId: string, validationId: string): Promise<OperationalRead> {
  if (!reader) return { state: "absent" };
  const verified = Boolean(staff && typeof staff.id === "string" && staff.id);
  try {
    const result = await reader({ caseId, validationId }, { access: () => verified });
    if (result.ok) return { state: "ok", view: result.view };
    return { state: result.code === "access_denied" ? "denied" : result.code === "invalid_input" ? "invalid" : result.code === "not_found" ? "not_found" : "unavailable" };
  } catch { return { state: "unavailable" }; }
}

export type OperationalDisplay = Readonly<{ tone: "neutral" | "warning" | "danger"; lines: readonly string[]; actionable: false }>;
const own = <T,>(labels: Readonly<Record<string, T>>, key: unknown) => typeof key === "string" && Object.hasOwn(labels, key) ? labels[key] : undefined;
const PERSON = "Vérification arrivée à sa limite : une personne doit regarder. Aucun renvoi ni remise à zéro automatique.";

const parentLabels: Readonly<Record<string, string>> = {
  pending: "Exécution en file, pas encore commencée.", running: "Exécution en cours de traitement.", waiting: "Exécution en attente.",
  uncertain: "Exécution au résultat incertain : vérification seule, aucun renvoi.", confirmed: "Exécution terminée.", refused: "Exécution arrêtée avant son terme (motif technique enregistré).",
};
const replyLabels: Readonly<Record<string, string>> = {
  no_recorded_effect: "Envoi : aucune étape enregistrée.", planned: "Envoi prévu, pas commencé.", dispatched: "Envoi commencé, pas encore confirmé.",
  acked: "Envoi accepté par Gmail, confirmation en cours.", uncertain: "Envoi incertain : vérification seule, aucun renvoi.", confirmed: "Reçu Gmail confirmé (ce n’est pas une résolution de la demande).",
};
const noteLabels: Readonly<Record<string, string>> = {
  no_recorded_note_effect: "Note interne : aucune étape de note enregistrée.", creation_pending: "Note interne : création en attente.",
  creation_uncertain: "Note interne : création peut-être effectuée, vérification seule.", created_association_pending: "Note interne créée, rattachement au ticket en attente.",
  association_uncertain: "Note interne créée, rattachement au ticket à vérifier.", confirmed: "Note interne créée et rattachement confirmé (ce n’est pas une résolution de la demande).",
};
const NOTE_SCOPE = "D’après le registre des effets seulement : ni la demande d’une note, ni son absence dans HubSpot ne sont prouvées.";
const incompleteLabels: Readonly<Record<string, string>> = {
  parent_unreadable: "exécution illisible", unexpected_effect: "effet inattendu sous cette exécution", duplicate_effect: "effet en double", note_pair_inconsistent: "étapes de note incohérentes",
  too_many_effects: "trop d’effets sous cette exécution", contradiction: "données contradictoires", unreadable_value: "valeur illisible",
};

/** One effect's verification, from C's own verdict only (never from a count). */
function effectLines(effect: CaseOperationalEffect | null, what: string, date: (value: string) => string): { lines: string[]; person: boolean; audit: boolean; unreadable: boolean } {
  if (!effect) return { lines: [], person: false, audit: false, unreadable: false };
  const v = effect.verification as Partial<CaseOperationalEffect["verification"]> | undefined;
  if (!v || typeof v.needsPerson !== "boolean") return { lines: [`${what} : état de vérification non lisible (lecture incomplète).`], person: false, audit: false, unreadable: true };
  const lines: string[] = [], audit = v.audit === "needs_audit";
  if (v.needsPerson) lines.push(`${what} : ${PERSON}${v.reason === "verification_limit" ? "" : " Motif non reconnu par cette version."}`);
  else if (typeof effect.nextVerificationAt === "string" && Number.isFinite(Date.parse(effect.nextVerificationAt))) lines.push(`${what} : prochaine vérification le ${date(effect.nextVerificationAt)}.`);
  if (audit) lines.push(`${what} : données contradictoires, à auditer (rien n’est réparé automatiquement).`);
  return { lines, person: v.needsPerson, audit, unreadable: false };
}

export function describeOperationalState(read: OperationalRead, page: Readonly<{ caseId: string; validationId: string }>, date: (value: string) => string): OperationalDisplay {
  const show = (tone: OperationalDisplay["tone"], lines: string[]): OperationalDisplay => ({ tone, lines, actionable: false });
  switch (read.state) {
    case "absent": return show("neutral", ["Suivi des effets (réponse et note interne) non branché dans cette version : son absence ne veut pas dire que tout est en ordre."]);
    case "denied": return show("danger", ["Suivi des effets : accès refusé, rien n’a été lu."]);
    case "invalid": return show("danger", ["Suivi des effets : identifiant de réponse invalide, rien n’a été lu."]);
    case "not_found": return show("danger", ["Aucun suivi d’effets pour cette réponse dans ce dossier."]);
    case "unavailable": return show("danger", ["Suivi des effets indisponible : la lecture a échoué. Ce n’est pas une liste vide."]);
  }
  const v = read.view;
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  // A projection of another case or another reply is a reader fault, never something to show here.
  if (!same(v.caseId, page.caseId) || !same(v.validationId, page.validationId)) return show("danger", ["Suivi des effets rejeté : il ne concerne pas cette réponse de ce dossier."]);
  if (v.schemaRevision !== OPERATIONAL_SCHEMA) return show("warning", ["Suivi des effets dans un format que cette version ne lit pas."]);
  const observed = typeof v.observedAt === "string" && Number.isFinite(Date.parse(v.observedAt)) ? `Lu le ${date(v.observedAt)} (heure du serveur, pas la fraîcheur de Gmail ni du CRM).` : "Heure de lecture non enregistrée.";
  const parent = v.parent === null ? "Pas en file d’envoi : aucune exécution enregistrée." : own(parentLabels, v.parent?.state) ?? "État d’exécution non lisible (lecture incomplète).";
  const replyLabel = own(replyLabels, v.reply?.status), noteLabel = own(noteLabels, v.note?.status);
  const reply = effectLines(v.reply?.effect ?? null, "Envoi", date), create = effectLines(v.note?.create ?? null, "Création de la note", date), associate = effectLines(v.note?.associate ?? null, "Rattachement de la note", date);
  const incompleteCodes = Array.isArray(v.incomplete) ? v.incomplete : [];
  const incomplete = v.complete !== true || incompleteCodes.length > 0;
  const needsPerson = v.needsPerson === true || reply.person || create.person || associate.person;
  const audit = v.auditRequired === true || reply.audit || create.audit || associate.audit;
  const unknown = !replyLabel || !noteLabel || v.validation === "unknown" || (v.parent !== null && !own(parentLabels, v.parent?.state)) || reply.unreadable || create.unreadable || associate.unreadable;
  const lines = [
    ...(needsPerson ? [PERSON] : []),
    ...(audit ? ["Lecture contradictoire : à auditer, rien n’est réparé automatiquement."] : []),
    ...(incomplete ? [`Lecture incomplète${incompleteCodes.length ? ` : ${incompleteCodes.map(code => own(incompleteLabels, code) ?? "motif non reconnu").join(", ")}` : ""}. Les parties non fiables sont indiquées « non lisible ».`] : []),
    parent,
    replyLabel ?? "Envoi : état non lisible (lecture incomplète).", ...reply.lines,
    noteLabel ?? "Note interne : état non lisible (lecture incomplète).", ...create.lines, ...associate.lines, NOTE_SCOPE,
    observed,
  ];
  return show(needsPerson ? "danger" : audit || incomplete || unknown ? "warning" : "neutral", lines);
}
