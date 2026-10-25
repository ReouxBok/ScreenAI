import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { savIntakeEvidenceContentHash } from "./engine";
import type { CrmSnapshot } from "./execution-types";
export type ContinuationSourceEmail = { from: string; to: string[]; subject: string; body: string; rfcMessageId?: string; mailbox?: string; gmailThreadId?: string };
export type QualifiedCrmEmail = Readonly<{ ticketId: string; eventId: string; contentHash: string; reason: "source_copy" | "automatic_ack"; authorityHash: string; expiresAt: string }>;
const issued = new WeakSet<object>();
export const isQualifiedCrmEmail = (p: QualifiedCrmEmail) => issued.has(p) && Date.parse(p.expiresAt) > Date.now();
const digest = (v: string) => createHash("sha256").update(v.replace(/\r\n?/g,"\n")).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const acknowledgementSchema = z.object({ version:z.literal(1), resource:z.object({resourceId:z.string().min(1).max(200),revisionId:z.string().min(1).max(200),sha256:hex}).strict(),
  approvedBy:z.string().min(1).max(200),approvedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
  templates:z.array(z.object({id:z.string().min(1).max(100),mailbox:z.email(),subjectSha256:hex,bodySha256:hex}).strict()).min(1).max(10) }).strict();
export function readCrmAcknowledgementAuthority(raw: string|undefined,now=new Date()) {
  if(!raw)return null;if(raw.length>32000)throw Error("SAV_INTAKE_ACK_AUTHORITY_REQUIRED");
  try {const value=acknowledgementSchema.parse(JSON.parse(raw));
    if(digest(JSON.stringify(value.templates))!==value.resource.sha256||Date.parse(value.approvedAt)>now.getTime()||Date.parse(value.expiresAt)<=now.getTime()
      ||new Set(value.templates.map(t=>t.id)).size!==value.templates.length)throw Error();return value;
  }catch{throw Error("SAV_INTAKE_ACK_AUTHORITY_REQUIRED");}
}
export function exactRfcMessageId(value: unknown): string|null {
  return typeof value==="string"&&/^<[^<>\s\r\n]{1,200}@[^<>\s\r\n]{1,200}>$/.test(value)?value:null;
}
export function crmRfcMessageId(raw: string|null|undefined): string|null {
  try {const h=JSON.parse(raw??"null");if(!h||typeof h!=="object"||Array.isArray(h))return null;
    const values=[h.messageId,h["message-id"],...(Array.isArray(h.headers)?h.headers.filter((v:{name?:string})=>v.name?.toLowerCase()==="message-id").map((v:{value?:string})=>v.value):[])].filter(v=>v!==undefined);
    return values.length===1?exactRfcMessageId(values[0]):null;
  }catch{return null;}
}
const envelope=z.object({from:z.email(),to:z.string().min(1),direction:z.string(),subject:z.string(),body:z.string()});
const addresses=(s:string)=>s.split(/[;,]/).map(v=>v.trim().toLowerCase()).sort();
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export type AckOriginInput = { mailbox:string; gmailThreadId:string; rfcMessageId:string; parentId:string; recipient:string; subject:string; body:string; at:string };
/** Private exact content AND a separately verified Gmail SENT/Auto-Submitted
 * origin are required. A domain, outgoing direction or template phrase is not proof. */
export async function qualifyCrmHistoryAdditions(baseline:CrmSnapshot,current:CrmSnapshot,source:ContinuationSourceEmail,
  options:{authority?:string;readEmail:(id:string)=>Promise<{id:string;properties:Record<string,string|null>}>;verifyAckOrigin:(input:AckOriginInput)=>Promise<boolean>;now?:Date}):Promise<QualifiedCrmEmail[]> {
  const now=options.now??new Date(),authority=readCrmAcknowledgementAuthority(options.authority,now),proofs:QualifiedCrmEmail[]=[];
  const additions=Object.entries(current.histories).flatMap(([ticketId,history])=>history.filter(e=>e.kind==="email"&&!baseline.histories[ticketId]?.some(b=>b.id===e.id)).map(e=>({ticketId,event:e})));
  if(additions.length>3)return [];
  for(const {ticketId,event} of additions){
    const parsed=envelope.safeParse((()=>{try{return JSON.parse(event.text);}catch{return null;}})());
    if(!parsed.success||!/^emails:\d{1,30}$/.test(event.id)||!source.rfcMessageId)continue;
    const e=parsed.data,sourceCopy=e.direction==="INCOMING_EMAIL"&&e.from.toLowerCase()===source.from.toLowerCase()
      &&same(addresses(e.to),source.to.map(v=>v.toLowerCase()).sort())&&e.subject===source.subject&&digest(e.body)===digest(source.body);
    const templates=authority?.templates.filter(t=>t.mailbox.toLowerCase()===source.mailbox?.toLowerCase()&&t.subjectSha256===digest(e.subject)&&t.bodySha256===digest(e.body))??[];
    if(!sourceCopy&&!(templates.length===1&&e.direction==="EMAIL"&&e.from.toLowerCase()===source.mailbox?.toLowerCase()
      &&same(addresses(e.to),[source.from.toLowerCase()])))continue;
    const row=await options.readEmail(event.id.slice(7)),p=row.properties;
    if(row.id!==event.id.slice(7)||!same({from:p.hs_email_from_email,to:p.hs_email_to_email,direction:p.hs_email_direction,subject:p.hs_email_subject,body:p.hs_email_text},e)
      ||!Number.isFinite(Date.parse(p.hs_timestamp??""))||new Date(p.hs_timestamp!).toISOString()!==event.at)continue;
    const rfc=crmRfcMessageId(p.hs_email_headers);if(!rfc)continue;
    const native=sourceCopy&&rfc===source.rfcMessageId;
    const automatic=!sourceCopy&&templates.length===1&&source.mailbox&&source.gmailThreadId&&await options.verifyAckOrigin({mailbox:source.mailbox,gmailThreadId:source.gmailThreadId,rfcMessageId:rfc,parentId:source.rfcMessageId,recipient:source.from,subject:e.subject,body:e.body,at:event.at});
    if(!native&&!automatic)continue;
    const proof=Object.freeze({ticketId,eventId:event.id,contentHash:savIntakeEvidenceContentHash(event),reason:native?"source_copy" as const:"automatic_ack" as const,
      authorityHash:native?digest(source.rfcMessageId):authority!.resource.sha256,expiresAt:new Date(Math.min(now.getTime()+60_000,authority&&!native?Date.parse(authority.expiresAt):Infinity)).toISOString()});
    issued.add(proof);proofs.push(proof);
  }
  return proofs;
}
