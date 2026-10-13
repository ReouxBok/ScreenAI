import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { queueSavManualTicket } from "./manual-tickets";
import { listSavInbox } from "./service";
import { processPendingHubspotActions, reconcileSavManualTicket } from "./hubspot";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string;
let messageId: string;
let decisionId: string;
let runId: string;
const proposal = savStructuredProposalSchema.parse({ schemaVersion: 1, category: "how_to", urgency: "normal", decision: { kind: "ticket_pending", reasonCode: "fixture_support", explanation: "Demande support fictive à vérifier", confidence: 800 }, routing: { kind: "new", reason: "fixture", contactId: "21" }, ticket: { title: "Retrouver les factures", description: "Comment retrouver mes factures ?" }, process: [{ kind: "human_review", label: "Relire la procédure proposée", sourceIds: [] }], internalNote: null, replyDraft: "Brouillon fictif", sources: [], knowledgeRevision: "not_consulted", model: "fixture" });
function reviewInput(reusability = "none") {
  return { messageId, decisionId, agentRunId: runId, expectedReviewId: null, status: "approved", verdict: "partial", dimensions: { classification: "correct", routing: "correct", grounding: "partial", tone: "correct", escalation: "correct" }, comment: "Revue fictive, corriger la procédure", reusability, reusableResolution: "Ouvrez Paramètres puis Facturation. Cas client@example.com, tél 0612345678.", justification: "Parcours générique vérifié, réutilisable pour retrouver les factures", correction: { category: proposal.category, urgency: proposal.urgency, decisionKind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, title: proposal.ticket.title, description: proposal.ticket.description, process: proposal.process, internalNote: "Note corrigée", replyDraft: "Brouillon corrigé, à relire" } };
}
function mockIntegrations(mode: "create" | "timeout" | "existing" | "unknown" | "different" = "create") {
  vi.stubEnv("GMAIL_CLIENT_ID", "test"); vi.stubEnv("GMAIL_CLIENT_SECRET", "test"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "test");
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("generativelanguage.googleapis.com")) {
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      return geminiFixture({ assessments: data.tickets.map((ticket: { id: string; text: string }) => ({ ticketId: ticket.id,
        relation: mode === "different" ? "different_issue" : "same_issue", messageExcerpt: data.currentMessage, historyExcerpt: "",
        ticketExcerpt: ticket.text.split("\n")[0], explanation: "Verdict provider simulé pour la demande synthétique." })) });
    }
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (url.includes("gmail.googleapis.com") && url.includes("threads/gmail-thread")) return Response.json({ messages: [{ id: "gmail-message", internalDate: String(Date.parse("2026-10-02T12:01:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "client@example.com" }] } }] });
    const stages = ["1", "2", "3", "4"].map((id) => ({ id, metadata: { isClosed: id === "4", ticketState: id === "4" ? "CLOSED" : "OPEN" } }));
    if (url.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages });
    if (url.endsWith("/pipelines/tickets")) return Response.json({ results: [{ id: "0", stages }] });
    if (url.endsWith("/contacts/search")) return Response.json({ results: mode === "unknown" ? [] : [{ id: "21", properties: { email: "client@example.com" } }] });
    if (url.endsWith("/tickets/search")) return Response.json({ results: ["existing", "different"].includes(mode) ? [{ id: "401", properties: { subject: mode === "different" ? "Intégration Slack impossible" : "Retrouver les factures", hs_pipeline: "0", hs_pipeline_stage: "1", hs_lastmodifieddate: new Date().toISOString() } }] : [] });
    if (url.endsWith("/objects/tickets") && init?.method === "POST") {
      if (mode === "timeout") throw new TypeError("Simulated ambiguous transport failure");
      return Response.json({ id: "301", properties: { subject: "Retrouver les factures", hs_pipeline: "0", hs_pipeline_stage: "1" } });
    }
    throw new Error("Unexpected network operation in isolated test");
  });
  vi.stubGlobal("fetch", network);
  return network;
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters"); vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "test-only");
  vi.stubEnv("SAV_GEMINI_API_KEY", "fixture-key"); vi.stubEnv("SAV_AI_ANALYSIS", "true");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "gmail-thread", subject: "Retrouver les factures", customerEmail: "client@example.com" }).returning(); threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "gmail-message", direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: proposal.ticket.description }), receivedAt: new Date("2026-10-02T12:01:00Z"), analysisStatus: "done" }).returning(); messageId = message.id;
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "rules", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture-v1", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal), completedAt: new Date() }).returning(); runId = run.id;
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: "fixture", explanation: "Demande fictive", confidence: 800 }).returning(); decisionId = decision.id;
});

import {loadSavDraftContext,reviewSavDraft} from "./draft-verdicts";
it("SAV-37+38+39 gives priority to a human ticket after draft refusal despite 100 forbidden AI suggestions",async()=>{
 const review=await reviewSavProposal({...reviewInput(),reviewScope:"dossier"},"ugo@limova.ai");
 const c=await loadSavDraftContext(messageId);await reviewSavDraft({threadId,messageId,decisionId,agentRunId:runId,sourceHash:c.sourceHash,expectedVerdictId:null,status:"rejected"},"ugo@limova.ai");
 for(let i=0;i<100;i++)await fixture.db.insert(savActions).values({threadId,messageId,decisionId,kind:"create_ticket",actorType:"ai",priority:999,idempotencyKey:`reviewer-ai-${i}`});
 const action=await queueSavManualTicket({threadId,reviewId:review.id,kind:"create_ticket"},"ugo@limova.ai");const network=mockIntegrations();
 expect((await processPendingHubspotActions(1)).processed).toMatchObject([{actionId:action.id,status:"succeeded",ticketId:"301"}]);
 expect(network.mock.calls.filter(([url,init])=>url.endsWith("/objects/tickets")&&init?.method==="POST")).toHaveLength(1);
 const actions=await fixture.db.select().from(savActions);expect(actions.filter(a=>a.actorType==="ai"&&a.status==="pending")).toHaveLength(100);expect(actions.some(a=>a.kind==="send_reply")).toBe(false);
});
it("F6 preserves a retained dossier verdict in the SAV inbox after identical regeneration",async()=>{
 const review=await reviewSavProposal({...reviewInput(),reviewScope:"dossier"},"ugo@limova.ai");
 await fixture.db.update(savDecisions).set({isCurrent:false}).where(eq(savDecisions.id,decisionId));
 const [run]=await fixture.db.insert(savAgentRuns).values({messageId,runtime:"local_fixture",mode:"off",status:"succeeded",model:"fixture2",promptRevision:"fixture2",inputHash:"fixture2",proposalCiphertext:encryptSavPayload(proposal)}).returning();
 const [d]=await fixture.db.insert(savDecisions).values({messageId,agentRunId:run.id,kind:"ticket_pending",reasonCode:"fixture",explanation:"Demande fictive",confidence:800}).returning();
 expect((await getSavProposalReview(messageId))?.review?.id).toBe(review.id);
 expect(await listSavInbox(100,{view:"reviewed"})).toMatchObject([{messageId,decisionId:d.id,reviewId:review.id,reviewStatus:"approved"}]);
});

it.each([false,true])("F1 reconciles an actual timeout after identical regeneration (legacy command: %s)",async(legacy)=>{
 const review=await reviewSavProposal({...reviewInput(),reviewScope:"dossier"},"ugo@limova.ai");
 await fixture.db.update(savDecisions).set({isCurrent:false}).where(eq(savDecisions.id,decisionId));
 const [run]=await fixture.db.insert(savAgentRuns).values({messageId,runtime:"local_fixture",mode:"off",status:"succeeded",model:"fixture2",promptRevision:"fixture2",inputHash:"fixture2",proposalCiphertext:encryptSavPayload(proposal)}).returning();
 const [decision]=await fixture.db.insert(savDecisions).values({messageId,agentRunId:run.id,kind:"ticket_pending",reasonCode:"fixture",explanation:"Demande fictive",confidence:800}).returning();
 const action=await queueSavManualTicket({threadId,reviewId:review.id,kind:"create_ticket"},"ugo@limova.ai");expect(action.decisionId).toBe(decision.id);
 const network=mockIntegrations("timeout");await processPendingHubspotActions(1);
 const [failed]=await fixture.db.select().from(savActions).where(eq(savActions.id,action.id));
 expect(failed.payload.ticketCreateDispatchedAt).toBeTruthy();
 const proof=decryptSavPayload<{properties:{subject:string;content:string};contactId:string;decisionId:string}>(String(failed.payload.ticketCreateRequestCiphertext));
 expect(proof.contactId).toBe("21");expect(proof.decisionId).toBe(decision.id);
 if(legacy){const payload={...failed.payload};delete payload.ticketCreateRequestCiphertext;delete payload.ticketReviewSnapshotCiphertext;await fixture.db.update(savActions).set({payload}).where(eq(savActions.id,action.id));}
 const before=network.mock.calls.filter(([url,init])=>url.endsWith("/objects/tickets")&&init?.method==="POST").length;
 vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>url.includes("/objects/tickets/301?")?Response.json({id:"301",properties:{...proof.properties,hs_pipeline:"0"},associations:{contacts:{results:[{id:"21"}]}}}):network(url,init));
 const reconciled=await reconcileSavManualTicket(action.id,"301","ugo@limova.ai","Ticket retrouvé, champs et contact vérifiés");
 expect(reconciled.status).toBe("succeeded");expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].hubspotTicketId).toBe("301");
 expect(network.mock.calls.filter(([url,init])=>url.endsWith("/objects/tickets")&&init?.method==="POST")).toHaveLength(before);
 expect(await fixture.db.select().from(savActions).where(eq(savActions.kind,"send_reply"))).toEqual([]);
});
it.each(["subject","content","pipeline","contact"])("F1 rejects a recovered ticket with wrong %s",async(field)=>{
 const review=await reviewSavProposal({...reviewInput(),reviewScope:"dossier"},"ugo@limova.ai");
 const action=await queueSavManualTicket({threadId,reviewId:review.id,kind:"create_ticket"},"ugo@limova.ai");const network=mockIntegrations("timeout");await processPendingHubspotActions(1);
 const [failed]=await fixture.db.select().from(savActions).where(eq(savActions.id,action.id));
 const proof=decryptSavPayload<{properties:{subject:string;content:string}}>(String(failed.payload.ticketCreateRequestCiphertext));
 vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>url.includes("/objects/tickets/301?")?Response.json({id:"301",properties:{...proof.properties,hs_pipeline:field==="pipeline"?"wrong":"0",...(field==="subject"?{subject:"wrong"}:{}),...(field==="content"?{content:"wrong"}:{})},associations:{contacts:{results:[{id:field==="contact"?"wrong":"21"}]}}}):network(url,init));
 await expect(reconcileSavManualTicket(action.id,"301","ugo@limova.ai","Ticket retrouvé à comparer avant rattachement")).rejects.toThrow("SAV_RECONCILIATION_TARGET_INVALID");
 expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].hubspotTicketId).toBeNull();
});
