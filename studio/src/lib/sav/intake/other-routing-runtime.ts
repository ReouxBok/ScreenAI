import "server-only";
import {createHash} from "node:crypto";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages,savMailboxes,savThreads } from "@/db/schema";
import { savAttachmentInventorySchema } from "../attachment-contract";
import { readSavOtherConfiguration } from "../other-observation";
import { readIntakeOtherRules,qualifyIntakeOther } from "./other-routing";
import type { IntakeLease } from "./runtime-store";

/** Qualification is local to one current lease. Configuration never supplies
 * a global qualifiedOther permission to the decision engine. */
export async function qualifyRuntimeOther(lease:IntakeLease,live:()=>Promise<void>,env:Record<string,string|undefined>,authenticate?:typeof import("../gmail").readSavGmailOtherAuthentication) {
  const catalogue=readIntakeOtherRules(env.SAV_INTAKE_OTHER_RULES_JSON);if(!catalogue)return null;
  const registry=readSavOtherConfiguration(env.SAV_OTHER_OBSERVATION_RULES_JSON).registry;if(!registry)return null;
  await live();const db=requireDb();
  const [message]=await db.select().from(savMessages).where(eq(savMessages.id,lease.run.messageId));
  const [thread]=await db.select().from(savThreads).where(eq(savThreads.id,lease.run.threadId));
  const [mailbox]=message?await db.select().from(savMailboxes).where(eq(savMailboxes.id,message.mailboxId)):[];
  if(!message?.gmailMessageId||!thread||!mailbox||thread.mailboxId!==mailbox.id)return null;
  const protectedContext=lease.input.conversation.data.length!==1||Boolean(thread.hubspotTicketId||thread.aiPaused||thread.humanRequestedAt);
  const inventory=savAttachmentInventorySchema.safeParse(lease.body.attachmentInventory);
  if(protectedContext||!inventory.success||!inventory.data.complete||lease.body.attachments?.length)return null;
  const input={mailboxId:mailbox.id,mailboxEmail:mailbox.email,messageId:message.id,gmailMessageId:message.gmailMessageId,gmailThreadId:thread.gmailThreadId,
    fromEmail:message.fromEmail,subject:message.subject,body:lease.body,sourceHash:lease.sourceHash,protectedContext,inventoryComplete:true};
  // Avoid even a metadata call unless an exact approved body/subject might match.
  const candidate=qualifyRuntimeCandidate(input,catalogue);if(!candidate)return null;
  await live();const reader=authenticate??(await import("../gmail")).readSavGmailOtherAuthentication;
  const proof=await reader({mailboxEmail:mailbox.email,messageId:message.gmailMessageId,threadId:thread.gmailThreadId,sender:message.fromEmail,signal:AbortSignal.timeout(10000)});
  await live();return qualifyIntakeOther(input,registry,catalogue,proof);
}
function qualifyRuntimeCandidate(input:{mailboxId:string;subject:string;body:{text:string}},catalogue:NonNullable<ReturnType<typeof readIntakeOtherRules>>) {
  // These digests only restrict the GET; the full qualified predicate still runs.
  const hash=(text:string)=>requireHash(text);
  return catalogue.rules.some(r=>r.mailboxId===input.mailboxId&&r.subjectSha256===hash(input.subject)&&r.bodySha256===hash(input.body.text));
}
const requireHash=(text:string)=>createHash("sha256").update(text.replace(/\r\n?/g,"\n")).digest("hex");
