import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savMailboxes, savMessages, savPilotBatches, savPilotItems, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { recordSavEmailOpened } from "./opened-email";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let input: { threadId: string; messageId: string };
let mailboxId: string;
let labels: Array<{ id: string; name: string; type: string }>;
let messageLabels: string[];
let deniedAt: "labels" | "modify" | null;
let uncertain: boolean;
let wrongThread: boolean;
let activateKillSwitch: boolean;
let wrongReceipt: boolean;
const network = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const address = String(url);
  if (address.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-only", expires_in: 3600 });
  if (address.endsWith("/labels")) return deniedAt === "labels" ? new Response(null, { status: 403 }) : Response.json({ labels });
  if (address.endsWith("/messages/selected-gmail-id/modify")) {
    if (deniedAt === "modify") return new Response(null, { status: 403 });
    const body = JSON.parse(String(init?.body)) as { addLabelIds: string[]; removeLabelIds: string[] };
    messageLabels = [...new Set([...messageLabels.filter((label) => !body.removeLabelIds.includes(label)), ...body.addLabelIds])];
    if (uncertain) throw new Error("fixture-timeout-after-modification");
    return Response.json({ id: "selected-gmail-id", threadId: wrongReceipt ? "unexpected-thread" : "original-thread", labelIds: messageLabels });
  }
  if (address.includes("/messages/selected-gmail-id?")) {
    if (activateKillSwitch) vi.stubEnv("SAV_WRITES_DISABLED", "true");
    return Response.json({ id: "selected-gmail-id", threadId: wrongThread ? "unexpected-thread" : "original-thread", labelIds: messageLabels });
  }
  throw new Error(`Unexpected fixture request: ${address}`);
});
function modifications() { return network.mock.calls.filter(([url]) => String(url).endsWith("/modify")); }
async function clickAudits() { return fixture.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_email_opened")); }

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false");
  vi.stubEnv("SAV_TEST_MODE", "false"); vi.stubEnv("SAV_PILOT_MODE", "false");
  vi.stubEnv("GMAIL_CLIENT_ID", "fixture"); vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture");
  vi.stubGlobal("__savGmailToken", undefined); vi.stubGlobal("fetch", network); network.mockClear();
  labels = [{ id: "existing-label", name: "MAIl STUDIO SAV", type: "user" }];
  messageLabels = ["INBOX", "UNREAD", "IMPORTANT"]; deniedAt = null; uncertain = false; wrongThread = false; activateKillSwitch = false; wrongReceipt = false;
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  mailboxId = mailbox.id;
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: "original-thread", subject: "Factures", customerEmail: "fiction@example.invalid" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: thread.id, gmailMessageId: "selected-gmail-id", direction: "inbound", fromEmail: thread.customerEmail, bodyCiphertext: "fixture", receivedAt: new Date("2026-10-02T12:01:00Z") }).returning();
  input = { threadId: thread.id, messageId: message.id };
});

describe("V0 explicit email click → existing Gmail label + archive", () => {
  it("adds only the existing label and removes only INBOX, preserving unread and other labels", async () => {
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "filed" });
    expect(modifications()).toHaveLength(1);
    expect(JSON.parse(String(modifications()[0][1]?.body))).toEqual({ addLabelIds: ["existing-label"], removeLabelIds: ["INBOX"] });
    expect(messageLabels).toEqual(["UNREAD", "IMPORTANT", "existing-label"]);
    expect((await clickAudits())[0]).toMatchObject({ actorEmail: "ugo@limova.ai", entityId: input.messageId, technicalMetadata: { gmailFilingStatus: "succeeded", labelId: "existing-label" } });
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(network.mock.calls.every(([url]) => !String(url).includes("hubspot"))).toBe(true);
  });
  it("files exactly the clicked message, not a newer message in the same thread", async () => {
    await fixture.db.insert(savMessages).values({ mailboxId, threadId: input.threadId, gmailMessageId: "newer-gmail-id", direction: "inbound", fromEmail: "fiction@example.invalid", bodyCiphertext: "fixture", receivedAt: new Date("2026-10-03T12:01:00Z") });
    await recordSavEmailOpened(input, "ugo@limova.ai");
    expect(modifications()[0][0]).toContain("/selected-gmail-id/modify");
    expect(network.mock.calls.some(([url]) => String(url).includes("newer-gmail-id"))).toBe(false);
  });
  it("repeated clicks are idempotent in Gmail but each authorized opening is traced", async () => {
    await recordSavEmailOpened(input, "ugo@limova.ai");
    expect(await recordSavEmailOpened(input, "reouven@limova.ai")).toMatchObject({ notice: "already_filed" });
    expect(modifications()).toHaveLength(1); expect(await clickAudits()).toHaveLength(2);
  });
  it.each(["shadow", "kill", "preview"])("records the opening without network in %s mode", async (mode) => {
    if (mode === "shadow") vi.stubEnv("SAV_AUTOMATION_MODE", "shadow");
    if (mode === "kill") vi.stubEnv("SAV_WRITES_DISABLED", "true");
    if (mode === "preview") vi.stubEnv("SAV_TEST_MODE", "true");
    expect(await recordSavEmailOpened(input, "contact@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_DISABLED" });
    expect(network).not.toHaveBeenCalled(); expect((await clickAudits())[0].technicalMetadata.gmailFilingStatus).toBe("disabled");
  });
  it("rejects unauthorized actors before database/network changes", async () => {
    await expect(recordSavEmailOpened(input, "other@limova.ai")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(await clickAudits()).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  });
  it("binds the message to its real thread and rejects outbound or CRM-only messages", async () => {
    await expect(recordSavEmailOpened({ ...input, threadId: "10000000-0000-4000-8000-000000000001" }, "ugo@limova.ai")).rejects.toThrow("SAV_GMAIL_FILING_SOURCE_INVALID");
    await fixture.db.update(savMessages).set({ direction: "outbound" }).where(eq(savMessages.id, input.messageId));
    await expect(recordSavEmailOpened(input, "ugo@limova.ai")).rejects.toThrow("SAV_GMAIL_FILING_SOURCE_INVALID");
    await fixture.db.update(savMessages).set({ direction: "inbound", gmailMessageId: null }).where(eq(savMessages.id, input.messageId));
    await expect(recordSavEmailOpened(input, "ugo@limova.ai")).rejects.toThrow("SAV_GMAIL_FILING_SOURCE_INVALID");
    expect(network).not.toHaveBeenCalled();
  });
  it("does not archive when the existing folder is missing or ambiguous", async () => {
    labels = [];
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_STUDIO_LABEL_NOT_FOUND" });
    labels = [{ id: "one", name: "MAIL STUDIO SAV", type: "user" }, { id: "two", name: "mail studio sav", type: "user" }];
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_STUDIO_LABEL_AMBIGUOUS" });
    expect(modifications()).toHaveLength(0); expect(messageLabels).toContain("INBOX");
    expect(network.mock.calls.some(([, init]) => init?.method === "POST" && String(init.body).includes("label"))).toBe(false);
  });
  it.each(["labels", "modify"] as const)("reports a missing Gmail permission at %s", async (step) => {
    deniedAt = step;
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_PERMISSION_DENIED" });
    expect(messageLabels).toContain("INBOX"); expect((await clickAudits())[0].technicalMetadata.gmailFilingStatus).toBe("failed");
  });
  it("rejects a remote message in the wrong thread or trash", async () => {
    wrongThread = true;
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_MESSAGE_MISMATCH" });
    wrongThread = false; messageLabels.push("TRASH");
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_MESSAGE_TRASHED" });
    expect(modifications()).toHaveLength(0);
  });
  it("blocks old emails, inactive mailboxes and pilot cases before network", async () => {
    await fixture.db.update(savMessages).set({ receivedAt: new Date("2026-10-01T12:01:00Z") }).where(eq(savMessages.id, input.messageId));
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_BEFORE_CUTOVER" });
    await fixture.db.update(savMessages).set({ receivedAt: new Date("2026-10-02T12:01:00Z") }).where(eq(savMessages.id, input.messageId));
    await fixture.db.update(savMailboxes).set({ active: false }).where(eq(savMailboxes.id, mailboxId));
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_MAILBOX_INACTIVE" });
    await fixture.db.update(savMailboxes).set({ active: true }).where(eq(savMailboxes.id, mailboxId));
    vi.stubEnv("SAV_PILOT_MODE", "true");
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_PILOT_BLOCKED" });
    vi.stubEnv("SAV_PILOT_MODE", "false");
    const [batch] = await fixture.db.insert(savPilotBatches).values({ createdBy: "ugo@limova.ai" }).returning();
    await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId: input.messageId });
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_PILOT_BLOCKED" });
    expect(network).not.toHaveBeenCalled();
  });
  it("rechecks the kill switch immediately before modification", async () => {
    activateKillSwitch = true;
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_DISABLED" });
    expect(modifications()).toHaveLength(0); expect(messageLabels).toContain("INBOX");
  });
  it("never claims success for a timeout; a later explicit click checks the existing result without another POST", async () => {
    uncertain = true;
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_UNCERTAIN" });
    expect((await clickAudits())[0].technicalMetadata.gmailFilingStatus).toBe("uncertain");
    uncertain = false;
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "already_filed" });
    expect(modifications()).toHaveLength(1);
  });
  it("does not trust a malformed modification acknowledgement", async () => {
    wrongReceipt = true;
    expect(await recordSavEmailOpened(input, "ugo@limova.ai")).toMatchObject({ notice: "SAV_GMAIL_FILING_UNCERTAIN" });
  });
});
