import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
const mocks = vi.hoisted(() => ({ db: null as unknown, staff: vi.fn(), budget: vi.fn(), config: vi.fn(), pause: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => { if (!mocks.db) throw Error("NO_DB"); return mocks.db; } }));
vi.mock("./console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("./budget-admin", () => ({ intakeBudgetOwner: mocks.budget }));
vi.mock("./runtime-contract",()=>({savIntakeRuntimeConfig:mocks.config}));
vi.mock("./agent-pause", () => ({ readSavAgentPause: mocks.pause }));
import { readIntakeMonitoring, projectMonitoringActivity } from "./monitoring-read";
let f: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { f = await createSavTestDb(); mocks.db = f.db; }, 120000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => { vi.clearAllMocks(); mocks.db=f.db; await f.db.delete(savSyncState); mocks.staff.mockResolvedValue({ email: "staff@example.invalid" }); mocks.pause.mockResolvedValue({level:"running",invalid:false}); });
const now = new Date("2026-11-09T12:00:00Z"), at = "2026-11-09T11:59:00Z";
const pulse = (value: unknown, status="finished") => ({key:"sav-monitor:v1:worker",status,cursor:JSON.stringify(value)});
it("never equates permission or a start with successful activity and keeps failed, stale and missing distinct", () => {
 expect(projectMonitoringActivity([], now).state).toBe("missing");
 expect(projectMonitoringActivity([pulse({startedAt:at})],now).state).toBe("stale");
 expect(projectMonitoringActivity([pulse({startedAt:at,lastFinishedAt:at,failed:true})],now).state).toBe("failed");
 expect(projectMonitoringActivity([pulse({startedAt:at,lastFinishedAt:"2026-11-09T11:00:00Z"})],now).state).toBe("stale");
 expect(projectMonitoringActivity([pulse({startedAt:at,lastFinishedAt:at,lastSucceededAt:at})],now).state).toBe("observed");
});
it("rejects malformed, oversized and future metadata while preserving partial collection", () => {
 for(const value of [{startedAt:"invalid"},{startedAt:"2026-11-10T11:00:00Z"},{startedAt:at,secret:"x".repeat(9000)}]) expect(projectMonitoringActivity([pulse(value)],now).state).toBe("unavailable");
 const result=projectMonitoringActivity([{key:"sav-monitor:v1:snapshot",status:"partial",cursor:JSON.stringify({observedAt:at,complete:false,secret:"never return"})}],now);
 expect(result.collection).toBe("partial");expect(JSON.stringify(result)).not.toContain("never return");
});
it("authenticates before reading and never calls the owner budget reader for other staff", async () => {
 mocks.staff.mockRejectedValueOnce(Error("UNAUTHORIZED"));mocks.db=null;
 await expect(readIntakeMonitoring()).rejects.toThrow("UNAUTHORIZED");expect(mocks.budget).not.toHaveBeenCalled();
 mocks.db=f.db; const result=await readIntakeMonitoring();
 expect(result).toMatchObject({permission:"running",configuration:"restricted",activity:{state:"missing"}});
 expect(mocks.budget).not.toHaveBeenCalled();expect(await f.db.select().from(savSyncState)).toHaveLength(0);
});
it("owner configuration uses the canonical authorization without bypass or leaking values", async () => {
 mocks.staff.mockResolvedValue({email:"ugo@limova.ai"});mocks.budget.mockResolvedValue({email:"ugo@limova.ai"});mocks.config.mockReturnValue({privateValue:"secret"});
 expect((await readIntakeMonitoring()).configuration).toBe("verified");expect(mocks.budget).toHaveBeenCalledExactlyOnceWith();
 mocks.budget.mockRejectedValue(Error("private error"));expect((await readIntakeMonitoring()).configuration).toBe("unavailable");
 mocks.budget.mockResolvedValue({email:"ugo@limova.ai"});mocks.config.mockImplementation(()=>{throw Error("private error");});
 const result=await readIntakeMonitoring();expect(result.configuration).toBe("unavailable");expect(JSON.stringify(result)).not.toMatch(/secret|private error/);
});
it("reads only the persisted metadata without changing it and reports unavailable on outage", async () => {
 const stamp=new Date().toISOString();await f.db.insert(savSyncState).values(pulse({startedAt:stamp,lastFinishedAt:stamp,secret:"private"}));
 const before=await f.db.select().from(savSyncState);expect((await readIntakeMonitoring()).activity.state).toBe("observed");
 expect(await f.db.select().from(savSyncState)).toEqual(before);
 mocks.db=null;expect((await readIntakeMonitoring()).activity.state).toBe("unavailable");
});

it("keeps human pause and unreadable authorization separate from worker evidence",async()=>{
 mocks.pause.mockResolvedValue({level:"fully_paused",invalid:false});expect((await readIntakeMonitoring()).permission).toBe("fully_paused");
 mocks.pause.mockResolvedValue({level:"actions_paused",invalid:false});expect((await readIntakeMonitoring()).permission).toBe("actions_paused");
 mocks.pause.mockResolvedValue({level:"fully_paused",invalid:true});expect((await readIntakeMonitoring()).permission).toBe("unknown");
});
