import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({classify:vi.fn(),revalidate:vi.fn()}));
vi.mock("@/lib/sav/intake/invalid-source-classification",()=>({classifyInvalidSourceAsOther:mocks.classify}));
vi.mock("@/lib/sav/external-completion",()=>({completeSavDossierManually:vi.fn()}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
import {classifyInvalidSourceAction} from "./actions";
const previous={ok:false,message:""};
function form(confirmed=true){const data=new FormData();for(const [key,value]of Object.entries({requestKey:"request",threadId:"thread",messageId:"message"}))data.set(key,value);if(confirmed)data.set("confirmed","on");return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.classify.mockResolvedValue({marked:1,alreadyCompleted:0,skipped:{}});});
it.each([false,true])("passes the exact message and explicit confirmation %s to the guarded classification",async confirmed=>{
 await classifyInvalidSourceAction(previous,form(confirmed));expect(mocks.classify).toHaveBeenCalledWith({requestKey:"request",threadId:"thread",messageId:"message",confirmed});
});
it("reports an actual or idempotent classification and refreshes the console",async()=>{
 const state=await classifyInvalidSourceAction(previous,form());expect(state.ok).toBe(true);expect(state.message).toContain("Autres");
 expect(mocks.revalidate.mock.calls.map(args=>args[0])).toEqual(["/studio/sav/intake/thread","/studio/sav/intake"]);
});
it.each(["active_worker","unsettled_action","new_inbound"])("keeps %s visible as a refusal",async reason=>{
 mocks.classify.mockResolvedValue({marked:0,alreadyCompleted:0,skipped:{[reason]:1}});const state=await classifyInvalidSourceAction(previous,form());expect(state.ok).toBe(false);expect(mocks.revalidate).not.toHaveBeenCalled();
});
it("never exposes an exception after a refused or failed classification",async()=>{
 mocks.classify.mockRejectedValue(Error("SAV_INTAKE_SOURCE_NOT_INVALID"));const state=await classifyInvalidSourceAction(previous,form());expect(state.ok).toBe(false);expect(state.message).not.toContain("SAV_INTAKE");
});
