import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { savMailboxes, savThreads, savMessages, savAgentRuns, savDecisions, savActions, savDraftVerdicts, savReplyDrafts } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { reviewSavDraft } from "./draft-verdicts";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { queueSavManualReply } from "./manual-replies";
import { saveSavHumanReplyDraft, getSavReplyDrafts } from "./drafts";

// Synthetic regression scenarios from the independent SAV-56 review.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let f: Awaited<ReturnType<typeof createSavTestDb>>, threadId: string, messageId: string, decisionId: string, runId: string;
let proposal = v0Proposal();
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

const actor="ugo@limova.ai";
function human(nature="technical") { return { action:"create_ticket",ticketId:null,confirmed:true,reason:"Le problème et le choix ont été vérifiés par l’humain.",understanding:{primaryRequestId:"h1",requests:[{id:"h1",summary:"Impossible de connecter mon outil",nature,product:"Limova",feature:"Connexion"}],relationship:"existing_customer",knownFacts:[],attemptedSteps:[],missingInformation:[]} }; }
async function approve(expectedReviewId:string|null=null,nature="technical") { const input=dossier();return reviewSavProposal({...input,expectedReviewId,correction:{...input.correction,title:"Connexion impossible dans mon outil",humanProcess:human(nature)}},actor); }
async function save(expectedDraftId:string|null=null,text="Bonjour, voici la procédure vérifiée par un humain."){return saveSavHumanReplyDraft({threadId,messageId,expectedDraftId,text},actor);}
async function accept(id:string) { const row=(await f.db.select().from(savReplyDrafts).where(eq(savReplyDrafts.id,id)))[0];const current=(await f.db.select().from(savDraftVerdicts).where(eq(savDraftVerdicts.isCurrent,true)))[0];return reviewSavDraft({threadId,messageId,decisionId,agentRunId:runId,sourceHash:row.sourceHash,expectedVerdictId:current?.id??null,draftId:id,status:"accepted"},actor); }
it("save, accept and queue are distinct and preserve the original AI draft",async()=>{await approve();const saved=await save();expect(await f.db.select().from(savDraftVerdicts)).toHaveLength(0);expect(await f.db.select().from(savActions)).toHaveLength(0);const accepted=await accept(saved.id);expect(await f.db.select().from(savActions)).toHaveLength(0);const a=await queueSavManualReply({threadId,draftId:accepted.draftId},actor);expect(a.status).toBe("pending");expect((await getSavProposalReview(messageId))?.before.replyDraft).toBe(proposal.replyDraft);expect(denyNetwork).not.toHaveBeenCalled();});
it("a text edit cancels acceptance and cannot be sent before acceptance",async()=>{await approve();const first=await save();const accepted=await accept(first.id);const next=await save(accepted.draftId!,"Texte humain modifié et à relire.");expect((await f.db.select().from(savDraftVerdicts)).every(v=>!v.isCurrent)).toBe(true);await expect(queueSavManualReply({threadId,draftId:next.id},actor)).rejects.toThrow("SAV_DRAFT_ACCEPTANCE_REQUIRED");});
it("a material process edit cancels the previous send authorization",async()=>{const r=await approve();const first=await save();const accepted=await accept(first.id);const input=dossier();await reviewSavProposal({...input,expectedReviewId:r.id,correction:{...input.correction,title:"Connexion impossible dans mon outil",humanProcess:human(),internalNote:"Information matérielle différente"}},actor);await expect(queueSavManualReply({threadId,draftId:accepted.draftId},actor)).rejects.toThrow("SAV_DRAFT_ACCEPTANCE_REQUIRED");});
it.each(["financial_operation","financial_data","legal","cancellation"])("%s blocks human draft creation",async(nature)=>{await approve(null,nature);await expect(save()).rejects.toThrow("SAV_DRAFT_NOT_APPLICABLE");expect(await f.db.select().from(savActions)).toHaveLength(0);});
it("stale and concurrent human saves cannot silently replace the current draft",async()=>{await approve();const first=await save();await expect(save(null,"Version concurrente du texte à conserver")).rejects.toThrow("SAV_DRAFT_VERSION_CHANGED");expect((await getSavReplyDrafts(threadId)).versions[0].id).toBe(first.id);});
it("a current human draft remains usable after saving against an identical new process review",async()=>{const r=await approve();const saved=await save();await approve(r.id);expect((await getSavReplyDrafts(threadId)).versions[0].stale).toBe(true);const refreshed=await save(saved.id);const current=(await getSavReplyDrafts(threadId)).versions.find(d=>d.isCurrent)!;expect(current.id).toBe(refreshed.id);expect(current.stale).toBe(false);});
it("unauthorized human draft writes are denied",async()=>{await expect(saveSavHumanReplyDraft({threadId,messageId,expectedDraftId:null,text:"Contenu non autorisé"},"other@example.invalid")).rejects.toThrow();expect(await f.db.select().from(savReplyDrafts)).toHaveLength(0);});
it("new inbound invalidates the previous human draft",async()=>{await approve();const saved=await save();const accepted=await accept(saved.id);const mb=(await f.db.select().from(savMailboxes))[0];await f.db.insert(savMessages).values({threadId,mailboxId:mb.id,direction:"inbound",fromEmail:"fixture@example.invalid",receivedAt:new Date("2026-10-09T10:00:00Z"),bodyCiphertext:encryptSavPayload({text:"Nouvelle demande"})});await expect(queueSavManualReply({threadId,draftId:accepted.draftId},actor)).rejects.toThrow();});

it("reuses the version only when text, actor and all current anchors are unchanged",async()=>{
  await approve(); const first=await save(); const repeated=await save(first.id);
  expect(repeated.id).toBe(first.id); expect((await getSavReplyDrafts(threadId)).versions).toHaveLength(1);
});
it("preserves history and requires acceptance after rebinding an identical draft to the new review",async()=>{
  const r1=await approve();const first=await save();const accepted=await accept(first.id);const r2=await approve(r1.id);
  const saved=await save(accepted.draftId!);expect(saved.id).not.toBe(accepted.draftId);
  const rows=await f.db.select().from(savReplyDrafts);expect(rows.find(d=>d.id===accepted.draftId)?.reviewId).toBe(r1.id);
  expect(rows.find(d=>d.id===saved.id)).toMatchObject({reviewId:r2.id,status:"draft",isCurrent:true});
  await expect(queueSavManualReply({threadId,draftId:saved.id},actor)).rejects.toThrow("SAV_DRAFT_ACCEPTANCE_REQUIRED");
  const reaccepted=await accept(saved.id);expect((await queueSavManualReply({threadId,draftId:reaccepted.draftId},actor)).status).toBe("pending");
});
