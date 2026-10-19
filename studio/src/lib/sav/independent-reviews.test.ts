import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { savMailboxes, savThreads, savMessages, savAgentRuns, savDecisions, savActions, savDraftVerdicts, savReplyDrafts, savResolutionObservations, savLearningCandidates, savObservationEvents } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { activateSavLearningCutover } from "./learning-admission";
import {acceptHubspotWebhook,processPendingHubspotReceipts} from "./hubspot";
import { encryptSavPayload, decryptSavPayload } from "./crypto";
import { loadSavDraftContext, reviewSavDraft } from "./draft-verdicts";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { queueSavManualTicket } from "./manual-tickets";
import { queueSavManualReply, assertSavCurrentManualReply } from "./manual-replies";
import {approveLearningCandidate} from "./learning";
import { getSavObservations, syncSavObservation, reconcileSavObservations, qualifySavObservation } from "./observations";
import { collectSavObservationSources, type ObservationSnapshot, type ObservationEvent } from "./observation-source";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./learning-comparator", () => ({
    SAV_LEARNING_COMPARATOR_REVISION: "fixture-comparator-v1", SAV_LEARNING_COMPARATOR_PROMPT_REVISION: "fixture-prompt-v1",
    compareSavLearningResolution: async (input: { evidenceRef: string; evidenceExcerpt: string; resolution: string; knowledge: Array<{ ref: string; title: string }> }) => {
        const target = input.resolution.includes("Paramètres") ? input.knowledge.find((entry) => entry.title === "Procédure fictive de support") : null;
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
async function qualifyInput(obsId: string) { const [row] = await getSavObservations(threadId); const c = row.cycles[0]; const proof = c.summary.humanEvidence[0]; return { observationId: obsId, cycleId: c.id, sourceHash: c.sourceHash, outcome: "resolved", evidenceRef: proof?.sourceRef ?? "", evidenceHash: proof?.contentHash ?? "", resolution: "Ouvrez Facturation puis téléchargez la facture dans votre compte.", justification: "Procédure générique vérifiée dans la réponse humaine réellement associée.", unconfirmedAcknowledged: true }; }
describe("SAV-38 independent dossier and immutable draft", () => {
    it("allows a valid dossier and refusal without rewrite, send or knowledge", async () => { const review = await reviewSavProposal(dossier(), "ugo@limova.ai"); await verdict("rejected"); expect((await getSavProposalReview(messageId))?.review?.id).toBe(review.id); expect((await getSavProposalReview(messageId))?.proposal.replyDraft).toBe(proposal.replyDraft); expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0); expect(denyNetwork).not.toHaveBeenCalled(); const a = await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai"); expect(a.kind).toBe("create_ticket"); });
    it("accepts without dossier approval, and sends only by separate confirmation", async () => { const v = await verdict("accepted"); expect(await f.db.select().from(savActions)).toHaveLength(0); const a = await queueSavManualReply({ threadId, draftId: v.draftId }, "ugo@limova.ai"); expect(a.payload.bodyCiphertext).toBe((await f.db.select().from(savReplyDrafts))[0].bodyCiphertext); expect(denyNetwork).not.toHaveBeenCalled(); });
    it("makes repeated refusals idempotent and permits optional reason", async () => { const v = await verdict(); expect((await verdict()).id).toBe(v.id); expect(await f.db.select().from(savResolutionObservations)).toHaveLength(1); });
    it("rejects a forged or stale draft hash and a stale form", async () => { const c = await loadSavDraftContext(messageId); await expect(reviewSavDraft({ threadId, messageId, decisionId, agentRunId: runId, sourceHash: "x".repeat(43), expectedVerdictId: null, status: "accepted" }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_CONTEXT_CHANGED"); await verdict(); await expect(reviewSavDraft({ threadId, messageId, decisionId, agentRunId: runId, sourceHash: c.sourceHash, expectedVerdictId: null, status: "accepted" }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_VERDICT_STALE"); });
    it("blocks a queued send after refusal and preserves the dossier", async () => { await reviewSavProposal(dossier(), "ugo@limova.ai"); const v = await verdict("accepted"); const a = await queueSavManualReply({ threadId, draftId: v.draftId }, "ugo@limova.ai"); await verdict("rejected"); await expect(assertSavCurrentManualReply(a)).rejects.toThrow(); expect((await getSavProposalReview(messageId))?.review?.status).toBe("approved"); });
    it("keeps the dossier after draft-only regeneration but invalidates the draft", async () => { await reviewSavProposal(dossier(), "ugo@limova.ai"); await verdict("accepted"); await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...proposal, replyDraft: "Nouveau brouillon" }) }).where(eq(savAgentRuns.id, runId)); const r = await getSavProposalReview(messageId); expect(r?.review?.status).toBe("approved"); expect(r?.draftVerdict?.stale).toBe(true); });
    it("keeps verdicts across new run IDs when content is exactly unchanged", async () => { const r = await reviewSavProposal(dossier(), "ugo@limova.ai"); const v = await verdict("accepted"); await f.db.update(savDecisions).set({ isCurrent: false }).where(eq(savDecisions.id, decisionId)); const [run] = await f.db.insert(savAgentRuns).values({ messageId, runtime: "local_fixture", mode: "off", status: "succeeded", model: "fixture2", promptRevision: "fixture2", inputHash: "fixture2", proposalCiphertext: encryptSavPayload({ ...proposal, model: "fixture2" }) }).returning(); const [d] = await f.db.insert(savDecisions).values({ messageId, agentRunId: run.id, kind: "ticket_pending", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 800 }).returning(); expect((await getSavProposalReview(messageId))?.review?.id).toBe(r.id); expect((await getSavProposalReview(messageId))?.draftVerdict?.stale).toBe(false); expect((await queueSavManualReply({ threadId, draftId: v.draftId }, "ugo@limova.ai")).decisionId).toBe(d.id); });
    it("invalidates a draft after changing the live email", async () => { const v = await verdict("accepted"); await f.db.update(savMessages).set({ subject: "Objet changé" }).where(eq(savMessages.id, messageId)); await expect(queueSavManualReply({ threadId, draftId: v.draftId }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_ACCEPTANCE_REQUIRED"); });
    it("requires new dossier review after material dossier changes", async () => { await reviewSavProposal(dossier(), "ugo@limova.ai"); await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...proposal, ticket: { ...proposal.ticket, description: "Contexte nouveau" } }) }).where(eq(savAgentRuns.id, runId)); expect((await getSavProposalReview(messageId))?.review).toBeNull(); });
    it("does not treat a legacy global validation as draft acceptance", async () => { await reviewSavProposal({ ...dossier(), reviewScope: "legacy_global" }, "ugo@limova.ai"); expect((await getSavProposalReview(messageId))?.draftVerdict).toBeNull(); });
    it("refuses cancellation and missing drafts", async () => { await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...proposal, replyDraft: null }) }).where(eq(savAgentRuns.id, runId)); await expect(verdict()).rejects.toThrow("SAV_DRAFT_NOT_APPLICABLE"); await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...proposal, decision: { ...proposal.decision, reasonCode: "cancellation_human_only" } }) }).where(eq(savAgentRuns.id, runId)); await expect(verdict("accepted")).rejects.toThrow("SAV_DRAFT_NOT_APPLICABLE"); });
    it("preserves encrypted history and cascades new journals during purge", async () => { await verdict("accepted"); await verdict("rejected"); expect(await f.db.select().from(savDraftVerdicts)).toHaveLength(2); await f.db.delete(savThreads).where(eq(savThreads.id, threadId)); expect(await f.db.select().from(savResolutionObservations)).toHaveLength(0); expect(await f.db.select().from(savDraftVerdicts)).toHaveLength(0); });
});
describe("SAV-39 readonly sourced observation", () => {
    it("waits without searching the contact or creating a ticket", async () => { const o = await observation(); const collect = vi.fn(); await syncSavObservation(o.id, collect, now); expect(collect).not.toHaveBeenCalled(); expect((await getSavObservations(threadId))[0].state).toBe("gmail_only"); });
    it("starts after a reliable link to a ticket created outside Studio", async () => { const o = await observation(); await f.db.update(savThreads).set({ hubspotTicketId: "123" }).where(eq(savThreads.id, threadId)); await syncSavObservation(o.id, async () => snapshot({ status: "open" }), now); expect((await getSavObservations(threadId))[0]).toMatchObject({ state: "active", hubspotTicketId: "123" }); });
    it("deduplicates events, versions changed notes, and ignores older provider state", async () => { const o = await linkedObservation(); await syncSavObservation(o.id, async () => snapshot(), now); await syncSavObservation(o.id, async () => snapshot(), now); expect(await f.db.select().from(savObservationEvents)).toHaveLength(2); await syncSavObservation(o.id, async () => snapshot({ events: [event("note", "Note réellement modifiée")] }), now); expect(await f.db.select().from(savObservationEvents)).toHaveLength(3); expect((await syncSavObservation(o.id, async () => snapshot({ status: "open", updatedAt: "2026-10-07T12:00:00Z" }), now)).status).toBe("stale_source"); expect((await getSavObservations(threadId))[0].closed).toBe(true); });
    it("shows 403 and partial sources without inventing a resolution", async () => { const o = await linkedObservation(); await syncSavObservation(o.id, async () => snapshot({ errors: ["notes:HTTP_403"] }), now); expect((await getSavObservations(threadId))[0].state).toBe("sources_incomplete"); await expect(qualifySavObservation(await qualifyInput(o.id), "ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_QUALIFICATION_REQUIRED"); expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0); });
    it("does not turn closure or completed tasks into resolution evidence", async () => { const o = await linkedObservation(); await syncSavObservation(o.id, async () => snapshot({ events: [event("task", "COMPLETED")] }), now); expect((await getSavObservations(threadId))[0].cycles[0].summary.humanEvidence).toHaveLength(0); await expect(qualifySavObservation(await qualifyInput(o.id), "ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_QUALIFICATION_REQUIRED"); });
    it("prepares no candidate until Ugo qualifies a specific human proof", async () => { const o = await linkedObservation(); await syncSavObservation(o.id, async () => snapshot(), now); expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0); const input = await qualifyInput(o.id); await expect(qualifySavObservation(input, "other@limova.ai")).rejects.toThrow(); await expect(qualifySavObservation({ ...input, unconfirmedAcknowledged: false }, "ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_QUALIFICATION_REQUIRED"); const first = await qualifySavObservation(input, "ugo@limova.ai"); expect(await qualifySavObservation(input, "ugo@limova.ai")).toEqual(first); expect(await f.db.select().from(savLearningCandidates)).toHaveLength(1); expect((await f.db.select().from(savLearningCandidates))[0].status).toBe("pending"); expect(denyNetwork).not.toHaveBeenCalled(); });
    it("invalidates qualification for late evidence and retains the prior cycle on reopening", async () => { const o = await linkedObservation(); await syncSavObservation(o.id, async () => snapshot(), now); await qualifySavObservation(await qualifyInput(o.id), "ugo@limova.ai"); await syncSavObservation(o.id, async () => snapshot({ events: [event(), { ...event("customer_reply", "Ça fonctionne maintenant"), sourceRef: "hubspot:emails:1000", occurredAt: "2026-10-08T13:00:00Z" }] }), new Date("2026-10-08T14:00:00Z")); expect((await getSavObservations(threadId))[0]).toMatchObject({ state: "closed_to_analyze" }); expect((await getSavObservations(threadId))[0].cycles[0].qualification).toBeNull(); await syncSavObservation(o.id, async () => snapshot({ status: "open", updatedAt: "2026-10-09T10:00:00Z" }), new Date("2026-10-09T11:00:00Z")); expect((await getSavObservations(threadId))[0].cycles).toHaveLength(2); expect((await getSavObservations(threadId))[0].cycle).toBe(2); });
    it("keeps daily reads after closure for late evidence, then opens a new cycle on reopening", async()=>{
     const o=await linkedObservation();await syncSavObservation(o.id,async()=>snapshot(),now);
     const tomorrow=new Date(now.getTime()+24*60*60*1000);await syncSavObservation(o.id,async()=>snapshot(),tomorrow);
     expect((await getSavObservations(threadId))[0].nextSyncAt.getUTCFullYear()).toBe(2026);
     expect((await reconcileSavObservations(5,new Date(tomorrow.getTime()+1000))).processed).toHaveLength(0);
     await syncSavObservation(o.id,async()=>snapshot({events:[event("note","Une preuve tardive réellement ajoutée")]}),new Date(tomorrow.getTime()+1000));
     expect((await getSavObservations(threadId))[0].nextSyncAt.getUTCFullYear()).toBe(2026);
     await syncSavObservation(o.id,async()=>snapshot({status:"open",updatedAt:"2026-10-10T12:00:00Z"}),new Date("2026-10-10T12:01:00Z"));
     expect((await getSavObservations(threadId))[0]).toMatchObject({state:"active",cycle:2,closedCatchupUntil:null});
    });
    it("blocks approval of a candidate invalidated by late sources",async()=>{
     const o=await linkedObservation();await syncSavObservation(o.id,async()=>snapshot(),now);
     const candidate=await qualifySavObservation(await qualifyInput(o.id),"ugo@limova.ai");
     await syncSavObservation(o.id,async()=>snapshot({events:[event("note","Résolution différente, source à requalifier")]}),now);
     await expect(approveLearningCandidate(candidate.candidateId!,"ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_STALE");
    });
    it.each(["Merci", "Ça ne fonctionne toujours pas", "Ce n’est pas résolu"])("does not count ambiguous or negative confirmation: %s", async (customerText) => { const o = await linkedObservation(); await syncSavObservation(o.id, async () => snapshot({ events: [event(), { ...event("customer_reply", customerText), sourceRef: "hubspot:emails:1000", occurredAt: "2026-10-08T13:00:00Z" }] }), now); expect((await getSavObservations(threadId))[0].cycles[0].summary.customerConfirmation).toHaveLength(0); });
    it("requires explicit Ugo selection before marking customer confirmation",async()=>{
     const o=await linkedObservation();const confirmation={...event("customer_reply","Ça marche maintenant"),sourceRef:"hubspot:emails:1000",occurredAt:"2026-10-08T13:00:00Z"};
     await syncSavObservation(o.id,async()=>snapshot({events:[event(),confirmation]}),now);
     const input=await qualifyInput(o.id);const first=await qualifySavObservation(input,"ugo@limova.ai");
     const firstCandidate=(await f.db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id,first.candidateId!)))[0];
     expect(decryptSavPayload<{customerConfirmed:boolean}>(String(firstCandidate.proposedPatch.ciphertext)).customerConfirmed).toBe(false);
     const second=await qualifySavObservation({...input,customerConfirmationRef:confirmation.sourceRef,unconfirmedAcknowledged:false},"ugo@limova.ai");expect(second.candidateId).not.toBe(first.candidateId);
    });
    it("receives duplicate ticket webhooks through the existing receipt worker without extra candidates",async()=>{
     await linkedObservation();vi.stubEnv("HUBSPOT_ACCESS_TOKEN","fixture");const fetch=providerMock();vi.stubGlobal("fetch",fetch);
     const notifications=[{eventId:41,objectId:123,occurredAt:now.getTime(),subscriptionType:"ticket.propertyChange",propertyName:"hs_pipeline_stage",propertyValue:"4"}];
     await acceptHubspotWebhook(notifications);await acceptHubspotWebhook(notifications);await processPendingHubspotReceipts(5);await processPendingHubspotReceipts(5);
     expect((await getSavObservations(threadId))[0].state).toBe("closed_to_analyze");expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);
     expect(fetch.mock.calls.filter(([url])=>String(url).includes("/objects/tickets/123?")).length).toBe(1);
    });
    it("reports unverifiable delivery and pipeline state as incomplete sources",async()=>{
     vi.stubEnv("HUBSPOT_ACCESS_TOKEN","fixture");const base=providerMock();vi.stubGlobal("fetch",async(url:string|URL|Request,init?:RequestInit)=>{
      const response=await base(url,init);const body=await response.json();
      if(String(url).includes("/pipelines/tickets/0"))return Response.json({stages:[{id:"4"}]});
      if(String(url).endsWith("/emails/batch/read"))delete body.results[0].properties.hs_email_status;
      return Response.json(body);
     });
     const source=await collectSavObservationSources("123");expect(source.status).toBe("unknown");expect(source.errors).toEqual(expect.arrayContaining(["pipeline:STAGE_STATE_UNKNOWN","emails:delivery_unverified"]));expect(source.events.some(e=>e.kind==="human_reply")).toBe(false);
    });
    it("holds a lease and prevents concurrent dispatch of a second reader", async () => { const o = await linkedObservation(); let resolve!: (s: ObservationSnapshot) => void; const collect = vi.fn(() => new Promise<ObservationSnapshot>(r => { resolve = r; })); const first = syncSavObservation(o.id, collect, now); while (!resolve)
        await new Promise(r => setTimeout(r, 5)); expect((await syncSavObservation(o.id, collect, now)).status).toBe("waiting_or_leased"); resolve(snapshot()); await first; expect(collect).toHaveBeenCalledTimes(1); });
    it("drains all due dossiers across small batches and recovers a lost webhook", async () => {
        await linkedObservation();
        const [first]=await f.db.select().from(savResolutionObservations);
        for(let i=0;i<5;i++) {
          const [thread]=await f.db.insert(savThreads).values({mailboxId:(await f.db.select().from(savMailboxes))[0].id,gmailThreadId:`independent-${i}`,customerEmail:`independent${i}@example.invalid`,hubspotTicketId:"123"}).returning();
          const [message]=await f.db.insert(savMessages).values({threadId:thread.id,mailboxId:thread.mailboxId,direction:"inbound",fromEmail:thread.customerEmail,bodyCiphertext:encryptSavPayload({text:"Autre dossier synthétique"}),receivedAt:now}).returning();
          await f.db.insert(savResolutionObservations).values({threadId:thread.id,messageId:message.id,snapshotId:first.snapshotId,hubspotTicketId:"123",trackingOrigin:"dossier_validated"});
        }
        await f.db.update(savResolutionObservations).set({ nextSyncAt: now });
        vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture");
        const fetch = providerMock();
        vi.stubGlobal("fetch", fetch);
        expect((await reconcileSavObservations(5, now)).processed).toHaveLength(5);
        expect((await reconcileSavObservations(5, now)).processed).toHaveLength(1);
        expect((await reconcileSavObservations(5, now)).processed).toHaveLength(0);
        expect((await getSavObservations(threadId)).every(o => o.state === "closed_to_analyze")).toBe(true);
        expect(fetch.mock.calls.every(([, init]) => !init?.method || ["GET", "POST"].includes(init.method))).toBe(true);
    });
    it("captures only explicitly associated emails, notes and tasks with readonly APIs", async () => { vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture"); const fetch = providerMock(); vi.stubGlobal("fetch", fetch); const s = await collectSavObservationSources("123"); expect(s.errors).toEqual([]); expect(s.events.map(e => e.kind)).toEqual(expect.arrayContaining(["status", "human_reply", "note", "task"])); expect(s.events.every(e => e.associationTicketId === "123")).toBe(true); for (const [url, init] of fetch.mock.calls) {
        if (init?.method === "POST") {
            expect(String(url)).toContain("/batch/read");
            expect(JSON.parse(String(init.body)).properties.length).toBeGreaterThan(0);
        }
        else
            expect(init?.method).toBe("GET");
    } });
    it("keeps finance out of reusable candidates", async () => { const o = await linkedObservation();
      // Historical refusal predates the no-financial-draft rule. Seed its archived evidence,
      // rather than requesting a now-forbidden new financial draft verdict.
      const [historical] = await f.db.select().from(savDraftVerdicts);
      const saved = decryptSavPayload<{ proposal: typeof proposal }>(historical.snapshotCiphertext);
      await f.db.update(savDraftVerdicts).set({ snapshotCiphertext: encryptSavPayload({ ...saved, proposal: { ...saved.proposal, category: "billing" } }) }).where(eq(savDraftVerdicts.id, historical.id)); await syncSavObservation(o.id, async () => snapshot(), now); await expect(qualifySavObservation(await qualifyInput(o.id), "ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_QUALIFICATION_REQUIRED"); });
});
function providerMock() { return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if(init?.method==="POST" && !String(url).endsWith("/batch/read"))throw new Error("Unexpected fixture mutation"); const u = String(url); if (u.includes('/objects/tickets/123?'))
    return Response.json({ id: "123", updatedAt: "2026-10-08T12:00:00Z", properties: { subject: "Fictif", hs_pipeline: "0", hs_pipeline_stage: "4" }, propertiesWithHistory: { hs_pipeline_stage: [{ value: "4", timestamp: "2026-10-08T12:00:00Z" }] } }); if (u.includes('/pipelines/tickets/0'))
    return Response.json({ stages: [{ id: "4", metadata: { isClosed: true } }] }); if (u.includes('/associations/'))
    return Response.json({ results: [{ toObjectId: 999 }] }); if (u.endsWith('/batch/read')) {
    const type = u.split('/')[6];
    return Response.json({ status: "COMPLETE", results: [{ id: "999", updatedAt: "2026-10-08T11:00:00Z", properties: { hs_timestamp: "2026-10-08T11:00:00Z", hs_email_text: "Procédure humaine réelle et assez détaillée", hs_email_direction: "EMAIL", hs_email_status:"SENT", hs_note_body: "Note humaine fictive", hs_task_body: "Action prévue", hs_task_status: "COMPLETED", hs_task_subject: type, hubspot_owner_id: "21" } }] });
} throw new Error("Unexpected fixture API path"); }); }
