import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSavReplyCoherence } from "./reply-coherence";
import { coverageFixture, geminiFixture, understandingFixture } from "../../../test/sav-understanding-fixtures";

const understanding = understandingFixture();
const coverage = coverageFixture(understanding);
const input = { understanding, coverage, replyDraft: coverage[0].text, evidence: [] };
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("SAV coherence verdict boundary (mocked model, not human accuracy)", () => {
  it("accepts a complete model verdict with an explicit trace", async () => {
    const network = vi.fn<typeof fetch>(async () => geminiFixture({ passed: true, coveredRequestIds: ["request-1"], issues: [] }));
    const result = await checkSavReplyCoherence(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledOnce(); expect(result).toMatchObject({ status: "passed", issues: [], errorCode: null, inputTokens: 10, totalTokens: 30 });
    expect(result.outputHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it.each([
    { passed: true, coveredRequestIds: [], issues: [] },
    { passed: true, coveredRequestIds: ["other"], issues: [] },
    { passed: true, coveredRequestIds: ["request-1", "other"], issues: [] },
    { passed: true, coveredRequestIds: ["request-1"], issues: ["unsupported_advice"] },
    { passed: false, coveredRequestIds: ["request-1"], issues: ["known_information_requested"] },
  ])("rejects incomplete or contradictory verdicts %j", async verdict => {
    const result = await checkSavReplyCoherence(input, { apiKey: "fixture", fetch: vi.fn<typeof fetch>(async () => geminiFixture(verdict)) });
    expect(result).toMatchObject({ status: "rejected", errorCode: "SAV_REPLY_COHERENCE_REJECTED" });
  });
  it.each(["invalid", "provider"])("returns unavailable for %s, never a false success or retry", async failure => {
    const network = vi.fn<typeof fetch>(async () => failure === "provider" ? new Response("fixture", { status: 500 }) : geminiFixture({ passed: true, coveredRequestIds: ["request-1"], issues: ["invented_issue"] }));
    const result = await checkSavReplyCoherence(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("unavailable"); expect(result.outputHash).toBeNull(); expect(network).toHaveBeenCalledOnce();
  });
  it("enforces the bound and cancels the request", async () => {
    vi.useFakeTimers();
    const network = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const pending = checkSavReplyCoherence(input, { apiKey: "fixture", fetch: network });
    await vi.advanceTimersByTimeAsync(18000);
    expect(await pending).toMatchObject({ status: "unavailable", errorCode: "SAV_AI_TIMEOUT" }); expect(network).toHaveBeenCalledOnce();
  });
});
