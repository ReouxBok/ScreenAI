/** Pure side of the V1 resume gate: what is recorded, what a bounded re-read proves, and when a resume is held. Synthetic data only. */
import { describe, expect, it } from "vitest";
import type { ReadResult } from "./engine-types";
import {
  SAV_INTAKE_RESUME_MAX_READS, SAV_INTAKE_RESUME_NO_PROGRESS, SAV_INTAKE_RESUME_PROBE_DELAYS_MS, SAV_INTAKE_RESUME_PROBE_UNAVAILABLE, SAV_INTAKE_RESUME_REVISION,
  intakeResumeDecision, intakeResumeHoldReason, intakeResumeNextProbeAt, intakeResumeProof, intakeResumeProofKey, newIntakeResumeObservation, observeIntakeReads,
  parseIntakeResumeProof, probeIntakeResume, withoutIntakeResumeProof, type IntakeResumeProof, type IntakeResumeReaders,
} from "./resume-progress";

const CONFIG = "c".repeat(64), SOURCE = "synthetic-source-hash", signal = new AbortController().signal;
const done = <T,>(data: T, observedAt = "2026-11-03T10:00:00.000Z"): ReadResult<T> => ({ status: "complete", data, observedAt });
const partial = <T,>(data: T): ReadResult<T> => ({ status: "partial", data, observedAt: "2026-11-03T10:00:00.000Z" });
const failed = <T,>(data: T): ReadResult<T> => ({ status: "failed", data, observedAt: "2026-11-03T10:00:00.000Z" });
type Script = Partial<Record<keyof IntakeResumeReaders, (arg: string) => ReadResult<unknown>>>;
const readers = (script: Script, calls: string[] = []): IntakeResumeReaders => {
  const read = (method: keyof IntakeResumeReaders) => async (arg: string) => { calls.push(`${method}:${arg}`); const fn = script[method]; if (!fn) throw Error(`UNEXPECTED_${method}`); return fn(arg); };
  return { findContactsByEmail: read("findContactsByEmail"), directAssociations: read("directAssociations"), getContact: read("getContact"),
    ticketsForContact: read("ticketsForContact"), ticketHistory: read("ticketHistory") } as unknown as IntakeResumeReaders;
};
const contacts = [{ id: "101", emails: ["client@example.invalid"] }];
const tickets = (subject: string) => [{ id: "201", subject }];
const base: Script = { findContactsByEmail: () => done(contacts), directAssociations: () => done([]), ticketsForContact: () => done(tickets("Connexion")), ticketHistory: () => partial([]) };

async function observed(script: Script = base) {
  const sink = newIntakeResumeObservation(), wrapped = observeIntakeReads(readers(script), sink);
  await wrapped.findContactsByEmail("client@example.invalid", signal); await wrapped.directAssociations("101", signal);
  await wrapped.ticketsForContact("101", signal); await wrapped.ticketHistory("201", signal);
  return sink;
}
const proofOf = async (script: Script = base, sourceHash = SOURCE) => intakeResumeProof(await observed(script), { configHash: CONFIG, sourceHash, incomplete: "pagination_cycle" })!;

describe("what is recorded", () => {
  it("passes every read through unchanged and keeps method, argument, status and a content digest only", async () => {
    const sink = newIntakeResumeObservation(), wrapped = observeIntakeReads(readers(base), sink);
    expect(await wrapped.ticketsForContact("101", signal)).toEqual(done(tickets("Connexion")));
    expect(await wrapped.ticketHistory("201", signal)).toEqual(partial([]));
    expect(sink.reads.map(r => [r.method, r.arg, r.status])).toEqual([["ticketsForContact", "101", "complete"], ["ticketHistory", "201", "partial"]]);
    expect(JSON.stringify(sink)).not.toContain("Connexion");
    expect(sink.reads.every(r => /^[a-f0-9]{64}$/.test(r.digest))).toBe(true);
  });

  it("does not count when a read was observed: only its content and status", async () => {
    const a = newIntakeResumeObservation(), b = newIntakeResumeObservation();
    await observeIntakeReads(readers({ ticketsForContact: () => done(tickets("Connexion"), "2026-11-03T10:00:00.000Z") }), a).ticketsForContact("101", signal);
    await observeIntakeReads(readers({ ticketsForContact: () => done(tickets("Connexion"), "2026-11-03T11:30:00.000Z") }), b).ticketsForContact("101", signal);
    expect(a.reads[0].digest).toBe(b.reads[0].digest);
    await observeIntakeReads(readers({ ticketsForContact: () => done(tickets("Autre sujet")) }), b).ticketsForContact("101", signal);
    expect(b.reads[0].digest).not.toBe(a.reads[0].digest);
  });

  it("keeps the last answer of a read repeated in one analysis, and flags more reads than it can prove", async () => {
    const sink = newIntakeResumeObservation();
    let n = 0;
    const wrapped = observeIntakeReads(readers({ ticketHistory: () => (n++ ? done([{ id: "notes:1" }]) : partial([])) }), sink);
    await wrapped.ticketHistory("201", signal); await wrapped.ticketHistory("201", signal);
    expect(sink.reads).toHaveLength(1); expect(sink.reads[0].status).toBe("complete"); expect(sink.truncated).toBe(false);
    for (let i = 0; i < SAV_INTAKE_RESUME_MAX_READS; i++) await wrapped.ticketHistory(`${300 + i}`, signal);
    expect(sink.reads).toHaveLength(SAV_INTAKE_RESUME_MAX_READS); expect(sink.truncated).toBe(true);
  });

  it("leaves a proof only when a read really was incomplete", async () => {
    expect(await proofOf()).toMatchObject({ revision: SAV_INTAKE_RESUME_REVISION, configHash: CONFIG, sourceHash: SOURCE, truncated: false, incomplete: "pagination_cycle" });
    expect(intakeResumeProof(await observed({ ...base, ticketHistory: () => done([]) }), { configHash: CONFIG, sourceHash: SOURCE, incomplete: "x" })).toBeUndefined();
    const proof = await proofOf();
    expect(proof.reads.map(r => r.method)).toEqual(["directAssociations", "findContactsByEmail", "ticketHistory", "ticketsForContact"]);
    expect(JSON.stringify(proof)).not.toContain("Connexion");
  });

  it("refuses a stored value that is not exactly a proof, so the ordinary resume applies", async () => {
    const proof = await proofOf();
    expect(parseIntakeResumeProof(JSON.parse(JSON.stringify(proof)))).toEqual(proof);
    for (const bad of [undefined, null, "x", {}, { ...proof, revision: "old" }, { ...proof, extra: 1 }, { ...proof, configHash: "short" }, { ...proof, reads: [{ ...proof.reads[0], status: "other" }] },
      { ...proof, reads: [{ ...proof.reads[0], method: "assessIssues" }] }, { ...proof, reads: Array.from({ length: SAV_INTAKE_RESUME_MAX_READS + 1 }, () => proof.reads[0]) }]) {
      expect(parseIntakeResumeProof(bad)).toBeNull();
    }
  });

  it("is removed from the payload when a new attempt starts", async () => {
    const proof = await proofOf(), next = withoutIntakeResumeProof({ reason: "pagination_cycle", resumeProof: proof });
    expect(next).toEqual({ reason: "pagination_cycle" }); expect("resumeProof" in next).toBe(false);
  });
});

describe("what a bounded re-read proves", () => {
  it("unchanged and still incomplete: no progress (the same stuck state, however often it is read)", async () => {
    const proof = await proofOf(), calls: string[] = [];
    expect(await probeIntakeResume(proof, readers(base, calls), signal)).toEqual({ state: "same", checked: 4 });
    expect(await probeIntakeResume(proof, readers(base), signal)).toEqual({ state: "same", checked: 4 });
    expect(calls).toEqual(["directAssociations:101", "findContactsByEmail:client@example.invalid", "ticketHistory:201", "ticketsForContact:101"]);
  });

  it("pagination completed: an incomplete read now complete is progress, and the probe stops there", async () => {
    const proof = await proofOf(), calls: string[] = [];
    expect(await probeIntakeResume(proof, readers({ ...base, ticketHistory: () => done([{ id: "notes:401" }]) }, calls), signal)).toEqual({ state: "progress", method: "ticketHistory", change: "completed", checked: 3 });
    expect(calls).toEqual(["directAssociations:101", "findContactsByEmail:client@example.invalid", "ticketHistory:201"]);
  });

  it("a complete read whose content changed is progress, even while another read stays incomplete", async () => {
    const proof = await proofOf();
    expect(await probeIntakeResume(proof, readers({ ...base, ticketsForContact: () => done(tickets("Sujet modifié")) }), signal)).toEqual({ state: "progress", method: "ticketsForContact", change: "changed", checked: 4 });
    expect(await probeIntakeResume(proof, readers({ ...base, findContactsByEmail: () => done([...contacts, { id: "102", emails: ["client@example.invalid"] }]) }), signal))
      .toMatchObject({ state: "progress", method: "findContactsByEmail", change: "changed" });
  });

  it("a read that was complete and now is not proves nothing: never taken for progress", async () => {
    const proof = await proofOf();
    expect(await probeIntakeResume(proof, readers({ ...base, ticketsForContact: () => partial([]) }), signal)).toEqual({ state: "unavailable", checked: 4 });
    expect(await probeIntakeResume(proof, readers({ ...base, directAssociations: () => failed([]), ticketsForContact: () => failed([]) }), signal)).toEqual({ state: "unavailable", checked: 4 });
    // ...unless another read did move: progress still wins.
    expect(await probeIntakeResume(proof, readers({ ...base, directAssociations: () => failed([]), ticketHistory: () => done([]) }), signal)).toMatchObject({ state: "progress", method: "ticketHistory" });
  });

  it("an incomplete read that is still incomplete, or now failed, is not progress", async () => {
    const proof = await proofOf();
    expect(await probeIntakeResume(proof, readers({ ...base, ticketHistory: () => failed([]) }), signal)).toEqual({ state: "unavailable", checked: 4 });
    const failedProof = { ...proof, reads: proof.reads.map(read => read.method === "ticketHistory" ? { ...read, status: "failed" as const } : read) };
    expect(await probeIntakeResume(failedProof, readers(base), signal)).toEqual({ state: "unavailable", checked: 4 });
  });

  it("a reader that throws, or an aborted probe, is unavailable", async () => {
    const proof = await proofOf(), controller = new AbortController();
    expect(await probeIntakeResume(proof, readers({ ...base, findContactsByEmail: () => { throw Error("network"); } }), signal)).toEqual({ state: "unavailable", checked: 1 });
    controller.abort();
    expect(await probeIntakeResume(proof, readers(base), controller.signal)).toEqual({ state: "unavailable", checked: 0 });
  });
});

describe("when a resume is held", () => {
  const current = { configHash: CONFIG, sourceHash: SOURCE };
  const same = { state: "same" as const, checked: 4 };
  it("holds on the same content and configuration while the CRM shows nothing new, and resumes on progress", async () => {
    const proof = await proofOf();
    expect(intakeResumeDecision(proof, current, same)).toEqual({ kind: "hold", cause: "no_progress" });
    expect(intakeResumeDecision(proof, current, { state: "unavailable", checked: 1 })).toEqual({ kind: "hold", cause: "probe_unavailable" });
    expect(intakeResumeDecision(proof, current, { state: "progress", method: "ticketHistory", change: "completed", checked: 3 })).toEqual({ kind: "resume", cause: "progress" });
  });

  it("a proof that applies and was not probed holds: a resume that skipped the check is never a free attempt", async () => {
    expect(intakeResumeDecision(await proofOf(), current, null)).toEqual({ kind: "hold", cause: "unchecked" });
  });

  it("old data resumes as it always did: no proof, another content (new message, edited mail, operator information), another configuration, too many reads", async () => {
    const proof = await proofOf();
    expect(intakeResumeDecision(null, current, same)).toEqual({ kind: "resume", cause: "no_proof" });
    expect(intakeResumeDecision(proof, { ...current, sourceHash: "another-content" }, same)).toEqual({ kind: "resume", cause: "stale_proof" });
    expect(intakeResumeDecision(proof, { ...current, configHash: "d".repeat(64) }, same)).toEqual({ kind: "resume", cause: "stale_proof" });
    expect(intakeResumeDecision({ ...proof, truncated: true }, current, same)).toEqual({ kind: "resume", cause: "unprovable" });
    expect(intakeResumeDecision({ ...proof, reads: [] }, current, same)).toEqual({ kind: "resume", cause: "unprovable" });
  });

  it("names the reason handed back to the caller", () => {
    expect(intakeResumeHoldReason("no_progress")).toBe(SAV_INTAKE_RESUME_NO_PROGRESS);
    expect(intakeResumeHoldReason("probe_unavailable")).toBe(SAV_INTAKE_RESUME_PROBE_UNAVAILABLE);
    expect(intakeResumeHoldReason("unchecked")).toBe(SAV_INTAKE_RESUME_PROBE_UNAVAILABLE);
  });

  it("identifies the same stuck state by what was read, not by when", async () => {
    expect(intakeResumeProofKey(await proofOf())).toBe(intakeResumeProofKey(await proofOf()));
    expect(intakeResumeProofKey(await proofOf())).not.toBe(intakeResumeProofKey(await proofOf({ ...base, ticketsForContact: () => done(tickets("Sujet modifié")) })));
  });

  it("looks again after a growing delay, bounded", () => {
    const now = new Date("2026-11-03T10:00:00.000Z");
    const at = (holds: number) => Date.parse(intakeResumeNextProbeAt(holds, now)) - now.getTime();
    expect([1, 2, 3, 4, 5, 50].map(at)).toEqual([...SAV_INTAKE_RESUME_PROBE_DELAYS_MS, SAV_INTAKE_RESUME_PROBE_DELAYS_MS[3], SAV_INTAKE_RESUME_PROBE_DELAYS_MS[3]]);
    expect(at(0)).toBe(SAV_INTAKE_RESUME_PROBE_DELAYS_MS[0]);
    expect(SAV_INTAKE_RESUME_PROBE_DELAYS_MS).toEqual([600_000, 1_800_000, 7_200_000, 21_600_000]);
  });
});

it("type check helper: a proof is a plain value", async () => {
  const proof: IntakeResumeProof = await proofOf();
  expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
});

it("a reordered batch or reordered address list is the same evidence", async () => {
  const a = { id: "101", emails: ["b@example.invalid", "a@example.invalid"] };
  const b = { id: "102", emails: ["c@example.invalid"] };
  const proof = await proofOf({ ...base, findContactsByEmail: () => done([a, b]) });
  const reordered = { ...base, findContactsByEmail: () => done([b, { ...a, emails: [...a.emails].reverse() }]) };
  expect(await probeIntakeResume(proof, readers(reordered), signal)).toEqual({ state: "same", checked: 4 });
});
