/** SAV-46: the private qualification receipt of the reader comparison. Synthetic data only; no
 * database, provider, CRM or Gmail. */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DATABASE_ALLOWED"); } }));
import { intakePlanSummary } from "./comparison-campaign";
import {
  assembleReaderEvidence, boundReaderEvidenceCiphertext, commonOversizeReaderEvidence, comparisonAttestationSchema, comparisonCommonEvidence, comparisonSideEvidence,
  comparisonSideTiming, frozenTicketOwner, intakeMutationExpectations, readerEvidenceManifestSchema, readerEvidenceQualification, savBoundedJsonBytes,
  savComparisonSnapshotHash, savFrozenCrmHash, SAV_READER_EVIDENCE_LIMITS, SAV_READER_EVIDENCE_VERSION, unavailableReaderEvidence, verifyReaderEvidence,
  type FrozenCrmEntry, type ReaderEvidenceIdentity,
} from "./comparison-evidence";
import type { EngineInput, IntakePlan } from "./engine-types";
import type { IntakeValidatedEvidence } from "./model-readers";

const at = "2026-10-31T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001", thread = "20000000-0000-4000-8000-000000000001";
const claimId = "30000000-0000-4000-8000-000000000001", campaignId = "synthetic-60";
const binding = { campaignId, messageId: mid, claimId };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ticketRead = (ownerId: string | null | undefined): FrozenCrmEntry => ({ key: "tickets:101", outcome: "resolved", status: "complete", observedAt: at,
  data: [{ id: "201", contactIds: ["101"], stage: "open", subject: "SYN agenda", content: "SYN", ...(ownerId === undefined ? {} : { ownerId }) }] });
const crm = (ownerId: string | null | undefined = "777"): FrozenCrmEntry[] => [
  { key: "contacts:syn@example.test", outcome: "resolved", status: "complete", observedAt: at, data: [{ id: "101", emails: ["syn@example.test"] }] },
  { key: "history:201", outcome: "resolved", status: "complete", observedAt: at, data: [{ id: "n1", kind: "note", text: "SYN historique", at }] },
  ticketRead(ownerId),
];
const engineInput: EngineInput = { message: { id: mid, threadId: thread, receivedAt: at, fromEmail: "syn@example.test", toEmails: ["support@example.test"], direction: "inbound",
  currentText: "SYN agenda en panne. SYN export en échec.", contentComplete: true }, latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: mid,
  conversation: { status: "complete", data: [], observedAt: at } };
/** Two plans with the same summary projection: same target, same mutation types, same progress. */
function plan(noteText: string, fingerprint = "f".repeat(64)): IntakePlan {
  return { revision: "sav-intake-engine-2026-10-20.v1", fingerprint, noteText, originalThreadId: thread, originalRecipientEmails: ["support@example.test"], referenceMode: "current", readCalls: 4, effects: "not_connected",
    progress: { kind: "processing" } as never,
    decision: { messageId: mid, classification: "support", disposition: { kind: "ticket", target: { operation: "link", contactId: "101", ticketId: "201", alreadyNew: false, ticketEvidenceId: "ticket-201", contactAssociationEvidenceId: "contact-101" } } } as never,
    steps: (["append_ticket_note", "associate_email", "link_ticket", "set_ticket_new"] as const).map((mutation, i) => ({ id: `s${i}`, mutation, ticketId: "201", requiresPermission: mutation, status: "not_dispatched" as const })) };
}
const validated = (quotes: string[]): IntakeValidatedEvidence => ({ reader: "simple", phase: "understanding", kind: "judgement", callIndex: 1, focused: false,
  value: { messageId: mid, nature: "request", requests: quotes.map((summary, i) => ({ id: `r${i + 1}`, kind: "support", summary, sourceIds: ["current"] })),
    identity: { kind: "unique", contactIds: ["101"], why: "SYN" }, tickets: [{ ticketId: "201", relation: "same", why: "SYN", sourceIds: ["current", "ticket-201"] }], missing: [], rationale: "SYN" } });
const calls = [{ order: 0, method: "analyseMessage" as const, input: { messageId: mid }, status: "returned" as const },
  { order: 1, method: "assessIssues" as const, input: { ticketIds: ["201"] }, status: "returned" as const }];
const timing = comparisonSideTiming({ startedAt: at, wallMs: 10, requests: [] });
const fromMail = () => "Objet : SYN\n\nSYN mail original";
const side = (kind: "current" | "simple", p: IntakePlan | null, evidence: IntakeValidatedEvidence[], entries = crm()) => comparisonSideEvidence({ side: kind, readerRevision: `syn-${kind}`,
  plan: p, technical: null, uncertain: false, semanticCalls: calls, validated: kind === "current" ? [{ ...evidence[0], reader: "current", kind: "analysis" }, { reader: "current", phase: "ticket_matching", kind: "issues", callIndex: 2, group: 0, value: {} }] : evidence,
  timing, expectations: p ? intakeMutationExpectations(p, entries, fromMail) : null });
const identity: ReaderEvidenceIdentity = { ...binding, comparisonRevision: "syn", codeRevision: "a".repeat(40), readerRevisions: { current: "syn-current", simple: "syn-simple" },
  engineRevision: "sav-intake-engine-2026-10-20.v1", model: "gemini-syn", runtimeConfigHash: "b".repeat(64), enginePolicyHash: "c".repeat(64), resourcesHash: "d".repeat(64), otherCatalogue: null };
function receipt(note: string, quotes: string[], entries = crm()) {
  const crmHash = savFrozenCrmHash(entries), common = comparisonCommonEvidence({ sourceHash: "e".repeat(64), messageSourceHash: "e".repeat(64), engineInput, provenance: new Map([[mid, { subject: "SYN" }]]),
    attachments: { count: 0, inventoryComplete: null }, crm: { hash: crmHash, entries } });
  return assembleReaderEvidence({ identity, common, sides: { current: side("current", plan(note), [validated(quotes)], entries), simple: side("simple", plan(note), [validated(quotes)], entries) },
    crmUse: { served: entries.map(e => e.key), misses: [], failedUsed: [], immutable: true }, snapshotHash: savComparisonSnapshotHash("e".repeat(64), crmHash), commonPreparationMs: 5, clock: () => 0 });
}

describe("receipt keeps what the summary projection loses", () => {
  it("RED on 238: same projection, lost second request and note are now different receipts", () => {
    // The projection 238 persisted cannot tell them apart (F01 review, F10xG7=70).
    expect(intakePlanSummary(plan("SYN R1 ET R2"))).toEqual(intakePlanSummary(plan("SYN R1 seul", "0".repeat(64))));
    const both = receipt("SYN R1 ET R2", ["SYN agenda", "SYN export"]), one = receipt("SYN R1 seul", ["SYN agenda"]);
    expect(both.manifest.status).toBe("complete"); expect(one.manifest.status).toBe("complete");
    expect(both.manifest.receiptSha256).not.toBe(one.manifest.receiptSha256);
    const simple = (r: typeof both) => r.receipt!.sides.simple as { plan: IntakePlan; validated: { value: { requests: unknown[] } }[] };
    expect(simple(both).plan.noteText).toBe("SYN R1 ET R2"); expect(simple(one).plan.noteText).toBe("SYN R1 seul");
    expect(simple(both).validated[0].value.requests).toHaveLength(2); expect(simple(one).validated[0].value.requests).toHaveLength(1);
  });
  it("a different owner baseline is kept from the frozen CRM, never from the model, and an absent owner is not invented", () => {
    const owned = receipt("SYN", ["SYN"], crm("777")), other = receipt("SYN", ["SYN"], crm("888")), unknown = receipt("SYN", ["SYN"], crm(undefined));
    const stage = (r: ReturnType<typeof receipt>) => ((r.receipt!.sides.simple as { mutationExpectations: { items: { mutation: string; ownerBaseline?: unknown }[] } }).mutationExpectations.items.find(i => i.mutation === "set_ticket_new"));
    expect(stage(owned)?.ownerBaseline).toMatchObject({ status: "observed", ownerId: "777", sourceKey: "tickets:101" });
    expect(stage(other)?.ownerBaseline).toMatchObject({ status: "observed", ownerId: "888" });
    expect(owned.manifest.receiptSha256).not.toBe(other.manifest.receiptSha256);
    expect(stage(unknown)?.ownerBaseline).toEqual({ status: "not_observed", sourceKey: "tickets:101" });
    expect(unknown.manifest.status).toBe("incomplete"); expect(unknown.manifest.criteriaMissing).toContain("owner_baseline_not_observed");
    expect(frozenTicketOwner(crm(null), "201")).toMatchObject({ status: "observed", ownerId: null });
  });
  it("a created ticket's description is the stored original mail (SAV-72), kept apart from the planner intent", () => {
    const p: IntakePlan = { ...plan("SYN"), noteText: null, steps: [{ id: "c", mutation: "create_ticket", ticketId: null, requiresPermission: "create_ticket", status: "not_dispatched" }],
      newTicket: { contactId: "101", title: "SYN titre", description: "SYN résumé du planificateur", requestIds: ["r1"], pipeline: "support", stage: "new", source: "email", owner: "leave_unassigned" } };
    const created = intakeMutationExpectations(p, crm(), planner => `Objet : SYN\n\nSYN mail original (${planner.length})`).items[0] as Record<string, { origin: string; text: string }>;
    expect(created.description).toMatchObject({ origin: "stored_original_mail_sav72", text: expect.stringContaining("SYN mail original") });
    expect(created.plannerDescription).toEqual({ origin: "plan_intent_not_sent", text: "SYN résumé du planificateur" });
    expect(intakeMutationExpectations(p, crm(), fromMail).nature).toBe("derived_intentions_not_executed_payloads");
  });
  it("a semantic answer the engine consumed without its accepted pre-loss copy is incomplete, never complete", () => {
    const missing = comparisonSideEvidence({ side: "simple", readerRevision: "syn", plan: plan("SYN"), technical: null, uncertain: false, semanticCalls: calls, validated: [], timing, expectations: null });
    expect(missing.status).toBe("incomplete"); expect(missing.criteriaMissing).toEqual(expect.arrayContaining(["validated_evidence_missing:analyseMessage", "validated_evidence_missing:assessIssues"]));
    expect(missing.notProducedByReader).toContain("request_verbatim_quote");
  });
});

describe("hashes, versions and tampering", () => {
  it("the frozen CRM hash recipe is byte-identical to the 238 freeze", () => {
    const entries: FrozenCrmEntry[] = [...crm(), { key: "tickets:999", outcome: "rejected" }, { key: "history:202", outcome: "resolved", status: "partial", data: [], observedAt: at }];
    // Exact formula of comparison-campaign.ts at 238 (frozenCrm.freeze).
    const legacy = createHash("sha256").update(JSON.stringify(entries.map(e => [e.key, e.outcome === "resolved" ? e.status ?? "error" : "error", e.outcome === "resolved" ? e.data ?? null : null]))).digest("hex");
    expect(savFrozenCrmHash(entries)).toBe(legacy);
    // observedAt is kept in the receipt but is not covered by this hash: said, not implied.
    expect(savFrozenCrmHash(entries.map(e => e.outcome === "resolved" ? { ...e, observedAt: "2020-01-01T00:00:00.000Z" } : e))).toBe(legacy);
    expect(savComparisonSnapshotHash("s", legacy)).toBe(createHash("sha256").update(JSON.stringify(["s", legacy])).digest("hex"));
  });
  it("round trip verifies, and every tamper fails closed", () => {
    const { receipt: r, manifest } = receipt("SYN", ["SYN"]);
    type Mutable = { version: string; hashes: { common: string | null }; common: { crm: { entries: { data: unknown }[] } };
      sides: { current: unknown; simple: { plan: { noteText: string } } } };
    const copy = () => JSON.parse(JSON.stringify(r)) as Mutable;
    expect(verifyReaderEvidence(copy(), manifest, binding, r!.hashes.snapshotHash)).toEqual({ ok: true, reason: null });
    const note = copy(); note.sides.simple.plan.noteText = "SYN altéré";
    expect(verifyReaderEvidence(note, manifest, binding, null).ok).toBe(false);
    const version = copy(); version.version = "reader-qualification-evidence.v0";
    expect(verifyReaderEvidence(version, manifest, binding, null)).toMatchObject({ reason: "receipt_version_or_shape_invalid" });
    expect(verifyReaderEvidence(copy(), manifest, { ...binding, claimId: randomUUID() }, null)).toMatchObject({ reason: "receipt_binding_mismatch" });
    expect(verifyReaderEvidence(copy(), manifest, binding, "0".repeat(64))).toMatchObject({ reason: "receipt_snapshot_hash_mismatch" });
    // A consistent forgery still has to match the manifest hash stored in the encrypted result.
    const forged = copy(); forged.common.crm.entries[0].data = []; forged.hashes.common = sha(JSON.stringify(forged.common));
    expect(verifyReaderEvidence(forged, { ...manifest, receiptSha256: sha(JSON.stringify(forged)), bytes: { ...manifest.bytes, total: Buffer.byteLength(JSON.stringify(forged)) } }, binding, null))
      .toMatchObject({ reason: "receipt_crm_hash_mismatch" });
    const swapped = copy(), { current, simple } = swapped.sides; Object.assign(swapped.sides, { current: simple, simple: current });
    expect(verifyReaderEvidence(swapped, { ...manifest, receiptSha256: sha(JSON.stringify(swapped)), bytes: { ...manifest.bytes, total: Buffer.byteLength(JSON.stringify(swapped)) } }, binding, null))
      .toMatchObject({ reason: "receipt_side_mismatch" });
  });
  it("a result without receipt is legacy (readable, never qualifiable); a malformed or foreign manifest is invalid", () => {
    const { manifest } = receipt("SYN", ["SYN"]);
    expect(readerEvidenceQualification({ coverage: [], simple: { summary: {} } }, binding)).toBe("legacy");
    expect(readerEvidenceQualification({ evidence: manifest }, binding)).toBe("complete");
    expect(readerEvidenceQualification({ evidence: { ...manifest, version: "v0" } }, binding)).toBe("invalid");
    expect(readerEvidenceQualification({ evidence: manifest }, { ...binding, messageId: randomUUID() })).toBe("invalid");
    expect(readerEvidenceQualification({ evidence: { ...manifest, receiptSha256: null } }, binding)).toBe("invalid");
    expect(readerEvidenceQualification(null, binding)).toBe("invalid");
    expect(manifest.version).toBe(SAV_READER_EVIDENCE_VERSION);
  });
  it("an attestation must name the receipt, the oracle and an explicit confirmation", () => {
    const valid = { kind: "attestation", expectedCampaignId: campaignId, messageId: mid, receiptSha256: "a".repeat(64), oracleSha256: "b".repeat(64), outcome: "matches_oracle", confirmed: true };
    expect(comparisonAttestationSchema.safeParse(valid).success).toBe(true);
    for (const bad of [{ ...valid, confirmed: false }, { ...valid, oracleSha256: "" }, { ...valid, outcome: "identical" }, { ...valid, reviewed: true }])
      expect(comparisonAttestationSchema.safeParse(bad).success).toBe(false);
  });
});

describe("bounds and confidentiality", () => {
  it("counts JSON bytes exactly without building the string, and stops past the limit", () => {
    for (const value of [{ a: "é\"\\\n 😀", b: [1, -0, 1e21, 1e-7, null, undefined, true], c: { d: undefined, e: () => 1 }, f: new Date(at) }, [], {}, "", [[{}]], { "1": 2, a: [undefined] }])
      expect(savBoundedJsonBytes(value, 1e9)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
    expect(savBoundedJsonBytes({ text: "x".repeat(100) }, 50)).toBeNull();
  });
  it("an oversize common capture is refused before any model call, never truncated", () => {
    const big = comparisonCommonEvidence({ sourceHash: "e".repeat(64), messageSourceHash: "e".repeat(64), engineInput, provenance: new Map(), attachments: { count: 0, inventoryComplete: null },
      crm: { hash: "f".repeat(64), entries: [{ key: "history:201", outcome: "resolved", status: "complete", observedAt: at, data: [{ text: "x".repeat(SAV_READER_EVIDENCE_LIMITS.commonBytes) }] }] } });
    expect(savBoundedJsonBytes(big, SAV_READER_EVIDENCE_LIMITS.commonBytes)).toBeNull();
    const refused = commonOversizeReaderEvidence(binding, 3);
    expect(refused).toMatchObject({ receipt: null, manifest: { status: "oversize", stored: false, parts: { common: "oversize" }, criteriaMissing: ["evidence_common_oversize"] } });
  });
  it("an oversize side is a stub with its limit, the receipt is not complete, and the ciphertext bound is checked too", () => {
    const huge = plan("x".repeat(SAV_READER_EVIDENCE_LIMITS.sideBytes + 10));
    const crmHash = savFrozenCrmHash(crm()), common = comparisonCommonEvidence({ sourceHash: "e".repeat(64), messageSourceHash: "e".repeat(64), engineInput, provenance: new Map(),
      attachments: { count: 0, inventoryComplete: null }, crm: { hash: crmHash, entries: crm() } });
    const r = assembleReaderEvidence({ identity, common, sides: { current: side("current", plan("SYN"), [validated(["SYN"])]), simple: side("simple", huge, [validated(["SYN"])]) },
      crmUse: { served: [], misses: [], failedUsed: [], immutable: true }, snapshotHash: savComparisonSnapshotHash("e".repeat(64), crmHash), commonPreparationMs: 1, clock: () => 0 });
    expect(r.manifest).toMatchObject({ status: "oversize", parts: { simple: "oversize" }, bytes: { simple: null } });
    expect(r.receipt!.sides.simple).toEqual({ side: "simple", status: "oversize", limitBytes: SAV_READER_EVIDENCE_LIMITS.sideBytes });
    const ok = receipt("SYN", ["SYN"]).manifest;
    expect(boundReaderEvidenceCiphertext(ok, SAV_READER_EVIDENCE_LIMITS.ciphertextBytes + 1, 1)).toMatchObject({ keep: false, manifest: { status: "oversize", stored: false } });
    expect(boundReaderEvidenceCiphertext(ok, 1000, 1)).toMatchObject({ keep: true, manifest: { status: "complete", bytes: { ciphertext: 1000 } } });
  });
  it("a partial or rejected CRM read, a miss or a mutated capture is incomplete", () => {
    const partial = receipt("SYN", ["SYN"], [...crm(), { key: "history:202", outcome: "resolved", status: "partial", data: [], observedAt: at }]);
    expect(partial.manifest.status).toBe("incomplete"); expect(partial.manifest.criteriaMissing).toContain("crm_partial:history");
    const rejected = receipt("SYN", ["SYN"], [...crm(), { key: "tickets:102", outcome: "rejected" }]);
    expect(rejected.manifest.criteriaMissing).toContain("crm_rejected:tickets");
  });
  it("the manifest holds codes and counts only: no address, text or identifier", () => {
    const text = JSON.stringify(receipt("SYN R1 ET R2", ["SYN agenda"], [...crm(), { key: "tickets:102", outcome: "rejected" }]).manifest);
    for (const secret of ["syn@example.test", "SYN agenda", "SYN R1", "tickets:102"]) expect(text).not.toContain(secret);
    expect(readerEvidenceManifestSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(JSON.stringify(unavailableReaderEvidence(binding, ["SAV_INTAKE_OTHER_CONFIGURATION_REQUIRED", "crm_not_captured:contact:secret@example.test"]).manifest.criteriaMissing))
      .toBe(JSON.stringify(["sav_intake_other_configuration_required", "crm_not_captured:contact"]));
  });
  it("the validated copy never keeps derived image text", () => {
    const withImages = comparisonSideEvidence({ side: "simple", readerRevision: "syn", plan: plan("SYN"), technical: null, uncertain: false, semanticCalls: [], timing, expectations: null,
      validated: [{ ...validated(["SYN"]), value: { ...(validated(["SYN"]).value as object), images: [{ text: "SYN pixel secret" }] } }] });
    expect(JSON.stringify(withImages)).not.toContain("SYN pixel secret");
  });
  it("timing names its scope and derives the informational production attempt from the wire text size", () => {
    const t = comparisonSideTiming({ startedAt: at, wallMs: 7, requests: [131072, 131073].map(textBytes => ({ phase: "understanding", textBytes, wireBytes: textBytes + 10, dispatched: true, httpStatus: 200,
      transport: { phase: "understanding", durationMs: 3, attempts: 1, retries: 0, errorCode: null, failureCategory: null } }) as never) });
    expect(t.requests.map(r => r.productionAttemptMs)).toEqual([18_000, 37_000]);
    expect(t).toMatchObject({ wallMs: 7, cumulativeTransportMs: 6, largestTextBytes: 131073, scope: "comparison_measurement_not_production_envelope" });
  });
});
