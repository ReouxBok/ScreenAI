import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savAgentRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { savRollbackCompatibleProposal } from "./proposal-compatibility";
import { savSemanticE2eProposal } from "../../../test/sav-semantic-e2e-fixture";
import { encryptSavPayload } from "./crypto";
import { GET } from "../../app/api/internal/sav/dossiers/[id]/diagnostics/route";

const state = vi.hoisted(() => ({ db: null as unknown, allowed: true }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./auth", () => ({ requireSavApiStaff: async () => { if (!state.allowed) throw new Error("UNAUTHORIZED"); return { email: "ugo@limova.ai" }; } }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; process.env.SAV_ENCRYPTION_KEY_V1 = "synthetic-diagnostic-key-only-at-least-32"; });
afterEach(() => { state.allowed = true; });
afterAll(async () => { delete process.env.SAV_ENCRYPTION_KEY_V1; await fixture?.client.close(); });
describe("read-only dossier diagnostic endpoint", () => {
  it("reads historical runs without opening or dispatching anything", async () => {
    const [mb] = await fixture.db.insert(savMailboxes).values({ email: "diagnostic@example.invalid" }).returning();
    const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mb.id, gmailThreadId: "diagnostic", subject: "Fixture", customerEmail: "fixture@example.invalid" }).returning();
    const [m] = await fixture.db.insert(savMessages).values({ mailboxId: mb.id, threadId: thread.id, gmailMessageId: "fixture", direction: "inbound", fromEmail: "fixture@example.invalid", bodyCiphertext: encryptSavPayload({ text: "Private body" }), receivedAt: new Date() }).returning();
    await fixture.db.insert(savAgentRuns).values({ messageId: m.id, runtime: "fixture", mode: "off", status: "fallback", model: "fixture", promptRevision: "fixture", inputHash: "fixture" });
    const proposal = savSemanticE2eProposal();
    const diagnostic = { phase: "composition" as const, rule: "request_coverage_mismatch", path: "coverage", candidateHash: "fixture-hash", shape: { requests: 1, evidence: 0, knownFacts: 0, attemptedSteps: 0, coverage: 0, citations: 0 } };
    proposal.replyAssessment!.validationDiagnostics = [diagnostic];
    proposal.replyAssessment!.recovery = { strategy: "investigation", originalErrorCode: "SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING", validated: true };
    const understandingSummary = { status: "needs_clarification", language: "unknown", requests: 0, knownFacts: 0, attemptedSteps: 0, uncertainties: ["ambiguous_intent"] };
    await fixture.db.insert(savAgentRuns).values({ messageId: m.id, runtime: "fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(savRollbackCompatibleProposal(proposal)), toolTrace: [{ sequence: 1, name: "sav_validation_outcome", status: "succeeded", durationMs: 0, resultSummary: { understandingSummary, validationDiagnostics: [diagnostic], recovery: proposal.replyAssessment!.recovery, coherenceAttempts: [] } }] });
    const response = await GET(new Request("https://example.invalid/diagnostic"), { params: Promise.resolve({ id: thread.id }) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const data = await response.json(); expect(data.runs).toHaveLength(2); expect(data.runs.some((r: { historicalDetailUnavailable: boolean }) => r.historicalDetailUnavailable)).toBe(true);
    expect(data.runs.find((r: { proposalReadable: boolean }) => r.proposalReadable)).toMatchObject({ diagnostics: [diagnostic], recovery: { validated: true }, historicalDetailUnavailable: false, understandingSummary });
    expect(JSON.stringify(data)).not.toMatch(/Private body|Bonjour|PDF|fixture-customer/);
    expect((await fixture.db.select().from(savMessages))[0].studioOpenedAt).toBeNull();
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(await fixture.db.select().from(auditLogs)).toHaveLength(0);
  });
  it("refuses access before querying data", async () => {
    state.allowed = false;
    const response = await GET(new Request("https://example.invalid/diagnostic"), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(403);
  });
});
