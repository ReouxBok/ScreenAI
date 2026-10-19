import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from "vitest";
import {eq} from "drizzle-orm";
import {createSavTestDb} from "../../../test/sav-db";
import {understandingFixture} from "../../../test/sav-understanding-fixtures";
import {savAnalysisSnapshots,savAgentRuns,savDecisions,savDraftVerdicts,savLearningCandidates,savMailboxes,savMessages,savThreads} from "@/db/schema";
import {decryptSavPayload,encryptSavPayload,savContentHash} from "./crypto";
import {activateSavV0Cutover} from "./cutover";
import {activateSavLearningCutover} from "./learning-admission";
import {defaultSavPlaybook} from "./playbook-contract";
import {analyzeSavMessage} from "./intelligence";
import {captureSavAnalysisSnapshot,ensureSavCaseObservationTx} from "./case-learning";
import {loadSavDraftContext} from "./draft-verdicts";
import {assertSavCurrentManualReply,confirmSavSuggestedReply} from "./manual-replies";
import {prepareSavManualTicketPreview} from "./manual-ticket-preview";
import {renderSavOutboundReply} from "./reply-format";
import {syncSavObservation,prepareSavObservationLearning,getSavObservations} from "./observations";
import {collectSavDossierContext} from "./dossier-context";
import {reviewSavProposal} from "./review";
import type {SavStructuredProposal} from "./proposal";
const deps=vi.hoisted(()=>({db:null as unknown,crm:vi.fn(),understand:vi.fn(),compare:vi.fn(),network:vi.fn()}));
vi.mock("@/db",()=>({requireDb:()=>deps.db}));
vi.mock("./hubspot",()=>({readSavHubspotContext:deps.crm}));
vi.mock("./understanding-model",()=>({understandSavMessage:deps.understand}));
vi.mock("./playbook",()=>({readActiveSavPlaybook:async()=>({versionId:"synthetic-playbook",version:1,document:defaultSavPlaybook})}));
vi.mock("./reply-coherence",()=>({checkSavReplyCoherence:async()=>({status:"passed",issues:[],promptRevision:"synthetic-coherence",model:"synthetic",inputHash:"fixture",outputHash:"fixture",durationMs:1,inputTokens:1,outputTokens:1,totalTokens:2,errorCode:null})}));
vi.mock("./learning-comparator",async original=>({...await original<typeof import("./learning-comparator")>(),compareSavLearningResolution:deps.compare}));
let fixture:Awaited<ReturnType<typeof createSavTestDb>>,threadId:string,messageId:string,body:string;
const actor="ugo@limova.ai",sender="sender@example.invalid",alternate="account@example.invalid";
const absent={contactFound:false,errorCode:null,identityCandidates:[],tickets:[],routing:{kind:"new",reason:"no_contact",candidateIds:[]}};
beforeAll(async()=>{fixture=await createSavTestDb();deps.db=fixture.db;},30000);
afterAll(async()=>fixture.client.close());
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
beforeEach(async()=>{
 for(const [name,value] of Object.entries({SAV_ENCRYPTION_KEY_V1:"synthetic-combination-only-encryption-key-2026",SAV_RELEASE_STAGE:"v0",SAV_AUTOMATION_MODE:"assist",SAV_WRITES_DISABLED:"false",SAV_AI_ANALYSIS:"true",SAV_TEST_MODE:"true",SAV_GEMINI_API_KEY:"synthetic",SAV_ADK_MODE:"off"}))vi.stubEnv(name,value);
 deps.crm.mockReset().mockResolvedValue(absent);deps.understand.mockReset();deps.compare.mockReset().mockImplementation(()=>{throw new Error("UNEXPECTED_COMPARISON");});deps.network.mockReset().mockImplementation(()=>{throw new Error("UNEXPECTED_NETWORK");});vi.stubGlobal("fetch",deps.network);
 await fixture.client.exec("TRUNCATE content_items CASCADE;TRUNCATE sav.mailboxes CASCADE;TRUNCATE sav.sync_state;TRUNCATE sav.learning_candidates CASCADE;TRUNCATE audit_logs;TRUNCATE active_knowledge");
 const [mailbox]=await fixture.db.insert(savMailboxes).values({email:"contact@limova.ai"}).returning();
 await activateSavV0Cutover({receivedAfter:"2026-10-01T00:00:00Z",mailboxEmail:"contact@limova.ai",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:actor});
 const [thread]=await fixture.db.insert(savThreads).values({mailboxId:mailbox.id,gmailThreadId:"synthetic-registration",customerEmail:sender}).returning();threadId=thread.id;
 body="Hello, my PDF export fails with ERR_42. Please help.";
 const [message]=await fixture.db.insert(savMessages).values({threadId,mailboxId:mailbox.id,gmailMessageId:"synthetic-registration-inbound",direction:"inbound",fromEmail:sender,subject:"PDF export",bodyCiphertext:encryptSavPayload({text:body,headers:{"message-id":"<synthetic-registration@example.invalid>"}}),receivedAt:new Date("2026-10-19T12:00:00Z")}).returning();messageId=message.id;
});
async function analyze(supplied=false){
 if(supplied)body+=` My registration email is ${alternate}`;
 await fixture.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:body,headers:{"message-id":"<synthetic-registration@example.invalid>"}})}).where(eq(savMessages.id,messageId));
 const u=understandingFixture({language:"en"});u.requests[0].summary="My PDF export fails.";u.evidence[0].excerpt=body;
 if(supplied)u.knownFacts=[{id:"registration",key:"registration_email",text:alternate,evidenceIds:[u.evidence[0].id]}];
 deps.understand.mockResolvedValue(u);
 const result=await analyzeSavMessage({from:sender,subject:"PDF export",body},{messageId});
 const [decision]=await fixture.db.insert(savDecisions).values({messageId,agentRunId:result.agentRunId,kind:result.proposal.kind,reasonCode:result.proposal.reasonCode,explanation:result.proposal.explanation,confidence:0}).returning();
 return {...result,decisionId:decision.id,structuredProposal:result.structuredProposal!};
}
async function confirmation(){const c=await loadSavDraftContext(messageId);const text=c.proposal.replyDraft!;return {threadId,messageId,decisionId:c.decision.id,agentRunId:c.run.id,sourceHash:c.sourceHash,expectedDraftId:null,text,recipient:sender,outboundHash:savContentHash(renderSavOutboundReply(text,"en","manual_reviewed")),origin:"ai"};}
async function observe(){return fixture.db.transaction(tx=>ensureSavCaseObservationTx(tx,messageId,"dossier_validated"));}
it("persists the English identity prerequisite before capture and confirms only that exact clarification without a verdict",async()=>{
 const result=await analyze();expect(result.proposal.reasonCode).toBe("registration_email_required");expect(result.replyDraft).toContain("register with Limova");expect(result.structuredProposal.process.some(p=>["product_step","create_ticket","link_ticket"].includes(p.kind))).toBe(false);
 const [snapshot]=await fixture.db.select().from(savAnalysisSnapshots);const captured=decryptSavPayload<{proposal:SavStructuredProposal;availableContext:{dossierContext:{crm:unknown}}}>(snapshot.payloadCiphertext);expect(captured.proposal).toEqual(result.structuredProposal);expect(captured.proposal.customerIdentity.verifiedByHuman).toBe(false);expect(captured.availableContext.dossierContext.crm).toMatchObject({status:"ready",data:{contactFound:false}});
 const action=await confirmSavSuggestedReply(await confirmation(),actor);expect((await assertSavCurrentManualReply(action)).outboundText).toContain("The Limova team");expect(action.payload.confirmedRecipient).toBe(sender);expect(await fixture.db.select().from(savDraftVerdicts)).toHaveLength(0);await expect(prepareSavManualTicketPreview({threadId,reviewId:result.decisionId},actor)).rejects.toThrow("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");expect(deps.crm).toHaveBeenCalledOnce();expect(deps.network).not.toHaveBeenCalled();
});
it("keeps an alternate address unverified through snapshot, Gmail-only tracking and one-click confirmation",async()=>{
 deps.crm.mockImplementation(async({email})=>email===alternate?{...absent,contactFound:true,contactId:"PRIVATE_ALTERNATE"}:absent);
 const result=await analyze(true);expect(result.proposal.reasonCode).toBe("registration_email_confirmation_required");expect(result.replyDraft).not.toContain("?");expect(result.structuredProposal.customerIdentity).toEqual({registrationEmail:alternate,verifiedByHuman:false});
 const id=(await observe())!,collector=vi.fn();await syncSavObservation(id,collector);expect(collector).not.toHaveBeenCalled();expect((await getSavObservations(threadId))[0].state).toBe("gmail_only");
 await expect(confirmSavSuggestedReply({...await confirmation(),recipient:alternate},actor)).rejects.toThrow("SAV_REPLY_MANUAL_CONTEXT_CHANGED");await confirmSavSuggestedReply(await confirmation(),actor);
 expect(deps.crm).toHaveBeenCalledOnce();expect(deps.crm.mock.calls[0][0].email).toBe(sender);expect(JSON.stringify((await fixture.db.select().from(savAnalysisSnapshots)).map(row=>decryptSavPayload(row.payloadCiphertext)))).not.toContain("PRIVATE_ALTERNATE");expect(deps.compare).not.toHaveBeenCalled();
});
it("preserves lookup unavailability instead of inventing customer absence or a resolution",async()=>{
 deps.crm.mockRejectedValue(new Error("synthetic-403"));const result=await analyze();expect(result.proposal.reasonCode).toBe("registration_lookup_unavailable");expect(result.replyDraft).not.toMatch(/register with Limova|not found/);const [run]=await fixture.db.select().from(savAgentRuns);expect(run.status).toBe("fallback");const id=(await observe())!,collector=vi.fn();await syncSavObservation(id,collector);expect(collector).not.toHaveBeenCalled();expect(await fixture.db.select().from(savLearningCandidates)).toHaveLength(0);
});
it("reads the alternate account only after an approved human verification, stales the old confirmation and preserves the initial reference",async()=>{
 const result=await analyze(true),oldConfirmation=await confirmation();await observe();const [initial]=await fixture.db.select().from(savAnalysisSnapshots);
 const p=result.structuredProposal;await reviewSavProposal({messageId,decisionId:result.decisionId,agentRunId:result.agentRunId!,expectedReviewId:null,reviewScope:"dossier",status:"approved",verdict:"partial",dimensions:{classification:"correct",routing:"partial",grounding:"correct",tone:"correct",escalation:"correct"},comment:"Identité du compte synthétique vérifiée humainement.",reusability:"none",correction:{category:p.category,urgency:p.urgency,decisionKind:p.decision.kind,reasonCode:"account_identity_verified",explanation:"Le compte a été vérifié par une personne autorisée.",title:p.ticket.title,description:p.ticket.description,process:p.process,internalNote:"",replyDraft:p.replyDraft!,registrationEmail:alternate,identityVerified:true}},actor);
 deps.crm.mockResolvedValue({...absent,contactFound:true,contactId:"CONFIRMED_ACCOUNT"});const context=await collectSavDossierContext(messageId);expect(context.crm.data?.contactId).toBe("CONFIRMED_ACCOUNT");expect(deps.crm.mock.calls.map(c=>c[0].email)).toEqual([sender,alternate]);await expect(confirmSavSuggestedReply(oldConfirmation,actor)).rejects.toThrow("SAV_REPLY_MANUAL_CONTEXT_CHANGED");
 await fixture.db.transaction(tx=>captureSavAnalysisSnapshot(tx,result.agentRunId!));const [current]=await fixture.db.select().from(savAnalysisSnapshots);expect(current.payloadCiphertext).toBe(initial.payloadCiphertext);expect(decryptSavPayload<{proposal:SavStructuredProposal}>(current.payloadCiphertext).proposal.customerIdentity.verifiedByHuman).toBe(false);
});
it("never learns a copied registration clarification or closure alone as an independently resolved procedure",async()=>{
 const result=await analyze();await activateSavLearningCutover({activatedAt:"2026-10-01T00:00:00.000Z",activatedBy:actor,deploymentSha:"b".repeat(40)},actor);await fixture.db.update(savThreads).set({hubspotTicketId:"123"}).where(eq(savThreads.id,threadId));const id=(await observe())!;
 await syncSavObservation(id,async()=>({ticketId:"123",status:"closed",subject:"Synthetic identity question",updatedAt:new Date().toISOString(),errors:[],events:[{sourceRef:"hubspot:emails:copy",kind:"human_reply",occurredAt:new Date().toISOString(),text:result.replyDraft!,author:"owner:fixture",provenance:"synthetic",associationTicketId:"123",remoteUpdatedAt:null}]}));await prepareSavObservationLearning(id);expect(deps.compare).not.toHaveBeenCalled();expect(await fixture.db.select().from(savLearningCandidates)).toHaveLength(0);
});
