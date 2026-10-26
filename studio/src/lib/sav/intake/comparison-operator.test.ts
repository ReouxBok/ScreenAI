import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), report: vi.fn(), run: vi.fn(), insert: vi.fn(), values: vi.fn() }));
vi.mock("./console-auth", () => ({ requireIntakeConsoleStaff: m.auth }));
vi.mock("@/db", () => ({ requireDb: () => ({ insert: m.insert }) }));
vi.mock("./comparison-campaign", async original => ({ ...await original<typeof import("./comparison-campaign")>(), readSavIntakeComparisonReport: m.report, runSavIntakeComparisonBatch: m.run }));
import { comparisonSentinelsReady, readIntakeComparisonPanel, runIntakeComparisonOperator } from "./comparison-operator";
const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const config = { campaignId: "synthetic-60", messageIds: ids, maxNanoUsd: 20e9, until: "2026-12-01T00:00:00.000Z" };
const environment = { SAV_INTAKE_COMPARISON_JSON: JSON.stringify(config), SAV_INTAKE_PIPELINE: "current" };
const good = () => ({ configured: true as const, rows: ids.map((messageId, i) => ({ messageId, state: i < 10 ? "done" : "pending", verdict: "identical",
  detail: i < 10 ? { coverage: [], simple: { summary: { classification: "support" }, technical: null, uncertain: false } } : null })) });
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue({ role: "admin", email: "admin@example.invalid" }); m.insert.mockReturnValue({ values: m.values }); m.values.mockResolvedValue(undefined); m.run.mockResolvedValue({ compared: [] }); m.report.mockResolvedValue(good()); });
it("GET authenticates but never starts calls or writes an audit", async () => {
  await readIntakeComparisonPanel(); expect(m.auth).toHaveBeenCalledOnce(); expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it.each(["staff", "owner"])("refuses %s even if a page could be opened", async role => {
  m.auth.mockResolvedValue({ role, email: "admin@example.invalid" });
  await expect(runIntakeComparisonOperator({ stage: "sentinels" }, { env: () => environment })).rejects.toThrow("UNAUTHORIZED");
  expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it("refuses an absent administrator session", async () => {
  m.auth.mockRejectedValue(Error("NO_SESSION"));
  await expect(readIntakeComparisonPanel()).rejects.toThrow(); expect(m.run).not.toHaveBeenCalled();
});
it("first phase cannot dispatch the remaining fifty or spend more than five", async () => {
  await runIntakeComparisonOperator({ stage: "sentinels", reviewed: false }, { env: () => environment });
  const options = m.run.mock.calls[0][0], actual = JSON.parse(options.env().SAV_INTAKE_COMPARISON_JSON);
  expect(options.limit).toBe(1); expect(actual).toEqual({ ...config, messageIds: ids.slice(0, 10), maxNanoUsd: 5e9 }); expect(m.values).toHaveBeenCalledOnce();
});
it("continues only after explicit attestation and ten usable simple results", async () => {
  await expect(runIntakeComparisonOperator({ stage: "remaining", reviewed: false }, { env: () => environment })).rejects.toThrow("REVIEW_REQUIRED"); expect(m.run).not.toHaveBeenCalled();
  await runIntakeComparisonOperator({ stage: "remaining", reviewed: true }, { env: () => environment });
  expect(JSON.parse(m.run.mock.calls[0][0].env().SAV_INTAKE_COMPARISON_JSON)).toEqual({ ...config, messageIds: ids.slice(10), maxNanoUsd: 20e9 });
});
it.each(["pending", "interrupted", "coverage", "missing_summary", "technical", "uncertain"])("cannot attest away %s", async fault => {
  const report = good(), row = report.rows[0];
  if (fault === "pending" || fault === "interrupted") row.state = fault;
  if (fault === "coverage") Object.assign(row.detail!, { coverage: ["crm_failed"] });
  if (fault === "missing_summary") Object.assign(row.detail!.simple, { summary: null });
  if (fault === "technical") Object.assign(row.detail!.simple, { technical: "SAV_AI_HTTP_503" });
  if (fault === "uncertain") Object.assign(row.detail!.simple, { uncertain: true });
  m.report.mockResolvedValue(report);
  expect(comparisonSentinelsReady(report as never)).toBe(false);
  await expect(runIntakeComparisonOperator({ stage: "remaining", reviewed: true }, { env: () => environment })).rejects.toThrow("REVIEW_REQUIRED");
  expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it("does not equate a divergence or an old-reader error with a bad simple decision", () => {
  const report = good(); report.rows[0].verdict = "divergent"; Object.assign(report.rows[0].detail!, { current: { technical: "OLD_FAILURE" } });
  expect(comparisonSentinelsReady(report as never)).toBe(true);
});
it("refuses client supplied scope or money, and refuses a live-reader switch", async () => {
  await expect(runIntakeComparisonOperator({ stage: "sentinels", messageIds: ids }, { env: () => environment })).rejects.toThrow();
  await expect(runIntakeComparisonOperator({ stage: "sentinels", maxNanoUsd: 50e9 }, { env: () => environment })).rejects.toThrow();
  await expect(runIntakeComparisonOperator({ stage: "sentinels" }, { env: () => ({ ...environment, SAV_INTAKE_PIPELINE: "simple" }) })).rejects.toThrow("LIVE_READER_CHANGED");
  expect(m.run).not.toHaveBeenCalled();
});
it("a removed or modified campaign is detected during dispatch revalidation", async () => {
  let live = { ...environment };
  await runIntakeComparisonOperator({ stage: "sentinels" }, { env: () => live });
  const scoped = m.run.mock.calls[0][0].env; live = { ...environment, SAV_INTAKE_COMPARISON_JSON: JSON.stringify({ ...config, campaignId: "other" }) };
  expect(() => scoped()).toThrow("CONFIGURATION_CHANGED");
  live = { ...environment, SAV_INTAKE_COMPARISON_JSON: "" }; expect(() => scoped()).toThrow("CONFIGURATION_REQUIRED");
});
it("a lower approved cap is never raised by the operator", async () => {
  const env = () => ({ ...environment, SAV_INTAKE_COMPARISON_JSON: JSON.stringify({ ...config, maxNanoUsd: 2e9 }) });
  await runIntakeComparisonOperator({ stage: "sentinels" }, { env });
  expect(JSON.parse(m.run.mock.calls[0][0].env().SAV_INTAKE_COMPARISON_JSON).maxNanoUsd).toBe(2e9);
});
