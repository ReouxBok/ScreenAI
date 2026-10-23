import {afterEach,expect,it,vi} from "vitest";
const request=vi.hoisted(()=>vi.fn());
vi.mock("../hubspot-transport",()=>({requestSavHubspot:request}));
import {crmRecordUrl} from "./crm-display";
import {readIntakeCrmDisplay} from "./crm-display-server";
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it("constructs only contact/ticket links for a numeric configured portal and record",()=>{
 expect(crmRecordUrl("123","contact","456")).toBe("https://app.hubspot.com/contacts/123/record/0-1/456");
 expect(crmRecordUrl("123","ticket","456")).toContain("/record/0-5/456");
 for(const p of [undefined,"123/evil","https://other.invalid"])expect(crmRecordUrl(p,"contact","456")).toBeNull();
 expect(crmRecordUrl("123","contact","../other")).toBeNull();
});
it("batches only authorized record IDs, keeps display separate and tolerates missing names",async()=>{
 vi.stubEnv("HUBSPOT_PORTAL_ID","123");vi.stubEnv("HUBSPOT_ACCESS_TOKEN","synthetic");
 request.mockImplementation(async(path:string)=>({status:"COMPLETE",results:path.includes("contacts")?[{id:"10",properties:{firstname:"Alice",lastname:"Test"}},{id:"11",properties:{email:"fixture@example.invalid"}},{id:"99",properties:{firstname:"Unrequested"}}]:[{id:"20",properties:{subject:"Connexion interrompue"}}]}));
 const v=await readIntakeCrmDisplay(["10","10","11","bad"],["20"]);
 expect(v.contacts["10"].label).toBe("Alice Test");expect(v.contacts["11"].label).toBe("fixture@example.invalid");expect(v.contacts["99"]).toBeUndefined();expect(v.tickets["20"].label).toBe("Connexion interrompue");
 expect(request).toHaveBeenCalledTimes(2);for(const [path,init] of request.mock.calls){expect(path).toMatch(/^\/crm\/v3\/objects\/(contacts|tickets)\/batch\/read$/);expect(init.method).toBe("POST");expect(init.redirect).toBe("error");expect(init.signal).toBeInstanceOf(AbortSignal);}
});
it("does not invent data on failed, partial or archived results and keeps valid fallback links",async()=>{
 vi.stubEnv("HUBSPOT_PORTAL_ID","123");vi.stubEnv("HUBSPOT_ACCESS_TOKEN","synthetic");
 for(const response of [{status:"PENDING",results:[]},{status:"COMPLETE",errors:[{}],results:[]},{status:"COMPLETE",results:[{id:"10",archived:true,properties:{firstname:"Archived"}}]}]){
  request.mockResolvedValue(response);const v=await readIntakeCrmDisplay(["10"],[]);expect(v.contacts["10"]).toMatchObject({available:false,label:"Fiche client — nom indisponible",url:"https://app.hubspot.com/contacts/123/record/0-1/10"});
 }
 request.mockRejectedValue(Error("synthetic"));expect((await readIntakeCrmDisplay(["10"],[])).contacts["10"].available).toBe(false);
});
it("does not read the provider without a configured portal/token and caps each batch at100",async()=>{
 vi.stubEnv("HUBSPOT_PORTAL_ID","");vi.stubEnv("HUBSPOT_ACCESS_TOKEN","");await readIntakeCrmDisplay(["10"],[]);expect(request).not.toHaveBeenCalled();
 vi.stubEnv("HUBSPOT_PORTAL_ID","123");vi.stubEnv("HUBSPOT_ACCESS_TOKEN","synthetic");request.mockResolvedValue({status:"COMPLETE",results:[]});
 const v=await readIntakeCrmDisplay(Array.from({length:110},(_,i)=>String(i+1)),[]);expect(Object.keys(v.contacts)).toHaveLength(100);expect(JSON.parse(request.mock.calls[0][1].body).inputs).toHaveLength(100);
});
