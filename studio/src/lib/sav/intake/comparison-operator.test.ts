import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), report: vi.fn(), run: vi.fn(), insert: vi.fn(), values: vi.fn(), evidence: vi.fn(), attest: vi.fn() }));
vi.mock("./console-auth", () => ({ requireIntakeConsoleStaff: m.auth }));
vi.mock("@/db", () => ({ requireDb: () => ({ insert: m.insert }) }));
vi.mock("./comparison-campaign", async original => ({ ...await original<typeof import("./comparison-campaign")>(), readSavIntakeComparisonReport: m.report, runSavIntakeComparisonBatch: m.run,
  readSavIntakeComparisonEvidence: m.evidence, appendSavIntakeComparisonAttestation: m.attest }));
import { attestIntakeComparison, comparisonSentinelsReady, readIntakeComparisonEvidence, readIntakeComparisonPanel, runIntakeComparisonOperator } from "./comparison-operator";
const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const config = { campaignId: "synthetic-60", messageIds: ids, maxNanoUsd: 20e9, until: "2026-12-01T00:00:00.000Z" };
const environment = { SAV_INTAKE_COMPARISON_JSON: JSON.stringify(config), SAV_INTAKE_PIPELINE: "current" };
const claim = (i: number) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`, receipt = (i: number) => String(i % 10).repeat(64);
type Attested = { claimId: string; receiptSha256: string; oracleSha256: string; outcome: "matches_oracle" | "differs_from_oracle"; at: string } | "invalid" | null;
/** Ten done sentinels, each with a complete v1 receipt and a human attestation naming it. */
const good = () => ({ configured: true as const, rows: ids.map((messageId, i) => ({ messageId, claimId: i < 10 ? claim(i) : null, state: i < 10 ? "done" : "pending", verdict: "identical",
  qualificationEvidence: (i < 10 ? "complete" : null) as string | null,
  attestation: (i < 10 ? { claimId: claim(i), receiptSha256: receipt(i), oracleSha256: "a".repeat(64), outcome: "matches_oracle", at: "2026-10-31T10:00:00.000Z" } : null) as Attested,
  detail: i < 10 ? { coverage: [], simple: { summary: { classification: "support" }, technical: null, uncertain: false }, evidence: { status: "complete", receiptSha256: receipt(i) } } : null })) });
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue({ role: "admin", email: "admin@example.invalid" }); m.insert.mockReturnValue({ values: m.values }); m.values.mockResolvedValue(undefined); m.run.mockResolvedValue({ compared: [] }); m.report.mockResolvedValue({ ...good(), rows: ids.map(messageId => ({ messageId, state: "pending", detail: null })) }); });
it("GET authenticates but never starts calls or writes an audit", async () => {
  await readIntakeComparisonPanel(); expect(m.auth).toHaveBeenCalledOnce(); expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it.each(["staff", "owner"])("refuses %s even if a page could be opened", async role => {
  m.auth.mockResolvedValue({ role, email: "admin@example.invalid" });
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels" }, { env: () => environment })).rejects.toThrow("UNAUTHORIZED");
  expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it("refuses an absent administrator session", async () => {
  m.auth.mockRejectedValue(Error("NO_SESSION"));
  await expect(readIntakeComparisonPanel()).rejects.toThrow(); expect(m.run).not.toHaveBeenCalled();
});
it("first phase cannot dispatch the remaining fifty or spend more than five", async () => {
  await runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels", reviewed: false }, { env: () => environment });
  const options = m.run.mock.calls[0][0], actual = JSON.parse(options.env().SAV_INTAKE_COMPARISON_JSON);
  expect(options.limit).toBe(1); expect(actual).toEqual({ ...config, messageIds: [ids[0]], maxNanoUsd: 5e9 }); expect(m.values).toHaveBeenCalledOnce();
});
it("continues only after explicit attestation and ten usable simple results", async () => {
  m.report.mockResolvedValue(good());
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[10], stage: "remaining", reviewed: false }, { env: () => environment })).rejects.toThrow("REVIEW_REQUIRED"); expect(m.run).not.toHaveBeenCalled();
  await runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[10], stage: "remaining", reviewed: true }, { env: () => environment });
  expect(JSON.parse(m.run.mock.calls[0][0].env().SAV_INTAKE_COMPARISON_JSON)).toEqual({ ...config, messageIds: [ids[10]], maxNanoUsd: 20e9 });
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
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[10], stage: "remaining", reviewed: true }, { env: () => environment })).rejects.toThrow("REVIEW_REQUIRED");
  expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it("does not equate a divergence or an old-reader error with a bad simple decision", () => {
  const report = good(); report.rows[0].verdict = "divergent"; Object.assign(report.rows[0].detail!, { current: { technical: "OLD_FAILURE" } });
  expect(comparisonSentinelsReady(report as never)).toBe(true);
});
it("refuses client supplied scope or money, and refuses a live-reader switch", async () => {
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels", messageIds: ids }, { env: () => environment })).rejects.toThrow();
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels", maxNanoUsd: 50e9 }, { env: () => environment })).rejects.toThrow();
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels" }, { env: () => ({ ...environment, SAV_INTAKE_PIPELINE: "simple" }) })).rejects.toThrow("LIVE_READER_CHANGED");
  expect(m.run).not.toHaveBeenCalled();
});
it("a removed or modified campaign is detected during dispatch revalidation", async () => {
  let live = { ...environment };
  await runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels" }, { env: () => live });
  const scoped = m.run.mock.calls[0][0].env; live = { ...environment, SAV_INTAKE_COMPARISON_JSON: JSON.stringify({ ...config, campaignId: "other" }) };
  expect(() => scoped()).toThrow("CONFIGURATION_CHANGED");
  live = { ...environment, SAV_INTAKE_COMPARISON_JSON: "" }; expect(() => scoped()).toThrow("CONFIGURATION_REQUIRED");
});
it("a lower approved cap is never raised by the operator", async () => {
  const env = () => ({ ...environment, SAV_INTAKE_COMPARISON_JSON: JSON.stringify({ ...config, maxNanoUsd: 2e9 }) });
  await runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[0], stage: "sentinels" }, { env });
  expect(JSON.parse(m.run.mock.calls[0][0].env().SAV_INTAKE_COMPARISON_JSON).maxNanoUsd).toBe(2e9);
});

it.each(["interrupted","technical","uncertain","coverage"])("SAV46 refuses advancing sentinels after %s, without dispatch or audit",async(fault)=>{
 const report=good();report.rows[0].state=fault==="interrupted"?"interrupted":"done";
 if(fault==="technical")Object.assign(report.rows[0].detail!.simple,{technical:"SAV_AI_TIMEOUT"});
 if(fault==="uncertain")Object.assign(report.rows[0].detail!.simple,{uncertain:true});
 if(fault==="coverage")Object.assign(report.rows[0].detail!,{coverage:["crm_missing"]});
 m.report.mockResolvedValue(report);
 await expect(runIntakeComparisonOperator({expectedCampaignId:config.campaignId,expectedMessageId:ids[0],stage:"sentinels"},{env:()=>environment})).rejects.toThrow("PREVIOUS_RESULT_REVIEW_REQUIRED");
 expect(m.run).not.toHaveBeenCalled();expect(m.values).not.toHaveBeenCalled();
});
it("SAV46 concurrent operator submissions cannot select different paid dossiers",async()=>{
 await Promise.all([runIntakeComparisonOperator({expectedCampaignId:config.campaignId,expectedMessageId:ids[0],stage:"sentinels"},{env:()=>environment}),runIntakeComparisonOperator({expectedCampaignId:config.campaignId,expectedMessageId:ids[0],stage:"sentinels"},{env:()=>environment})]);
 expect(m.run).toHaveBeenCalledTimes(2);
 for(const [options] of m.run.mock.calls)expect(JSON.parse(options.env().SAV_INTAKE_COMPARISON_JSON).messageIds).toEqual([ids[0]]);
});
it("SAV46 a completed phase returns without another command or audit",async()=>{
 m.report.mockResolvedValue(good());
 expect(await runIntakeComparisonOperator({expectedCampaignId:config.campaignId,expectedMessageId:ids[0],stage:"sentinels"},{env:()=>environment})).toMatchObject({compared:[]});
 expect(m.run).not.toHaveBeenCalled();expect(m.values).not.toHaveBeenCalled();
});

it("SAV46 refuses a delayed replay after the first result, rather than paying for the next dossier",async()=>{
 const command={expectedCampaignId:config.campaignId,stage:"sentinels",expectedMessageId:ids[0]};
 await runIntakeComparisonOperator(command,{env:()=>environment});
 expect(m.run).toHaveBeenCalledOnce();
 const report=good();report.rows[0].state="done";for(let i=1;i<10;i++){report.rows[i].state="pending";report.rows[i].detail=null;}
 m.report.mockResolvedValue(report);m.run.mockClear();m.values.mockClear();
 await expect(runIntakeComparisonOperator(command,{env:()=>environment})).rejects.toThrow("STALE_COMMAND");
 expect(m.run).not.toHaveBeenCalled();expect(m.values).not.toHaveBeenCalled();
 await runIntakeComparisonOperator({...command,expectedMessageId:ids[1]},{env:()=>environment});
 expect(JSON.parse(m.run.mock.calls[0][0].env().SAV_INTAKE_COMPARISON_JSON).messageIds).toEqual([ids[1]]);
});
it("SAV46 requires a rendered dossier token and never accepts a later dossier as the next",async()=>{
 await expect(runIntakeComparisonOperator({stage:"sentinels"},{env:()=>environment})).rejects.toThrow();
 await expect(runIntakeComparisonOperator({stage:"sentinels",expectedCampaignId:config.campaignId,expectedMessageId:ids[1]},{env:()=>environment})).rejects.toThrow("STALE_COMMAND");
 expect(m.run).not.toHaveBeenCalled();expect(m.values).not.toHaveBeenCalled();
});

it("SAV46 refuses an old form after the campaign changed, even if the dossier is the same",async()=>{
 await expect(runIntakeComparisonOperator({stage:"sentinels",expectedCampaignId:"previous-campaign",expectedMessageId:ids[0]},{env:()=>environment})).rejects.toThrow("STALE_COMMAND");
 expect(m.run).not.toHaveBeenCalled();expect(m.values).not.toHaveBeenCalled();
});

it.each(["legacy", "incomplete", "oversize", "invalid", "not_available"])("SAV-46 a %s receipt never qualifies a sentinel nor lets the campaign continue", async status => {
  const report = good(); report.rows[0].qualificationEvidence = status;
  m.report.mockResolvedValue(report);
  expect(comparisonSentinelsReady(report as never)).toBe(false);
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[10], stage: "remaining", reviewed: true }, { env: () => environment })).rejects.toThrow("REVIEW_REQUIRED");
  expect(m.run).not.toHaveBeenCalled(); expect(m.values).not.toHaveBeenCalled();
});
it.each(["missing", "invalid", "differs", "other_receipt", "other_claim"])("SAV-46 ten identical projections without a matching attestation of each receipt are not sentinels (%s)", async fault => {
  const report = good(), row = report.rows[9], attestation = row.attestation as Exclude<Attested, "invalid" | null>;
  if (fault === "missing") row.attestation = null;
  if (fault === "invalid") row.attestation = "invalid";
  if (fault === "differs") attestation.outcome = "differs_from_oracle";
  if (fault === "other_receipt") attestation.receiptSha256 = "f".repeat(64);
  if (fault === "other_claim") attestation.claimId = claim(42);
  m.report.mockResolvedValue(report);
  expect(comparisonSentinelsReady(report as never)).toBe(false);
  await expect(runIntakeComparisonOperator({ expectedCampaignId: config.campaignId, expectedMessageId: ids[10], stage: "remaining", reviewed: true }, { env: () => environment })).rejects.toThrow("SENTINELS_REVIEW_REQUIRED");
  expect(m.run).not.toHaveBeenCalled();
});
describe("SAV-46 one dossier's receipt and its attestation", () => {
  const verified = (over: Record<string, unknown> = {}) => ({ campaignId: config.campaignId, messageId: ids[0], claimId: claim(0), qualificationEvidence: "complete", verification: { ok: true, reason: null },
    detail: { evidence: { receiptSha256: receipt(0) } }, attestation: null, receipt: {}, ...over });
  const attestation = { kind: "attestation", expectedCampaignId: config.campaignId, messageId: ids[0], receiptSha256: receipt(0), oracleSha256: "b".repeat(64), outcome: "matches_oracle", confirmed: true };
  it.each(["staff", "owner", "absent"])("refuses %s before any lookup or decryption", async role => {
    if (role === "absent") m.auth.mockRejectedValue(Error("NO_SESSION")); else m.auth.mockResolvedValue({ role, email: "staff@example.invalid" });
    await expect(readIntakeComparisonEvidence(ids[0], { env: () => environment })).rejects.toThrow();
    await expect(attestIntakeComparison(attestation, { env: () => environment })).rejects.toThrow();
    expect(m.evidence).not.toHaveBeenCalled(); expect(m.attest).not.toHaveBeenCalled();
  });
  it("refuses a malformed identifier before any lookup", async () => {
    await expect(readIntakeComparisonEvidence("../x", { env: () => environment })).rejects.toThrow(); expect(m.evidence).not.toHaveBeenCalled();
  });
  it("records an attestation bound to the claim and the exact receipt, and never starts a comparison", async () => {
    m.evidence.mockResolvedValue(verified());
    expect(await attestIntakeComparison(attestation, { env: () => environment })).toEqual({ campaignId: config.campaignId, messageId: ids[0], outcome: "matches_oracle" });
    expect(m.attest).toHaveBeenCalledWith(expect.objectContaining({ campaignId: config.campaignId, messageId: ids[0], claimId: claim(0), receiptSha256: receipt(0), oracleSha256: "b".repeat(64) }), "admin@example.invalid");
    expect(m.run).not.toHaveBeenCalled();
  });
  it.each([["legacy", { qualificationEvidence: "legacy", verification: null }], ["incomplete", { qualificationEvidence: "incomplete" }], ["tampered", { qualificationEvidence: "invalid", verification: { ok: false, reason: "receipt_sha256_mismatch" } }],
    ["stale receipt", { detail: { evidence: { receiptSha256: "e".repeat(64) } } }]] as const)("refuses to attest a %s receipt", async (_name, over) => {
    m.evidence.mockResolvedValue(verified(over));
    await expect(attestIntakeComparison(attestation, { env: () => environment })).rejects.toThrow(/NOT_QUALIFIABLE|STALE_COMMAND/);
    expect(m.attest).not.toHaveBeenCalled();
  });
  it("refuses an attestation without explicit confirmation or oracle, or for another campaign", async () => {
    for (const bad of [{ ...attestation, confirmed: false }, { ...attestation, oracleSha256: "" }, { ...attestation, expectedCampaignId: "previous-campaign" }])
      await expect(attestIntakeComparison(bad, { env: () => environment })).rejects.toThrow();
    expect(m.attest).not.toHaveBeenCalled();
  });
});
