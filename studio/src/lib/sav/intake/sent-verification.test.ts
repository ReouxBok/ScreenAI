import { expect, it } from "vitest";
import { createIntakeExecutorAdapters, type GmailRequest } from "./execution-adapters";
import type { EffectIntent } from "./execution-types";
const at = new Date("2026-01-01T12:00:00Z");
const intent: EffectIntent = { kind:"identity_send",permission:"send_identity_template",key:"synthetic",sourceMessageId:"source",
  mailbox:"support@example.test",recipient:"customer@example.test",threadId:"thread",rfcMessageId:"<expected@example.test>",text:"Bonjour\nExact template\nSupport",
  raw:"From: support@example.test\r\nIn-Reply-To: <parent@example.test>\r\nReferences: <older@example.test> <parent@example.test>\r\n\r\nbody" };
function fixture(change?: (observed: ReturnType<typeof message>)=>void) {
  const sent=message(); change?.(sent);
  let sends=0;
  const gmail: GmailRequest=async <T>(_mailbox:string,path:string,init?:RequestInit)=>{
    if(init?.method){sends++;throw Error("WRITES_FORBIDDEN");}
    if(path.startsWith("messages?"))return {messages:[]} as T;
    if(path.startsWith("threads/"))return {id:"thread",messages:[{id:"sent",labelIds:["SENT"]}]} as T;
    return sent as T;
  };
  return {adapter:createIntakeExecutorAdapters({gmailRequest:gmail}),sends:()=>sends};
}
function message(){return {id:"sent",threadId:"thread",internalDate:String(at.getTime()+1000),labelIds:["SENT"],payload:{mimeType:"text/plain",body:{data:Buffer.from(intent.text!).toString("base64url")},headers:[
  {name:"From",value:intent.mailbox!},{name:"To",value:intent.recipient!},{name:"Message-ID",value:"<rewritten@gmail.test>"},
  {name:"In-Reply-To",value:"<parent@example.test>"},{name:"References",value:"<older@example.test> <parent@example.test>"}]}};}
it.each([true,false])("attributes a rewritten RFC Message-ID with ACK=%s without sending",async ack=>{
  const f=fixture();expect(await f.adapter.verify(intent,ack?{id:"sent",threadId:"thread"}:null,at,AbortSignal.timeout(1000))).toMatchObject({confirmed:true,attributed:true,ack:{id:"sent"}});expect(f.sends()).toBe(0);
});
it.each(["parent","references","recipient","sender","old","late","body","cc","duplicate","thread"])("rejects a mismatched %s despite a provider ACK",async kind=>{
  const f=fixture(m=>{
    if(kind==="old")m.internalDate=String(at.getTime()-61000);
    else if(kind==="late")m.internalDate=String(at.getTime()+600001);
    else if(kind==="body")m.payload.body.data=Buffer.from("different").toString("base64url");
    else if(kind==="cc")m.payload.headers.push({name:"Cc",value:"other@example.test"});
    else if(kind==="duplicate")m.payload.headers.push({name:"To",value:intent.recipient!});
    else if(kind==="thread")m.threadId="other";
    else m.payload.headers.find(h=>h.name===({parent:"In-Reply-To",references:"References",recipient:"To",sender:"From"}[kind]))!.value="wrong@example.test";
  });expect(await f.adapter.verify(intent,{id:"sent"},at,AbortSignal.timeout(1000))).toMatchObject({confirmed:false,attributed:false});expect(f.sends()).toBe(0);
});
