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
import { and, eq, sql } from "drizzle-orm";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-ack-closure-encryption-key-000");
  await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.cases CASCADE; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state WHERE key LIKE 'sav-ack-close:%'");
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

// Review Astra (c4316e8): both resume scenarios THROUGH the recovery sweep, real receipts and lease, HubSpot faked behind the port.
describe("review Astra (c4316e8): resume through the sweep", () => {
  function hubspot(options: { failedReadsAfterPatch?: number } = {}) {
    const state = { stage: "2", patches: 0, notes: 0, failing: 0 };
    const port: AckClosureDeps["hubspot"] = {
      readTicket: async () => { if (state.failing > 0) { state.failing--; throw Error("SAV_SYNTHETIC_READ_FAILED"); } return { pipeline: "0", stage: state.stage }; },
      setClosed: async () => { state.patches++; state.stage = "4"; state.failing = options.failedReadsAfterPatch ?? 0; return "applied"; },
      createNote: async () => { state.notes++; return String(500 + state.notes); },
      readNote: async id => ({ body: "<p>Fermé : le client a confirmé la résolution (accusé)</p>", ticketIds: [id && "8101"] }),
    };
    return { state, port };
  }
  async function scene() {
    const th = await thread("8101");
    const ours = await message(th.id, "outbound", "C'est corrigé.", t(60));
    const mail = await message(th.id, "inbound", "Ok merci", t(30));
    await f.db.insert(savIntakeConsole).values({ threadId: th.id, messageId: mail.id, mailboxId, view: "completed", status: "acknowledgement_only", epoch: 1, projectedEpoch: 1 });
    return { th, ours, mail };
  }
  const sweepDeps = (ours: { id: string }, hub: AckClosureDeps["hubspot"]): AckClosureDeps => ({ env: () => ({ SAV_ACK_CLOSE: "on" }), authority: async () => {}, store: ackClosureAuditStore, hubspot: hub,
    // V1's acknowledgement and the model's close are stubbed (they need a full V1 run); every thread and ticket fact is the stored one.
    readFacts: async id => { const real = await readAckClosureFacts(id); return real && { ...real, v1Acknowledgement: true, model: { decision: "close", confidence: "high",
      lastOutboundMessageId: ours.id, lastOutboundState: "conclusive", customerMessage: "pure_ack", justification: "Réponse conclusive.", evidenceQuote: "C'est corrigé." } }; } });
  const actions = async (id: string) => (await f.db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, id))).map(r => r.action).sort();

  it("PATCH ok + read-back failed, then a new inbound on the thread: the sweep still resumes it to an explicit uncertainty (stage seen closed, no note)", async () => {
    const { th, ours, mail } = await scene();
    const hub = hubspot({ failedReadsAfterPatch: 1 }), deps = sweepDeps(ours, hub.port);
    expect(await reconcileAckClosures(3, Date.now() + 60_000, deps)).toMatchObject({ candidates: 1, resumes: 0, results: [{ messageId: mail.id, result: { retry: "stage_unconfirmed" } }] });
    await message(th.id, "inbound", "Encore une chose", t(5));
    expect(await reconcileAckClosures(3, Date.now() + 60_000, deps)).toMatchObject({ candidates: 1, resumes: 1, results: [{ messageId: mail.id, result: { final: "uncertain", reason: "newer_message" } }] });
    const [row] = await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, mail.id), eq(auditLogs.action, "sav_ack_close_uncertain")));
    expect(row!.technicalMetadata).toMatchObject({ stageMayBeClosed: true, stageObserved: "4", ticketId: "8101" });
    expect(hub.state).toMatchObject({ stage: "4", patches: 1, notes: 0 });
    expect(await reconcileAckClosures(3, Date.now() + 60_000, deps)).toMatchObject({ candidates: 0 });
  });
  it("PATCH ok + read-back failed, nothing new: the sweep resumes it and posts the note exactly once", async () => {
    const { ours, mail } = await scene();
    const hub = hubspot({ failedReadsAfterPatch: 1 }), deps = sweepDeps(ours, hub.port);
    await reconcileAckClosures(3, Date.now() + 60_000, deps);
    expect(await reconcileAckClosures(3, Date.now() + 60_000, deps)).toMatchObject({ resumes: 1, results: [{ result: { final: "confirmed" } }] });
    expect(hub.state).toMatchObject({ stage: "4", patches: 1, notes: 1 });
    expect(await actions(mail.id)).toEqual(["sav_ack_close_claimed", "sav_ack_close_confirmed", "sav_ack_close_note_dispatched", "sav_ack_close_stage_confirmed", "sav_ack_close_stage_dispatched"]);
  });
  it("two concurrent sweeps, the first fails before the note: no false « already closed », the resume posts the note once", async () => {
    const { ours, mail } = await scene();
    const hub = hubspot({ failedReadsAfterPatch: 1 }), deps = sweepDeps(ours, hub.port);
    const passes = await Promise.all([reconcileAckClosures(3, Date.now() + 60_000, deps), reconcileAckClosures(3, Date.now() + 60_000, deps)]);
    const results = passes.flatMap(p => (p as { results: Array<{ result: unknown }> }).results.map(r => r.result));
    expect(results).toContainEqual({ retry: "stage_unconfirmed" });
    // The race is real: both sweeps picked the same ack; the lease let only one of them act.
    expect(results).toContainEqual({ skipped: "busy" });
    expect(results.every(r => JSON.stringify(r) !== JSON.stringify({ final: "already_closed" }))).toBe(true);
    expect(await actions(mail.id)).not.toContain("sav_ack_close_already_closed");
    expect(await reconcileAckClosures(3, Date.now() + 60_000, deps)).toMatchObject({ resumes: 1, results: [{ result: { final: "confirmed" } }] });
    expect(hub.state).toMatchObject({ stage: "4", patches: 1, notes: 1 });
    expect(await reconcileAckClosures(3, Date.now() + 60_000, deps)).toMatchObject({ candidates: 0 });
  });
  it("the lease is exclusive and released", async () => {
    const id = randomUUID();
    const release = await ackClosureAuditStore.lease(id);
    expect(release).not.toBeNull();
    expect(await ackClosureAuditStore.lease(id)).toBeNull();
    await release!();
    const again = await ackClosureAuditStore.lease(id);
    expect(again).not.toBeNull(); await again!();
  });
});

// Review Astra (0ac3311): the resume acts on the dispatched ticket only, and a ticket that is gone or keeps failing cannot hold the sweep. Through the
// sweep, real receipts, attempts and lease; HubSpot faked behind the port, per ticket.
describe("review Astra (0ac3311): resume through the sweep", () => {
  type Ticket = { stage: string; mode: "ok" | "gone" | "fail"; failAfterPatch: number; reads: number; patches: number; notes: number };
  function hubspot() {
    const tickets = new Map<string, Ticket>(), notes = new Map<string, string>();
    const of = (id: string) => { const row = tickets.get(id) ?? { stage: "2", mode: "ok", failAfterPatch: 1, reads: 0, patches: 0, notes: 0 }; tickets.set(id, row); return row; };
    const port: AckClosureDeps["hubspot"] = {
      readTicket: async id => {
        const row = of(id); row.reads++;
        if (row.mode === "gone") return "gone";
        if (row.mode === "fail" || row.patches > 0 && row.failAfterPatch-- > 0) throw Error("SAV_SYNTHETIC_READ_FAILED");
        return { pipeline: "0", stage: row.stage };
      },
      setClosed: async id => { const row = of(id); row.patches++; row.stage = "4"; return "applied"; },
      createNote: async id => { of(id).notes++; const noteId = String(700 + notes.size); notes.set(noteId, id); return noteId; },
      readNote: async noteId => ({ body: "<p>Fermé : le client a confirmé la résolution (accusé)</p>", ticketIds: [notes.get(noteId)!] }),
    };
    return { tickets, of, port };
  }
  async function scene(ticket: string, minutesAgo: number) {
    const th = await thread(ticket);
    await message(th.id, "outbound", "C'est corrigé.", t(minutesAgo + 30));
    const mail = await message(th.id, "inbound", "Ok merci", t(minutesAgo));
    await f.db.insert(savIntakeConsole).values({ threadId: th.id, messageId: mail.id, mailboxId, view: "completed", status: "acknowledgement_only", epoch: 1, projectedEpoch: 1 });
    return { th, mail };
  }
  const sweepDeps = (hub: AckClosureDeps["hubspot"]): AckClosureDeps => ({ env: () => ({ SAV_ACK_CLOSE: "on" }), authority: async () => {}, store: ackClosureAuditStore, hubspot: hub,
    // V1's acknowledgement and the model's close are stubbed; every thread and ticket fact is the stored one.
    readFacts: async id => { const real = await readAckClosureFacts(id); return real && { ...real, v1Acknowledgement: true, model: { decision: "close", confidence: "high",
      lastOutboundMessageId: real.previous!.messageId, lastOutboundState: "conclusive", customerMessage: "pure_ack", justification: "Réponse conclusive.", evidenceQuote: "C'est corrigé." } }; } });
  const final = async (id: string) => (await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id),
    sql`${auditLogs.action} in ('sav_ack_close_confirmed','sav_ack_close_uncertain','sav_ack_close_not_applied','sav_ack_close_already_closed')`)));
  const sweep = (deps: AckClosureDeps, limit = 3) => reconcileAckClosures(limit, Date.now() + 60_000, deps) as Promise<{ candidates: number; resumes: number; results: Array<{ messageId: string; result: unknown }> }>;

  it("finding 1: thread relinked from A to B after our dispatch: only A is finished, B gets no read, no PATCH, no note", async () => {
    const { th, mail } = await scene("8401", 30);
    const hub = hubspot(), deps = sweepDeps(hub.port);
    expect(await sweep(deps)).toMatchObject({ results: [{ messageId: mail.id, result: { retry: "stage_unconfirmed" } }] });
    await f.db.update(savThreads).set({ hubspotTicketId: "8402" }).where(eq(savThreads.id, th.id));
    expect(await sweep(deps)).toMatchObject({ resumes: 1, results: [{ messageId: mail.id, result: { final: "confirmed" } }] });
    expect(hub.of("8401")).toMatchObject({ stage: "4", patches: 1, notes: 1 });
    expect(hub.tickets.has("8402")).toBe(false);
    const [row] = await final(mail.id);
    expect(row!.technicalMetadata).toMatchObject({ ticketId: "8401" });
    expect(await sweep(deps)).toMatchObject({ candidates: 0 });
  });
  it("finding 1: relinked, then a newer mail: the uncertainty names A and reads only A", async () => {
    const { th, mail } = await scene("8411", 30);
    const hub = hubspot(), deps = sweepDeps(hub.port);
    await sweep(deps);
    await f.db.update(savThreads).set({ hubspotTicketId: "8412" }).where(eq(savThreads.id, th.id));
    await message(th.id, "inbound", "Encore une chose", t(5));
    expect(await sweep(deps)).toMatchObject({ resumes: 1, results: [{ result: { final: "uncertain", reason: "newer_message" } }] });
    expect((await final(mail.id))[0]!.technicalMetadata).toMatchObject({ ticketId: "8411", currentTicketId: "8412", stageMayBeClosed: true, stageObserved: "4" });
    expect(hub.tickets.has("8412")).toBe(false);
  });
  it("finding 2: three dispatched tickets now 404 and a fourth healthy one: the 404s end uncertain (ticket_gone), the fourth is closed by the next sweep", async () => {
    const gone = [await scene("8501", 40), await scene("8502", 39), await scene("8503", 38)], healthy = await scene("8504", 10);
    const hub = hubspot(), deps = sweepDeps(hub.port);
    // All four dispatched, none read back (a crash right after each PATCH).
    expect((await sweep(deps, 4)).results.map(r => r.result)).toEqual(Array(4).fill({ retry: "stage_unconfirmed" }));
    for (const id of ["8501", "8502", "8503"]) hub.of(id).mode = "gone";
    const first = await sweep(deps);
    expect(first.results).toEqual(gone.map(g => ({ messageId: g.mail.id, result: { final: "uncertain", reason: "ticket_gone" } })));
    const second = await sweep(deps);
    expect(second.results).toMatchObject([{ messageId: healthy.mail.id, result: { final: "confirmed" } }]);
    for (const g of gone) expect((await final(g.mail.id))[0]!.technicalMetadata).toMatchObject({ reason: "ticket_gone", stageMayBeClosed: true });
    expect(["8501", "8502", "8503"].map(id => hub.of(id).notes)).toEqual([0, 0, 0]);
    expect(hub.of("8504")).toMatchObject({ patches: 1, notes: 1 });
    expect(await sweep(deps)).toMatchObject({ candidates: 0 });
  });
  it("finding 2: three dispatched tickets failing (5xx) and a fourth healthy one: fair order closes the fourth on the next sweep, the failing ones end uncertain after 5 attempts", async () => {
    const failing = [await scene("8601", 40), await scene("8602", 39), await scene("8603", 38)], healthy = await scene("8604", 10);
    const hub = hubspot(), deps = sweepDeps(hub.port);
    await sweep(deps, 4);
    for (const id of ["8601", "8602", "8603"]) hub.of(id).mode = "fail";
    expect((await sweep(deps)).results.map(r => r.result)).toEqual(Array(3).fill({ retry: "ticket_unreadable" }));
    // Never attempted, the healthy one goes first now.
    expect((await sweep(deps)).results[0]).toMatchObject({ messageId: healthy.mail.id, result: { final: "confirmed" } });
    let sweeps = 0;
    while ((await sweep(deps)).candidates > 0 && sweeps < 10) sweeps++;
    expect(sweeps).toBeLessThan(10);
    for (const x of failing) expect((await final(x.mail.id))[0]!.technicalMetadata).toMatchObject({ reason: "ticket_unreadable_attempts", attempts: 5, stageMayBeClosed: true });
    const attempts = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_ack_close_attempt"));
    expect(attempts).toHaveLength(15);
    expect(["8601", "8602", "8603"].map(id => [hub.of(id).patches, hub.of(id).notes])).toEqual([[1, 0], [1, 0], [1, 0]]);
  });
  it("review 23f8c4e: A reopened, a new mail on a sibling thread of A, the thread now on B: no second PATCH, no note, uncertain on A", async () => {
    const { th, mail } = await scene("8701", 30);
    const hub = hubspot(), deps = sweepDeps(hub.port);
    expect(await sweep(deps)).toMatchObject({ results: [{ messageId: mail.id, result: { retry: "stage_unconfirmed" } }] });
    hub.of("8701").stage = "1";
    const sibling = await thread("8701");
    await message(sibling.id, "inbound", "Le problème est revenu", t(5));
    await f.db.update(savThreads).set({ hubspotTicketId: "8702" }).where(eq(savThreads.id, th.id));
    expect(await sweep(deps)).toMatchObject({ resumes: 1, results: [{ messageId: mail.id, result: { final: "uncertain", reason: "dispatched_stage_not_observed" } }] });
    expect(hub.of("8701")).toMatchObject({ stage: "1", patches: 1, notes: 0 });
    expect(hub.tickets.has("8702")).toBe(false);
    expect((await final(mail.id))[0]!.technicalMetadata).toMatchObject({ ticketId: "8701", currentTicketId: "8702", stageMayBeClosed: false, stageObserved: "1" });
    expect(await sweep(deps)).toMatchObject({ candidates: 0 });
  });
});

