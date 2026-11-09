import {previewCommercialDeliveryAuthority,commitCommercialDeliveryAuthority,commercialDeliverySettingsSchema} from "./commercial-delivery-authority";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savActions, savMailboxes, savMessages, savThreads, staffUsers, savSyncState } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { activateSavV0Cutover } from "../cutover";
import { type SavIntakeDecision, SAV_INTAKE_CONTRACT_REVISION } from "./contract";
import { prepareSavCommercialForward, queueSavCommercialForward } from "./commercial-forward";
import { savAgentPauseKey, SAV_AGENT_PAUSE_REVISION } from "./agent-pause";
import { retrySavAction } from "../service";
import { processPendingGmailSendActions } from "../gmail";
type ResourceRef = {resourceId:string;revisionId:string;sha256:string};
type ObservationFixture = {id:string;messageId:string;fresh:boolean;sourceMatches:boolean;currentSourceHash:string;leaseToken:string|null;leaseUntil:Date|null;payload:{plan:{supervisedResource:ResourceRef;decision:SavIntakeDecision}}};
const state = vi.hoisted(() => ({ db: null as unknown, current: {} as ObservationFixture, policy: {resources:{commercial:{resourceId:"",revisionId:"",sha256:""}}}, actorId:"", actor: "contact@limova.ai" }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./runtime-store", () => ({ readSavIntakeCurrent: async () => state.current }));
vi.mock("./runtime-contract", async (importOriginal) => ({ ...await importOriginal<typeof import("./runtime-contract")>(), savIntakeRuntimeConfig: () => ({ policy: state.policy }) }));
vi.mock("./execution-policy", async (importOriginal) => ({ ...await importOriginal<typeof import("./execution-policy")>(), executionAdministrator: async () => ({ id:state.actorId,email: state.actor }) }));
// Occupation is separately qualified; no real HubSpot is reachable in this isolated transport test.
vi.mock("./legacy-occupation", () => ({ guardLegacyIntakeOccupation: async () => { }, withLegacyOccupationAction: async (_a: unknown, fn: () => unknown) => fn(), markLegacyIntakeDispatch: async () => { }, releaseLegacyIntakeIfConfirmed: async () => { } }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>, threadId: string, messageId: string, raw: {raw:string;threadId?:string}, failSend = false;
const recipient = "commercial-desk@example.invalid", body = "Bonjour, nous souhaitons un devis pour un nouveau projet.";
const resource = { schema: "sav-commercial-forward.v1", recipient, subjectPrefix: "Demande commerciale", introduction: "Demande à examiner par votre équipe.", policy: "Only a genuine commercial request, with explicit operator confirmation." };
const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { const u = String(url); if (u.includes("oauth2.googleapis.com/token"))
    return Response.json({ access_token: "fixture", expires_in: 3600 }); if (u.includes("/messages?"))
    return Response.json({ messages: [] }); if (u.includes("/threads/"))
    return Response.json({ messages: [{ id: "gmail-original", internalDate: "1790942460000", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "fiction@example.invalid" }] } }] }); if (u.endsWith("/messages/send")) {
    raw = JSON.parse(String(init?.body));
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
    raw = {raw:""};
    failSend = false;
    state.actor = "contact@limova.ai";
    await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs; TRUNCATE staff_users CASCADE");
    const [administrator]=await fixture.db.insert(staffUsers).values({ clerkId: "synthetic-clerk", email: state.actor, role: "admin", active: true }).returning();state.actorId=administrator.id;
    const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
    await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
    const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "original-thread", subject: "Devis", customerEmail: "fiction@example.invalid" }).returning();
    threadId = thread.id;
    const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "gmail-original", direction: "inbound", fromEmail: thread.customerEmail, subject: "Devis", bodyCiphertext: encryptSavPayload({ text: body }), receivedAt: new Date("2026-10-02T12:01:00Z") }).returning();
    messageId = message.id;
    const ref = { resourceId: "synthetic-commercial", revisionId: "synthetic-v1", sha256: "a".repeat(64) };
    state.policy = { resources: { commercial: ref } };
    vi.stubEnv("SAV_INTAKE_RUNTIME_RESOURCES", JSON.stringify([{ resource: ref, text: JSON.stringify(resource) }]));
    state.current = { id: crypto.randomUUID(), messageId, fresh: true, sourceMatches: true, currentSourceHash: "source", leaseToken: null, leaseUntil: null, payload: { plan: { supervisedResource: ref, decision: { revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, threadId, receivedAt: message.receivedAt.toISOString(), classification: "commercial", requests: [{ id: "request", kind: "commercial", evidenceIds: ["current"] }], evidence: [{ id: "current", source: "current_message", sourceId: messageId, observedAt: message.receivedAt.toISOString(), contentHash: "a".repeat(43) }], disposition: { kind: "no_ticket", reason: "outside_support", nextAction: "supervised_commercial", learning: "excluded", evidenceIds: ["current"] } } } } };
    const authorityPreview=await previewCommercialDeliveryAuthority({commandId:crypto.randomUUID(),expectedRevision:null,settings:{scope:"commercial_pure_contact_mailbox",recipient,subjectPrefix:resource.subjectPrefix,introduction:resource.introduction,state:"enabled",expiresAt:new Date(Date.now()+3600000).toISOString()}});
    await commitCommercialDeliveryAuthority(authorityPreview.commandId,authorityPreview.hash);

});
describe("commercial forward with private recipient", () => {
    it("previews exact original without any network or mutation", async () => { const p = await prepareSavCommercialForward(threadId); expect(p.to).toBe(recipient); expect(p.text).toContain(body); expect(await fixture.db.select().from(savActions)).toHaveLength(0); expect(network).not.toHaveBeenCalled(); });
    it("deduplicates confirmation and sends one separate email with no CRM/customer reply", async () => { const p = await prepareSavCommercialForward(threadId); const a = await queueSavCommercialForward(p.token); expect(await queueSavCommercialForward(p.token)).toMatchObject({ actionId: a.actionId }); const result = await processPendingGmailSendActions(1, a.actionId); expect(result.processed).toEqual([expect.objectContaining({ status: "succeeded" })]); await processPendingGmailSendActions(1, a.actionId); expect(posts()).toHaveLength(1); expect(raw.threadId).toBeUndefined(); const mail = Buffer.from(raw.raw, "base64url").toString(); expect(mail).toContain(`To: ${recipient}`); expect(mail).toContain(p.text); expect(mail).not.toMatch(/^(Cc|Bcc|In-Reply-To|References):/m); expect(await fixture.db.select().from(savMessages)).toHaveLength(1); });
    it("never retries an uncertain dispatch", async () => { const a = await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token); failSend = true; await processPendingGmailSendActions(1, a.actionId); await processPendingGmailSendActions(1, a.actionId); const [row] = await fixture.db.select().from(savActions); expect(row.status).toBe("failed"); expect(row.errorCode).toBe("SAV_COMMERCIAL_RECONCILIATION_REQUIRED"); expect(posts()).toHaveLength(1); await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("RECONCILIATION_REQUIRED"); });
    it.each(["support", "finance", "cancellation", "partnership", "investor"] as const)("rejects mixed %s", async (kind) => { state.current.payload.plan.decision.requests.push({ id: "other", kind, evidenceIds: ["current"] }); await expect(prepareSavCommercialForward(threadId)).rejects.toThrow(); expect(posts()).toHaveLength(0); });
    it.each(["fresh", "sourceMatches"] as const)("rejects stale %s", async (key) => { state.current[key] = false; await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("CURRENT_ANALYSIS_REQUIRED"); });
    it("refuses a human pause", async () => { await fixture.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId)); await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("HUMAN_HOLD"); });
    it("refuses a later outbound message", async () => { const [m] = await fixture.db.select().from(savMessages); await fixture.db.insert(savMessages).values({ mailboxId: m.mailboxId, threadId, direction: "outbound", fromEmail: "contact@limova.ai", subject: "Re", bodyCiphertext: encryptSavPayload({ text: "Déjà traité" }), receivedAt: new Date() }); await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("HUMAN_HISTORY_REVIEW_REQUIRED"); });
    it("rechecks resource before queue", async () => { const p = await prepareSavCommercialForward(threadId); state.policy.resources.commercial = { ...state.policy.resources.commercial, revisionId: "changed" }; await expect(queueSavCommercialForward(p.token)).rejects.toThrow("RESOURCE_CHANGED"); });
    it("rejects tampered preview body at dispatch", async () => { const p = await prepareSavCommercialForward(threadId); const changed = decryptSavPayload<{text:string}>(p.token); changed.text = "different"; await expect(queueSavCommercialForward(encryptSavPayload(changed))).rejects.toThrow("PREVIEW_STALE"); expect(posts()).toHaveLength(0); });
    it("rechecks actor revocation before dispatch", async () => { const a = await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token); await fixture.db.update(staffUsers).set({ active: false }); await processPendingGmailSendActions(1, a.actionId); expect(posts()).toHaveLength(0); });
    it("does not accept header injection", () => { const settings={scope:"commercial_pure_contact_mailbox",recipient,subjectPrefix:resource.subjectPrefix,introduction:resource.introduction,state:"enabled",expiresAt:new Date(Date.now()+3600000).toISOString()};expect(commercialDeliverySettingsSchema.safeParse({...settings,subjectPrefix:"ok\nBcc: bad"}).success).toBe(false);expect(commercialDeliverySettingsSchema.safeParse({...settings,recipient:"desk@example.invalid\r\nBcc: bad"}).success).toBe(false); });
    it.each(["actions_paused", "fully_paused"])("honors global %s", async (level) => { await fixture.db.insert(savSyncState).values({ key: savAgentPauseKey("intake"), cursor: encryptSavPayload({ revision: SAV_AGENT_PAUSE_REVISION, agent: "intake", level, setBy: "fixture", setAt: new Date().toISOString(), reason: "Human fixture pause" }) }); await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("PAUSED"); expect(posts()).toHaveLength(0); });
    it("does not reset a failed action", async () => { const p = await prepareSavCommercialForward(threadId); const a = await queueSavCommercialForward(p.token); await fixture.db.update(savActions).set({ status: "failed", attemptCount: 4, errorCode: "SAV_COMMERCIAL_PREVIEW_STALE" }).where(eq(savActions.id, a.actionId)); expect(await queueSavCommercialForward(p.token)).toMatchObject({ status: "failed" }); const [saved] = await fixture.db.select().from(savActions); expect(saved.attemptCount).toBe(4); expect(saved.errorCode).toBe("SAV_COMMERCIAL_PREVIEW_STALE"); });
    it("rechecks source after confirmation", async () => { const a = await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token); state.current.sourceMatches = false; await processPendingGmailSendActions(1, a.actionId); expect(posts()).toHaveLength(0); });
    it("rejects a different confirming administrator", async () => { const p = await prepareSavCommercialForward(threadId); state.actor = "ugo@limova.ai"; await expect(queueSavCommercialForward(p.token)).rejects.toThrow("PREVIEW_EXPIRED"); });
    it("rejects a lease held by the intake worker", async () => { state.current.leaseToken = crypto.randomUUID(); await expect(prepareSavCommercialForward(threadId)).rejects.toThrow("CURRENT_ANALYSIS_REQUIRED"); });
    it("blocks the legacy retry entry point after an uncertain forward", async () => {
        const a = await queueSavCommercialForward((await prepareSavCommercialForward(threadId)).token);
        failSend = true;
        await processPendingGmailSendActions(1, a.actionId);
        await expect(retrySavAction(a.actionId, state.actor)).rejects.toThrow("SAV_COMMERCIAL_RECONCILIATION_REQUIRED");
        expect(posts()).toHaveLength(1);
    });

});
