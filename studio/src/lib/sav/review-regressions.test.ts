import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { savMailboxes, savThreads, savMessages, savAgentRuns, savDecisions, savActions, savDraftVerdicts, savResolutionObservations, savLearningCandidates, savResolutionEvidence, contentVersions, categories, knowledgeProjectionCandidates, knowledgeFamilySources, knowledgeFamilyRevisions, contentItems } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { activateSavLearningCutover } from "./learning-admission";
import {reconcileSavManualTicket} from "./hubspot";
import { encryptSavPayload, savContentHash } from "./crypto";
import { loadSavDraftContext, reviewSavDraft } from "./draft-verdicts";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { queueSavManualTicket } from "./manual-tickets";
import {approveLearningCandidate} from "./learning";
import { getSavObservations, syncSavObservation, qualifySavObservation } from "./observations";
import { type ObservationSnapshot, type ObservationEvent } from "./observation-source";
const state = vi.hoisted(() => ({ db: null as unknown, targetItemId: null as string | null }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./learning-comparator", () => ({
    SAV_LEARNING_COMPARATOR_REVISION: "fixture-comparator-v1", SAV_LEARNING_COMPARATOR_PROMPT_REVISION: "fixture-prompt-v1",
    compareSavLearningResolution: async (input: { evidenceRef: string; evidenceExcerpt: string; resolution: string; knowledge: Array<{ ref: string; title: string }> }, options:{model:string;derivedReservationId?:string}) => {
        if(options.derivedReservationId){const budget=await import("./derived-budget");await budget.dispatchSavDerivedCall(options.derivedReservationId,"comparison",options.model,{systemInstruction:{parts:[{text:"Synthetic"}]},contents:[{parts:[{text:"Synthetic"}]}],generationConfig:{maxOutputTokens:4096}});await budget.settleSavDerivedCall(options.derivedReservationId,{inputTokens:1,outputTokens:1,thoughtTokens:0,totalTokens:2});}
        const target = state.targetItemId ? input.knowledge.find((entry) => entry.ref === `content:${state.targetItemId}`) : null;
        return ({ decision: { outcome: target ? "amendment" : "new", matchedRef: target?.ref ?? null, groupSignature: "synthetic-support-resolution", subject: "Procédure fictive de support", resolution: input.resolution,
            conditions: ["Dossier support fictif"], expectedResult: "Le problème fictif est résolu", limitations: ["Ne couvre que le scénario synthétique"],
            evidenceRef: input.evidenceRef, evidenceExcerpt: input.evidenceExcerpt, rationale: "Résolution humaine synthétique avec résultat observable." },
        revision: "fixture-comparator-v1", promptRevision: "fixture-prompt-v1", model: "fixture", inputHash: "fixture", durationMs: 1, inputTokens: 1, outputTokens: 1,
    });
    },
}));
let f: Awaited<ReturnType<typeof createSavTestDb>>, threadId: string, messageId: string, decisionId: string, runId: string;
let proposal = v0Proposal();
const now = new Date("2026-10-08T12:00:00Z");
const denyNetwork = vi.fn(() => { throw new Error("Unexpected real network request"); });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => f.client.close());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
    state.targetItemId = null;
    vi.stubEnv("SAV_RELEASE_STAGE", "v0");
    vi.stubEnv("SAV_AUTOMATION_MODE", "assist");
    vi.stubEnv("SAV_WRITES_DISABLED", "false");
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "sav-v0-review-fixture-key-only-32-characters");
    vi.stubGlobal("fetch", denyNetwork);
    denyNetwork.mockClear();
    await f.client.exec("TRUNCATE sav.mailboxes CASCADE;TRUNCATE sav.sync_state;TRUNCATE active_knowledge;TRUNCATE audit_logs;TRUNCATE sav.learning_candidates CASCADE;TRUNCATE sav.ticket_snapshots CASCADE");
    proposal = v0Proposal();
    const [mb] = await f.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
    await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mb.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
    await activateSavLearningCutover({ activatedAt: "2026-10-07T00:00:00.000Z", activatedBy: "ugo@limova.ai", deploymentSha: "b".repeat(40) }, "ugo@limova.ai");
    const [thread] = await f.db.insert(savThreads).values({ mailboxId: mb.id, gmailThreadId: "fixture-thread", subject: "Fictif", customerEmail: "fixture@example.invalid" }).returning();
    threadId = thread.id;
    const [message] = await f.db.insert(savMessages).values({ threadId, mailboxId: mb.id, gmailMessageId: "fixture-message", direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: "Demande fictive", headers: { "message-id": "<fixture@example.invalid>" } }), receivedAt: new Date("2026-10-08T10:00:00Z") }).returning();
    messageId = message.id;
    const [run] = await f.db.insert(savAgentRuns).values({ messageId, runtime: "local_fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
    runId = run.id;
    const [decision] = await f.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 800 }).returning();
    decisionId = decision.id;
});
function dossier() { return { reviewScope: "dossier", messageId, decisionId, agentRunId: runId, expectedReviewId: null, status: "approved", verdict: "correct", dimensions: { classification: "correct", routing: "correct", grounding: "correct", tone: "correct", escalation: "correct" }, comment: "Dossier fictif vérifié et validé", reusability: "none", correction: { category: proposal.category, urgency: proposal.urgency, decisionKind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, title: proposal.ticket.title, description: proposal.ticket.description, process: proposal.process, internalNote: "", replyDraft: "IGNORED_FOR_DOSSIER" } }; }
async function verdict(status = "rejected", reason = "") { const c = await loadSavDraftContext(messageId); const [current] = await f.db.select().from(savDraftVerdicts).where(eq(savDraftVerdicts.isCurrent, true)); return reviewSavDraft({ threadId, messageId, decisionId: c.decision.id, agentRunId: c.run.id, sourceHash: c.sourceHash, expectedVerdictId: current?.id ?? null, status, reason }, "ugo@limova.ai"); }
async function observation() { await verdict(); return (await f.db.select().from(savResolutionObservations))[0]; }
function event(kind = "human_reply", text = "La procédure réelle consiste à ouvrir Facturation puis télécharger la facture."): ObservationEvent { return { sourceRef: "hubspot:emails:999", kind, text, occurredAt: "2026-10-08T11:00:00.000Z", author: "owner:21", provenance: "HubSpot emails / association explicite", associationTicketId: "123", remoteUpdatedAt: "2026-10-08T11:00:00.000Z" }; }
function snapshot(overrides: Partial<ObservationSnapshot> = {}): ObservationSnapshot { return { ticketId: "123", status: "closed", updatedAt: "2026-10-08T12:00:00.000Z", subject: "Dossier fictif", events: [event()], errors: [], ...overrides }; }
async function linkedObservation() { await f.db.update(savThreads).set({ hubspotTicketId: "123" }).where(eq(savThreads.id, threadId)); return observation(); }
async function qualifyInput(obsId: string, useLatestProof = false) { const [row] = await getSavObservations(threadId); const c = row.cycles[0]; const proof = useLatestProof ? c.summary.humanEvidence.find((entry) => entry.sourceRef.endsWith(":1000")) ?? c.summary.humanEvidence.at(-1) : c.summary.humanEvidence[0]; return { observationId: obsId, cycleId: c.id, sourceHash: c.sourceHash, outcome: "resolved", evidenceRef: proof?.sourceRef ?? "", evidenceHash: proof?.contentHash ?? "", resolution: "Ouvrez Facturation puis téléchargez la facture dans votre compte.", justification: "Procédure générique vérifiée dans la réponse humaine réellement associée.", unconfirmedAcknowledged: true }; }

async function regenerateSame() {
 await f.db.update(savDecisions).set({isCurrent:false}).where(eq(savDecisions.id,decisionId));
 const [run]=await f.db.insert(savAgentRuns).values({messageId,runtime:"local_fixture",mode:"off",status:"succeeded",model:"fixture2",promptRevision:"fixture2",inputHash:"fixture2",proposalCiphertext:encryptSavPayload(proposal)}).returning();
 const [decision]=await f.db.insert(savDecisions).values({messageId,agentRunId:run.id,kind:"ticket_pending",reasonCode:proposal.decision.reasonCode,explanation:proposal.decision.explanation,confidence:800}).returning();
 return decision;
}
it("F1 allows reconciliation after retained dossier approval and a new identical generation",async()=>{
 const review=await reviewSavProposal(dossier(),"ugo@limova.ai");const decision=await regenerateSame();
 const action=await queueSavManualTicket({threadId,reviewId:review.id,kind:"create_ticket"},"ugo@limova.ai");expect(action.decisionId).toBe(decision.id);
 await f.db.update(savActions).set({status:"failed",payload:{...action.payload,ticketCreateDispatchedAt:now.toISOString()},errorCode:"SAV_MANUAL_RECONCILIATION_REQUIRED"}).where(eq(savActions.id,action.id));
 // Stop at a sentinel provider read: this must reach read-only reconciliation, not reject its valid retained review.
 vi.stubEnv("HUBSPOT_ACCESS_TOKEN","fixture");const readReached=vi.fn(()=>{throw new Error("REVIEWER_READ_ONLY_RECONCILIATION_REACHED");});vi.stubGlobal("fetch",readReached);
 await expect(reconcileSavManualTicket(action.id,"123","ugo@limova.ai","Ticket fictif vérifié par le reviewer")).rejects.toThrow("SAV_HUBSPOT_READ_UNAVAILABLE");
 expect(readReached).toHaveBeenCalled();
});
it("F2 approves a corrected candidate after an earlier candidate for this cycle was approved",async()=>{
 await f.db.insert(categories).values({slug:"depannage",label:"Dépannage",position:0}).onConflictDoNothing();
 const o=await linkedObservation();await syncSavObservation(o.id,async()=>snapshot(),now);
 const first=await qualifySavObservation(await qualifyInput(o.id),"ugo@limova.ai");const initial=await approveLearningCandidate(first.candidateId!,"ugo@limova.ai");
 state.targetItemId=initial.item.id;
 await syncSavObservation(o.id,async()=>snapshot({events:[event("human_reply","Nouvelle résolution humaine : ouvrir Paramètres et corriger le compte.")]}),now);
 const second=await qualifySavObservation({...await qualifyInput(o.id),resolution:"Ouvrez Paramètres puis corrigez le compte avant de recommencer."},"ugo@limova.ai");
 expect(second.candidateId).not.toBe(first.candidateId);
 const corrected=await approveLearningCandidate(second.candidateId!,"ugo@limova.ai");
 expect(corrected.item.id).toBe(initial.item.id);expect(corrected.version.id).not.toBe(initial.version.id);
 expect(corrected.version.version).toBe(initial.version.version+1);
 expect(corrected.version.bodyMarkdown).toContain("Ouvrez Paramètres puis corrigez le compte");expect(corrected.version.bodyMarkdown).not.toContain("Ouvrez Facturation puis téléchargez");
 expect((await f.db.select().from(contentVersions).where(eq(contentVersions.id,initial.version.id)))[0].bodyMarkdown).toBe(initial.version.bodyMarkdown);
 expect((await approveLearningCandidate(second.candidateId!,"ugo@limova.ai")).version.id).toBe(corrected.version.id);
});
it("F3 invalidates the already approved source after late contradictory evidence",async()=>{
 await f.db.insert(categories).values({slug:"depannage",label:"Dépannage",position:0}).onConflictDoNothing();
 const o=await linkedObservation();await syncSavObservation(o.id,async()=>snapshot(),now);
 const first=await qualifySavObservation(await qualifyInput(o.id),"ugo@limova.ai");await approveLearningCandidate(first.candidateId!,"ugo@limova.ai");
 await syncSavObservation(o.id,async()=>snapshot({events:[event("human_reply","La procédure précédente ne résout pas le problème et doit être corrigée.")]}),now);
 expect((await f.db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id,first.candidateId!)))[0].status).toBe("rejected");
 const evidence=await f.db.select().from(savResolutionEvidence).where(eq(savResolutionEvidence.sourceRef,`sav-observation:${(await getSavObservations(threadId))[0].cycles[0].id}`));
 expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({outcome:"superseded",weight:0});
 await expect(approveLearningCandidate(first.candidateId!,"ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_STALE");
});
it("F4 reports a truncated synchronized Gmail body as incomplete evidence",async()=>{
 const o=await linkedObservation();await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"a".repeat(8500)})}).where(eq(savMessages.id,messageId));
 await syncSavObservation(o.id,async()=>snapshot(),now);
 const row=(await getSavObservations(threadId))[0];expect(row.sourceErrors.length).toBeGreaterThan(0);expect(row.state).toBe("sources_incomplete");
});
it.each([false,true])("F5 blocks pending or already-approved candidate during refresh: %s",async(approved)=>{
 await f.db.insert(categories).values({slug:"depannage",label:"Dépannage",position:0}).onConflictDoNothing();
 const o=await linkedObservation();await syncSavObservation(o.id,async()=>snapshot(),new Date());
 const c=await qualifySavObservation(await qualifyInput(o.id),"ugo@limova.ai");
 if(approved)await approveLearningCandidate(c.candidateId!,"ugo@limova.ai");
 let done!:(s:ObservationSnapshot)=>void;const sync=syncSavObservation(o.id,()=>new Promise(r=>{done=r}));while(!done)await new Promise(r=>setTimeout(r,5));
 try {await expect(approveLearningCandidate(c.candidateId!,"ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_SYNC_IN_PROGRESS");} finally {done(snapshot());await sync;}
});

import { listSavInbox } from "./service";
it("F6 shares the retained dossier verdict between detail, reviewed and pending inbox",async()=>{
 const review=await reviewSavProposal(dossier(),"ugo@limova.ai");
 const decision=await regenerateSame();
 await f.db.update(savMessages).set({analysisStatus:"done"}).where(eq(savMessages.id,messageId));
 expect((await getSavProposalReview(messageId))?.review?.id).toBe(review.id);
 expect(await listSavInbox(100,{view:"reviewed"})).toMatchObject([{messageId,decisionId:decision.id,reviewId:review.id,reviewStatus:"approved"}]);
 expect(await listSavInbox(100,{view:"pending"})).toEqual([]);
});

it("F4 retains a full Gmail fingerprint and blocks qualification of incomplete sources",async()=>{
 const o=await linkedObservation();const prefix="a".repeat(8000);
 await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:prefix+"First contradictory tail"})}).where(eq(savMessages.id,messageId));
 await syncSavObservation(o.id,async()=>snapshot(),now);
 const first=(await getSavObservations(threadId))[0];const source=first.cycles[0].summary.events.find(e=>e.sourceRef==="gmail:fixture-message")!;
 expect(source.fullContentHash).toBe(savContentHash(prefix+"First contradictory tail"));expect(source.truncated).toBe(true);
 await expect(qualifySavObservation(await qualifyInput(o.id),"ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_QUALIFICATION_REQUIRED");
 await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:prefix+"Different contradictory tail"})}).where(eq(savMessages.id,messageId));
 await syncSavObservation(o.id,async()=>snapshot(),now);
 const second=(await getSavObservations(threadId))[0];expect(second.cycles[0].sourceHash).not.toBe(first.cycles[0].sourceHash);
 expect(second.cycles[0].summary.events.find(e=>e.sourceRef===source.sourceRef)?.text).toBe(source.text);
});
it.each(["dossier","legacy_global"])("F6 invalidates material changes in both detail and inbox: %s",async(reviewScope)=>{
 await reviewSavProposal({...dossier(),reviewScope},"ugo@limova.ai");
 proposal={...proposal,ticket:{...proposal.ticket,title:"Autre demande matérielle"}};await regenerateSame();
 await f.db.update(savMessages).set({analysisStatus:"done"}).where(eq(savMessages.id,messageId));
 expect((await getSavProposalReview(messageId))?.review).toBeNull();expect(await listSavInbox(1,{view:"reviewed"})).toEqual([]);
 expect(await listSavInbox(1,{view:"pending"})).toMatchObject([{messageId,reviewId:null,reviewStatus:null}]);
});
it("F6 preserves strict generation identity for legacy global verdicts",async()=>{
 await reviewSavProposal({...dossier(),reviewScope:"legacy_global"},"ugo@limova.ai");await regenerateSame();
 expect((await getSavProposalReview(messageId))?.review).toBeNull();expect(await listSavInbox(1,{view:"reviewed"})).toEqual([]);
});
it("F6 paginates after filtering across a full unreviewed batch",async()=>{
 const review=await reviewSavProposal(dossier(),"ugo@limova.ai");
 const [m]=await f.db.select().from(savMessages).where(eq(savMessages.id,messageId));
 await f.db.insert(savMessages).values(Array.from({length:251},(_,i)=>({...m,id:undefined,gmailMessageId:`other-${i}`,receivedAt:new Date(now.getTime()+i),analysisStatus:"done" as const})));
 expect(await listSavInbox(1,{view:"reviewed"})).toMatchObject([{messageId,reviewId:review.id}]);
 expect(await listSavInbox(1,{view:"reviewed",offset:1})).toEqual([]);
});

it("F7 creates an idempotent proposal from revalidated evidence without reviving its rejected history", async () => {
 await f.db.insert(categories).values({slug:"depannage",label:"Dépannage",position:0}).onConflictDoNothing();
 const o=await linkedObservation(); await syncSavObservation(o.id,async()=>snapshot(),now);
 const first=await qualifySavObservation(await qualifyInput(o.id),"ugo@limova.ai");
 const firstApproved=await approveLearningCandidate(first.candidateId!,"ugo@limova.ai"); state.targetItemId=firstApproved.item.id;
 const [source]=await f.db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.sourceRef,`sav-learning:${first.candidateId}`));
 const [original]=await f.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.sourceId,source.id));
 expect(original.status).toBe("needs_recording");
 await syncSavObservation(o.id,async()=>snapshot({events:[event(),{...event("human_reply","Confirmation humaine supplémentaire : la procédure de téléchargement reste valide."),sourceRef:"hubspot:emails:1000"}]}),now);
 const [historical]=await f.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id,original.id));
 expect(historical.status).toBe("rejected");
 const second=await qualifySavObservation(await qualifyInput(o.id,true),"ugo@limova.ai");
 expect(second.candidateId).not.toBe(first.candidateId);
 const approved=await approveLearningCandidate(second.candidateId!,"ugo@limova.ai");
 await approveLearningCandidate(second.candidateId!,"ugo@limova.ai");
 const rows=await f.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.familyId,original.familyId));
 const current=rows.find(row=>row.status==="needs_recording");
 expect(current).toBeDefined(); expect(rows).toHaveLength(2);
 expect(rows.find(row=>row.id===historical.id)).toEqual(historical);
 expect(current!.id).not.toBe(historical.id); expect(current!.revisionId).not.toBe(historical.revisionId);
 const [newSource]=await f.db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id,current!.sourceId));
 expect(newSource.sourceRef).toBe(`sav-learning:${second.candidateId}`);
 expect(newSource.sourceVersionId).toBe(approved.version.id);
 expect(newSource.evidence).toMatchObject({learningCandidateId:second.candidateId,sourceVersionId:approved.version.id});
 expect(current!.proposedInput).toHaveProperty("metadata.sourceMetadata.learningCandidateId",second.candidateId);
 expect(current!.proposedInput).toHaveProperty("metadata.actionSteps",[]);
 const revisions=await f.db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId,original.familyId));
 expect(revisions).toHaveLength(2); expect(revisions[0].document).toEqual(revisions[1].document);
 expect((await f.db.select().from(contentItems).where(eq(contentItems.id,approved.item.id)))[0].publishedVersionId).toBeNull();
 expect(denyNetwork).not.toHaveBeenCalled();
});
