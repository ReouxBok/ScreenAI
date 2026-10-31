import { createHash } from "node:crypto";
import { z } from "zod";
import type { EngineInput, IntakePlan, ReadResult } from "./engine-types";
import type { IntakeDispatchDiagnostic } from "./model-dispatch";
import type { IntakeValidatedEvidence } from "./model-readers";

/** Private qualification receipt of the separate reader comparison (SAV-46). It keeps what an
 * independent, pre-frozen oracle needs to be confronted with: the common source and CRM capture
 * both readers were served, each reader's accepted answers before they lose quotes and mappings,
 * the complete canonical plan and the intentions derived from it. It is evidence, not a verdict:
 * `identical` stays a projection equality and only an explicit human attestation qualifies. */
export const SAV_READER_EVIDENCE_VERSION = "reader-qualification-evidence.v1";
/** The receipt is hashed as the UTF-8 bytes of JSON.stringify of the stored object. */
export const SAV_READER_EVIDENCE_SERIALIZATION = "json-stringify-utf8.v1";
/** Exactly the comparison's existing frozen CRM hash: sha256 of JSON [key, status|"error", data|null]
 * in the stored entry order (keys sorted when frozen). observedAt is kept but NOT covered by it. */
export const SAV_FROZEN_CRM_HASH_RECIPE = "frozen-crm-key-status-data-sha256.v1";
/** Intentions derived from the plan and the frozen CRM baseline, never executed payloads. */
export const SAV_MUTATION_EXPECTATIONS_REVISION = "intake-mutation-expectations.v1";
const MiB = 1024 * 1024;
export const SAV_READER_EVIDENCE_LIMITS = { commonBytes: 4 * MiB, sideBytes: MiB, totalBytes: 6 * MiB,
  // aes-256-gcm stored as version.iv.tag.base64url(ciphertext)
  ciphertextBytes: Math.ceil(6 * MiB * 4 / 3) + 256 } as const;
/** Informational mirror of the live transport rule (gemini-transport): one attempt may last 18 s, or
 * 37 s above 128 KiB of text. A comparison measurement never proves the production envelope. */
const PRODUCTION_LARGE_TEXT_BYTES = 128 * 1024, PRODUCTION_ATTEMPT_MS = 18_000, PRODUCTION_LARGE_ATTEMPT_MS = 37_000;

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const jsonSha = (value: unknown) => sha256(JSON.stringify(value));

const OVER = Symbol("over");
/** UTF-8 size of JSON.stringify(value), counted without building the whole string, stopping as soon as
 * it exceeds `limit` (null). Plain JSON data only, as the receipts contain. */
export function savBoundedJsonBytes(value: unknown, limit: number): number | null {
  let total = 0;
  const add = (bytes: number) => { total += bytes; if (total > limit) throw OVER; };
  const emitted = (v: unknown) => v !== undefined && typeof v !== "function" && typeof v !== "symbol";
  const visit = (input: unknown, depth: number): void => {
    if (depth > 200) throw TypeError("SAV_INTAKE_COMPARISON_EVIDENCE_DEPTH");
    const v = input && typeof input === "object" && typeof (input as { toJSON?: unknown }).toJSON === "function" ? (input as { toJSON(): unknown }).toJSON() : input;
    if (v === null || !emitted(v)) { add(4); return; }
    if (typeof v === "string") { add(Buffer.byteLength(JSON.stringify(v), "utf8")); return; }
    if (typeof v === "number") { add(Number.isFinite(v) ? String(v).length : 4); return; }
    if (typeof v === "boolean") { add(v ? 4 : 5); return; }
    if (typeof v === "bigint") throw TypeError("SAV_INTAKE_COMPARISON_EVIDENCE_TYPE");
    if (Array.isArray(v)) {
      add(2 + Math.max(0, v.length - 1));
      for (const item of v) visit(item, depth + 1);
      return;
    }
    let first = true; add(2);
    for (const key of Object.keys(v as object)) {
      const child = (v as Record<string, unknown>)[key];
      const resolved = child && typeof child === "object" && typeof (child as { toJSON?: unknown }).toJSON === "function" ? (child as { toJSON(): unknown }).toJSON() : child;
      if (!emitted(resolved)) continue;
      add((first ? 0 : 1) + Buffer.byteLength(JSON.stringify(key), "utf8") + 1); first = false;
      visit(resolved, depth + 1);
    }
  };
  try { visit(value, 0); return total; }
  catch (error) { if (error === OVER) return null; throw error; }
}

export type FrozenCrmEntry = { key: string; outcome: "resolved"; status: ReadResult<unknown>["status"]; data: unknown; observedAt: string; reconstructedAsOf?: string }
  | { key: string; outcome: "rejected" };
/** The recipe above; one implementation for the comparison's freeze and for recomputation. */
export function savFrozenCrmHash(entries: readonly FrozenCrmEntry[]) {
  return jsonSha(entries.map(e => [e.key, e.outcome === "resolved" ? e.status ?? "error" : "error", e.outcome === "resolved" ? e.data ?? null : null]));
}
export const savComparisonSnapshotHash = (sourceHash: string, crmHash: string) => jsonSha([sourceHash, crmHash]);

const kindOf = (key: string) => key.split(":")[0];
/** Codes only (no identifier, no text): what the frozen capture could not establish. */
export function frozenCrmGaps(entries: readonly FrozenCrmEntry[]) {
  return [...new Set(entries.flatMap(e => e.outcome === "rejected" ? [`crm_rejected:${kindOf(e.key)}`] : e.status !== "complete" ? [`crm_${e.status}:${kindOf(e.key)}`] : []))].sort();
}

type Provenance = ReadonlyMap<string, unknown>;
/** One common block both readers point to: the engine input (current text, conversation, operator
 * information, continuation), the per-message provenance (subject, current/quoted/signature parts),
 * the attachment inventory status and the frozen CRM entries. No MIME, headers, images or HTML. */
export function comparisonCommonEvidence(input: { sourceHash: string; messageSourceHash: string; engineInput: EngineInput; provenance: Provenance;
  attachments: { count: number; inventoryComplete: boolean | null }; crm: { hash: string; entries: readonly FrozenCrmEntry[] } }) {
  const gaps = [...(input.engineInput.conversation.status !== "complete" ? [`conversation_${input.engineInput.conversation.status}`] : []), ...frozenCrmGaps(input.crm.entries)];
  return { status: gaps.length ? "incomplete" as const : "complete" as const, criteriaMissing: gaps,
    source: { sourceHash: input.sourceHash, messageSourceHash: input.messageSourceHash, engineInput: input.engineInput,
      provenance: [...input.provenance].map(([messageId, value]) => ({ messageId, value })), attachments: input.attachments },
    crm: { recipe: SAV_FROZEN_CRM_HASH_RECIPE, hash: input.crm.hash, entries: input.crm.entries } };
}
export type ComparisonCommonEvidence = ReturnType<typeof comparisonCommonEvidence>;

/** The engine's owner baseline is the frozen CRM ticket record, never a model output. */
export function frozenTicketOwner(entries: readonly FrozenCrmEntry[], ticketId: string) {
  for (const entry of entries) {
    if (entry.outcome !== "resolved" || entry.status !== "complete" || kindOf(entry.key) !== "tickets" || !Array.isArray(entry.data)) continue;
    const ticket = (entry.data as { id?: unknown; ownerId?: unknown }[]).find(t => t?.id === ticketId);
    // Optional field: absent is unknown, null is an observed "unassigned".
    if (ticket) return ticket.ownerId === undefined ? { status: "not_observed" as const, sourceKey: entry.key }
      : { status: "observed" as const, ownerId: ticket.ownerId as string | null, sourceKey: entry.key, observedAt: entry.observedAt };
  }
  return { status: "not_observed" as const, sourceKey: null };
}

/** Intentions the plan commits to, versioned and derived, kept apart from what an executor would send:
 * no executor, CRM, Gmail or operation ledger is called. A ticket creation's description is the stored
 * original email (SAV-72), shown separately from the planner's own description. */
export function intakeMutationExpectations(plan: IntakePlan, crm: readonly FrozenCrmEntry[], descriptionFromOriginalMail: (plannerDescription: string) => string) {
  const d = plan.decision.disposition, target = d.kind === "ticket" ? d.target : null;
  const finalTicket = (step: IntakePlan["steps"][number]) => step.ticketId ?? (target && target.operation !== "create" ? target.ticketId : "created_ticket");
  const missing: string[] = [];
  const items = plan.steps.map(step => {
    switch (step.mutation) {
      case "create_ticket": {
        if (!plan.newTicket) { missing.push("creation_intent_missing"); return { mutation: step.mutation, intent: null }; }
        return { mutation: step.mutation, contactId: plan.newTicket.contactId, title: plan.newTicket.title, pipeline: plan.newTicket.pipeline, stage: plan.newTicket.stage,
          source: plan.newTicket.source, owner: plan.newTicket.owner, requestIds: plan.newTicket.requestIds,
          description: { origin: "stored_original_mail_sav72", excludesStudioMarker: true, text: descriptionFromOriginalMail(plan.newTicket.description) },
          plannerDescription: { origin: "plan_intent_not_sent", text: plan.newTicket.description } };
      }
      case "set_ticket_new": {
        const ticketId = finalTicket(step), baseline = ticketId === "created_ticket" ? { status: "not_observed" as const, sourceKey: null } : frozenTicketOwner(crm, ticketId);
        if (baseline.status !== "observed") missing.push("owner_baseline_not_observed");
        return { mutation: step.mutation, ticketId, stage: "new", ownerPolicy: "preserve_stage_only_patch",
          ...(target?.operation === "reopen" ? { planPreserveOwnerId: target.preserveOwnerId } : {}), ownerBaseline: baseline };
      }
      case "append_ticket_note":
        if (plan.noteText === null) missing.push("note_text_missing");
        return { mutation: step.mutation, ticketId: finalTicket(step), noteText: plan.noteText, deduplication: "source_message_and_final_ticket" };
      case "associate_email":
        return { mutation: step.mutation, ticketId: finalTicket(step), messageId: plan.decision.messageId, direction: "email_to_ticket" };
      case "link_ticket":
        return { mutation: step.mutation, ticketId: finalTicket(step), contactId: target?.contactId ?? null, alreadyNew: target?.operation === "link" ? target.alreadyNew : null };
      case "send_identity_template":
        return { mutation: step.mutation, template: d.kind === "request_identification" ? { resourceId: d.template.resourceId, revisionId: d.template.revisionId, variant: d.template.variant } : null,
          recipient: "original_sender_original_thread", originalThreadId: plan.originalThreadId };
      default:
        missing.push("mutation_unsupported"); return { mutation: step.mutation, intent: null };
    }
  });
  return { revision: SAV_MUTATION_EXPECTATIONS_REVISION, nature: "derived_intentions_not_executed_payloads" as const, items, criteriaMissing: [...new Set(missing)].sort() };
}

export type SemanticCallRecord = { order: number; method: "analyseMessage" | "assessIssues" | "assessIdentity"; input: Record<string, unknown>;
  status: "started" | "returned" | "failed"; output?: unknown; errorCode?: string };
type Side = "current" | "simple";
const NOT_PRODUCED: Record<Side, string[]> = {
  // Reader design, not a capture gap: listed so a reviewer never assumes them.
  current: ["request_summary_per_request"],
  simple: ["request_verbatim_quote", "ticket_grounding_quotes"],
};
/** Drops derived image text the comparison never loads and keeps the rest of the accepted answer. */
const withoutImages = (evidence: IntakeValidatedEvidence): IntakeValidatedEvidence => {
  if (!evidence.value || typeof evidence.value !== "object") return evidence;
  const { images, attachmentObservations, ...value } = evidence.value as Record<string, unknown>; void images; void attachmentObservations;
  return { ...evidence, value };
};
/** Every semantic answer the engine consumed must have its accepted, pre-loss copy. */
function validatedGaps(side: Side, calls: readonly SemanticCallRecord[], validated: readonly IntakeValidatedEvidence[]) {
  const gaps: string[] = [];
  for (const call of calls) {
    if (call.status !== "returned") continue;
    // A consumed grouped answer needs an accepted copy for EVERY ticket it was asked about (both
    // readers reject an answer that does not cover each ticket, so a gap is a lost copy).
    const ticketsOf = (kinds: readonly IntakeValidatedEvidence["kind"][]) =>
      new Set(validated.filter(v => kinds.includes(v.kind)).flatMap(v => ((v.value as { tickets?: { ticketId?: unknown }[] } | null)?.tickets ?? []).map(t => t?.ticketId)));
    const asked = (call.input.ticketIds as string[] | undefined) ?? [];
    if (side === "current") {
      const judged = ticketsOf(["issues"]);
      const ok = call.method === "analyseMessage" ? validated.some(v => v.kind === "analysis")
        : call.method === "assessIssues" ? asked.every(id => judged.has(id)) : validated.some(v => v.kind === "identity");
      if (!ok) gaps.push(`validated_evidence_missing:${call.method}`);
    } else {
      const judged = ticketsOf(["judgement"]);
      const ok = call.method === "analyseMessage" ? validated.some(v => v.phase === "understanding")
        : call.method === "assessIssues" ? asked.every(id => judged.has(id)) : validated.length > 0;
      if (!ok) gaps.push(`validated_evidence_missing:${call.method}`);
    }
  }
  return gaps;
}
/** Per-request transport, plus the side's own wall time; cumulative and largest wire text visible. */
export function comparisonSideTiming(input: { startedAt: string; wallMs: number; requests: readonly IntakeDispatchDiagnostic[] }) {
  const requests = input.requests.map(r => ({ phase: r.phase, textBytes: r.textBytes, wireBytes: r.wireBytes, dispatched: r.dispatched, httpStatus: r.httpStatus,
    transportMs: r.transport?.durationMs ?? null, attempts: r.transport?.attempts ?? null, retries: r.transport?.retries ?? null,
    productionAttemptMs: r.textBytes > PRODUCTION_LARGE_TEXT_BYTES ? PRODUCTION_LARGE_ATTEMPT_MS : PRODUCTION_ATTEMPT_MS }));
  return { clock: "monotonic_ms" as const, startedAt: input.startedAt, wallMs: input.wallMs, requests,
    cumulativeTransportMs: requests.reduce((sum, r) => sum + (r.transportMs ?? 0), 0), largestTextBytes: Math.max(0, ...requests.map(r => r.textBytes)),
    scope: "comparison_measurement_not_production_envelope" as const };
}
export function comparisonSideEvidence(input: { side: Side; readerRevision: string; plan: IntakePlan | null; technical: string | null; uncertain: boolean;
  semanticCalls: readonly SemanticCallRecord[]; validated: readonly IntakeValidatedEvidence[]; timing: ReturnType<typeof comparisonSideTiming>;
  expectations: ReturnType<typeof intakeMutationExpectations> | null }) {
  const gaps = [...(input.technical ? [`side_technical:${input.technical}`] : []), ...(input.uncertain ? ["side_uncertain"] : []),
    ...(input.plan ? [] : ["plan_missing"]), ...validatedGaps(input.side, input.semanticCalls, input.validated), ...(input.expectations?.criteriaMissing ?? [])];
  return { side: input.side, status: gaps.length ? "incomplete" as const : "complete" as const, criteriaMissing: [...new Set(gaps)], notProducedByReader: NOT_PRODUCED[input.side],
    readerRevision: input.readerRevision, technical: input.technical, uncertain: input.uncertain, plan: input.plan,
    semanticCalls: input.semanticCalls, validated: input.validated.map(withoutImages), mutationExpectations: input.expectations, timing: input.timing };
}
export type ComparisonSideEvidence = ReturnType<typeof comparisonSideEvidence>;

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const partStatus = z.enum(["complete", "incomplete", "oversize", "not_available"]);
/** Small, code-only description of a receipt, stored inside the encrypted result payload. */
export const readerEvidenceManifestSchema = z.object({
  version: z.literal(SAV_READER_EVIDENCE_VERSION), status: partStatus, qualifiedSide: z.literal("simple"),
  binding: z.object({ campaignId: z.string().regex(/^[a-z0-9-]{1,64}$/), messageId: z.uuid(), claimId: z.uuid() }).strict(),
  receiptSha256: hex64.nullable(), stored: z.boolean(),
  parts: z.object({ common: partStatus, current: partStatus, simple: partStatus }).strict(),
  bytes: z.object({ common: z.number().int().nonnegative().nullable(), current: z.number().int().nonnegative().nullable(), simple: z.number().int().nonnegative().nullable(),
    total: z.number().int().nonnegative().nullable(), ciphertext: z.number().int().nonnegative().nullable() }).strict(),
  criteriaMissing: z.array(z.string().regex(/^[a-z0-9_]+(?::[A-Za-z0-9_]+)?$/)).max(100),
  timing: z.object({ commonPreparationMs: z.number().nonnegative().nullable(), evidenceSerializationMs: z.number().nonnegative().nullable(), encryptionMs: z.number().nonnegative().nullable() }).strict(),
}).strict().superRefine((m, ctx) => {
  if (m.status === "complete" && (!m.receiptSha256 || !m.stored || m.parts.common !== "complete" || m.parts.simple !== "complete" || m.criteriaMissing.length))
    ctx.addIssue({ code: "custom", message: "SAV_INTAKE_COMPARISON_EVIDENCE_INCONSISTENT" });
});
export type ReaderEvidenceManifest = z.infer<typeof readerEvidenceManifestSchema>;
type Binding = ReaderEvidenceManifest["binding"];
/** Identifiers and codes are stripped from the manifest; the receipt keeps the identifiers. */
const code = (value: string) => value.split(":").slice(0, 2).map((part, i) => i === 0 ? part.toLowerCase().replace(/[^a-z0-9_]/g, "_") || "x" : /^[A-Za-z0-9_]+$/.test(part) ? part : "x").join(":");
const sameBinding = (a: Binding, b: Binding) => a.campaignId === b.campaignId && a.messageId === b.messageId && a.claimId === b.claimId;

export type ReaderEvidenceIdentity = { campaignId: string; messageId: string; claimId: string; comparisonRevision: string; codeRevision: string;
  readerRevisions: { current: string; simple: string }; engineRevision: string; model: string; runtimeConfigHash: string; enginePolicyHash: string; resourcesHash: string;
  otherCatalogue: { resourceId: string; revisionId: string; sha256: string; expiresAt: string } | null };
/** Not available: nothing was captured (message missing, configuration refused). */
export function unavailableReaderEvidence(binding: Binding, criteria: string[]) {
  return { receipt: null, manifest: readerEvidenceManifestSchema.parse({ version: SAV_READER_EVIDENCE_VERSION, status: "not_available", qualifiedSide: "simple", binding,
    receiptSha256: null, stored: false, parts: { common: "not_available", current: "not_available", simple: "not_available" },
    bytes: { common: null, current: null, simple: null, total: null, ciphertext: null }, criteriaMissing: [...new Set(criteria.map(code))].slice(0, 100),
    timing: { commonPreparationMs: null, evidenceSerializationMs: null, encryptionMs: null } }) };
}
/** The common capture exceeds its bound: refused before any model call, never truncated. */
export function commonOversizeReaderEvidence(binding: Binding, commonPreparationMs: number) {
  const { manifest } = unavailableReaderEvidence(binding, ["evidence_common_oversize"]);
  return { receipt: null, manifest: { ...manifest, status: "oversize" as const, parts: { ...manifest.parts, common: "oversize" as const }, timing: { ...manifest.timing, commonPreparationMs } } };
}

/** Assembles and bounds the receipt. An oversize part is replaced by a stub (status and limit, no
 * content); a receipt above the total bound is not stored at all. Never a silent truncation. */
export function assembleReaderEvidence(input: { identity: ReaderEvidenceIdentity; common: ComparisonCommonEvidence; sides: { current: ComparisonSideEvidence; simple: ComparisonSideEvidence };
  crmUse: { served: string[]; misses: string[]; failedUsed: string[]; immutable: boolean }; snapshotHash: string; commonPreparationMs: number; clock: () => number }) {
  const started = input.clock(), L = SAV_READER_EVIDENCE_LIMITS;
  const binding = { campaignId: input.identity.campaignId, messageId: input.identity.messageId, claimId: input.identity.claimId };
  const commonBytes = savBoundedJsonBytes(input.common, L.commonBytes);
  const sized = (side: ComparisonSideEvidence) => { const bytes = savBoundedJsonBytes(side, L.sideBytes); return bytes === null
    ? { bytes: null, part: { side: side.side, status: "oversize" as const, limitBytes: L.sideBytes }, status: "oversize" as const } : { bytes, part: side, status: side.status }; };
  const current = sized(input.sides.current), simple = sized(input.sides.simple);
  const crmGaps = [...input.crmUse.misses.map(key => `crm_not_captured:${kindOf(key)}`), ...input.crmUse.failedUsed, ...(input.crmUse.immutable ? [] : ["crm_snapshot_mutated"])];
  const criteria = [...new Set([...input.common.criteriaMissing, ...crmGaps, ...(simple.status === "oversize" ? ["evidence_side_oversize:simple"] : input.sides.simple.criteriaMissing)].map(code))].slice(0, 100);
  const oversize = commonBytes === null || current.status === "oversize" || simple.status === "oversize";
  const status = oversize ? "oversize" as const : criteria.length || input.common.status !== "complete" || simple.status !== "complete" ? "incomplete" as const : "complete" as const;
  const receipt = { version: SAV_READER_EVIDENCE_VERSION, serialization: SAV_READER_EVIDENCE_SERIALIZATION, mode: "comparison_no_execution" as const, status, qualifiedSide: "simple" as const,
    identity: input.identity,
    hashes: { sourceHash: input.common.source.sourceHash, crmHash: input.common.crm.hash, snapshotHash: input.snapshotHash,
      common: commonBytes === null ? null : jsonSha(input.common), current: current.bytes === null ? null : jsonSha(current.part), simple: simple.bytes === null ? null : jsonSha(simple.part) },
    common: commonBytes === null ? { status: "oversize" as const, limitBytes: L.commonBytes } : input.common,
    sides: { current: current.part, simple: simple.part }, crmUse: input.crmUse, criteriaMissing: criteria,
    // Projection equality is reported elsewhere; it is never a business verdict.
    qualification: { verdict: null, requires: "human_attestation_against_frozen_oracle" as const } };
  const total = savBoundedJsonBytes(receipt, L.totalBytes);
  const text = total === null ? null : JSON.stringify(receipt);
  const evidenceSerializationMs = Math.max(0, input.clock() - started);
  const stored = text !== null;
  const manifest = readerEvidenceManifestSchema.parse({ version: SAV_READER_EVIDENCE_VERSION, status: stored ? status : "oversize", qualifiedSide: "simple", binding,
    receiptSha256: text === null ? null : sha256(text), stored,
    parts: { common: commonBytes === null ? "oversize" : input.common.status, current: current.status, simple: simple.status },
    bytes: { common: commonBytes, current: current.bytes, simple: simple.bytes, total: text === null ? null : Buffer.byteLength(text, "utf8"), ciphertext: null },
    criteriaMissing: stored ? criteria : [...new Set([...criteria, "evidence_total_oversize"])].slice(0, 100),
    timing: { commonPreparationMs: input.commonPreparationMs, evidenceSerializationMs, encryptionMs: null } });
  return { receipt: stored ? receipt : null, manifest };
}
/** After encryption: an over-bound ciphertext is not stored either. */
export function boundReaderEvidenceCiphertext(manifest: ReaderEvidenceManifest, ciphertextBytes: number, encryptionMs: number): { manifest: ReaderEvidenceManifest; keep: boolean } {
  const timing = { ...manifest.timing, encryptionMs };
  if (ciphertextBytes <= SAV_READER_EVIDENCE_LIMITS.ciphertextBytes) return { keep: true, manifest: { ...manifest, timing, bytes: { ...manifest.bytes, ciphertext: ciphertextBytes } } };
  return { keep: false, manifest: { ...manifest, timing, status: "oversize", stored: false, bytes: { ...manifest.bytes, ciphertext: ciphertextBytes },
    criteriaMissing: [...new Set([...manifest.criteriaMissing, "evidence_ciphertext_oversize"])].slice(0, 100) } };
}

export type ReaderEvidenceQualification = "complete" | "incomplete" | "oversize" | "not_available" | "legacy" | "invalid";
/** What a list row may claim without decrypting the receipt. A result written before v1 is legacy:
 * readable, never qualifiable, never backfilled from its summary. */
export function readerEvidenceQualification(detail: unknown, binding: Binding | null): ReaderEvidenceQualification {
  if (!detail || typeof detail !== "object") return "invalid";
  if (!Object.hasOwn(detail, "evidence")) return "legacy";
  const parsed = readerEvidenceManifestSchema.safeParse((detail as { evidence: unknown }).evidence);
  if (!parsed.success || !binding || !sameBinding(parsed.data.binding, binding)) return "invalid";
  return parsed.data.status;
}

const receiptSchema = z.object({ version: z.literal(SAV_READER_EVIDENCE_VERSION), serialization: z.literal(SAV_READER_EVIDENCE_SERIALIZATION), mode: z.literal("comparison_no_execution"),
  status: partStatus, qualifiedSide: z.literal("simple"),
  identity: z.object({ campaignId: z.string(), messageId: z.uuid(), claimId: z.uuid() }).passthrough(),
  hashes: z.object({ sourceHash: z.string().min(1), crmHash: hex64, snapshotHash: hex64, common: hex64.nullable(), current: hex64.nullable(), simple: hex64.nullable() }).strict(),
  common: z.record(z.string(), z.unknown()), sides: z.object({ current: z.record(z.string(), z.unknown()), simple: z.record(z.string(), z.unknown()) }).strict(),
  crmUse: z.object({ served: z.array(z.string()), misses: z.array(z.string()), failedUsed: z.array(z.string()), immutable: z.boolean() }).strict(),
  criteriaMissing: z.array(z.string()), qualification: z.object({ verdict: z.null(), requires: z.literal("human_attestation_against_frozen_oracle") }).strict() }).strict();
/** Fail-closed check of a decrypted receipt against its manifest and its ledger row: version, exact
 * bytes, every part hash, the CRM hash recipe, the snapshot hash and the campaign/message/claim. */
export function verifyReaderEvidence(receipt: unknown, manifest: ReaderEvidenceManifest, binding: Binding, snapshotHash: string | null) {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const parsed = receiptSchema.safeParse(receipt);
  if (!parsed.success) return fail("receipt_version_or_shape_invalid");
  const r = parsed.data, text = JSON.stringify(receipt);
  if (!manifest.receiptSha256 || sha256(text) !== manifest.receiptSha256 || Buffer.byteLength(text, "utf8") !== manifest.bytes.total) return fail("receipt_hash_mismatch");
  if (!sameBinding(r.identity, binding) || !sameBinding(manifest.binding, binding)) return fail("receipt_binding_mismatch");
  if (r.status !== manifest.status) return fail("receipt_status_mismatch");
  for (const part of ["current", "simple"] as const) {
    if (r.sides[part].side !== part) return fail("receipt_side_mismatch");
    if (r.hashes[part] !== null && jsonSha(r.sides[part]) !== r.hashes[part]) return fail("receipt_side_hash_mismatch");
  }
  if (r.hashes.common !== null) {
    if (jsonSha(r.common) !== r.hashes.common) return fail("receipt_common_hash_mismatch");
    const common = r.common as { source?: { sourceHash?: unknown }; crm?: { recipe?: unknown; hash?: unknown; entries?: FrozenCrmEntry[] } };
    if (common.crm?.recipe !== SAV_FROZEN_CRM_HASH_RECIPE || !Array.isArray(common.crm.entries) || savFrozenCrmHash(common.crm.entries) !== common.crm.hash
      || common.crm.hash !== r.hashes.crmHash) return fail("receipt_crm_hash_mismatch");
    if (common.source?.sourceHash !== r.hashes.sourceHash) return fail("receipt_source_hash_mismatch");
  }
  if (savComparisonSnapshotHash(r.hashes.sourceHash, r.hashes.crmHash) !== r.hashes.snapshotHash || (snapshotHash !== null && snapshotHash !== r.hashes.snapshotHash))
    return fail("receipt_snapshot_hash_mismatch");
  return { ok: true as const, reason: null };
}

/** A human attestation names the exact receipt and the exact pre-frozen oracle it was checked against. */
export const comparisonAttestationSchema = z.object({ kind: z.literal("attestation"), expectedCampaignId: z.string().regex(/^[a-z0-9-]{1,64}$/), messageId: z.uuid(),
  receiptSha256: hex64, oracleSha256: hex64, outcome: z.enum(["matches_oracle", "differs_from_oracle"]), confirmed: z.literal(true) }).strict();
export type ComparisonAttestation = { campaignId: string; messageId: string; claimId: string; receiptSha256: string; oracleSha256: string; outcome: "matches_oracle" | "differs_from_oracle"; at: string };
