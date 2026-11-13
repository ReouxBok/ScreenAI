import "server-only";
import {createHash} from "node:crypto";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages,savMailboxes,savThreads } from "@/db/schema";
import { savAttachmentInventorySchema } from "../attachment-contract";
import { readSavOtherConfiguration } from "../other-observation";
import { readIntakeOtherRules, qualifyIntakeOther, type IntakeOtherQualification } from "./other-routing";
import type { IntakeLease } from "./runtime-store";
import { intakeQuotesMailbox } from "./message";

type OtherEvaluation =
  | { state: "catalogue_unavailable" | "not_applicable" | "evidence_unavailable" }
  | { state: "qualified"; qualification: IntakeOtherQualification };

/** Qualification is local to one current lease. Configuration never supplies
 * a global qualifiedOther permission to the decision engine. */
export async function qualifyRuntimeOther(lease:IntakeLease,live:()=>Promise<void>,env:Record<string,string|undefined>,authenticate?:typeof import("../gmail").readSavGmailOtherAuthentication): Promise<OtherEvaluation> {
  let catalogue;
  try { catalogue = readIntakeOtherRules(env.SAV_INTAKE_OTHER_RULES_JSON ?? ""); }
  catch { return { state: "catalogue_unavailable" }; }
  if (!catalogue) return { state: "catalogue_unavailable" };
  const registry=readSavOtherConfiguration(env.SAV_OTHER_OBSERVATION_RULES_JSON).registry;
  await live();const db=requireDb();
  const [message]=await db.select().from(savMessages).where(eq(savMessages.id,lease.run.messageId));
  const [thread]=await db.select().from(savThreads).where(eq(savThreads.id,lease.run.threadId));
  const [mailbox]=message?await db.select().from(savMailboxes).where(eq(savMailboxes.id,message.mailboxId)):[];
  if(!message?.gmailMessageId||!thread||!mailbox||thread.mailboxId!==mailbox.id)return { state: "evidence_unavailable" };
  const protectedContext=lease.input.conversation.data.length!==1||Boolean(thread.hubspotTicketId||thread.aiPaused||thread.humanRequestedAt);
  const inventory=savAttachmentInventorySchema.safeParse(lease.body.attachmentInventory);
  if(protectedContext || lease.body.attachments?.length) return {state:"not_applicable"};

  const input={mailboxId:mailbox.id,mailboxEmail:mailbox.email,messageId:message.id,gmailMessageId:message.gmailMessageId,gmailThreadId:thread.gmailThreadId,
    fromEmail:message.fromEmail,subject:message.subject,body:lease.body,sourceHash:lease.sourceHash,protectedContext,inventoryComplete:true};
  // Avoid even a metadata call unless an exact approved body/subject might match.
  const candidate=qualifyRuntimeCandidate(input,catalogue);if(!candidate)return {state:"not_applicable"};
  if(!inventory.success || !inventory.data.complete) return {state:"evidence_unavailable"};
  if (!registry && !catalogue.rules.some(r => r.family === "authenticated_newsletter" && r.mailboxId === input.mailboxId
    && r.subjectSha256 === requireHash(input.subject) && r.bodySha256 === requireHash(input.body.text))) return {state:"catalogue_unavailable"};
  await live();const reader=authenticate??(await import("../gmail")).readSavGmailOtherAuthentication;
  const proof=await reader({mailboxEmail:mailbox.email,messageId:message.gmailMessageId,threadId:thread.gmailThreadId,sender:message.fromEmail,signal:AbortSignal.timeout(10000)});
  await live();
  const qualification = qualifyIntakeOther(input,registry,catalogue,proof);
  if (Date.parse(catalogue.expiresAt) <= Date.now()) return { state: "catalogue_unavailable" };
  return qualification ? { state: "qualified", qualification } : { state: "not_applicable" };
}
/** Exact approved mailbox+subject+body match: the only dossiers an Other rule could qualify. */
export function qualifyRuntimeCandidate(input:{mailboxId:string;subject:string;body:{text:string}},catalogue:NonNullable<ReturnType<typeof readIntakeOtherRules>>) {
  // These digests only restrict the GET; the full qualified predicate still runs.
  const hash=(text:string)=>requireHash(text);
  return catalogue.rules.some(r=>r.mailboxId===input.mailboxId&&r.subjectSha256===hash(input.subject)&&r.bodySha256===hash(input.body.text));
}
const requireHash=(text:string)=>createHash("sha256").update(text.replace(/\r\n?/g,"\n")).digest("hex");
/** SAV-90: per-mail evidence that the current mail answers a mail of the mailbox itself (its stored quote header
 * names the mailbox address). Read only; any read failure is « no evidence », never a classification. */
export async function intakeQuotedMailboxReply(lease:Pick<IntakeLease,"run"|"provenance">,mailboxId:string) {
  const provenance=lease.provenance.get(lease.run.messageId);if(!provenance)return false;
  const [mailbox]=await requireDb().select({email:savMailboxes.email}).from(savMailboxes).where(eq(savMailboxes.id,mailboxId));
  return Boolean(mailbox&&intakeQuotesMailbox(provenance,mailbox.email));
}
