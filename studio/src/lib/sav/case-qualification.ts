import "server-only";
import { readIntakeLearningQualification } from "./intake/observation-binding";
import {and,desc,eq} from "drizzle-orm";
import {requireDb} from "@/db";
import {savMessages,savThreads} from "@/db/schema";
import {loadSavDossierReviewContext} from "./draft-verdicts";
import {savReplyForbidden} from "./review-contract";
import {savContentHash} from "./crypto";
/** Baselines stay immutable; current human qualification owns sensitive gates. */
export async function readSavCaseLearningQualification(threadId:string,db:Pick<ReturnType<typeof requireDb>,"select">=requireDb()) {
 const intake = await readIntakeLearningQualification(threadId, db);
 if (intake) return intake;
 const [thread]=await db.select({paused:savThreads.aiPaused}).from(savThreads).where(eq(savThreads.id,threadId));
 const [message]=await db.select({id:savMessages.id}).from(savMessages).where(and(eq(savMessages.threadId,threadId),eq(savMessages.direction,"inbound"))).orderBy(desc(savMessages.receivedAt),desc(savMessages.createdAt),desc(savMessages.id)).limit(1);
 if(!thread||thread.paused||!message)return {allowed:false,fingerprint:null};
 try {
  const context=await loadSavDossierReviewContext(message.id,db),proposal=context.proposal;
  if(context.review && context.review.status!=="approved")return {allowed:false,fingerprint:null};
  const sensitive=proposal.category==="billing"||savReplyForbidden(proposal)||/cancellation|refund|legal|security/.test(proposal.decision.reasonCode);
  return {allowed:!sensitive,fingerprint:savContentHash({messageId:message.id,decisionId:context.decision.id,runId:context.run.id,reviewId:context.review?.id??null,sourceHash:context.sourceHash})};
 }catch{return {allowed:false,fingerprint:null};}
}
