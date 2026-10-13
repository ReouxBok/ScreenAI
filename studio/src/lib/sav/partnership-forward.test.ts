import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { understandingFixture } from "../../../test/sav-understanding-fixtures";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { savActions, savAgentRuns, savDecisions, savFollowups, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { assertSavCurrentPartnershipForward, getSavPartnershipTransferState, prepareSavPartnershipForward, queueSavPartnershipForward } from "./partnership-forward";
import { processPendingGmailSendActions } from "./gmail";
import { retrySavAction } from "./service";
import { savSemanticPlan } from "./understanding";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string, messageId: string, runId: string;
let rawMail: { raw: string; threadId?: string } | null;
let failSend = false, newerRemote = false, revokePreflight = false;
const body = "Bonjour, notre agence souhaite établir un partenariat de distribution avec Limova.";
function proposal() {
  const understanding = understandingFixture();
  understanding.requests[0] = { ...understanding.requests[0], nature: "partnership", summary: "Proposition de partenariat de distribution." };
  understanding.evidence[0].excerpt = body;
  return { ...v0Proposal(), replyDraft: null, understanding };
}
const network = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const address = String(url);
  if (address.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-only", expires_in: 3600 });
  if (address.includes("/messages?")) return Response.json({ messages: [] });
  if (address.includes("/threads/")) {
    if (revokePreflight) vi.stubEnv("SAV_WRITES_DISABLED", "true");
    return Response.json({ messages: [{ id: newerRemote ? "newer" : "gmail-original", internalDate: "1790942460000", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "fiction@example.invalid" }] } }] });
  }
  if (address.endsWith("/messages/send")) {
    rawMail = JSON.parse(String(init?.body));
    if (failSend) throw new Error("fixture-dispatch-timeout");
    return Response.json({ id: "forward-ack", threadId: "separate-internal-thread" });
  }
  throw new Error("Unexpected mock request");
});
const posts = () => network.mock.calls.filter(([url]) => String(url).endsWith("/messages/send"));
const prepare = () => prepareSavPartnershipForward(threadId, "ugo@limova.ai");
const queue = async () => queueSavPartnershipForward((await prepare()).token, "ugo@limova.ai");
async function changeProposal(mutator: (p: ReturnType<typeof proposal>) => void) {
  const p = proposal(); mutator(p);
  await fixture.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(p) }).where(eq(savAgentRuns.id, runId));
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_PILOT_MODE", "false"); vi.stubEnv("SAV_WRITES_DISABLED", "false");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-partnership-forward-encryption-key-32-characters");
  vi.stubEnv("GMAIL_CLIENT_ID", "fixture"); vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture"); vi.stubEnv("GMAIL_REPLY_FROM_ADDRESS", "contact@limova.ai");
  vi.stubGlobal("__savGmailToken", undefined); vi.stubGlobal("fetch", network); network.mockClear();
  rawMail = null; failSend = false; newerRemote = false; revokePreflight = false;
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "original-thread", subject: "Partenariat", customerEmail: "fiction@example.invalid", hubspotTicketId: "123" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, gmailMessageId: "gmail-original", direction: "inbound", fromEmail: thread.customerEmail, subject: "Partenariat", bodyCiphertext: encryptSavPayload({ text: body, headers: { "message-id": "<original@example.invalid>" } }), receivedAt: new Date("2026-10-02T12:01:00Z") }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal()) }).returning();
  await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "human_review_required", reasonCode: "partnership_human_forward", explanation: "Partenariat fictif", confidence: 0 });
  threadId = thread.id; messageId = message.id; runId = run.id;
});
describe("human-confirmed partnership forward", () => {
  it("previews without network or queue mutation, fixes recipient and retains the email", async () => {
    const preview = await prepare(); expect(preview.to).toBe("nathan@limova.ai"); expect(preview.text).toContain(body);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  });
  it("permits previews when writes are disabled and blocks confirmation", async () => {
    vi.stubEnv("SAV_WRITES_DISABLED", "true"); const preview = await prepare();
    expect(await getSavPartnershipTransferState(threadId)).toMatchObject({ available: true, sendBlockedReason: "SAV_WRITES_DISABLED" });
    await expect(queueSavPartnershipForward(preview.token, "ugo@limova.ai")).rejects.toThrow("SAV_WRITES_DISABLED"); expect(network).not.toHaveBeenCalled();
  });
  it("deduplicates confirmations and sends one new internal email with the exact preview body", async () => {
    const preview = await prepare(); const first = await queueSavPartnershipForward(preview.token, "ugo@limova.ai");
    expect((await queueSavPartnershipForward(preview.token, "ugo@limova.ai")).id).toBe(first.id);
    expect((await processPendingGmailSendActions(1, first.id)).processed[0]).toMatchObject({ status: "succeeded" });
    await processPendingGmailSendActions(); expect(posts()).toHaveLength(1); expect(rawMail).not.toHaveProperty("threadId");
    const [headers, ...content] = Buffer.from(rawMail!.raw, "base64url").toString("utf8").split("\r\n\r\n");
    expect(content.join("\r\n\r\n")).toBe(preview.text); expect(headers).toContain("To: nathan@limova.ai");
    expect(headers).not.toMatch(/(?:^|\r\n)(?:Cc|Bcc|Reply-To|In-Reply-To|References):/); expect(headers).not.toContain("fiction@example.invalid");
    expect(await fixture.db.select().from(savActions)).toHaveLength(1); expect(await fixture.db.select().from(savMessages)).toHaveLength(1); expect(await fixture.db.select().from(savFollowups)).toHaveLength(0);
    const [thread] = await fixture.db.select().from(savThreads); expect(thread.hubspotTicketId).toBe("123"); expect(thread.status).not.toBe("awaiting_customer");
    expect(await getSavPartnershipTransferState(threadId)).toMatchObject({ status: "succeeded" });
  });
  it.each([
    { status: "human_requested" as const, aiPaused: true },
    { status: "human_processing" as const, aiPaused: true },
    { status: "resolved" as const, aiPaused: true },
    { status: "resolved" as const, aiPaused: false },
  ])("allows an explicitly confirmed human forward with $status / paused=$aiPaused without changing those states", async ({ status, aiPaused }) => {
    await fixture.db.update(savThreads).set({ status, aiPaused }).where(eq(savThreads.id, threadId));
    expect(await getSavPartnershipTransferState(threadId)).toMatchObject({ available: true });
    const action = await queue();
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "succeeded" });
    expect(posts()).toHaveLength(1);
    const [thread] = await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId));
    expect(thread).toMatchObject({ status, aiPaused, hubspotTicketId: "123" });
    expect(await fixture.db.select().from(savMessages)).toHaveLength(1);
    expect(await fixture.db.select().from(savFollowups)).toHaveLength(0);
  });
  it.each(["ai", "system"] as const)("does not extend the paused-human exception to a %s transfer", async actorType => {
    await fixture.db.update(savThreads).set({ status: "human_requested", aiPaused: true }).where(eq(savThreads.id, threadId));
    const action = await queue();
    await fixture.db.update(savActions).set({ actorType }).where(eq(savActions.id, action.id));
    await expect(assertSavCurrentPartnershipForward({ ...action, actorType })).rejects.toThrow("SAV_PARTNERSHIP_CONFIRMATION_REQUIRED");
    await processPendingGmailSendActions(1, action.id);
    expect(posts()).toHaveLength(0);
  });
  it("rejects unauthorized staff and previews belonging to another allowed actor", async () => {
    await expect(prepareSavPartnershipForward(threadId, "fiction@example.invalid")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    await expect(queueSavPartnershipForward((await prepare()).token, "reouven@limova.ai")).rejects.toThrow("SAV_PARTNERSHIP_PREVIEW_EXPIRED"); expect(network).not.toHaveBeenCalled();
  });
  it("rejects an altered token and an altered target even in a signed fixture", async () => {
    const preview = await prepare();
    await expect(queueSavPartnershipForward(preview.token.replace(/^v1\./, "v2."), "ugo@limova.ai")).rejects.toThrow();
    const changed = { ...decryptSavPayload<Record<string, unknown>>(preview.token), to: "customer@example.invalid" };
    await expect(queueSavPartnershipForward(encryptSavPayload(changed), "ugo@limova.ai")).rejects.toThrow(); expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("expires previews after fifteen minutes", async () => {
    const preview = await prepare(); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 16 * 60000);
    await expect(queueSavPartnershipForward(preview.token, "ugo@limova.ai")).rejects.toThrow("SAV_PARTNERSHIP_PREVIEW_EXPIRED");
  });
  it("rejects a changed source or decision after preview", async () => {
    const preview = await prepare(); await fixture.db.update(savMessages).set({ subject: "Changed subject" }).where(eq(savMessages.id, messageId));
    await expect(queueSavPartnershipForward(preview.token, "ugo@limova.ai")).rejects.toThrow("SAV_PARTNERSHIP_PREVIEW_STALE");
    const second = await prepare(); await fixture.db.update(savDecisions).set({ isCurrent: false });
    await expect(queueSavPartnershipForward(second.token, "ugo@limova.ai")).rejects.toThrow("SAV_PARTNERSHIP_ANALYSIS_REQUIRED"); expect(posts()).toHaveLength(0);
  });
  it.each(["support", "unknown", "historical", "subject-only", "invented", "clarification"])("blocks %s evidence", async scenario => {
    await changeProposal(p => {
      if (scenario === "support") p.understanding.requests[0].nature = "technical";
      if (scenario === "unknown") p.understanding.requests[0].nature = "unknown";
      if (scenario === "historical") p.understanding.evidence[0].source = "history";
      if (scenario === "subject-only") p.understanding.evidence[0].sourceId = "current_subject";
      if (scenario === "invented") p.understanding.evidence[0].excerpt = "Je confirme le partenariat imaginaire.";
      if (scenario === "clarification") p.understanding.status = "needs_clarification";
    });
    expect(await getSavPartnershipTransferState(threadId)).toMatchObject({ available: false }); await expect(prepare()).rejects.toThrow("SAV_PARTNERSHIP_NOT_DETECTED");
  });
  it("does not reuse a quoted old partnership as current body", async () => {
    await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: `Mon agent ne répond plus.\n\nLe 1 octobre 2026, Fiction a écrit :\n${body}` }) }).where(eq(savMessages.id, messageId));
    await expect(prepare()).rejects.toThrow("SAV_PARTNERSHIP_NOT_DETECTED");
  });
  it.each(["v1", "v2", "v4"])("cannot prepare or execute under %s", async stage => {
    const action = await queue(); vi.stubEnv("SAV_RELEASE_STAGE", stage);
    await expect(prepare()).rejects.toThrow("SAV_PARTNERSHIP_INVALID_STAGE"); await expect(assertSavCurrentPartnershipForward(action)).rejects.toThrow("SAV_PARTNERSHIP_INVALID_STAGE");
  });
  it.each(["pilot", "shadow", "kill"])("blocks queued forwards when %s is enabled", async guard => {
    const action = await queue();
    if (guard === "pilot") vi.stubEnv("SAV_PILOT_MODE", "true"); if (guard === "shadow") vi.stubEnv("SAV_AUTOMATION_MODE", "shadow"); if (guard === "kill") vi.stubEnv("SAV_WRITES_DISABLED", "true");
    await processPendingGmailSendActions(1, action.id); expect(posts()).toHaveLength(0);
  });
  it("blocks if the remote email or last preflight permission changed", async () => {
    const action = await queue(); newerRemote = true; await processPendingGmailSendActions(1, action.id); expect(posts()).toHaveLength(0);
    newerRemote = false; revokePreflight = true; const retry = await queue(); await processPendingGmailSendActions(1, retry.id); expect(posts()).toHaveLength(0);
    const [stored] = await fixture.db.select().from(savActions); expect(stored.payload.forwardDispatchedAt).toBeUndefined();
  });
  it("never resends an uncertain dispatch or hides it on semantic change", async () => {
    const action = await queue(); failSend = true;
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED" });
    await expect(prepare()).rejects.toThrow("SAV_PARTNERSHIP_RECONCILIATION_REQUIRED"); await expect(retrySavAction(action.id, "ugo@limova.ai")).rejects.toThrow("SAV_PARTNERSHIP_RECONCILIATION_REQUIRED");
    await fixture.db.update(savActions).set({ status: "running", updatedAt: new Date(Date.now() - 16 * 60000) }).where(eq(savActions.id, action.id));
    await processPendingGmailSendActions(1, action.id); expect(posts()).toHaveLength(1);
    await changeProposal(p => { p.understanding.requests[0].nature = "technical"; });
    expect(await getSavPartnershipTransferState(threadId)).toMatchObject({ status: "uncertain" });
  });
  it("keeps secondary support and finance requests in policy", () => {
    const p = proposal(); expect(savSemanticPlan(p.understanding)).toMatchObject({ ticketRequired: false, replyPolicy: "none" });
    p.understanding.requests.push({ ...p.understanding.requests[0], id: "support", nature: "technical", summary: "Le téléphone ne répond plus." });
    expect(savSemanticPlan(p.understanding)).toMatchObject({ ticketRequired: true, replyPolicy: "compose", requiresHuman: true });
    p.understanding.requests.push({ ...p.understanding.requests[0], id: "billing", nature: "financial_data", financialScope: "support_account" });
    expect(savSemanticPlan(p.understanding)).toMatchObject({ ticketRequired: true, replyPolicy: "none", reasonCode: "finance_human_only" });
  });
});
