vi.mock("@/lib/sav/intake/executor",()=>({reconcileIntakeExecutor:d.intakeExec}));
vi.mock("@/lib/sav/intake/gmail-read",()=>({reconcileHandledIntakeGmailRead:vi.fn(async()=>({skipped:"off"}))}));
vi.mock("@/lib/sav/intake/runtime",()=>({reconcileSavIntakeRuntime:d.intakeRuntime}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const monitor=vi.hoisted(()=>({pulse:vi.fn()}));
vi.mock("@/lib/sav/monitor",()=>({recordSavWorkerPulse:monitor.pulse}));
const d=vi.hoisted(()=>({gmail:vi.fn(),hubspot:vi.fn(),send:vi.fn(),ticket:vi.fn(),pilotActions:vi.fn(),pilot:vi.fn(),messages:vi.fn(),followups:vi.fn(),observations:vi.fn(),retention:vi.fn(),trainings:vi.fn(),evaluations:vi.fn(),openings:vi.fn(),context:vi.fn(),projection:vi.fn(),enabled:vi.fn(),intakeExec:vi.fn(),intakeRuntime:vi.fn(),intakeChoices:vi.fn(),intakeTracking:vi.fn(),intakeConsole:vi.fn(),translations:vi.fn()}));
vi.mock("@/lib/sav/gmail",()=>({processPendingGmailReceipts:d.gmail,processPendingGmailSendActions:d.send}));
vi.mock("@/lib/sav/hubspot",()=>({processPendingHubspotReceipts:d.hubspot,processPendingHubspotActions:d.ticket,processPendingPilotHubspotActionsAcrossBatches:d.pilotActions,getHubspotBackfillState:vi.fn(async()=>null),shouldAttemptHubspotBackfill:vi.fn(()=>false),continueHubspotBackfill:vi.fn()}));
vi.mock("@/lib/sav/service",()=>({processPendingSavPilotItems:d.pilot,processPendingSavMessages:d.messages}));
vi.mock("@/lib/sav/followups",()=>({processDueFollowups:d.followups}));
vi.mock("@/lib/sav/observations",()=>({reconcileSavObservations:d.observations}));
vi.mock("@/lib/sav/retention",()=>({enforceSavRetention:d.retention}));
vi.mock("@/lib/sav/translations",()=>({reconcileSavTranslations:d.translations}));
vi.mock("@/lib/training",()=>({reconcileStaleTrainings:d.trainings}));
vi.mock("@/lib/evaluations",()=>({expireStaleEvaluationRuns:d.evaluations}));
vi.mock("@/lib/sav/dispatch",()=>({dispatchPendingSavEmailOpenings:d.openings,processPendingSavContextRefreshes:d.context}));
vi.mock("@/lib/sav/dashboard-projection",()=>({refreshSavDashboardProjection:d.projection,savSqlDashboardEnabled:d.enabled}));
vi.mock("@/lib/sav/intake/human-worker",()=>({reconcileIntakeHumanChoices:d.intakeChoices}));
vi.mock("@/lib/sav/intake/observation-binding",()=>({ensureIntakeObservations:d.intakeTracking}));
vi.mock("@/lib/sav/intake/console-store",()=>({refreshIntakeConsole:d.intakeConsole}));
const relays=vi.hoisted(()=>({sweep:vi.fn()}));
vi.mock("@/lib/sav/cases/intake-boundary",()=>({sweepCaseRelays:relays.sweep}));
import {GET} from "./route";
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv("CRON_SECRET","synthetic-local-cron-token");vi.stubEnv("SAV_HUBSPOT_BACKFILL_ENABLED","false");
  monitor.pulse.mockResolvedValue(true);
  for(const fn of Object.values(d))fn.mockResolvedValue({processed:0});d.enabled.mockReturnValue(false);
});
afterEach(()=>vi.unstubAllEnvs());
const request=()=>new Request("http://localhost/api/cron/sav-reconcile",{headers:{authorization:"Bearer synthetic-local-cron-token"}});
it("authenticates before all shared work",async()=>{
  expect((await GET(new Request("http://localhost/api/cron/sav-reconcile"))).status).toBe(401);
  expect(d.gmail).not.toHaveBeenCalled();expect(d.openings).not.toHaveBeenCalled();expect(d.projection).not.toHaveBeenCalled();
  expect(monitor.pulse).not.toHaveBeenCalled();
});
it("keeps training/evaluation and ordered ticket/reply reconciliation, with SQL disabled by default",async()=>{
  const response=await GET(request());expect(response.status).toBe(200);
  expect(d.openings).toHaveBeenCalledWith(10);expect(d.context).toHaveBeenCalledWith(5);
  expect(d.trainings).toHaveBeenCalledTimes(1);expect(d.evaluations).toHaveBeenCalledTimes(1);expect(d.projection).not.toHaveBeenCalled();
  expect(d.ticket.mock.invocationCallOrder[0]).toBeLessThan(d.send.mock.invocationCallOrder[0]);
  expect(d.ticket.mock.invocationCallOrder[1]).toBeGreaterThan(d.send.mock.invocationCallOrder[0]);
  expect(await response.json()).toMatchObject({dashboardProjection:{status:"skipped",data:{reason:"disabled"}}});
  expect(monitor.pulse).toHaveBeenCalledTimes(2);
  expect(monitor.pulse.mock.calls[1]).toEqual([...monitor.pulse.mock.calls[0],false]);
});
it("does not trigger the retired V0 follow-ups, and keeps receipts, the Lu opening, the intake steps and the human-command workers",async()=>{
  const response=await GET(request());expect(response.status).toBe(200);
  expect(d.followups).not.toHaveBeenCalled();
  const payload=await response.json() as Record<string,unknown>;
  expect(payload).not.toHaveProperty("followups");
  for(const key of ["gmail","hubspot","emailOpenings","contextRefreshes","intakeObservation","intakeWakes","intakeChoices","intakeExecution","intakeTracking","intakeConsole","intakeRead","ticketActions","replies","statusActions"])expect(payload).toHaveProperty(key);
  for(const fn of [d.gmail,d.hubspot,d.openings,d.context,d.intakeRuntime,d.intakeExec,d.send])expect(fn).toHaveBeenCalled();
});
it("does not trigger the retired V0 analysis: no pilot-item and no pending-message step, whatever the load",async()=>{
  const response=await GET(request());expect(response.status).toBe(200);
  expect(d.pilot).not.toHaveBeenCalled();expect(d.messages).not.toHaveBeenCalled();
  const payload=await response.json() as Record<string,unknown>;
  expect(payload).not.toHaveProperty("pilotItems");expect(payload).not.toHaveProperty("pendingMessages");
  expect(d.intakeRuntime).toHaveBeenCalled();
});
it("continues shared recovery after a dispatch failure and reports that failure",async()=>{
  d.openings.mockRejectedValue(new Error("SYNTHETIC_DISPATCH_UNAVAILABLE"));
  const response=await GET(request());expect(response.status).toBe(500);
  expect(d.context).toHaveBeenCalled();expect(d.trainings).toHaveBeenCalled();expect(d.send).toHaveBeenCalled();
  expect(await response.json()).toMatchObject({emailOpenings:{status:"error",errorCode:"SYNTHETIC_DISPATCH_UNAVAILABLE"}});
  expect(monitor.pulse.mock.calls.at(-1)?.at(-1)).toBe(true);
});
it("only repairs a bounded projection batch when explicitly enabled",async()=>{
  d.enabled.mockReturnValue(true);expect((await GET(request())).status).toBe(200);expect(d.projection).toHaveBeenCalledWith(25,undefined,{deadlineMs:expect.any(Number)});
});

it("prioritizes intake after ticket actions and before legacy model/derived work",async()=>{
  await GET(request());
  const order=(fn:typeof d.intakeRuntime)=>fn.mock.invocationCallOrder[0];
  expect(order(d.ticket)).toBeLessThan(order(d.intakeRuntime));
  expect(order(d.intakeRuntime)).toBeLessThan(order(d.intakeChoices));
  expect(order(d.intakeChoices)).toBeLessThan(order(d.intakeExec));
  expect(order(d.intakeExec)).toBeLessThan(order(d.intakeTracking));
  expect(order(d.intakeExec)).toBeLessThan(order(d.observations));
  expect(order(d.intakeExec)).toBeLessThan(order(d.translations));
});
it("keeps the shared deadline and skips new human/effect dispatch if earlier recovery consumed it",async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date());
  d.ticket.mockImplementationOnce(async()=>{vi.setSystemTime(new Date(Date.now()+240000));return {processed:0};});
  try {
    const response=await GET(request());expect(d.intakeChoices).not.toHaveBeenCalled();expect(d.intakeExec).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({intakeChoices:{data:{skipped:"deadline"}},intakeExecution:{data:{skipped:"deadline"}}});
  } finally {vi.useRealTimers();}
});
it("SAV-11: the V2 catch-up runs after the intake execution only when the relay is on, and never loads the case code otherwise",async()=>{
  const off=await (await GET(request())).json() as Record<string,unknown>;
  expect(off).toMatchObject({caseRelays:{status:"ok",data:{skipped:"recording_off"}}});expect(relays.sweep).not.toHaveBeenCalled();
  vi.stubEnv("SAV_CASE_RECORDING","ON");
  expect(await (await GET(request())).json()).toMatchObject({caseRelays:{data:{skipped:"recording_off"}}});expect(relays.sweep).not.toHaveBeenCalled();
  vi.stubEnv("SAV_CASE_RECORDING","on");relays.sweep.mockResolvedValue({relayed:1,unchanged:0,skipped:{}});
  const on=await GET(request());expect(on.status).toBe(200);
  expect(relays.sweep).toHaveBeenCalledTimes(1);expect(relays.sweep).toHaveBeenCalledWith({limit:50});
  expect(d.intakeExec.mock.invocationCallOrder[0]).toBeLessThan(relays.sweep.mock.invocationCallOrder[0]);
  expect(await on.json()).toMatchObject({caseRelays:{status:"ok",data:{relayed:1}}});
  // A failed catch-up is reported, like any step, and the later steps still run.
  relays.sweep.mockRejectedValueOnce(new Error("SYNTHETIC_CASE_RELAY_DOWN"));
  const failed=await GET(request());expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({caseRelays:{status:"error",errorCode:"SYNTHETIC_CASE_RELAY_DOWN"}});expect(d.intakeTracking).toHaveBeenCalled();
});
it("SAV-11: the V2 catch-up keeps the shared deadline",async()=>{
  vi.stubEnv("SAV_CASE_RECORDING","on");vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date());
  d.ticket.mockImplementationOnce(async()=>{vi.setSystemTime(new Date(Date.now()+260000));return {processed:0};});
  try {expect(await (await GET(request())).json()).toMatchObject({caseRelays:{data:{skipped:"deadline"}}});expect(relays.sweep).not.toHaveBeenCalled();}
  finally {vi.useRealTimers();}
});

it("keeps both V2 switches closed on the shared reconcile entry, then honors the effects switch", async () => {
  expect(await (await GET(request())).json()).toMatchObject({ caseEffects: { data: { skipped: "v2_off" } }, caseReminders: { data: { skipped: "j2_off" } } });
  vi.stubEnv("SAV_V2_ENTRY", "on");
  expect(await (await GET(request())).json()).toMatchObject({ caseEffects: { data: { skipped: "v2_off" } } });
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  const report = await (await GET(request())).json();
  expect(report.caseEffects).toMatchObject({ status: "ok", data: { skipped: "effects_off" } });
});
