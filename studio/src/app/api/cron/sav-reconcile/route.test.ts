import { afterEach, beforeEach, expect, it, vi } from "vitest";
const d=vi.hoisted(()=>({gmail:vi.fn(),hubspot:vi.fn(),send:vi.fn(),ticket:vi.fn(),pilotActions:vi.fn(),pilot:vi.fn(),messages:vi.fn(),followups:vi.fn(),observations:vi.fn(),retention:vi.fn(),trainings:vi.fn(),evaluations:vi.fn(),openings:vi.fn(),context:vi.fn(),projection:vi.fn(),enabled:vi.fn()}));
vi.mock("@/lib/sav/gmail",()=>({processPendingGmailReceipts:d.gmail,processPendingGmailSendActions:d.send}));
vi.mock("@/lib/sav/hubspot",()=>({processPendingHubspotReceipts:d.hubspot,processPendingHubspotActions:d.ticket,processPendingPilotHubspotActionsAcrossBatches:d.pilotActions,getHubspotBackfillState:vi.fn(async()=>null),shouldAttemptHubspotBackfill:vi.fn(()=>false),continueHubspotBackfill:vi.fn()}));
vi.mock("@/lib/sav/service",()=>({processPendingSavPilotItems:d.pilot,processPendingSavMessages:d.messages}));
vi.mock("@/lib/sav/followups",()=>({processDueFollowups:d.followups}));
vi.mock("@/lib/sav/observations",()=>({reconcileSavObservations:d.observations}));
vi.mock("@/lib/sav/retention",()=>({enforceSavRetention:d.retention}));
vi.mock("@/lib/training",()=>({reconcileStaleTrainings:d.trainings}));
vi.mock("@/lib/evaluations",()=>({expireStaleEvaluationRuns:d.evaluations}));
vi.mock("@/lib/sav/dispatch",()=>({dispatchPendingSavEmailOpenings:d.openings,processPendingSavContextRefreshes:d.context}));
vi.mock("@/lib/sav/dashboard-projection",()=>({refreshSavDashboardProjection:d.projection,savSqlDashboardEnabled:d.enabled}));
import {GET} from "./route";
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv("CRON_SECRET","synthetic-local-cron-token");vi.stubEnv("SAV_HUBSPOT_BACKFILL_ENABLED","false");
  for(const fn of Object.values(d))fn.mockResolvedValue({processed:0});d.enabled.mockReturnValue(false);
});
afterEach(()=>vi.unstubAllEnvs());
const request=()=>new Request("http://localhost/api/cron/sav-reconcile",{headers:{authorization:"Bearer synthetic-local-cron-token"}});
it("authenticates before all shared work",async()=>{
  expect((await GET(new Request("http://localhost/api/cron/sav-reconcile"))).status).toBe(401);
  expect(d.gmail).not.toHaveBeenCalled();expect(d.openings).not.toHaveBeenCalled();expect(d.projection).not.toHaveBeenCalled();
});
it("keeps training/evaluation and ordered ticket/reply reconciliation, with SQL disabled by default",async()=>{
  const response=await GET(request());expect(response.status).toBe(200);
  expect(d.openings).toHaveBeenCalledWith(10);expect(d.context).toHaveBeenCalledWith(5);
  expect(d.trainings).toHaveBeenCalledTimes(1);expect(d.evaluations).toHaveBeenCalledTimes(1);expect(d.projection).not.toHaveBeenCalled();
  expect(d.ticket.mock.invocationCallOrder[0]).toBeLessThan(d.send.mock.invocationCallOrder[0]);
  expect(d.ticket.mock.invocationCallOrder[1]).toBeGreaterThan(d.send.mock.invocationCallOrder[0]);
  expect(await response.json()).toMatchObject({dashboardProjection:{status:"skipped",data:{reason:"disabled"}}});
});
it("continues shared recovery after a dispatch failure and reports that failure",async()=>{
  d.openings.mockRejectedValue(new Error("SYNTHETIC_DISPATCH_UNAVAILABLE"));
  const response=await GET(request());expect(response.status).toBe(500);
  expect(d.context).toHaveBeenCalled();expect(d.trainings).toHaveBeenCalled();expect(d.send).toHaveBeenCalled();
  expect(await response.json()).toMatchObject({emailOpenings:{status:"error",errorCode:"SYNTHETIC_DISPATCH_UNAVAILABLE"}});
});
it("only repairs a bounded projection batch when explicitly enabled",async()=>{
  d.enabled.mockReturnValue(true);expect((await GET(request())).status).toBe(200);expect(d.projection).toHaveBeenCalledWith(100);
});
