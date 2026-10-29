import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({classify:vi.fn(),revalidate:vi.fn()}));
vi.mock("@/lib/sav/intake/manual-other-classification",()=>({classifyValidSourceAsOther:mocks.classify}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
import {classifyManualOtherAction} from "./manual-other-actions";
const command={revision:"sav-intake-manual-other.v2",requestKey:"request",threadId:"thread",messageId:"message",runId:"run",version:1,attachmentCount:0,runSourceHash:null,sourceHash:"a".repeat(64),expectedEpoch:4,reason:"Explicit human reason.",confirmed:true};
function form(confirmed=true){const form=new FormData();for(const[key,value]of Object.entries(command))if(value!==null)form.set(key,String(value));form.set("runSourceHash","");if(confirmed)form.set("confirmed","on");else form.delete("confirmed");return form;}
beforeEach(()=>{vi.clearAllMocks();mocks.classify.mockResolvedValue({marked:1,alreadyCompleted:0,skipped:{}});});
it.each([false,true])("passes the exact binding and explicit confirmation %s",async confirmed=>{
 await classifyManualOtherAction({ok:false,message:""},form(confirmed));expect(mocks.classify).toHaveBeenCalledExactlyOnceWith({...command,confirmed});
});
it.each([{marked:1,alreadyCompleted:0},{marked:0,alreadyCompleted:1}])("refreshes only after canonical success or idempotence",async result=>{
 mocks.classify.mockResolvedValue({...result,skipped:{}});expect((await classifyManualOtherAction({ok:false,message:""},form())).ok).toBe(true);
 expect(mocks.revalidate.mock.calls.map(args=>args[0])).toEqual(["/studio/sav/intake/thread","/studio/sav/intake"]);
});
it.each(["active_worker","source_changed","unsettled_action"])("reports %s without refreshing or claiming a classification",async reason=>{
 mocks.classify.mockResolvedValue({marked:0,alreadyCompleted:0,skipped:{[reason]:1}});expect((await classifyManualOtherAction({ok:false,message:""},form())).ok).toBe(false);expect(mocks.revalidate).not.toHaveBeenCalled();
});
it("does not expose an exception or claim success",async()=>{
 mocks.classify.mockRejectedValue(Error("PRIVATE_INTERNAL_EXCEPTION"));const result=await classifyManualOtherAction({ok:false,message:""},form());expect(result.ok).toBe(false);expect(result.message).not.toContain("PRIVATE");expect(mocks.revalidate).not.toHaveBeenCalled();
});

it("asks for readback when canonical commit succeeded but cache refresh failed",async()=>{
 mocks.revalidate.mockImplementationOnce(()=>{throw Error("CACHE_REFRESH_FAILED");});
 const result=await classifyManualOtherAction({ok:false,message:""},form());
 expect(mocks.classify).toHaveBeenCalledTimes(1);expect(result.ok).toBe(false);
 expect(result.message).toContain("Impossible de confirmer");expect(result.message).toContain("Rechargez le dossier");
 expect(result.message).not.toContain("non enregistré");expect(result.message).not.toContain("CACHE_REFRESH_FAILED");
});
