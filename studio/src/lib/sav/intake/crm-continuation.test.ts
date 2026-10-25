import { createHash } from "node:crypto";
import { beforeEach,expect,it,vi } from "vitest";
import { qualifyCrmHistoryAdditions,readCrmAcknowledgementAuthority,isQualifiedCrmEmail } from "./crm-continuation";
import {assertExecutionCrmUnchanged} from "./execution-context";
import {encryptSavPayload} from "../crypto";
import type {CrmSnapshot,Effect} from "./execution-types";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const source={from:"customer@example.invalid",to:["support@example.invalid"],subject:"Synthetic failure",body:"It fails.",rfcMessageId:"<source@example.invalid>",mailbox:"support@example.invalid",gmailThreadId:"synthetic-thread"};
const body="Synthetic automatic acknowledgement. No customer request.",subject="Synthetic receipt";
const templates=[{id:"synthetic-ack",mailbox:source.mailbox,subjectSha256:hash(subject),bodySha256:hash(body)}];
function authority(){return JSON.stringify({version:1,resource:{resourceId:"synthetic-resource",revisionId:"v1",sha256:hash(JSON.stringify(templates))},templates,approvedBy:"synthetic-admin",approvedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});}
function fixture(native=false){
 const at=new Date().toISOString(),contact={id:"101",emails:[source.from]};
 const baseline:CrmSnapshot={address:source.from,lookup:[contact],contacts:{"101":contact},associations:[],tickets:{"101":[{id:"201",contactIds:["101"],stage:"open",createdAt:at,ownerId:null,subject:"Synthetic",content:"Synthetic"}]},histories:{"201":[]}};
 const email=native?{from:source.from,to:source.to.join(";"),direction:"INCOMING_EMAIL",subject:source.subject,body:source.body}:{from:source.mailbox,to:source.from,direction:"EMAIL",subject,body};
 const event={id:"emails:301",kind:"email" as const,at,text:JSON.stringify(email)},current=structuredClone(baseline);current.histories["201"]=[event];
 const row={id:"301",properties:{hs_email_from_email:email.from,hs_email_to_email:email.to,hs_email_direction:email.direction,hs_email_subject:email.subject,hs_email_text:email.body,hs_timestamp:at,hs_email_headers:JSON.stringify({messageId:native?source.rfcMessageId:"<ack@example.invalid>"})}};
 const effect={kind:"note_create",state:"confirmed",intentCiphertext:encryptSavPayload({kind:"note_create",ticketId:"201"}),verificationCiphertext:null,ackCiphertext:null} as Effect;
 return {baseline,current,row,effect,event};
}
beforeEach(()=>{vi.stubEnv("SAV_ENCRYPTION_KEY_V1","synthetic-execution-encryption-key-32-characters");});
it("requires exact private approval AND separately verified automatic origin",async()=>{
 const f=fixture(),verify=vi.fn(async()=>true),read=vi.fn(async()=>f.row);
 const proofs=await qualifyCrmHistoryAdditions(f.baseline,f.current,source,{authority:authority(),readEmail:read,verifyAckOrigin:verify});
 expect(proofs).toHaveLength(1);expect(isQualifiedCrmEmail(proofs[0])).toBe(true);expect(isQualifiedCrmEmail({...proofs[0]})).toBe(false);
 expect(()=>assertExecutionCrmUnchanged(f.baseline,f.current,[f.effect],{nextKind:"stage_new",qualifiedEmails:proofs})).not.toThrow();
 expect(await qualifyCrmHistoryAdditions(f.baseline,f.current,source,{authority:authority(),readEmail:read,verifyAckOrigin:async()=>false})).toEqual([]);
 expect(await qualifyCrmHistoryAdditions(f.baseline,f.current,source,{readEmail:read,verifyAckOrigin:verify})).toEqual([]);
});
it("recognizes a native source copy by transport id AND full envelope/content",async()=>{
 const f=fixture(true),options={readEmail:async()=>f.row,verifyAckOrigin:async()=>false};
 expect(await qualifyCrmHistoryAdditions(f.baseline,f.current,source,options)).toHaveLength(1);
 f.row.properties.hs_email_headers=JSON.stringify({messageId:"<different@example.invalid>"});expect(await qualifyCrmHistoryAdditions(f.baseline,f.current,source,options)).toHaveLength(0);
});
it.each(["human_email","owner","stage","contact","existing_note"])("keeps the %s protection even with an approved acknowledgement",async kind=>{
 const f=fixture();const proofs=await qualifyCrmHistoryAdditions(f.baseline,f.current,source,{authority:authority(),readEmail:async()=>f.row,verifyAckOrigin:async()=>true});
 if(kind==="human_email")f.current.histories["201"].push({...f.event,id:"emails:302",text:JSON.stringify({...JSON.parse(f.event.text),body:"New human question"})});
 if(kind==="owner")f.current.tickets["101"][0].ownerId="999";
 if(kind==="stage")f.current.tickets["101"][0].stage="closed";
 if(kind==="contact")f.current.contacts["101"].emails=["other@example.invalid"];
 if(kind==="existing_note")f.current.histories["201"].push({...f.event,id:"notes:901",kind:"note",text:"Human edit"});
 expect(()=>assertExecutionCrmUnchanged(f.baseline,f.current,[f.effect],{nextKind:"stage_new",qualifiedEmails:proofs})).toThrow("CRM_CHANGED");
});
it("rejects changed/expired authority and does not accept a subject/domain alone",()=>{
 const raw=JSON.parse(authority());raw.templates[0].bodySha256="a".repeat(64);expect(()=>readCrmAcknowledgementAuthority(JSON.stringify(raw))).toThrow();
 const expired=JSON.parse(authority());expired.expiresAt=new Date(0).toISOString();expect(()=>readCrmAcknowledgementAuthority(JSON.stringify(expired))).toThrow();
});
