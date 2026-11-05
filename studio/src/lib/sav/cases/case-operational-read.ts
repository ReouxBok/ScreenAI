// SAV-10 (pole C), C9: the READ-ONLY operational state of ONE prepared reply and of the effects of its execution, for the Studio (UX owns the words, this owns what they may truthfully say).
// Contract: `review-operator-gaps/CONTRACT_C_UX.md`. It decides, proposes, approves, plans, marks, resets and resends NOTHING. Not wired to any route, page or credential.
//   - `access` is a server-side callback of the CALLER's context (the page's staff check, injected). Absent, failing or anything but `true` it DENIES, and it is awaited BEFORE any SQL.
//   - ONE repeatable-read, read-only transaction: no lock, no write, no format upgrade. The validation is selected by id AND case; the parent by the id that row names AND the same case
//     AND the same reply key; the effects by that parent only, restricted to the three closed kinds.
//   - NOTHING IS DECRYPTED. The columns read are plain (ids, states, dates, counters, ledger keys); no ciphertext column is selected. The effects' keys are checked against the canonical
//     keys (`caseReplyKey` from the stored validation, `caseNoteKey` / `caseNoteAssociationKey` of the same case and the same interaction), so an unexpected effect never enters the answer.
//   - The answer is a CLOSED object: no text, recipient, subject, body, MIME, token or CRM identifier. A source that cannot be read is `unavailable`, an inconsistency is `unknown` /
//     `auditRequired`, never an empty list.
//   - "needs a person" is `classifyEffectVerification` (`case-effect-verification.ts`), the scheduler's rule; the limit is handed over as `verificationLimit`, never repeated by the UI.
//   - `no_recorded_note_effect` means "no note step is recorded in the ledger". It does NOT mean "no note was requested" (the sealed payload is not read, on purpose) and says nothing about HubSpot.
import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffects } from "@/db/schema";
import { caseNoteAssociationKey, caseNoteKey } from "./case-effects";
import { CASE_VERIFICATION_READ_LIMIT, classifyEffectVerification, verificationStillScheduled, type CaseVerificationVerdict } from "./case-effect-verification";
import { savCaseReplyValidations } from "./case-reply-validation-table";

export const CASE_OPERATIONAL_READ_SCHEMA = "sav-v2-case-operational-read.v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PART = /^[A-Za-z0-9._@<>=+:-]{1,200}$/;
const REASON = /^SAV_CASE_EFFECT_[A-Z0-9_]{1,120}$/;
/** More rows than this under one parent is not a normal parent (a reply and one note = 3 rows): the read is reported incomplete. */
const EFFECT_ROWS_MAX = 20;

const VALIDATION_STATES = ["proposed", "approved", "declined", "revoked", "superseded"] as const;
const PARENT_STATES = ["pending", "running", "waiting", "uncertain", "confirmed", "refused"] as const;
const EFFECT_STATES = ["planned", "dispatched", "acked", "uncertain", "confirmed"] as const;
const EFFECT_KINDS = ["reply_send", "note_create", "note_associate"] as const;
export type CaseOperationalEffectKind = typeof EFFECT_KINDS[number];
export type CaseOperationalEffectState = typeof EFFECT_STATES[number];
export type CaseOperationalIncomplete = "parent_unreadable" | "unexpected_effect" | "duplicate_effect" | "note_pair_inconsistent" | "too_many_effects" | "contradiction" | "unreadable_value";

export type CaseOperationalEffect = Readonly<{
  kind: CaseOperationalEffectKind;
  state: CaseOperationalEffectState;
  dispatchedAt: string | null;
  confirmedAt: string | null;
  /** Shown only while a verification is really scheduled (engaged, marker, parent open, under the limit). An old date left on any other effect is not a schedule. */
  nextVerificationAt: string | null;
  reconcileAttempts: number;
  verification: Readonly<{ needsPerson: boolean; reason: "verification_limit" | null; audit: "none" | "needs_audit" }>;
}>;

export type CaseOperationalReplyStatus = "no_recorded_effect" | CaseOperationalEffectState | "unknown";
export type CaseOperationalNoteStatus = "no_recorded_note_effect" | "creation_pending" | "creation_uncertain" | "created_association_pending" | "association_uncertain" | "confirmed" | "unknown";

export type CaseOperationalView = Readonly<{
  schemaRevision: typeof CASE_OPERATIONAL_READ_SCHEMA;
  /** The instant of the read (server clock). It is NOT the freshness of the mail provider or of the CRM. */
  observedAt: string;
  caseId: string;
  validationId: string;
  validation: typeof VALIDATION_STATES[number] | "unknown";
  /** `null` when the validation was never queued. */
  parent: Readonly<{ state: typeof PARENT_STATES[number] | "unknown"; reason: string | null }> | null;
  /** The backend's limit of verification reads, so that no UI repeats the number. */
  verificationLimit: number;
  reply: Readonly<{ status: CaseOperationalReplyStatus; effect: CaseOperationalEffect | null }>;
  note: Readonly<{ status: CaseOperationalNoteStatus; create: CaseOperationalEffect | null; associate: CaseOperationalEffect | null }>;
  /** Any effect of the reply or of the note has reached the limit of verification reads with its parent still open: a person must look. Nothing resends or resets. */
  needsPerson: boolean;
  /** Rows that contradict each other (see `incomplete`): reported, never repaired. */
  auditRequired: boolean;
  /** `false` when any part of the read could not be trusted. The parts that could not are `unknown`, never absent. */
  complete: boolean;
  incomplete: readonly CaseOperationalIncomplete[];
}>;

export type CaseOperationalReadResult =
  | Readonly<{ ok: true; view: CaseOperationalView }>
  | Readonly<{ ok: false; code: "access_denied" | "invalid_input" | "not_found" | "unavailable" }>;

export type CaseOperationalAccess = () => Promise<boolean> | boolean;
export type CaseOperationalReadDeps = Readonly<{
  /** Server-side check of the CALLER's context (the page's staff check). Absent, throwing or anything but `true` denies. Never a value taken from a request. */
  access?: CaseOperationalAccess | undefined;
  now?: (() => Date) | undefined;
}>;

const iso = (value: Date | null | undefined) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : null;

type EffectRow = Readonly<{
  kind: string; businessKey: string; state: string; dispatchedAt: Date | null; confirmedAt: Date | null; nextReconcileAt: Date | null; reconcileAttempts: number;
}>;

function project(row: EffectRow, parentState: string, flags: Set<CaseOperationalIncomplete>): CaseOperationalEffect | null {
  const kind = oneOf(EFFECT_KINDS, row.kind), state = oneOf(EFFECT_STATES, row.state);
  const verdict: CaseVerificationVerdict = classifyEffectVerification({ executionState: parentState, effectState: row.state, dispatchedAt: row.dispatchedAt, reconcileAttempts: row.reconcileAttempts });
  if (!kind || !state || verdict === "unreadable") { flags.add("unreadable_value"); return null; }
  if (verdict === "needs_audit") flags.add("contradiction");
  const scheduled = verificationStillScheduled({ executionState: parentState, effectState: row.state, dispatchedAt: row.dispatchedAt, reconcileAttempts: row.reconcileAttempts });
  return {
    kind, state, dispatchedAt: iso(row.dispatchedAt), confirmedAt: iso(row.confirmedAt), nextVerificationAt: scheduled ? iso(row.nextReconcileAt) : null,
    reconcileAttempts: row.reconcileAttempts,
    verification: { needsPerson: verdict === "needs_person", reason: verdict === "needs_person" ? "verification_limit" : null, audit: verdict === "needs_audit" ? "needs_audit" : "none" },
  };
}

const ENGAGED = ["dispatched", "acked", "uncertain"];
function noteStatus(create: CaseOperationalEffect | null, associate: CaseOperationalEffect | null, trusted: boolean): CaseOperationalNoteStatus {
  if (!trusted) return "unknown";
  if (!create && !associate) return "no_recorded_note_effect";
  if (!create) return "unknown"; // an association with no creation is not a state this ledger can produce
  if (create.verification.audit === "needs_audit" || associate?.verification.audit === "needs_audit") return "unknown";
  if (create.state === "planned") return associate ? "unknown" : "creation_pending";
  if (ENGAGED.includes(create.state)) return associate ? "unknown" : "creation_uncertain";
  // creation confirmed
  if (!associate || associate.state === "planned") return "created_association_pending";
  if (ENGAGED.includes(associate.state)) return "association_uncertain";
  return "confirmed";
}

/**
 * One reply and its effects. `caseId` is REQUIRED: a reply of another case answers `not_found` before its effects are even selected.
 * The caller's `access` is awaited BEFORE any SQL; the input shape is judged after it (a denied caller learns nothing, not even the shape rule).
 */
export async function readCaseReplyOperationalState(input: Readonly<{ caseId: string; validationId: string }>, deps: CaseOperationalReadDeps = {}): Promise<CaseOperationalReadResult> {
  let allowed = false;
  try { allowed = deps.access ? await deps.access() === true : false; } catch { allowed = false; }
  if (!allowed) return { ok: false, code: "access_denied" };
  const caseId = typeof input?.caseId === "string" ? input.caseId : "", validationId = typeof input?.validationId === "string" ? input.validationId : "";
  if (!UUID.test(caseId) || !UUID.test(validationId)) return { ok: false, code: "invalid_input" };
  const wantedCase = caseId.toLowerCase(), wantedValidation = validationId.toLowerCase();
  try {
    const observedAt = (deps.now ?? (() => new Date()))();
    return await requireDb().transaction(async (tx): Promise<CaseOperationalReadResult> => {
      const v = savCaseReplyValidations;
      const [validation] = await tx.select({ id: v.id, caseId: v.caseId, replyKey: v.replyKey, state: v.state, executionId: v.executionId })
        .from(v).where(and(eq(v.id, wantedValidation), eq(v.caseId, wantedCase)));
      if (!validation) return { ok: false, code: "not_found" };
      const flags = new Set<CaseOperationalIncomplete>();
      const base = { schemaRevision: CASE_OPERATIONAL_READ_SCHEMA, observedAt: observedAt.toISOString(), caseId: wantedCase, validationId: wantedValidation, verificationLimit: CASE_VERIFICATION_READ_LIMIT } as const;
      const validationState = oneOf(VALIDATION_STATES, validation.state) ?? "unknown";
      if (validationState === "unknown") flags.add("unreadable_value");
      const finish = (parent: CaseOperationalView["parent"], reply: CaseOperationalView["reply"], note: CaseOperationalView["note"], needsPerson: boolean): CaseOperationalReadResult => ({
        ok: true, view: {
          ...base, validation: validationState, parent, reply, note, needsPerson, auditRequired: flags.has("contradiction"), complete: flags.size === 0, incomplete: [...flags],
        },
      });
      const noEffect = { status: "no_recorded_effect" as const, effect: null };
      const noNote = { status: "no_recorded_note_effect" as const, create: null, associate: null };
      if (!validation.executionId) return finish(null, noEffect, noNote, false);

      const e = savCaseEffectExecutions;
      const [parent] = await tx.select({ id: e.id, caseId: e.caseId, replyKey: e.replyKey, state: e.state, reason: e.reason }).from(e)
        .where(and(eq(e.id, validation.executionId), eq(e.caseId, wantedCase)));
      const parentState = parent ? oneOf(PARENT_STATES, parent.state) : null;
      // The parent is named by the validation row; it must be of the same case and of the same reply key, or nothing it owns is read.
      if (!parent || parent.replyKey !== validation.replyKey || !parentState) {
        flags.add("parent_unreadable");
        return finish({ state: "unknown", reason: null }, { status: "unknown", effect: null }, { status: "unknown", create: null, associate: null }, false);
      }
      const reason = typeof parent.reason === "string" && REASON.test(parent.reason) ? parent.reason : null;

      const f = savIntakeEffects;
      const rows = await tx.select({ kind: f.kind, businessKey: f.businessKey, state: f.state, dispatchedAt: f.dispatchedAt, confirmedAt: f.confirmedAt, nextReconcileAt: f.nextReconcileAt, reconcileAttempts: f.reconcileAttempts })
        .from(f).where(and(eq(f.executionId, parent.id), inArray(f.kind, [...EFFECT_KINDS]))).orderBy(asc(f.createdAt), asc(f.id)).limit(EFFECT_ROWS_MAX + 1);
      if (rows.length > EFFECT_ROWS_MAX) flags.add("too_many_effects");

      // Canonical keys only. The reply key is the validation's own; the note keys are those of THIS case and ONE interaction.
      const slot: { reply?: EffectRow; create?: EffectRow; associate?: EffectRow } = {};
      const notePrefix = caseNoteKey(wantedCase, "x").slice(0, -1), assocPrefix = caseNoteAssociationKey(wantedCase, "x").slice(0, -1);
      let interaction: string | null = null;
      const claim = (name: "reply" | "create" | "associate", row: EffectRow) => { if (slot[name]) flags.add("duplicate_effect"); else slot[name] = row; };
      for (const row of rows.slice(0, EFFECT_ROWS_MAX)) {
        if (row.kind === "reply_send" && row.businessKey === validation.replyKey) { claim("reply", row); continue; }
        const isCreate = row.kind === "note_create" && row.businessKey.startsWith(notePrefix), isAssociate = row.kind === "note_associate" && row.businessKey.startsWith(assocPrefix);
        if (isCreate || isAssociate) {
          const part = row.businessKey.slice((isCreate ? notePrefix : assocPrefix).length);
          if (ID_PART.test(part) && (isCreate ? caseNoteKey(wantedCase, part) : caseNoteAssociationKey(wantedCase, part)) === row.businessKey) {
            if (interaction !== null && interaction !== part) flags.add("note_pair_inconsistent"); else interaction = part;
            claim(isCreate ? "create" : "associate", row);
            continue;
          }
        }
        flags.add("unexpected_effect"); // a key that is not the canonical one of this reply or of one note of this case: never shown
      }

      const reply = slot.reply ? project(slot.reply, parentState, flags) : null;
      const create = slot.create ? project(slot.create, parentState, flags) : null;
      const associate = slot.associate ? project(slot.associate, parentState, flags) : null;
      // A note pair is trusted only if both rows (when present) are readable and the pair belongs to one interaction.
      const noteTrusted = !flags.has("note_pair_inconsistent") && !flags.has("too_many_effects") && !flags.has("unreadable_value") && !(slot.create && !create) && !(slot.associate && !associate);
      const replyTrusted = !flags.has("too_many_effects") && !(reply?.verification.audit === "needs_audit");
      const needsPerson = [reply, create, associate].some(effect => effect?.verification.needsPerson === true);
      return finish(
        { state: parentState, reason },
        reply === null ? (slot.reply ? { status: "unknown", effect: null } : noEffect) : { status: replyTrusted ? reply.state : "unknown", effect: reply },
        { status: noteStatus(create, associate, noteTrusted), create, associate },
        needsPerson,
      );
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch {
    // A database that cannot be read is an incomplete read, never an empty answer. No error text leaves this function.
    return { ok: false, code: "unavailable" };
  }
}
