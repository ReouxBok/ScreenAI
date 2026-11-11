import { describe, expect, it, vi } from "vitest";
import { manualQualification, type ManualQualificationPorts } from "./manual-qualification";

const messageId = "10000000-0000-4000-8000-000000000001";
const caseId = "10000000-0000-4000-8000-000000000002";
const executionId = "10000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-10T12:00:00Z");
const scope = { schema: "sav-v2-qualification-scope.v1", revision: "synthetic-manual-v1", senderEmail: "operator@example.invalid", hubspotContactId: "101", initialSubject: "Synthetic login test", notBefore: "2026-11-10T11:00:00Z", expiresAt: "2026-11-10T13:00:00Z" };
const env = { SAV_V2_SCOPE_MODE: "qualification", SAV_V2_QUALIFICATION_SCOPE_JSON: JSON.stringify(scope), SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_V2_INVESTIGATION: "observe" };
function ports() {
  return { now: () => NOW, paused: vi.fn(async () => false), target: vi.fn(async () => ({ executionId, runId: null, runVersion: 1, ticketId: "202", caseId })), eligible: vi.fn(async () => true), relay: vi.fn(async () => ({ caseId, owner: "agent" })), continue: vi.fn(async () => ({ status: "queued" })) } satisfies ManualQualificationPorts;
}
async function confirmed(p = ports()) {
  const preview = await manualQualification({ operation: "preview", messageId }, env, p);
  if (preview.status !== "ready") throw Error("fixture preview failed");
  return { p, request: { operation: "run", messageId, expected: preview.expected } };
}
describe("manual V2 qualification: one existing message, canonical guards", () => {
  it("preview neither relays nor calls the model continuation", async () => {
    const { p } = await confirmed();
    expect(p.target).toHaveBeenCalledWith(messageId);
    expect(p.relay).not.toHaveBeenCalled(); expect(p.continue).not.toHaveBeenCalled();
  });
  it.each([{}, { ...env, SAV_V2_QUALIFICATION_SCOPE_JSON: "{}" }, { ...env, SAV_V2_QUALIFICATION_SCOPE_JSON: JSON.stringify({ ...scope, expiresAt: NOW.toISOString() }) }, { ...env, SAV_V2_ENTRY: "off" }])("closed/unscoped/off never reaches runtime", async input => {
    const p = ports();
    expect((await manualQualification({ operation: "preview", messageId }, input, p)).status).toBe("refused");
    expect(p.target).not.toHaveBeenCalled(); expect(p.continue).not.toHaveBeenCalled();
  });
  it("a pause or ineligible source prevents even the relay", async () => {
    const { p, request } = await confirmed(); p.paused.mockResolvedValue(true);
    expect(await manualQualification(request, env, p)).toMatchObject({ status: "refused", code: "paused" });
    p.paused.mockResolvedValue(false); p.eligible.mockResolvedValue(false);
    expect(await manualQualification(request, env, p)).toMatchObject({ status: "refused", code: "source_not_eligible" });
    expect(p.relay).not.toHaveBeenCalled();
  });
  it("a changed scope/source/case requires a new preview", async () => {
    const { p, request } = await confirmed();
    p.target.mockResolvedValue({ executionId, runId: null, runVersion: 2, ticketId: "202", caseId });
    expect(await manualQualification(request, env, p)).toMatchObject({ status: "refused", code: "preview_stale" });
    expect(p.relay).not.toHaveBeenCalled();
  });
  it("the explicit run invokes only the chosen message and its returned exact case", async () => {
    const { p, request } = await confirmed();
    expect(await manualQualification(request, env, p)).toMatchObject({ status: "attempted", outcome: "queued", ticketId: "202" });
    expect(p.relay).toHaveBeenCalledExactlyOnceWith(messageId); expect(p.continue).toHaveBeenCalledExactlyOnceWith(caseId);
    // No success or sent claim is inferred from a queued preparation.
  });
  it("a skipped passage names its closed gate code; free text is never echoed", async () => {
    const { p, request } = await confirmed();
    p.continue.mockResolvedValue({ status: "skipped", reason: "ticket_owner_unverified", detail: "none" } as never);
    expect(await manualQualification(request, env, p)).toEqual({ status: "attempted", caseId, ticketId: "202", outcome: "skipped", reason: "ticket_owner_unverified", detail: "none" });
    p.continue.mockResolvedValue({ status: "skipped", reason: "Owner is Jane <jane@example.com>", detail: "a b" } as never);
    expect(await manualQualification(request, env, p)).toEqual({ status: "attempted", caseId, ticketId: "202", outcome: "skipped" });
  });
  it("human ownership or a different returned case never continues", async () => {
    const { p, request } = await confirmed(); p.relay.mockResolvedValue({ caseId, owner: "human" });
    expect(await manualQualification(request, env, p)).toMatchObject({ code: "relay_not_agent" }); expect(p.continue).not.toHaveBeenCalled();
    p.relay.mockResolvedValue({ caseId: executionId, owner: "agent" });
    expect(await manualQualification(request, env, p)).toMatchObject({ code: "relay_not_agent" }); expect(p.continue).not.toHaveBeenCalled();
  });
  it("pause or expiry arriving during relay prevents model cost", async () => {
    const { p, request } = await confirmed(); p.paused.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await manualQualification(request, env, p)).toMatchObject({ code: "gate_changed" }); expect(p.continue).not.toHaveBeenCalled();
    p.paused.mockResolvedValue(false); let calls = 0;
    p.now = () => ++calls === 1 ? NOW : new Date(scope.expiresAt);
    expect(await manualQualification(request, env, p)).toMatchObject({ code: "gate_changed" }); expect(p.continue).not.toHaveBeenCalled();
  });
  it("cannot accept batches, prompts, environment overrides or a run without preview", async () => {
    const p = ports();
    for (const raw of [[{ operation: "preview", messageId }], { operation: "run", messageId }, { operation: "preview", messageId, prompt: "override" }]) await expect(manualQualification(raw, env, p)).rejects.toThrow();
    expect(p.relay).not.toHaveBeenCalled();
  });
});
