import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({state:{ok:false,message:"",code:undefined as string|undefined},pending:false}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useActionState:()=>[m.state,vi.fn(),m.pending]}));
vi.mock("./actions",()=>({runComparisonAction:vi.fn()}));
import {comparisonActionResponse,COMPARISON_RESPONSE_LOST} from "./action-response";
import {ComparisonForm} from "./comparison-form";
beforeEach(()=>{m.state={ok:false,message:"",code:undefined};m.pending=false});
it("keeps a lost command response explicit and never retries it",async()=>{
 const action=vi.fn().mockRejectedValue(Error("PRIVATE_NETWORK_BODY"));
 const result=await comparisonActionResponse(action,{ok:false,message:""},new FormData());
 expect(action).toHaveBeenCalledOnce();expect(result.code).toBe(COMPARISON_RESPONSE_LOST);
 expect(result.message).toContain("peut avoir été comparé et facturé");expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
it("shows a read-only full navigation and disables a new comparison after response loss",()=>{
 m.state={ok:false,code:COMPARISON_RESPONSE_LOST,message:"Consultez le rapport"};
 const html=renderToStaticMarkup(createElement(ComparisonForm,{stage:"sentinels",ready:true,complete:false,campaignId:"synthetic-60",expectedMessageId:"00000000-0000-4000-8000-000000000001"}));
 expect(html).toContain('<fieldset disabled=""');expect(html).toContain('type="button"');expect(html).toContain('Consulter le rapport sans relancer');
 expect(html).toContain('name="expectedMessageId"');expect(html).toContain('value="00000000-0000-4000-8000-000000000001"');expect(html).toContain('role="alert"');expect(html).not.toContain("Réessayer");
});
it("preserves successful and explicit server error responses",async()=>{
 for(const result of [{ok:true,message:"Fini"},{ok:false,message:"Refus",code:"SAV_INTAKE_COMPARISON_BUDGET_EXHAUSTED"}]){
  const action=vi.fn().mockResolvedValue(result);expect(await comparisonActionResponse(action,{ok:false,message:""},new FormData())).toEqual(result);expect(action).toHaveBeenCalledOnce();
 }
});
