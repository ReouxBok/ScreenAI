import { describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({db:vi.fn(),day:vi.fn(),policy:vi.fn(),shared:vi.fn()}));
vi.mock("../shared-spend",()=>({savSharedSpendAvailable:f.shared}));
vi.mock("@/db",()=>({requireDb:f.db}));
vi.mock("./investigation-v2-spend",()=>({readCaseV2SpendPolicy:f.policy,readCaseV2SpendDay:f.day}));
const store=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock("./case-reply-store",()=>({enqueueApprovedCaseReply:store.enqueue}));
vi.mock("../crypto",async importOriginal=>({...await importOriginal<typeof import("../crypto")>(),decryptSavPayload:(value:unknown)=>value}));
import { enqueueApprovedJ2, j2BudgetAvailable, readJ2ReminderEffect, reconcileCaseJ2, sendQueuedJ2Now } from "./v2-j2-binding";

const timer={id:"10000000-0000-4000-8000-000000000001",caseId:"10000000-0000-4000-8000-000000000002"};
function rows(...results:unknown[][]) {
  f.db.mockReturnValue({select:()=>({from:()=>({where:()=>Promise.resolve(results.shift())})})});
}
describe("J2 wake binding",()=>{
  const on={SAV_V2_ENTRY:"on",SAV_CASE_RECORDING:"on",SAV_CASE_EFFECTS:"supervised",SAV_V2_J2:"on"};
  it("leaves an unconfigured or expired wake outside the database",async()=>{
    f.db.mockClear();
    expect(await reconcileCaseJ2({env:{},deadlineMs:Date.now()+5000})).toEqual({skipped:"j2_off"});
    expect(await reconcileCaseJ2({env:on,deadlineMs:NaN})).toEqual({skipped:"deadline"});
    expect(await reconcileCaseJ2({env:on,deadlineMs:Date.now()+5000})).toEqual({skipped:"j2_batch_unconfigured"});
    expect(await reconcileCaseJ2({env:{...on,SAV_V2_J2_BATCH:"2"},deadlineMs:Date.now()+5000})).toEqual({skipped:"execution_off"});
    expect(f.db).not.toHaveBeenCalled();
  });
  it.each([["acked","uncertain"],["uncertain","uncertain"],["unexpected","uncertain"],["confirmed","confirmed"],["planned","planned"],["dispatched","dispatched"],["failed","failed"]])("reads %s without issuing a new reminder",async(state,expected)=>{
    rows([{kind:"reply_send",state}]);expect(await readJ2ReminderEffect(timer)).toBe(expected);
  });
  it("distinguishes an enqueued parent from a timer without any effect",async()=>{
    rows([],[{id:"parent"}]);expect(await readJ2ReminderEffect(timer)).toBe("planned");
    rows([],[]);expect(await readJ2ReminderEffect(timer)).toBe("none");
    rows([{kind:"case_note",state:"confirmed"}]);expect(await readJ2ReminderEffect(timer)).toBe("uncertain");
  });
  it("reports a missing exact reminder approval without composing a substitute",async()=>{
    rows([]);expect(await enqueueApprovedJ2(timer,10,{id:"unused",hash:"unused"},{} as never)).toBe("reminder_approval_missing");
  });
  it("needs room in both V2 envelopes including held costs; never reserves",async()=>{
    const section={dailyCapMicroUsd:20,reserveMicroUsdPerCall:4};
    f.policy.mockReturnValue({ok:false});expect(await j2BudgetAvailable({},new Date())).toBe(false);
    f.policy.mockReturnValue({ok:true,policy:{model:section,embedding:section}});
    f.day.mockResolvedValueOnce(null).mockResolvedValueOnce({heldMicroUsd:12,settledMicroUsd:6});
    expect(await j2BudgetAvailable({},new Date())).toBe(false);
    f.day.mockResolvedValue(null);f.shared.mockResolvedValue(false);expect(await j2BudgetAvailable({},new Date())).toBe(false);
    f.shared.mockResolvedValue(true);expect(await j2BudgetAvailable({},new Date())).toBe(true);
    expect(f.shared).toHaveBeenLastCalledWith(8000,expect.any(Date));
  });
});

describe("J2 immediate send (11/11): the reminder this tick queued leaves at once, within the worker's budget",()=>{
  it("names the execution it CREATED (never one already queued) to the caller",async()=>{
    const proposal={purpose:"reminder",triggerEventId:`timer:${timer.id}`,caseId:timer.caseId,caseVersion:10};
    const queued:string[]=[];
    rows([{id:"validation-1",caseVersion:10,proposalCiphertext:proposal}]);
    store.enqueue.mockResolvedValueOnce({ok:true,created:true,executionId:"exec-new"});
    expect(await enqueueApprovedJ2(timer,10,{id:"p",hash:"h"},{} as never,id=>queued.push(id))).toBe("queued");
    rows([{id:"validation-1",caseVersion:10,proposalCiphertext:proposal}]);
    store.enqueue.mockResolvedValueOnce({ok:true,created:false,executionId:"exec-new"});
    expect(await enqueueApprovedJ2(timer,10,{id:"p",hash:"h"},{} as never,id=>queued.push(id))).toBe("already_queued");
    expect(queued).toEqual(["exec-new"]);
  });
  it("sends each queued reminder with the worker's deadline while a full send fits; short of budget it sends nothing and they stay queued",async()=>{
    const sendNow=vi.fn(async()=>({skipped:"effects_off"}));
    const deadlineMs=Date.now()+200_000;
    expect(await sendQueuedJ2Now(["a","b"],{env:{},deadlineMs,sendNow})).toEqual([{executionId:"a",outcome:{skipped:"effects_off"}},{executionId:"b",outcome:{skipped:"effects_off"}}]);
    expect(sendNow.mock.calls).toEqual([[{env:{},executionId:"a",callerDeadlineMs:deadlineMs}],[{env:{},executionId:"b",callerDeadlineMs:deadlineMs}]]);
    sendNow.mockClear();
    expect(await sendQueuedJ2Now(["c"],{env:{},deadlineMs:Date.now()+30_000,sendNow})).toEqual([{executionId:"c",outcome:{skipped:"caller_budget"}}]);
    expect(sendNow).not.toHaveBeenCalled();
    expect(await sendQueuedJ2Now(["d"],{env:{},deadlineMs,sendNow:null})).toEqual([]);
    sendNow.mockRejectedValueOnce(Error("SYNTHETIC"));
    expect(await sendQueuedJ2Now(["e"],{env:{},deadlineMs,sendNow})).toEqual([{executionId:"e",outcome:{failed:"SAV_V2_IMMEDIATE_SEND_THREW"}}]);
  });
});
