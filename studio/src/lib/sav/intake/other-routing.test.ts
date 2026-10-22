import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {readSavOtherAuthentication} from "../other-auth";
import {savOtherFamilies,type SavOtherRegistry} from "../other-observation";
import {qualifyIntakeOther,readIntakeOtherRules,intakeOtherQualificationFresh} from "./other-routing";
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const mailboxId="00000000-0000-4000-8000-000000000001",messageId="00000000-0000-4000-8000-000000000002";
const sender=savOtherFamilies.trustpilot_positive.sender,subject="Synthetic review 5 stars",text="Synthetic complete notification";
const input={mailboxId,mailboxEmail:"support@example.invalid",messageId,gmailMessageId:"m1",gmailThreadId:"t1",fromEmail:sender,subject,body:{text,headers:{"message-id":"message1","content-type":"text/plain","in-reply-to":"",references:""}},sourceHash:"a".repeat(64),protectedContext:false,inventoryComplete:true};
const registry:SavOtherRegistry={version:1,rules:[{mailboxId,family:"trustpilot_positive",subjectSha256:[hash(subject)]}]};
const proofInput={mailboxEmail:input.mailboxEmail,messageId:"m1",threadId:"t1",sender,signal:AbortSignal.timeout(1000)};
function response(headers?:Array<{name:string;value:string}>) {return {id:"m1",threadId:"t1",payload:{headers:headers??[{name:"From",value:sender},{name:"Authentication-Results",value:"mx.google.com; dkim=pass header.i=@trustpilot.com; dmarc=pass header.from=trustpilot.com"}]}};}
const proof=()=>readSavOtherAuthentication(proofInput,async()=>Response.json(response()));
function configuration(rules:unknown[]=[{id:"synthetic-rule",family:"trustpilot_positive",mailboxId,subjectSha256:hash(subject),bodySha256:hash(text)}]) {return JSON.stringify({version:1,resource:{resourceId:"synthetic-resource",revisionId:"v1",sha256:hash(JSON.stringify(rules))},approvedBy:"synthetic-operator",approvedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),rules});}
it("qualifies an exact approved current body and authenticated mailbox/message only",async()=>{
 const network=async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{expect(String(url)).toContain("https://gmail.googleapis.com/gmail/v1/users/support%40example.invalid/messages/m1?format=metadata");expect(init?.method).toBe("GET");return Response.json(response());};
 const p=await readSavOtherAuthentication(proofInput,network);
 expect(qualifyIntakeOther(input,registry,readIntakeOtherRules(configuration()),p)).toMatchObject({messageId,sourceHash:input.sourceHash,ruleId:"synthetic-rule",family:"trustpilot_positive"});
});
it.each([
 ["different body",{body:{...input.body,text:text+" Please help me log in"}}],
 ["reply",{subject:"Re: "+subject}], ["wrong sender",{fromEmail:"sender@example.invalid"}],
 ["customer context",{protectedContext:true}], ["inventory incomplete",{inventoryComplete:false}],
 ["attachment",{body:{...input.body,attachments:[{}]}}], ["wrong mailbox",{mailboxId:messageId}],
 ["wrong message",{gmailMessageId:"m2"}], ["wrong thread",{gmailThreadId:"t2"}],
])("keeps %s in support",async(_name,patch)=>{expect(qualifyIntakeOther({...input,...patch},registry,readIntakeOtherRules(configuration()),await proof())).toBeNull();});
it("requires a transient server-issued proof, rejects copied/expired proofs and rule collisions",async()=>{
 const p=await proof(),catalogue=readIntakeOtherRules(configuration())!;
 expect(qualifyIntakeOther(input,registry,catalogue,p?{...p}:null)).toBeNull();
 expect(qualifyIntakeOther(input,registry,catalogue,p,new Date(Date.now()+61000))).toBeNull();
 const doubled={...catalogue,rules:[...catalogue.rules,{...catalogue.rules[0],id:"duplicate"}]};
 expect(qualifyIntakeOther(input,registry,doubled,p)).toBeNull();
 expect(qualifyIntakeOther(input,registry,null,p)).toBeNull();
});
it("validates approval digest/expiry and never treats observation config as routing authority",()=>{
 expect(readIntakeOtherRules(undefined)).toBeNull();expect(()=>readIntakeOtherRules(JSON.stringify(registry))).toThrow("CONFIGURATION_REQUIRED");
 const raw=JSON.parse(configuration());raw.resource.sha256="0".repeat(64);expect(()=>readIntakeOtherRules(JSON.stringify(raw))).toThrow("CONFIGURATION_REQUIRED");
 raw.resource.sha256=hash(JSON.stringify(raw.rules));raw.expiresAt=new Date(0).toISOString();expect(()=>readIntakeOtherRules(JSON.stringify(raw))).toThrow("CONFIGURATION_REQUIRED");
});
it.each([
 "mx.google.com; dkim=fail header.i=@trustpilot.com; dmarc=pass header.from=trustpilot.com",
 "mx.google.com; dkim=pass header.i=@evil.invalid; dmarc=pass header.from=trustpilot.com",
 "mx.google.com; dkim=pass header.i=@trustpilot.com; dmarc=fail header.from=trustpilot.com",
 "untrusted.invalid; dkim=pass header.i=@trustpilot.com; dmarc=pass header.from=trustpilot.com",
 "mx.google.com; spf=pass smtp.mailfrom=trustpilot.com",
])("rejects unauthenticated or non-aligned result %s",async(value)=>{
 expect(await readSavOtherAuthentication(proofInput,async()=>Response.json(response([{name:"From",value:sender},{name:"Authentication-Results",value}])))).toBeNull();
});
it("rejects duplicate headers, forwarded chain failures, a different Gmail response and unbounded metadata",async()=>{
 const data=response();data.payload.headers.push(data.payload.headers[1]);expect(await readSavOtherAuthentication(proofInput,async()=>Response.json(data))).toBeNull();
 const forwarded=response();forwarded.payload.headers.push({name:"ARC-Authentication-Results",value:"i=1; mx.google.com; dkim=fail"});expect(await readSavOtherAuthentication(proofInput,async()=>Response.json(forwarded))).toBeNull();
 expect(await readSavOtherAuthentication(proofInput,async()=>Response.json({...response(),id:"wrong"}))).toBeNull();
 await expect(readSavOtherAuthentication(proofInput,async()=>new Response("x".repeat(140000)))).rejects.toThrow();
});

it("revalidates catalogue expiration after qualification before publication",async()=>{
 const now=new Date(),raw=JSON.parse(configuration());raw.expiresAt=new Date(now.getTime()+1000).toISOString();
 const catalogue=readIntakeOtherRules(JSON.stringify(raw),now),qualified=qualifyIntakeOther(input,registry,catalogue,await proof(),new Date());
 expect(qualified).not.toBeNull();expect(intakeOtherQualificationFresh(qualified!,JSON.stringify(raw),now)).toBe(true);
 expect(intakeOtherQualificationFresh(qualified!,JSON.stringify(raw),new Date(now.getTime()+1001))).toBe(false);
});
