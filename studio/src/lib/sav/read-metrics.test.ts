import { afterEach, expect, it, vi } from "vitest";
import { countSavRead, measureSavDashboardRead } from "./read-metrics";
afterEach(()=>vi.restoreAllMocks());
it("isolates concurrent read counters and only emits aggregate fields",async()=>{
  const info=vi.spyOn(console,"info").mockImplementation(()=>{});
  countSavRead("queries",99);
  await Promise.all([1,2].map(count=>measureSavDashboardRead("sql",async()=>{countSavRead("queries",count);await Promise.resolve();countSavRead("sourceRows",count);})));
  expect(info.mock.calls.map(args=>args[1].queries).sort()).toEqual([1,2]);
  expect(info.mock.calls.map(args=>args[1].sourceRows).sort()).toEqual([1,2]);
  expect(Object.keys(info.mock.calls[0][1]).sort()).toEqual(["ciphertextBytes","classifiedRows","decryptions","durationMs","mode","queries","relatedRows","revision","sourceRows","status"].sort());
});
it("distinguishes pending projection from failure without swallowing errors",async()=>{
  const info=vi.spyOn(console,"info").mockImplementation(()=>{});
  await expect(measureSavDashboardRead("sql",async()=>{throw new Error("SAV_DASHBOARD_PROJECTION_PENDING");})).rejects.toThrow("PENDING");
  expect(info.mock.calls[0][1].status).toBe("pending");
  await expect(measureSavDashboardRead("sql",async()=>{throw new Error("fixture-private-error-not-logged");})).rejects.toThrow();
  expect(info.mock.calls[1][1].status).toBe("failed");
  expect(JSON.stringify(info.mock.calls)).not.toContain("fixture-private-error-not-logged");
});
