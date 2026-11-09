import {previewCommercialDeliveryAuthority,commitCommercialDeliveryAuthority,readCommercialDeliveryAuthority,getCommercialDeliveryAuthority,reserveCommercialForwardDispatch,COMMERCIAL_AUTHORITY_KEY} from "./commercial-delivery-authority";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savActions, savMailboxes, savMessages, savThreads, staffUsers, savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { activateSavV0Cutover } from "../cutover";
import type { IntakePlan } from "./engine-types";
import { savIntakeDecisionSchema, SAV_INTAKE_CONTRACT_REVISION } from "./contract";
import { prepareSavCommercialForward, queueSavCommercialForward } from "./commercial-forward";
import { retrySavAction } from "../service";
import { processPendingGmailSendActions } from "../gmail";
const state = vi.hoisted(() => ({ db: null as unknown, clerkId:"synthetic-clerk",actor: "contact@limova.ai" }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => ({id:state.clerkId,primaryEmailAddress:{emailAddress:state.actor,verification:{status:"verified"}}}) }));
import {createHash} from "node:crypto";
import {savIntakeRuntimeConfig,intakeRuntimeHash,SAV_INTAKE_RUNTIME_REVISION} from "./runtime-contract";
import {enqueueSavIntakeMessage,claimSavIntakeRun,saveSavIntakeResult,readSavIntakeCurrent} from "./runtime-store";
import {savIntakePlanFingerprint} from "./engine";
import {savIntakeOccupations,auditLogs} from "@/db/schema";
let fixture: Awaited<ReturnType<typeof createSavTestDb>>, threadId: string, messageId: string, failSend = false;
let config:NonNullable<ReturnType<typeof savIntakeRuntimeConfig>>;
const recipient = "commercial-desk@example.invalid", body = "Bonjour, nous souhaitons un devis pour un nouveau projet.";
const classificationText="Synthetic approved classification guidance; pure commercial requests require supervised handling.";
const resource = { schema: "sav-commercial-forward.v1", recipient, subjectPrefix: "Demande commerciale", introduction: "Demande à examiner par votre équipe.", policy: "Only a genuine commercial request, with explicit operator confirmation." };
const network = vi.fn(async (url: string | URL | Request) => { const u = String(url); if(u.endsWith("/crm/v3/objects/contacts/search")) return Response.json({results:[]}); if (u.includes("oauth2.googleapis.com/token"))
    return Response.json({ access_token: "fixture", expires_in: 3600 }); if (u.includes("/messages?"))
    return Response.json({ messages: [] }); if (u.includes("/threads/"))
    return Response.json({ messages: [{ id: "gmail-original", internalDate: "1790942460000", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "fiction@example.invalid" }] } }] }); if (u.endsWith("/messages/send")) {
    if (failSend)
        throw Error("fixture-timeout");
    return Response.json({ id: "ack", threadId: "internal-new-thread" });
} throw Error("Unexpected mock network"); });
const posts = () => network.mock.calls.filter(([url]) => String(url).endsWith("/messages/send"));
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
    for (const [k, v] of Object.entries({ SAV_RELEASE_STAGE: "v0", SAV_AUTOMATION_MODE: "assist", SAV_PILOT_MODE: "false", SAV_WRITES_DISABLED: "false", SAV_ENCRYPTION_KEY_V1: "commercial-test-only-encryption-key-32-characters", GMAIL_CLIENT_ID: "fixture", GMAIL_CLIENT_SECRET: "fixture", GMAIL_REFRESH_TOKEN: "fixture", GMAIL_REPLY_FROM_ADDRESS: "contact@limova.ai" }))
        vi.stubEnv(k, v);
    vi.stubGlobal("__savGmailToken", undefined);
    vi.stubGlobal("fetch", network);
    network.mockClear();
    failSend = false;
    state.actor = "contact@limova.ai";state.clerkId="synthetic-clerk";
    await fixture.client.exec("TRUNCATE sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs; TRUNCATE staff_users CASCADE");
    await fixture.db.insert(staffUsers).values({ clerkId: "synthetic-clerk", email: state.actor, role: "admin", active: true });
    const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
    await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
    const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "original-thread", subject: "Devis", customerEmail: "fiction@example.invalid" }).returning();
    threadId = thread.id;
    const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "gmail-original", direction: "inbound", toEmails:["contact@limova.ai"], fromEmail: thread.customerEmail, subject: "Devis", bodyCiphertext: encryptSavPayload({ text: body }), receivedAt: new Date("2026-10-02T12:01:00Z") }).returning();
    messageId = message.id;
    const ref = { resourceId: "synthetic-commercial", revisionId: "synthetic-v1", sha256: createHash("sha256").update(classificationText).digest("hex") };
    const policy = {relationRevision:"synthetic-no-relations",admittedRelations:[], resources: { commercial: ref } };
    vi.stubEnv("SAV_INTAKE_RUNTIME_RESOURCES", JSON.stringify([{resource:ref,text:classificationText,approvalId:"fixture-approval",approvedBy:"fixture-admin",approvedAt:new Date(Date.now()-1000).toISOString(),status:"approved"}]));
    const decision = savIntakeDecisionSchema.parse({ revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, threadId, receivedAt: message.receivedAt.toISOString(), classification: "commercial", requests: [{ id: "request", kind: "commercial", evidenceIds: ["current"] }], evidence: [{ id: "current", source: "current_message", sourceId: messageId, observedAt: new Date().toISOString(), contentHash: "a".repeat(43) }], disposition: { kind: "no_ticket", reason: "outside_support", nextAction: "supervised_commercial", learning: "excluded", evidenceIds: ["current"] } });
    const pins={mailboxId:mailbox.id,receivedAfter:"2026-10-02T12:00:00.000Z",createdAfter:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),codeRevision:"a".repeat(40),policyHash:intakeRuntimeHash(policy),resourcesHash:intakeRuntimeHash(JSON.parse(process.env.SAV_INTAKE_RUNTIME_RESOURCES!)),maxNanoUsd:3000000000,maxCalls:30};
    for(const [k,v] of Object.entries({SAV_INTAKE_RUNTIME_MODE:"observe",SAV_CODE_REVISION:pins.codeRevision,SAV_AI_MODEL:"gemini-3.6-flash",SAV_GEMINI_API_KEY:"fake-model",HUBSPOT_ACCESS_TOKEN:"fake-crm",SAV_INTAKE_RUNTIME_POLICY:JSON.stringify(policy),SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify(pins),SAV_INTAKE_EXECUTION_MODE:"execute"}))vi.stubEnv(k,v);
    config=savIntakeRuntimeConfig()!;
    await fixture.db.insert(savSyncState).values({key:"sav-intake-execution-schema-v1",status:"installed"});
    const id=await enqueueSavIntakeMessage(messageId,config);expect(id).toBeTruthy();
    const lease=await claimSavIntakeRun(id!,config);expect(lease).toBeTruthy();
    const plan:Omit<IntakePlan,"fingerprint">={revision:"sav-intake-engine-2026-10-20.v1",decision,steps:[],progress:{kind:"supervised_action",messageId,classification:"commercial",action:"supervised_commercial",approval:"human_confirmation_required",evidenceIds:["current"],view:"to_validate"},noteText:null,supervisedResource:ref,originalThreadId:threadId,originalRecipientEmails:[message.fromEmail],referenceMode:"current",readCalls:0,effects:"not_connected"};
    await saveSavIntakeResult(lease!,config,{revision:SAV_INTAKE_RUNTIME_REVISION,effects:"not_connected",reason:"synthetic-classifier-output",plan:{...plan,fingerprint:savIntakePlanFingerprint(plan)}},"observed");
    expect((await readSavIntakeCurrent(threadId,config))?.fresh).toBe(true);

    const authorityPreview=await previewCommercialDeliveryAuthority({commandId:crypto.randomUUID(),expectedRevision:null,settings:{scope:"commercial_pure_contact_mailbox",recipient,subjectPrefix:resource.subjectPrefix,introduction:resource.introduction,state:"enabled",expiresAt:new Date(Date.now()+3600000).toISOString()}});
    await commitCommercialDeliveryAuthority(authorityPreview.commandId,authorityPreview.hash);

});

describe("commercial forwarding with real runtime and occupation",()=>{
 it("validates the approved resource and dispatches with real durable occupation",async()=>{
  expect(config.policy.resources.commercial?.sha256).toBe(createHash("sha256").update(classificationText).digest("hex"));
  const p=await prepareSavCommercialForward(threadId),a=await queueSavCommercialForward(p.token);
  expect(await processPendingGmailSendActions(1,a.actionId)).toMatchObject({processed:[{status:"succeeded"}]});
  expect(posts()).toHaveLength(1);const [action]=await fixture.db.select().from(savActions);expect(action.payload.intakeOccupationAttempt).toBe(1);expect(action.payload.intakeOccupationDispatchedAt).toBeTruthy();expect(action.payload.forwardAcknowledgedAt).toBeTruthy();expect(await fixture.db.select().from(savIntakeOccupations)).toHaveLength(0);
 });
 it("refuses modified text without matching approved runtime pins",async()=>{
  const entries=JSON.parse(process.env.SAV_INTAKE_RUNTIME_RESOURCES!);entries[0].text=JSON.stringify({...resource,recipient:"different@example.invalid"});vi.stubEnv("SAV_INTAKE_RUNTIME_RESOURCES",JSON.stringify(entries));
  expect(()=>savIntakeRuntimeConfig()).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");expect(posts()).toHaveLength(0);
 });
 it("concurrent confirmations create exactly one action without resetting attempts",async()=>{
  const p=await prepareSavCommercialForward(threadId);const results=await Promise.all([queueSavCommercialForward(p.token),queueSavCommercialForward(p.token)]);
  expect(results[0].actionId).toBe(results[1].actionId);expect(await fixture.db.select().from(savActions)).toHaveLength(1);
  await processPendingGmailSendActions(1,results[0].actionId);expect(posts()).toHaveLength(1);
 });
 it("a crash with a persisted occupation prevents another POST and retains uncertainty",async()=>{
  const a=await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token);failSend=true;
  // Synthetic database crash only: worker cannot persist its failure after the uncertain POST.
  await fixture.client.exec("CREATE FUNCTION public.fixture_commercial_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'synthetic crash before failure persistence'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_commercial_crash BEFORE UPDATE ON sav.actions FOR EACH ROW EXECUTE FUNCTION public.fixture_commercial_crash()");
  try{await expect(processPendingGmailSendActions(1,a.actionId)).rejects.toThrow();}finally{await fixture.client.exec("DROP TRIGGER fixture_commercial_crash ON sav.actions; DROP FUNCTION public.fixture_commercial_crash()");}
  const [before]=await fixture.db.select().from(savActions);expect(before.status).toBe("running");expect(before.payload.forwardDispatchedAt).toBeTruthy();expect(before.payload.intakeOccupationDispatchedAt).toBeTruthy();expect(posts()).toHaveLength(1);
  // Move only the synthetic clock age to model a genuine stale-worker reclaim.
  await fixture.db.update(savActions).set({updatedAt:new Date(Date.now()-16*60000)}).where(eq(savActions.id,a.actionId));
  const searches=network.mock.calls.filter(([url])=>String(url).includes("/messages?")).length;
  await processPendingGmailSendActions(1,a.actionId);
  const [after]=await fixture.db.select().from(savActions);expect(after.status).toBe("failed");expect(after.errorCode).toBe("SAV_COMMERCIAL_RECONCILIATION_REQUIRED");expect(after.attemptCount).toBe(2);expect(after.payload.intakeOccupationAttempt).toBe(1);expect(after.payload.forwardDispatchedAt).toBe(before.payload.forwardDispatchedAt);expect(posts()).toHaveLength(1);expect(await fixture.db.select().from(savIntakeOccupations)).not.toHaveLength(0);expect(network.mock.calls.filter(([url])=>String(url).includes("/messages?")).length).toBe(searches);
  await expect(retrySavAction(a.actionId,state.actor)).rejects.toThrow("RECONCILIATION_REQUIRED");
 });
});

async function rotation(stateValue:"enabled"|"revoked"="enabled"){
 const old=await readCommercialDeliveryAuthority();
 return previewCommercialDeliveryAuthority({commandId:crypto.randomUUID(),expectedRevision:old.revision,settings:{...old.settings,recipient:"next-desk@example.invalid",state:stateValue}});
}
describe("independent commercial delivery authority",()=>{
 it("rotates the private destination without changing V1 pins, observation or actions",async()=>{
  const before=savIntakeRuntimeConfig()!,observation=await readSavIntakeCurrent(threadId,before);const preview=await rotation();
  await commitCommercialDeliveryAuthority(preview.commandId,preview.hash);
  const after=savIntakeRuntimeConfig()!;expect([after.resourcesHash,after.policyHash,after.configHash]).toEqual([before.resourcesHash,before.policyHash,before.configHash]);
  const current=await readSavIntakeCurrent(threadId,after);expect(current?.id).toBe(observation?.id);expect(current?.attempts).toBe(observation?.attempts);expect(current?.fresh).toBe(true);expect(await fixture.db.select().from(savActions)).toHaveLength(0);expect(network).not.toHaveBeenCalled();expect((await prepareSavCommercialForward(threadId)).to).toBe("next-desk@example.invalid");
 });
 it.each(["missing","corrupt","revoked","expired"] as const)("refuses %s authority without changing V1 configuration",async condition=>{
  const before=savIntakeRuntimeConfig()!.configHash;
  if(condition==="missing")await fixture.db.delete(savSyncState).where(eq(savSyncState.key,COMMERCIAL_AUTHORITY_KEY));
  if(condition==="corrupt")await fixture.db.update(savSyncState).set({cursor:"invalid"}).where(eq(savSyncState.key,COMMERCIAL_AUTHORITY_KEY));
  if(condition==="revoked"){const p=await rotation("revoked");await commitCommercialDeliveryAuthority(p.commandId,p.hash);}
  if(condition==="expired"){const old=await readCommercialDeliveryAuthority();const settings={...old.settings,expiresAt:new Date(Date.now()-1000).toISOString()};await fixture.db.update(savSyncState).set({cursor:encryptSavPayload({...old,settings,contentHash:intakeRuntimeHash(settings)})}).where(eq(savSyncState.key,COMMERCIAL_AUTHORITY_KEY));}
  await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("SAV_COMMERCIAL_AUTHORITY_");expect(savIntakeRuntimeConfig()!.configHash).toBe(before);expect(posts()).toHaveLength(0);
 });
 it("commits one of two concurrent revisions and replays only an identical command",async()=>{
  const p=await rotation(),q=await rotation();const results=await Promise.allSettled([commitCommercialDeliveryAuthority(p.commandId,p.hash),commitCommercialDeliveryAuthority(q.commandId,q.hash)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);const winner=results[0].status==="fulfilled"?p:q;
  expect(await commitCommercialDeliveryAuthority(winner.commandId,winner.hash)).toMatchObject({revision:winner.commandId,idempotent:true});
  await expect(previewCommercialDeliveryAuthority({...winner,actorId:undefined})).rejects.toThrow();
  await expect(previewCommercialDeliveryAuthority({commandId:winner.commandId,expectedRevision:winner.expectedRevision,settings:{...winner.settings,introduction:"Different approved introduction"}})).rejects.toThrow("PREVIEW_CONFLICT");
  const audits=await fixture.db.select().from(auditLogs).where(eq(auditLogs.action,"sav_commercial_delivery_authority_approved"));expect(audits).toHaveLength(2);expect(JSON.stringify(audits)).not.toContain(recipient);
 });
 it("fails commit for a revoked actor and for another authenticated administrator",async()=>{
  const p=await rotation();await fixture.db.update(staffUsers).set({active:false}).where(eq(staffUsers.clerkId,"synthetic-clerk"));await expect(commitCommercialDeliveryAuthority(p.commandId,p.hash)).rejects.toThrow();
  await fixture.db.insert(staffUsers).values({clerkId:"second-clerk",email:"ugo@limova.ai",role:"admin",active:true});state.actor="ugo@limova.ai";state.clerkId="second-clerk";await expect(commitCommercialDeliveryAuthority(p.commandId,p.hash)).rejects.toThrow("PREVIEW_CONFLICT");
 });
 it("fails expired and altered previews",async()=>{
  const p=await rotation(),key=`${COMMERCIAL_AUTHORITY_KEY}:preview:${p.commandId}`;
  await expect(commitCommercialDeliveryAuthority(p.commandId,"0".repeat(64))).rejects.toThrow("PREVIEW_CONFLICT");
  const {hash,...rest}=p;void hash;const expired={...rest,createdAt:new Date(Date.now()-900000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()};
  await fixture.db.update(savSyncState).set({cursor:encryptSavPayload({...expired,hash:intakeRuntimeHash(expired)})}).where(eq(savSyncState.key,key));await expect(commitCommercialDeliveryAuthority(p.commandId,intakeRuntimeHash(expired))).rejects.toThrow("EXPIRED");
 });
 it("rotation invalidates a preview and a queued action before any POST",async()=>{
  const old=await prepareSavCommercialForward(threadId),p=await rotation();await commitCommercialDeliveryAuthority(p.commandId,p.hash);await expect(queueSavCommercialForward(old.token)).rejects.toThrow("PREVIEW_STALE");
  const action=await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token),q=await rotation();await commitCommercialDeliveryAuthority(q.commandId,q.hash);await processPendingGmailSendActions(1,action.actionId);expect(posts()).toHaveLength(0);
 });
 it("serializes authority rotation against the durable dispatch marker",async()=>{
  const a=await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token),old=await readCommercialDeliveryAuthority(),p=await rotation();
  await fixture.db.update(savActions).set({status:"running",attemptCount:1}).where(eq(savActions.id,a.actionId));
  const [reserved,rotated]=await Promise.allSettled([reserveCommercialForwardDispatch(a.actionId,old.revision,old.contentHash),commitCommercialDeliveryAuthority(p.commandId,p.hash)]);
  expect(rotated.status).toBe("fulfilled");const [saved]=await fixture.db.select().from(savActions).where(eq(savActions.id,a.actionId));
  if(reserved.status==="fulfilled"){expect(saved.payload.forwardDispatchedAt).toBeTruthy();expect(saved.payload.commercialAuthorityRevision).toBe(old.revision);if(rotated.status==="fulfilled")expect(rotated.value.dispatched?.some(x=>x.id===a.actionId)).toBe(true);}else{expect(saved.payload.forwardDispatchedAt).toBeUndefined();}
  expect(posts()).toHaveLength(0);
 });
 it("does not send a successfully forwarded message again after rotation",async()=>{
  const a=await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token);await processPendingGmailSendActions(1,a.actionId);const p=await rotation();await commitCommercialDeliveryAuthority(p.commandId,p.hash);await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("ALREADY_REQUESTED");await processPendingGmailSendActions(1,a.actionId);expect(posts()).toHaveLength(1);
 });
 it("rejects non-admin publication without altering delivery authority",async()=>{
  const old=await readCommercialDeliveryAuthority();await fixture.db.update(staffUsers).set({role:"member"}).where(eq(staffUsers.clerkId,"synthetic-clerk"));
  await expect(previewCommercialDeliveryAuthority({commandId:crypto.randomUUID(),expectedRevision:old.revision,settings:old.settings})).rejects.toThrow();expect(posts()).toHaveLength(0);
 });
 it("rolls back publication if the mandatory audit cannot persist",async()=>{
  const old=await readCommercialDeliveryAuthority(),p=await rotation();
  await fixture.client.exec("CREATE FUNCTION public.fixture_authority_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='sav_commercial_delivery_authority_approved' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_authority_audit_fail BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fixture_authority_audit_fail()");
  try{await expect(commitCommercialDeliveryAuthority(p.commandId,p.hash)).rejects.toThrow();}finally{await fixture.client.exec("DROP TRIGGER fixture_authority_audit_fail ON public.audit_logs; DROP FUNCTION public.fixture_authority_audit_fail()");}
  expect((await readCommercialDeliveryAuthority()).revision).toBe(old.revision);const [draft]=await fixture.db.select().from(savSyncState).where(eq(savSyncState.key,`${COMMERCIAL_AUTHORITY_KEY}:preview:${p.commandId}`));expect(draft.status).toBe("preview");expect(await fixture.db.select().from(savActions)).toHaveLength(0);
 });

 it("labels bounded dispatch history and prioritizes uncertain actions deterministically",async()=>{
  const values=Array.from({length:102},(_,i)=>({threadId,messageId,kind:"send_reply",status:i===0?"failed":"succeeded",actorType:"human",idempotencyKey:`synthetic-history-${i}`,updatedAt:new Date(i===0?0:Date.now()),payload:{purpose:"intake_commercial_forward",forwardDispatchedAt:new Date().toISOString()}}));
  const inserted=await fixture.db.insert(savActions).values(values).returning();const first=await getCommercialDeliveryAuthority(),second=await getCommercialDeliveryAuthority();
  expect(first).toMatchObject({dispatchedLimit:100,dispatchedTruncated:true,dispatchedIncludesConfirmed:true});expect(first.dispatched).toHaveLength(100);expect(first.dispatched[0]).toMatchObject({id:inserted[0].id,status:"failed"});expect(second.dispatched).toEqual(first.dispatched);expect(posts()).toHaveLength(0);
 });

});
