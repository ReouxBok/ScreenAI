import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Read only, from what V1 stored: no provider, CRM or Gmail behind these readers.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { caseCustomerAttachmentMedia } from "./investigation-customer-attachments";
import type { CaseAttachmentDownload } from "./investigation-customer-attachments-reader";
import { caseCustomerContextReader } from "./investigation-customer-context-reader";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseEvent, type CaseSnapshot } from "./case-types";

/*
 * SAV-92: the SQL of the V2 customer-context and attachments readers on a REAL database. Locally on PGlite; the same file runs on native
 * Postgres when SAV_TEST_POSTGRES_URL is set (CI `sav-native`). Synthetic data only, every id random: the native database is shared by
 * the other files, nothing here is truncated or deleted.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, policyId: string, mailboxId: string, ticketSeq = 8_100_000;
const native = Boolean(process.env.SAV_TEST_POSTGRES_URL);
const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 9, minute));
const iso = (minute: number) => at(minute).toISOString();
type Mail = { gmail: string; direction?: "inbound" | "outbound"; minute: number; createdMinute?: number; subject?: string; body?: unknown; threadId: string; mailbox?: string };

async function newThread(mailbox = mailboxId) {
  const id = randomUUID();
  await f.db.insert(savThreads).values({ id, mailboxId: mailbox, gmailThreadId: `thr-${id}`, subject: "Synthétique", customerEmail: `client-${id}@example.invalid` });
  return id;
}
async function addMail(m: Mail) {
  const id = randomUUID();
  await f.db.insert(savMessages).values({ id, mailboxId: m.mailbox ?? mailboxId, threadId: m.threadId, gmailMessageId: m.gmail, direction: m.direction ?? "inbound",
    fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject: m.subject ?? "Sujet", receivedAt: at(m.minute), createdAt: at(m.createdMinute ?? m.minute),
    bodyCiphertext: typeof m.body === "string" ? m.body : encryptSavPayload(m.body ?? { text: `texte ${m.gmail}` }) });
  return id;
}
async function addExecution(messageId: string, threadId: string, options: { ticketId?: string | null; payload?: unknown; raw?: string }) {
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId: options.ticketId ?? null,
    payloadCiphertext: options.raw ?? encryptSavPayload(options.payload) });
}
const plan = (contactId: string | null) => ({ decision: { disposition: contactId ? { kind: "ticket", contactScope: { primaryContactId: contactId } } : { kind: "other" } } });
const baseline = (contactId: string, ticketId: string, extra: Record<string, unknown[]> = {}) => ({
  tickets: { [contactId]: [{ id: ticketId, stage: "open", createdAt: iso(0), subject: "Connexion impossible" }, { id: `${ticketId}-old`, stage: "closed", createdAt: "2026-10-01T08:00:00.000Z", subject: "Ancien sujet" }], ...extra },
  histories: { [ticketId]: [{ id: "notes:1", kind: "note", text: "Note interne : rappeler le client.", at: iso(1) }] },
});
const snapshot = (threadIds: string[], ticketId = String(++ticketSeq)): CaseSnapshot => ({ contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: randomUUID(), ticketId, threadIds, version: 1,
  owner: { type: "agent" } as never, phase: "open" as never, sensitivity: "none" as never, createdAt: iso(0), updatedAt: iso(0), body: emptyCaseBody(), admission: null, admissionInputVersion: 0 });
const inbound = (gmail: string, minute: number, caseVersion = 1): CaseEvent => ({ id: randomUUID(), caseId: "c", kind: "inbound_confirmed", dedupeKey: `inbound:${gmail}`, caseVersion,
  direction: "customer_inbound", occurredAt: iso(minute), sourceRef: { type: "email", id: gmail }, detail: null, createdAt: iso(minute) });
const attachment = (filename: string, mimeType = "image/png", size = 2048) => ({ filename, mimeType, size });
const gm = (label: string) => `gm-${label}-${randomUUID()}`;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "customer-readers-fixture-key-32-chars");
  f = await createSavTestDb(); state.db = f.db;
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `synthetic-readers-admin-${run}`, email: `readers-admin-${run}@example.invalid`, role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-readers-${run}@example.invalid` }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "customer-readers-fixture-key-32-chars");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  state.db = f.db;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe(`customer-context reader SQL (${native ? "native Postgres" : "PGlite"})`, () => {
  it("picks the latest inbound of the event, the earlier thread in order, never a later mail, with secrets masked", async () => {
    const threadId = await newThread(), g = { a: gm("a"), b: gm("b"), c: gm("c"), latest: gm("latest"), later: gm("later") };
    await addMail({ threadId, gmail: g.a, minute: 1, subject: "Connexion", body: { text: "Bonjour, je ne peux pas me connecter." } });
    await addMail({ threadId, gmail: g.b, direction: "outbound", minute: 2, body: { text: "Pouvez-vous vérifier vos spams ?" } });
    await addMail({ threadId, gmail: g.c, minute: 3, body: { text: "Pas de mail dans les spams." } });
    const latestId = await addMail({ threadId, gmail: g.latest, minute: 4, subject: "Re: Connexion", body: { text: "Toujours bloqué, erreur 403. Mon mot de passe est Soleil2024! et le code reçu 482913." } });
    await addMail({ threadId, gmail: g.later, minute: 9, body: { text: "Mail suivant, autre entrée." } });
    // Two inbound events: the latest by date wins, whatever the order of the array.
    const context = await caseCustomerContextReader()(snapshot([threadId]), [inbound(g.latest, 4, 4), inbound(g.a, 1, 1)]);
    expect(context.latestMessage).toMatchObject({ from: "customer", subject: "Re: Connexion", at: iso(4) });
    expect(context.latestMessage!.text).toContain("erreur 403");
    expect(context.latestMessage!.text).not.toMatch(/Soleil2024|482913/);
    expect(context.thread.map(row => [row.from, row.text, row.at])).toEqual([
      ["customer", "Bonjour, je ne peux pas me connecter.", iso(1)], ["support", "Pouvez-vous vérifier vos spams ?", iso(2)], ["customer", "Pas de mail dans les spams.", iso(3)]]);
    expect(JSON.stringify(context)).not.toContain("Mail suivant");
    expect(context.threadOmitted).toBe(0);
    expect(context.missing).toEqual(["crm_not_recorded"]);
    expect(latestId).toBeTruthy();
  });

  it("bounds the thread to the four newest earlier mails, oldest first, over a case of two threads", async () => {
    const t1 = await newThread(), t2 = await newThread(), latest = gm("latest");
    for (let i = 1; i <= 7; i++) await addMail({ threadId: i % 2 ? t1 : t2, gmail: gm(`m${i}`), minute: i, direction: i % 3 ? "inbound" : "outbound", body: { text: `message numéro ${i}` } });
    await addMail({ threadId: t1, gmail: latest, minute: 10, body: { text: "Dernier mail du client." } });
    const context = await caseCustomerContextReader()(snapshot([t1, t2]), [inbound(latest, 10)]);
    expect(context.thread.map(row => row.text)).toEqual(["message numéro 4", "message numéro 5", "message numéro 6", "message numéro 7"]);
    expect(context.latestMessage!.text).toBe("Dernier mail du client.");
    // Eight mails are read (the bound is nine rows): three earlier ones are counted as omitted.
    expect(context.threadOmitted).toBe(3);
  });

  it("without any inbound event: no latest message (listed), the newest mails still read, nothing thrown", async () => {
    const threadId = await newThread();
    await addMail({ threadId, gmail: gm("x"), minute: 1, body: { text: "Premier." } });
    await addMail({ threadId, gmail: gm("y"), direction: "outbound", minute: 2, body: { text: "Réponse." } });
    const context = await caseCustomerContextReader()(snapshot([threadId]), []);
    expect(context.latestMessage).toBeNull();
    expect(context.missing).toContain("latest_message_unavailable");
    expect(context.thread.map(row => row.text)).toEqual(["Premier.", "Réponse."]);
  });

  it("a case without thread, or an event whose mail is not stored, degrades to a context that says so", async () => {
    const empty = await caseCustomerContextReader()(snapshot([]), [inbound(gm("none"), 1)]);
    expect(empty).toMatchObject({ latestMessage: null, thread: [], crm: null });
    expect(empty.missing).toEqual(expect.arrayContaining(["crm_unavailable", "latest_message_unavailable"]));
    const threadId = await newThread();
    await addMail({ threadId, gmail: gm("kept"), minute: 1, body: { text: "Un vieux mail." } });
    const unknown = await caseCustomerContextReader()(snapshot([threadId]), [inbound(gm("not-stored"), 5)]);
    expect(unknown.latestMessage).toBeNull();
    expect(unknown.missing).toContain("latest_message_unavailable");
  });

  it("an undecryptable body is listed, not guessed, and the other mails are still read", async () => {
    const threadId = await newThread(), latest = gm("latest");
    await addMail({ threadId, gmail: gm("bad"), minute: 1, body: "v1.broken.broken.broken" });
    await addMail({ threadId, gmail: gm("good"), minute: 2, body: { text: "Mail lisible." } });
    await addMail({ threadId, gmail: latest, minute: 3, body: { text: "Dernier." } });
    const context = await caseCustomerContextReader()(snapshot([threadId]), [inbound(latest, 3)]);
    expect(context.thread.map(row => row.text)).toEqual(["Mail lisible."]);
    expect(context.missing).toContain("thread_unavailable");
  });

  it("another customer's data is never returned: same Gmail id in another mailbox, another thread, its CRM snapshot", async () => {
    // Eight other customers, each in a mailbox of their own, all with the same Gmail message id (unique per mailbox only) and the same ticket id,
    // written before ours: an unfiltered `limit 1` finds one of theirs first (the planner's order is not fixed, so eight copies, not one).
    const shared = gm("shared"), ticketId = String(++ticketSeq), mine = await newThread();
    for (let i = 0; i < 8; i++) {
      const [box] = await f.db.insert(savMailboxes).values({ email: `support-foreign-${i}-${randomUUID()}@example.invalid` }).returning();
      const theirs = await newThread(box!.id);
      const theirLatest = await addMail({ threadId: theirs, mailbox: box!.id, gmail: shared, minute: 4, body: { text: "SECRET AUTRE CLIENT" } });
      await addMail({ threadId: theirs, mailbox: box!.id, gmail: gm("t1"), minute: 3, body: { text: "HISTOIRE AUTRE CLIENT" } });
      await addExecution(theirLatest, theirs, { ticketId, payload: { plan: plan("c-other"), baseline: baseline("c-other", ticketId) } });
    }
    // Stored after the other customer's rows, so an unfiltered `limit 1` would find theirs first.
    await addMail({ threadId: mine, gmail: shared, minute: 4, body: { text: "Ma demande à moi." } });
    await addMail({ threadId: mine, gmail: gm("m1"), minute: 1, body: { text: "Mon premier mail." } });
    const context = await caseCustomerContextReader()(snapshot([mine], ticketId), [inbound(shared, 4)]);
    expect(JSON.stringify(context)).not.toMatch(/AUTRE CLIENT|Connexion impossible|Ancien sujet/);
    expect(context.latestMessage!.text).toBe("Ma demande à moi.");
    expect(context.thread.map(row => row.text)).toEqual(["Mon premier mail."]);
    expect(context.crm).toBeNull();
    expect(context.missing).toContain("crm_not_recorded");
  });
});

describe("V1 CRM snapshot read from intake_executions", () => {
  async function caseWithExecution(execution: { ticketId?: string | null; payload?: unknown; raw?: string } | null, ticketId = String(++ticketSeq)) {
    const threadId = await newThread(), latest = gm("latest");
    const messageId = await addMail({ threadId, gmail: latest, minute: 5, body: { text: "Toujours le même souci." } });
    if (execution) await addExecution(messageId, threadId, execution);
    return { context: await caseCustomerContextReader()(snapshot([threadId], ticketId), [inbound(latest, 5)]), ticketId };
  }

  it("present: the case's ticket, the contact's other tickets, the note masked of third parties' details; observedAt is the execution's", async () => {
    const ticketId = String(++ticketSeq);
    const data = baseline("c-1", ticketId, { "c-assoc": [{ id: "t-assoc", stage: "open", subject: "Ticket d'une personne associée" }] });
    const { context } = await caseWithExecution({ ticketId, payload: { plan: plan("c-1"), baseline: data } }, ticketId);
    expect(context.crm).toMatchObject({ source: "v1_crm_snapshot", contact: { knownTickets: 2 },
      currentTicket: { stage: "open", recordedInSnapshot: true, notes: [{ text: "Note interne : rappeler le client." }] }, otherTickets: [{ stage: "closed", subject: "Ancien sujet" }] });
    expect(new Date(context.crm!.observedAt).getTime()).toBeGreaterThan(0);
    expect(context.missing).not.toContain("crm_not_recorded");
    // Only the contact V1 identified: never the tickets of an associated contact.
    expect(JSON.stringify(context)).not.toContain("personne associée");
  });

  it("absent: no execution, a non-ticket disposition, or no baseline all say crm_not_recorded", async () => {
    expect((await caseWithExecution(null)).context.missing).toContain("crm_not_recorded");
    expect((await caseWithExecution({ payload: { plan: plan(null), baseline: baseline("c-1", "1") } })).context.crm).toBeNull();
    const none = await caseWithExecution({ payload: { plan: plan("c-1") } });
    expect(none.context.crm).toBeNull();
    expect(none.context.missing).toContain("crm_not_recorded");
  });

  it("an execution for another ticket is crm_ticket_mismatch and its contact's history is not shown", async () => {
    const { context } = await caseWithExecution({ ticketId: "999", payload: { plan: plan("c-1"), baseline: baseline("c-1", "999") } }, String(++ticketSeq));
    expect(context.crm).toBeNull();
    expect(context.missing).toContain("crm_ticket_mismatch");
    expect(JSON.stringify(context)).not.toContain("Connexion impossible");
  });

  it("an unreadable or malformed payload is crm_unavailable; the mails are still returned", async () => {
    const broken = await caseWithExecution({ raw: "v1.broken.broken.broken" });
    expect(broken.context.crm).toBeNull();
    expect(broken.context.missing).toContain("crm_unavailable");
    expect(broken.context.latestMessage!.text).toBe("Toujours le même souci.");
    const malformed = await caseWithExecution({ payload: { plan: plan("c-1"), baseline: { tickets: { "c-1": [{ stage: "open" }] }, histories: {} } } });
    expect(malformed.context.crm).toBeNull();
    expect(malformed.context.missing).toContain("crm_unavailable");
  });

  it("the CRM is read from a recent customer mail of the case when the latest one has no execution", async () => {
    const threadId = await newThread(), ticketId = String(++ticketSeq), older = gm("older"), latest = gm("latest");
    const olderId = await addMail({ threadId, gmail: older, minute: 2, body: { text: "Premier mail." } });
    await addMail({ threadId, gmail: latest, minute: 5, body: { text: "Second mail." } });
    await addExecution(olderId, threadId, { ticketId, payload: { plan: plan("c-1"), baseline: baseline("c-1", ticketId) } });
    const context = await caseCustomerContextReader()(snapshot([threadId], ticketId), [inbound(latest, 5, 2), inbound(older, 2, 1)]);
    expect(context.crm?.currentTicket).toMatchObject({ stage: "open" });
  });

  it("a SQL failure on the CRM read keeps the mails; a failure of the whole read is an unavailable context", async () => {
    const threadId = await newThread(), latest = gm("latest");
    await addMail({ threadId, gmail: latest, minute: 1, body: { text: "Un mail." } });
    const realSelect = f.db.select.bind(f.db);
    let calls = 0;
    // The first two selects (the latest mail, the thread) pass; the CRM read fails.
    vi.spyOn(f.db, "select").mockImplementation(((...args: unknown[]) => { if (++calls > 2) throw Error("CRM_SQL_DOWN"); return (realSelect as (...a: unknown[]) => unknown)(...args); }) as never);
    const partial = await caseCustomerContextReader()(snapshot([threadId]), [inbound(latest, 1)]);
    expect(partial.latestMessage!.text).toBe("Un mail.");
    expect(partial.missing).toContain("crm_unavailable");
    state.db = { select: () => { throw Error("DB_DOWN"); } };
    const down = await caseCustomerContextReader()(snapshot([threadId]), [inbound(latest, 1)]);
    expect(down).toMatchObject({ latestMessage: null, thread: [], crm: null, missing: ["context_read_failed", "latest_message_unavailable"] });
  });
});

describe("attachments reader SQL and references", () => {
  // Review P2-2: the attachments feature rides on SAV_V2_ATTACHMENT_MEDIA; the listing is read with it on, the download failing (nothing leaves).
  const MEDIA_ON = { SAV_V2_ATTACHMENT_MEDIA: "images" };
  const noDownload: CaseAttachmentDownload = async () => { throw Error("SYN_NO_DOWNLOAD"); };
  const withFiles = async (files: unknown[], extra: Record<string, unknown> = {}, env: Record<string, string | undefined> = MEDIA_ON, download: CaseAttachmentDownload = noDownload) => {
    const threadId = await newThread(), latest = gm("latest");
    await addMail({ threadId, gmail: latest, minute: 5, body: { text: "Voir la capture.", attachments: files, ...extra } });
    return caseCustomerContextReader({ env: () => env, download })(snapshot([threadId]), [inbound(latest, 5)]);
  };

  it("review P2-2: media off (the default) gives the v4 context: no attachments block, no evidence (so no attachments instruction), nothing downloaded", async () => {
    const files = [attachment("capture.png", "image/png", 2048), attachment("facture.pdf", "application/pdf", 10_240)];
    const download = vi.fn<CaseAttachmentDownload>(async () => Buffer.alloc(0));
    for (const env of [{}, { SAV_V2_ATTACHMENT_MEDIA: "off" }, { SAV_V2_ATTACHMENT_MEDIA: "yes" }]) {
      const context = await withFiles(files, {}, env, download);
      expect(context.attachments).toBeUndefined();
      expect(context.evidence).toBeUndefined();
      expect(caseCustomerAttachmentMedia(context)).toEqual([]);
      expect(context.latestMessage!.text).toBe("Voir la capture.");
    }
    expect(download).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("media on: lists the stored references of the latest mail, masked name and bounded size in KB", async () => {
    const context = await withFiles([attachment("capture.png", "image/png", 2048), attachment("facture.pdf", "application/pdf", 10_240), attachment("note.txt", "text/plain", 10)]);
    expect(context.attachments!.files.map(file => [file.message, file.name, file.kind, file.sizeKb, file.part])).toEqual([
      ["latest", "capture.png", "image", 2, null], ["latest", "facture.pdf", "pdf", 10, null], ["latest", "note.txt", "other", 1, null]]);
    expect(context.attachments!.files.find(file => file.name === "note.txt")!.notAttached).toBe("unsupported_type");
    expect(caseCustomerAttachmentMedia(context)).toEqual([]);
    expect(context.evidence).toMatchObject({ screenshotProvided: true });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("lists the previous inbound mail's files too, and only the two newest inbound mails, never another thread's or a later mail's", async () => {
    const mine = await newThread(), other = await newThread(), g = { old: gm("old"), prev: gm("prev"), latest: gm("latest"), later: gm("later") };
    await addMail({ threadId: mine, gmail: g.old, minute: 1, body: { text: "ancien", attachments: [attachment("ancien.png")] } });
    await addMail({ threadId: mine, gmail: g.prev, minute: 2, body: { text: "précédent", attachments: [attachment("precedent.png")] } });
    await addMail({ threadId: mine, gmail: g.latest, minute: 3, body: { text: "dernier", attachments: [attachment("dernier.png")] } });
    await addMail({ threadId: mine, gmail: g.later, minute: 8, body: { text: "plus tard", attachments: [attachment("plus-tard.png")] } });
    await addMail({ threadId: other, gmail: gm("other"), minute: 3, body: { text: "autre client", attachments: [attachment("autre-client.png")] } });
    const context = await caseCustomerContextReader({ env: () => MEDIA_ON, download: noDownload })(snapshot([mine]), [inbound(g.latest, 3)]);
    expect(context.attachments!.files.map(file => [file.message, file.name])).toEqual([["latest", "dernier.png"], ["previous", "precedent.png"]]);
    // The earlier mail's screenshot still counts as evidence for the screenshot-or-link rule.
    expect(context.evidence!.screenshotProvided).toBe(true);
    expect(JSON.stringify(context)).not.toMatch(/autre-client|plus-tard/);
  });

  it("an incomplete inventory is listed; a mail with no file and a complete inventory gives no attachments block", async () => {
    const incomplete = await withFiles([attachment("a.png")], { attachmentInventory: { complete: false, limits: ["reference_limit"] } });
    expect(incomplete.attachments!.missing).toContain("attachment_inventory_incomplete");
    const none = await withFiles([], { attachmentInventory: { complete: true, limits: [] } });
    expect(none.attachments).toBeUndefined();
  });

  it("with media on, the reference is re-validated against the stored mailbox and thread: a foreign reference is never downloaded", async () => {
    const download = vi.fn<CaseAttachmentDownload>(async () => Buffer.alloc(0));
    const threadId = await newThread(), latest = gm("latest");
    await addMail({ threadId, gmail: latest, minute: 5, body: { text: "capture", attachments: [{ ...attachment("etrangere.png", "image/png", 2048),
      reference: { version: 1, mailboxEmail: "autre-boite@example.invalid", gmailMessageId: latest, gmailThreadId: "thr-ailleurs", partId: "1", attachmentId: "att-1", contentId: null, disposition: "attachment" } }] } });
    const context = await caseCustomerContextReader({ env: () => ({ SAV_V2_ATTACHMENT_MEDIA: "images" }), download })(snapshot([threadId]), [inbound(latest, 5)]);
    expect(download).not.toHaveBeenCalled();
    expect(context.attachments!.files[0]).toMatchObject({ name: "etrangere.png", part: null });
    expect(context.attachments!.files[0]!.notAttached).not.toBeNull();
  });

  it("with media on, the reference of this very mail is downloaded once, from its stored mailbox and Gmail thread; a failing download is a reason, never an error", async () => {
    const threadId = await newThread(), latest = gm("latest");
    const [thread] = await f.db.select({ gmailThreadId: savThreads.gmailThreadId, email: savMailboxes.email }).from(savThreads).innerJoin(savMailboxes, eq(savMailboxes.id, savThreads.mailboxId)).where(eq(savThreads.id, threadId));
    const reference = { version: 1 as const, mailboxEmail: thread!.email, gmailMessageId: latest, gmailThreadId: thread!.gmailThreadId, partId: "1", attachmentId: "att-1", contentId: null, disposition: "attachment" as const };
    await addMail({ threadId, gmail: latest, minute: 5, body: { text: "capture", attachments: [{ ...attachment("ok.png", "image/png", 2048), reference }] } });
    const download = vi.fn<CaseAttachmentDownload>(async () => { throw Error("GMAIL_DOWN"); });
    const context = await caseCustomerContextReader({ env: () => ({ SAV_V2_ATTACHMENT_MEDIA: "images" }), download })(snapshot([threadId]), [inbound(latest, 5)]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toEqual(reference);
    expect(context.attachments!.files[0]).toMatchObject({ name: "ok.png", part: null, notAttached: "download_failed" });
    expect(context.latestMessage!.text).toBe("capture");
  });

  it("a failure of the attachments read keeps the context without files; an unreadable body is listed as attachments_unavailable", async () => {
    const threadId = await newThread(), latest = gm("latest");
    await addMail({ threadId, gmail: latest, minute: 5, body: "v1.broken.broken.broken" });
    const context = await caseCustomerContextReader({ env: () => MEDIA_ON, download: noDownload })(snapshot([threadId]), [inbound(latest, 5)]);
    expect(context.latestMessage).toBeNull();
    expect(context.attachments?.missing ?? []).toEqual(expect.arrayContaining(["attachments_unavailable"]));
    expect(context.revision).toBeTruthy();
  });
});
