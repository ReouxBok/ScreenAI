import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readSavAttachmentJson } from "./attachment-gmail";
const responseSchema = z.object({ id: z.string(), threadId: z.string(), payload: z.object({ headers: z.array(z.object({ name: z.string().max(200), value: z.string().max(8000) })).max(200) }) });
export type SavOtherAuthentication = Readonly<{ mailboxEmail: string; messageId: string; threadId: string; sender: string; observedAt: string; headerHash: string; bulk?: boolean }>;
const issued = new WeakSet<object>();
export const isSavOtherAuthentication = (value: SavOtherAuthentication) => issued.has(value);
/** Only the Gmail API read capability may mint this transient proof. Duplicate,
 * forwarded or missing authentication evidence never authorizes classification. */
export async function readSavOtherAuthentication(input: { mailboxEmail: string; messageId: string; threadId: string; sender: string; signal: AbortSignal }, network: typeof fetch) {
  if (!z.email().safeParse(input.mailboxEmail).success || !z.email().safeParse(input.sender).success
    || ![input.messageId,input.threadId].every(id => /^[A-Za-z0-9_-]{1,1024}$/.test(id))) return null;
  const fields = ["From", "Authentication-Results", "ARC-Authentication-Results", "In-Reply-To", "References", "List-Id", "List-Unsubscribe", "Precedence"];
  const query = new URLSearchParams({ format: "metadata" }); for (const name of fields) query.append("metadataHeaders",name);
  const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(input.mailboxEmail)}/messages/${input.messageId}?${query}`;
  const raw = await readSavAttachmentJson(await network(url, { method: "GET", signal: input.signal, redirect: "error" }),128*1024);
  const parsed=responseSchema.safeParse(raw); if (!parsed.success || input.signal.aborted) return null;
  const value=parsed.data; if(value.id!==input.messageId || value.threadId!==input.threadId) return null;
  const headers=(name:string)=>value.payload.headers.filter(h=>h.name.toLowerCase()===name.toLowerCase()).map(h=>h.value.replace(/\r?\n[ \t]+/g," "));
  const from=headers("From"), auth=headers("Authentication-Results");
  if(from.length!==1 || auth.length!==1 || headers("In-Reply-To").some(v=>v.trim()) || headers("References").some(v=>v.trim()) || headers("ARC-Authentication-Results").some(v=>/\b(?:dkim|dmarc|arc)=fail\b/i.test(v))) return null;
  const sender=(from[0].match(/<([^<>]+)>\s*$/)?.[1]??from[0]).trim().toLowerCase();
  if(sender!==input.sender.toLowerCase() || !/^mx\.google\.com\s*;/i.test(auth[0])) return null;
  const clauses=auth[0].split(";").map(v=>v.trim()), domain=sender.split("@")[1];
  const dkim=clauses.filter(v=>/^dkim=pass\b/i.test(v)),dmarc=clauses.filter(v=>/^dmarc=pass\b/i.test(v));
  if(dkim.length!==1 || dmarc.length!==1) return null;
  const signing=(dkim[0].match(/\bheader\.d=([^\s;]+)/i)?.[1]??dkim[0].match(/\bheader\.i=[^\s;]*@([^\s;]+)/i)?.[1])?.toLowerCase();
  if(signing!==domain || dmarc[0].match(/\bheader\.from=([^\s;]+)/i)?.[1].toLowerCase()!==domain) return null;
  const list=headers("List-Id"), unsubscribe=headers("List-Unsubscribe"), precedence=headers("Precedence");
  const bulk=list.length===1&&/^.{0,1000}<[^<>\s]+>\s*$/.test(list[0])&&unsubscribe.length===1&&/^\s*<(?:https:\/\/|mailto:)[^<>\r\n]+>/.test(unsubscribe[0])
    &&precedence.length<=1&&(!precedence.length||/^(?:bulk|list)\s*$/i.test(precedence[0]));
  const proof=Object.freeze({ mailboxEmail:input.mailboxEmail.toLowerCase(),messageId:input.messageId,threadId:input.threadId,sender,observedAt:new Date().toISOString(),headerHash:createHash("sha256").update(JSON.stringify([auth,list,unsubscribe,precedence])).digest("hex"),bulk });
  issued.add(proof);return proof;
}
