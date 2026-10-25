import { describe, it, expect, vi } from "vitest";
import { continuitySelection, continuityPreview, continuityCommit } from "./continuity-client";
const sourcePolicyId = "10000000-0000-4000-8000-000000000001";
const targetPolicyId = "10000000-0000-4000-8000-000000000002";
const executionIds = ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"];
const preview = { sourcePolicyId, targetPolicyId, executionIds, hash: "a".repeat(64) };
const success = { receipt: { id: "30000000-0000-4000-8000-000000000001", executionIds }, providerActions: 0, modelCalls: 0 };
describe("explicit continuity client", () => {
  it("parses only explicit unique UUIDs", () => {
    expect(continuitySelection(` ${sourcePolicyId} `, executionIds.join(",\n"))).toEqual({ sourcePolicyId, executionIds });
  });
  it.each(["", "not-an-id", `${executionIds[0]},${executionIds[0]}`])("refuses invalid selection %s", ids => {
    expect(() => continuitySelection(sourcePolicyId, ids)).toThrow();
  });
  it("refuses more than one hundred IDs", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(() => continuitySelection(sourcePolicyId, ids.join(","))).toThrow();
  });
  it("previews once, same origin, without POST", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ preview, requires: "drain" }));
    expect(await continuityPreview({ sourcePolicyId, executionIds }, f)).toEqual(preview);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toMatch(/^\/api\/internal\/sav\/intake\/continuity\?/);
    expect(f.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
  });
  it.each([{ ...preview, sourcePolicyId: targetPolicyId }, { ...preview, targetPolicyId: sourcePolicyId },
    { ...preview, executionIds: [executionIds[0]] }, { ...preview, executionIds: [...executionIds, executionIds[0]] },
    { ...preview, hash: "bad" }])("rejects a mismatched preview", async bad => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ preview: bad, requires: "drain" }));
    await expect(continuityPreview({ sourcePolicyId, executionIds }, f)).rejects.toBeDefined();
  });
  it("requires the explicit drain attestation before any request", async () => {
    const f = vi.fn<typeof fetch>(); await expect(continuityCommit(preview, false, f)).rejects.toMatchObject({ uncertain: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("commits exactly once with the server hash and selection", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json(success));
    expect(await continuityCommit(preview, true, f)).toEqual(success.receipt);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("/api/internal/sav/intake/continuity");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error" });
    expect(JSON.parse(f.mock.calls[0][1]!.body as string)).toEqual({ sourcePolicyId, executionIds, expectedHash: preview.hash, oldDeploymentFencedAndDrained: true });
  });
  it.each([400, 403])("reports an explicit pre-transaction refusal %s without retry", async status => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "SAV_INTAKE_EXECUTION_CONTINUITY_REFUSED" }, { status }));
    await expect(continuityCommit(preview, true, f)).rejects.toMatchObject({ uncertain: false }); expect(f).toHaveBeenCalledTimes(1);
  });
  it("a lost response is uncertain and never retried", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(Error("connection lost"));
    await expect(continuityCommit(preview, true, f)).rejects.toMatchObject({ uncertain: true }); expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([Response.json({ error: "invalid_request" }, { status: 409 }), Response.json({ error: "SAV_FAILURE" }, { status: 500 }), new Response("bad", { status: 502 }),
    Response.json({ ...success, providerActions: 1 }), Response.json({ ...success, receipt: { ...success.receipt, executionIds: [executionIds[0]] } })])("an unproven commit outcome is uncertain", async response => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(continuityCommit(preview, true, f)).rejects.toMatchObject({ uncertain: true }); expect(f).toHaveBeenCalledTimes(1);
  });
});
