import { describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({db:vi.fn(),day:vi.fn(),policy:vi.fn(),shared:vi.fn()}));
vi.mock("../shared-spend",()=>({savSharedSpendAvailable:f.shared}));
vi.mock("@/db",()=>({requireDb:f.db}));
vi.mock("./investigation-v2-spend",()=>({readCaseV2SpendPolicy:f.policy,readCaseV2SpendDay:f.day}));
import { enqueueApprovedJ2, j2BudgetAvailable, readJ2ReminderEffect, reconcileCaseJ2 } from "./v2-j2-binding";

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
