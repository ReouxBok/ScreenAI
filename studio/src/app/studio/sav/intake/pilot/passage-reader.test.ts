import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readPassage } from "./passage";
import { decodePassageArtifact } from "./passage-reader";
// Decoder-only SYN fixture. It is never imported by the page and is not evidence of a pipeline run.
function fixture() {
  const common = { ownerWrite: false, atomicOwnerCompare: "not_proven" };
  const counts = { modelCalls: 0, ticketPosts: 0, ownerWrites: 0, mailsSent: 0 };
  return { schema: "sav-pilot-passage.syn.v1", simulated: true, atomicOwnerCompare: "not_proven", ids: "invented", sourcesAndScope: "invented_fixture_no_real_sheet_approved_by_nobody", model: "synthetic_port_no_paid_call", rows: [
    { ref: "SYN-P1", label: "Connexion SYN", passage: { ...common, state: "agent_ready", situation: "agent", v2Work: true, caseOwner: "agent", crmReading: "v2", admission: { target: "agent", reasons: [] } },
      decision: { status: "accepted", contract: "SYN-contract", decidedOn: 1, scope: { revision: "SYN-scope", policyRevision: "SYN-policy" } }, sourcesStatus: "proven_from_decision",
      sources: [{ knowledgeId: "SYN-source", contentVersionId: "SYN-v1", permission: "answer", title: "Fiche SYN", content: "Contenu inventé pour le test du lecteur.", verifiedAt: "2026-11-01T00:00:00.000Z", verification: "fresh", evaluatedAt: "2026-11-04T07:00:00.000Z" }],
      draft: { status: "awaiting_validation", validatable: true, purpose: "answer", subject: "Connexion", text: "Réponse préparée avec une IA." }, counters: { ...counts, modelCalls: 1, ticketPosts: 1 } },
    { ref: "SYN-P2", label: "Humain SYN", passage: { ...common, state: "team_person", situation: "human_owner", v2Work: false, caseOwner: "human", crmReading: "human", admission: { target: "agent", reasons: [] } }, decision: null, sourcesStatus: "no_search_case_with_team", sources: [], draft: null, counters: { ...counts } },
    { ref: "SYN-P3", label: "Mixte SYN", passage: { ...common, state: "team_out_of_scope", situation: "excluded_sensitive", v2Work: false, caseOwner: "human", crmReading: "none", admission: { target: "team", reasons: ["finance"] } }, decision: null, sourcesStatus: "no_search_case_with_team", sources: [], draft: null, counters: { ...counts, ticketPosts: 1 } },
    { ref: "SYN-R2" }, { ref: "SYN-R3" }, { ref: "SYN-R4" },
  ] };
}
const meta = (raw: string) => ({ producerSha: "a".repeat(40), artifactHash: createHash("sha256").update(raw).digest("hex"), evidence: "SYN decoder fixture only", authorTested: true });
function decode(value: unknown) { const raw = JSON.stringify(value); return decodePassageArtifact(raw, meta(raw)); }
describe("passage display cannot manufacture evidence or team work", () => {
  it("maps the exact three scenes and retains source version, date, scope, draft and counters", () => {
    const read = decode(fixture()); expect(read.ok).toBe(true); if (!read.ok) return;
    expect(read.data.scenarios.map(row => [row.ref, row.counters.modelCalls, row.counters.mailsSent])).toEqual([["SYN-P1", 1, 0], ["SYN-P2", 0, 0], ["SYN-P3", 0, 0]]);
    expect(read.data.scenarios[0]).toMatchObject({ draft: "Réponse préparée avec une IA.", scope: "SYN-scope · politique SYN-policy", sources: [{ version: "SYN-v1", verifiedAt: "2026-11-01T00:00:00.000Z" }] });
  });
  it("retains the producer revalidation_due status without upgrading it", () => { const f = fixture(); f.rows[0].sources![0].verifiedAt = "2026-08-06T07:00:00.000Z"; f.rows[0].sources![0].verification = "revalidation_due"; const read = decode(f); expect(read.ok).toBe(true); if (read.ok) expect(read.data.scenarios[0].sources[0]).toMatchObject({ verification: "revalidation_due", evaluatedAt: "2026-11-04T07:00:00.000Z" }); });
  it.each([
    ["missing producer verification", (f: ReturnType<typeof fixture>) => { Reflect.deleteProperty(f.rows[0].sources![0], "verification"); }],
    ["unverified source", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].verification = "unverified"; }],
    ["stale source", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].verification = "stale"; }],
    ["missing evaluation date", (f: ReturnType<typeof fixture>) => { Reflect.deleteProperty(f.rows[0].sources![0], "evaluatedAt"); }],
    ["invalid evaluation date", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].evaluatedAt = "today"; }],
    ["future verification at evaluation", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].evaluatedAt = "2026-10-01T00:00:00.000Z"; }],
    ["unknown source field", (f: ReturnType<typeof fixture>) => { Reflect.set(f.rows[0].sources![0], "extra", true); }],
    ["missing sources", (f: ReturnType<typeof fixture>) => { f.rows[0].sources = []; }],
    ["missing version", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].contentVersionId = ""; }],
    ["missing verification date", (f: ReturnType<typeof fixture>) => { Reflect.set(f.rows[0].sources![0], "verifiedAt", null); }],
    ["unknown verification date", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].verifiedAt = "synthetic_10_days_before_the_run"; }],
    ["orientation-only source", (f: ReturnType<typeof fixture>) => { f.rows[0].sources![0].permission = "orient_only"; }],
    ["missing scope", (f: ReturnType<typeof fixture>) => { f.rows[0].decision!.scope.revision = ""; }],
    ["absent AI mention", (f: ReturnType<typeof fixture>) => { f.rows[0].draft!.text = "Une réponse"; }],
    ["unknown owner is not agent", (f: ReturnType<typeof fixture>) => { f.rows[0].passage!.crmReading = "unknown"; }],
    ["human draft", (f: ReturnType<typeof fixture>) => { f.rows[1].draft = f.rows[0].draft; }],
    ["human model call", (f: ReturnType<typeof fixture>) => { f.rows[1].counters!.modelCalls = 1; }],
    ["out-of-scope send", (f: ReturnType<typeof fixture>) => { f.rows[2].counters!.mailsSent = 1; }],
    ["owner write", (f: ReturnType<typeof fixture>) => { f.rows[0].counters!.ownerWrites = 1; }],
    ["non-synthetic report", (f: ReturnType<typeof fixture>) => { f.simulated = false; }],
    ["duplicate case", (f: ReturnType<typeof fixture>) => { f.rows[1].ref = "SYN-P1"; }],
  ] as const)("refuses %s, even with a recomputed hash", (_name, mutate) => { const f = fixture(); mutate(f); expect(decode(f).ok).toBe(false); });
  it("rejects changed bytes and an unqualified producer", () => { const raw = JSON.stringify(fixture()); expect(decodePassageArtifact(raw + " ", meta(raw)).ok).toBe(false); expect(decodePassageArtifact(raw, { ...meta(raw), authorTested: false }).ok).toBe(false); });
});

describe("qualified C artifact integration", () => {
  it("reads the regenerated SYN export with its exact producer SHA and all three source fields", () => {
    const result = readPassage(); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.producerSha).toBe("7ebeb21281bb93e29a7edf335989453ff8098c62");
    expect(result.data.artifactHash).toBe("361b0cedea2279c78fc91248b7e7bd430e388d50d311f8da6586c0d182b6844a");
    expect(result.data.scenarios[0].sources[0]).toMatchObject({ verifiedAt: "2026-10-25T09:00:00.000Z", verification: "fresh", evaluatedAt: "2026-11-04T07:00:00.000Z" });
    expect(result.data.scenarios.map(s => [s.ref, s.counters.modelCalls, s.counters.mailsSent, Boolean(s.draft)])).toEqual([["SYN-P1", 1, 0, true], ["SYN-P2", 0, 0, false], ["SYN-P3", 0, 0, false]]);
  });
  it("keeps the actual loader unavailable without the evidence files", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-SYN-evidence");
    try { expect(readPassage()).toMatchObject({ ok: false }); } finally { cwd.mockRestore(); }
  });
});
