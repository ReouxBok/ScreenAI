import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({complete:vi.fn(),revalidate:vi.fn()}));
vi.mock("@/lib/sav/external-completion",()=>({completeSavDossierManually:mocks.complete}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
import {completeIntakeDossierAction} from "./actions";
const previous={ok:false,message:""};
function form(confirmed=true){const data=new FormData();for(const [key,value]of Object.entries({requestKey:"request",threadId:"thread",messageId:"message"}))data.set(key,value);if(confirmed)data.set("confirmed","on");return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.complete.mockResolvedValue({marked:1,alreadyCompleted:0,skipped:{}});});
it.each([false,true])("passes the exact message, server-side request and explicit confirmation %s to the guarded operation",async confirmed=>{
 await completeIntakeDossierAction(previous,form(confirmed));expect(mocks.complete).toHaveBeenCalledWith({requestKey:"request",threadId:"thread",messageId:"message",confirmed});
});
it.each([{marked:1,alreadyCompleted:0},{marked:0,alreadyCompleted:1}])("refreshes both console views after actual or idempotent completion",async result=>{
 mocks.complete.mockResolvedValue({...result,skipped:{}});const state=await completeIntakeDossierAction(previous,form());expect(state.ok).toBe(true);
 expect(mocks.revalidate.mock.calls.map(args=>args[0])).toEqual(["/studio/sav/intake/thread","/studio/sav/thread","/studio/sav/intake","/studio/sav"]);
});
it.each(["active_worker","unsettled_action","new_inbound","not_live_eligible"])("keeps %s visible as a failed completion",async reason=>{
 mocks.complete.mockResolvedValue({marked:0,alreadyCompleted:0,skipped:{[reason]:1}});const state=await completeIntakeDossierAction(previous,form());expect(state.ok).toBe(false);expect(state.message).not.toContain("passé en Terminés");expect(mocks.revalidate).not.toHaveBeenCalled();
});
it("does not expose an exception or claim success after a permission/database failure",async()=>{
 mocks.complete.mockRejectedValue(Error("PRIVATE_ERROR"));const state=await completeIntakeDossierAction(previous,form());expect(state.ok).toBe(false);expect(state.message).not.toContain("PRIVATE_ERROR");expect(mocks.revalidate).not.toHaveBeenCalled();
});
