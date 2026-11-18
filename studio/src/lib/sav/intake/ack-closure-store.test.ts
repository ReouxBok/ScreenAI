// SAV-95 on a real local database (PGlite, migrations applied): receipts are audit rows written once per (message, step), the facts come from the stored
// thread, the recovery sweep only picks a current acknowledgement with a ticket and no final receipt, and the switch off touches nothing. Synthetic data.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savCases, savIntakeConsole, savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { ackClosureAuditStore, readAckClosureFacts, reconcileAckClosures } from "./ack-closure-store";
import { closeAcknowledgedTicket, type AckClosureDeps } from "./ack-closure";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-ack-closure-encryption-key-000");
  await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.cases CASCADE; TRUNCATE public.audit_logs");
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning(); mailboxId = mailbox.id;
});
afterEach(() => vi.unstubAllEnvs());

async function thread(ticket: string | null = "8001") {
  const [row] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid", hubspotTicketId: ticket }).returning();
  return row;
}
async function message(threadId: string, direction: "inbound" | "outbound", text: string, at: Date) {
  const [row] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction, fromEmail: direction === "inbound" ? "client@example.invalid" : "support@example.invalid",
    toEmails: [], subject: "Re: accès", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text }), receivedAt: at, createdAt: at }).returning();
  return row;
}
const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

describe("receipts", () => {
  it("records each step once per message, concurrent writers included", async () => {
    const id = randomUUID();
    const results = await Promise.all([ackClosureAuditStore.record(id, "note_dispatched", { ticketId: "1" }), ackClosureAuditStore.record(id, "note_dispatched", { ticketId: "1" })]);
    expect(results.sort()).toEqual([false, true]);
    expect(await ackClosureAuditStore.record(id, "claimed", {})).toBe(true);
    expect(await ackClosureAuditStore.steps(id)).toEqual(["claimed", "note_dispatched"]);
    const rows = await f.db.select().from(auditLogs);
    expect(rows.map(r => [r.actorEmail, r.action, r.entityType, r.entityId]).sort()).toEqual([
      ["studio-intake", "sav_ack_close_claimed", "sav_message", id], ["studio-intake", "sav_ack_close_note_dispatched", "sav_message", id]]);
  });
});

describe("facts from the stored thread", () => {
  it("our reply just before, no newer message, ticket, no V2 case; V1 acknowledgement unreadable without a run", async () => {
    const th = await thread();
    const ours = await message(th.id, "outbound", "C'est corrigé.", t(60));
    const mail = await message(th.id, "inbound", "Ok merci", t(30));
    expect(await readAckClosureFacts(mail.id)).toEqual({ v1Acknowledgement: false, customerMessageId: mail.id, ticketId: "8001", model: null,
      previous: { messageId: ours.id, direction: "outbound" }, newerMessage: false, sensitiveDossier: false, v2Case: false });
  });
  it("a newer message and a V2 case are seen", async () => {
    const th = await thread();
    await message(th.id, "outbound", "C'est corrigé.", t(60));
    const mail = await message(th.id, "inbound", "Ok merci", t(30));
    await message(th.id, "outbound", "Une personne de l'équipe répond.", t(10));
    expect((await readAckClosureFacts(mail.id))?.v2Case).toBe(false);
    await f.db.insert(savCases).values({ ticketId: "8001", threadIds: [th.id], owner: "human", phase: "human_owned", contractRevision: "synthetic", payloadCiphertext: "not-read" });
    const read = await readAckClosureFacts(mail.id);
    expect(read?.newerMessage).toBe(true);
    expect(read?.v2Case).toBe(true);
  });
});

describe("review Astra (8c2891d): the ticket, not only the thread", () => {
  it("a V2 case on the same ticket through ANOTHER thread excludes the close: zero PATCH end to end", async () => {
    const mine = await thread("8002"), other = await thread("8002");
    const ours = await message(mine.id, "outbound", "C'est corrigé.", t(60));
    const mail = await message(mine.id, "inbound", "Ok merci", t(30));
    await f.db.insert(savCases).values({ ticketId: "8002", threadIds: [other.id], owner: "human", phase: "human_owned", contractRevision: "synthetic", payloadCiphertext: "not-read" });
    const read = await readAckClosureFacts(mail.id);
    expect(read?.v2Case).toBe(true);
    const writes: string[] = [];
    const result = await closeAcknowledgedTicket(mail.id, { env: () => ({ SAV_ACK_CLOSE: "on" }), authority: async () => {}, store: ackClosureAuditStore,
      readFacts: async id => ({ ...(await readAckClosureFacts(id))!, v1Acknowledgement: true, model: { decision: "close", confidence: "high", lastOutboundMessageId: ours.id,
        lastOutboundState: "conclusive", customerMessage: "pure_ack", justification: "Réponse conclusive.", evidenceQuote: "C'est corrigé." } }),
      hubspot: { readTicket: async () => ({ pipeline: "0", stage: "2" }), setClosed: async () => { writes.push("stage"); return "applied"; },
        createNote: async () => { writes.push("note"); return "1"; }, readNote: async () => null } });
    expect(result).toMatchObject({ final: "not_applied", reason: "v2_case" });
    expect(writes).toEqual([]);
  });
  it("a newer customer mail on another thread of the same ticket is a newer message", async () => {
    const mine = await thread("8003"), other = await thread("8003");
    await message(mine.id, "outbound", "C'est corrigé.", t(60));
    const mail = await message(mine.id, "inbound", "Ok merci", t(30));
    expect((await readAckClosureFacts(mail.id))?.newerMessage).toBe(false);
    await message(other.id, "inbound", "Autre chose", t(10));
    expect((await readAckClosureFacts(mail.id))?.newerMessage).toBe(true);
  });
});

describe("recovery sweep", () => {
  it("off: nothing read or written", async () => {
    vi.stubEnv("SAV_ACK_CLOSE", "off");
    expect(await reconcileAckClosures()).toEqual({ skipped: "off" });
    expect(await f.db.select().from(auditLogs)).toEqual([]);
  });
  it("picks only the latest acknowledgement with a ticket and no final receipt", async () => {
    vi.stubEnv("SAV_ACK_CLOSE", "on");
    const project = (m: { id: string; threadId: string }, status = "acknowledgement_only") =>
      f.db.insert(savIntakeConsole).values({ threadId: m.threadId, messageId: m.id, mailboxId, view: "completed", status, epoch: 1, projectedEpoch: 1 });
    const a = await thread(); await message(a.id, "outbound", "C'est corrigé.", t(60)); const ackA = await message(a.id, "inbound", "Ok merci", t(30)); await project(ackA);
    const b = await thread(null); const ackB = await message(b.id, "inbound", "Ok merci", t(30)); await project(ackB);
    const c = await thread(); const ackC = await message(c.id, "inbound", "Ok merci", t(30)); await project(ackC); await message(c.id, "outbound", "Réponse humaine.", t(5));
    const d = await thread(); const ackD = await message(d.id, "inbound", "Ok merci", t(30)); await project(ackD);
    await f.db.insert(auditLogs).values({ actorEmail: "studio-intake", action: "sav_ack_close_not_applied", entityType: "sav_message", entityId: ackD.id });
    const e = await thread(); const other = await message(e.id, "inbound", "Une question", t(30)); await project(other, "followup_pending");
    const result = await reconcileAckClosures(10, Date.now() + 60_000) as { candidates: number; results: Array<{ messageId: string }> };
    expect(result.candidates).toBe(1);
    expect(result.results.map(r => r.messageId)).toEqual([ackA.id]);
  });
});

it("end to end on the real receipts: one close, then nothing on retry", async () => {
  const th = await thread();
  const ours = await message(th.id, "outbound", "C'est corrigé.", t(60));
  const mail = await message(th.id, "inbound", "Ok merci", t(30));
  const real = await readAckClosureFacts(mail.id);
  const writes: string[] = [];
  let stage = "2";
  const deps: AckClosureDeps = { env: () => ({ SAV_ACK_CLOSE: "on" }), authority: async () => {}, store: ackClosureAuditStore,
    // V1's acknowledgement and the model's close are the only facts stubbed (they need a full V1 run); the thread facts are the stored ones.
    readFacts: async () => ({ ...real!, v1Acknowledgement: true, model: { decision: "close", confidence: "high", lastOutboundMessageId: ours.id, lastOutboundState: "conclusive",
      customerMessage: "pure_ack", justification: "Réponse conclusive.", evidenceQuote: "C'est corrigé." } }),
    hubspot: { readTicket: async () => ({ pipeline: "0", stage }), setClosed: async () => { writes.push("stage"); stage = "4"; return "applied"; },
      createNote: async () => { writes.push("note"); return "77"; }, readNote: async () => ({ body: "<p>Fermé : le client a confirmé la résolution (accusé)</p>", ticketIds: ["8001"] }) } };
  expect(await closeAcknowledgedTicket(mail.id, deps)).toEqual({ final: "confirmed", basis: "conclusive_reply_acknowledged", noteId: "77" });
  expect(await closeAcknowledgedTicket(mail.id, deps)).toEqual({ skipped: "already_done" });
  expect(writes).toEqual(["stage", "note"]);
  expect(await ackClosureAuditStore.steps(mail.id)).toEqual(["claimed", "stage_dispatched", "stage_confirmed", "note_dispatched", "confirmed"]);
});
