import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("./evaluations", () => ({ findEvaluationByToken: lookup }));
import { readStudioEvaluationContext } from "./studio-evaluation-context";

const detail = () => ({
  run: { id: "run", status: "running", expiresAt: new Date("2030-01-01"), tokenHash: "private-hash", createdBy: "staff@example.test" },
  testCase: { id: "case", kind: "live_action", title: "Connect", prompt: "Open settings", expectation: { action: true } },
  item: { id: "item", agentKey: "charly", title: "Settings", summary: "Summary", createdBy: "private-owner" },
  version: { id: "version", bodyMarkdown: "Draft body", metadata: { steps: [] }, createdBy: "private-author" },
});
beforeEach(() => lookup.mockReset().mockResolvedValue(detail()));

describe("staff evaluation MCP projection", () => {
  it("reads the pinned draft without leaking run credentials or staff identities", async () => {
    const context = await readStudioEvaluationContext("staff-code");
    expect(lookup).toHaveBeenCalledWith("staff-code");
    expect(context).toMatchObject({ runId: "run", draft: { id: "item", versionId: "version", bodyMarkdown: "Draft body" }, scenario: { id: "case" } });
    expect(JSON.stringify(context)).not.toMatch(/private-|staff@example|tokenHash|createdBy/);
  });
  it("rejects absent, expired or superseded grants returned by the authoritative lookup", async () => {
    lookup.mockResolvedValue(null);
    expect(await readStudioEvaluationContext("expired")).toBeNull();
  });
  it.each(["passed", "failed", "expired", "cancelled"])("rejects terminal status %s", async status => {
    const value = detail(); value.run.status = status; lookup.mockResolvedValue(value);
    expect(await readStudioEvaluationContext("code")).toBeNull();
  });
  it("does not expose SAV drafts through the extension evaluation channel", async () => {
    const value = detail(); value.item.agentKey = "sav"; lookup.mockResolvedValue(value);
    expect(await readStudioEvaluationContext("code")).toBeNull();
  });
});
