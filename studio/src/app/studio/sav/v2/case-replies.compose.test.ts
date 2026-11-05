import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { finalReplyText } from "../../../../../test/sav-case-reply-text";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { encryptSavPayload } from "@/lib/sav/crypto";
import { openCaseEvent, readCase } from "@/lib/sav/cases/case-store";
import { caseDedupeKey } from "@/lib/sav/cases/case-types";
import { caseReplyPayloadHash, type CaseReplyProposal } from "@/lib/sav/cases/case-effects";
import { decideCaseReply, submitCaseReplyProposal } from "@/lib/sav/cases/case-reply-store";
import { describeCaseReply, readCaseReplies, readCaseReply } from "./case-replies";
import { caseReplyReaders } from "./case-replies-port";

// COMPOSITION ONLY (UX 79fda7f + B's final composition ebf1479 = A 0051 5ccaa20, C 4652e46, B a8ecd3a): the V2 page's read functions on pole C's
// REAL readers, on A's real migrations through 0051 (PGlite).
// Synthetic data only; no provider, no network. The approval uses a test-only authorizer: no permissive port exists in application code.
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const deps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };

async function seed(f: Awaited<ReturnType<typeof createSavTestDb>>) {
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: `support-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  const gmailMessageId = `gm-${randomUUID()}`;
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthetic", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<in@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId: String(9_400_000 + Math.floor(Math.random() * 1000)), threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const version = (await readCase(opened.caseId))!.version;
  const proposal = (n: number): CaseReplyProposal => ({ caseId: opened.caseId, caseVersion: version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message.id, purpose: "question",
    recipient: "customer@example.invalid", subject: "Synthetic", text: finalReplyText(`SYNTHETIC reply ${n}.`), question: { id: "q1", text: "SYNTHETIC question?", factKeys: [] } } as CaseReplyProposal);
  return { caseId: opened.caseId, proposal };
}

beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); })); });

describe("without the 0051 table (a database not migrated to 0051)", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; await f.client.exec("DROP TABLE sav.case_reply_validations CASCADE"); }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });
  it("the page reads 'unavailable', never an empty list, for the list and for one reply", async () => {
    const caseId = randomUUID();
    expect(await readCaseReplies(caseReplyReaders, { caseId })).toEqual({ state: "unavailable" });
    expect(await readCaseReply(caseReplyReaders, { caseId, id: randomUUID() })).toEqual({ state: "unavailable" });
  });
});

describe("with A's migration 0051", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });
  it("proposed and approved replies read through the page's functions: real states, nothing sent, cursor round trip, other case not shown", async () => {
    const s = await seed(f);
    expect(await readCaseReplies(caseReplyReaders, { caseId: s.caseId })).toEqual({ state: "ok", items: [], next: null });
    const ids: string[] = [];
    for (const n of [1, 2]) { const r = await submitCaseReplyProposal(s.proposal(n), deps); if (!r.ok) throw Error(r.code); ids.push(r.id); }
    const p2 = s.proposal(2);
    const decided = await decideCaseReply({ action: "approve", validationId: ids[1]!, approverId: STAFF, authorizer: () => ({ allowed: true, basis: "fixture.allow" }), deps,
      seen: { payloadHash: caseReplyPayloadHash(p2), caseVersion: p2.caseVersion, recipient: p2.recipient } });
    expect(decided.ok).toBe(true);
    const page = await readCaseReplies(caseReplyReaders, { caseId: s.caseId });
    if (page.state !== "ok") throw Error(page.state);
    expect(page.items.map(item => [item.validation, item.status.code, item.status.sent])).toEqual([["approved", "approved_not_queued", "no"], ["superseded", "superseded", "no"]]);
    expect(page.items.map(item => describeCaseReply(item).status)).toEqual(["Validée, pas encore en file", "Remplacée par une proposition plus récente"]);
    expect(JSON.stringify(page.items)).not.toContain("customer@example.invalid");
    const one = await readCaseReply(caseReplyReaders, { caseId: s.caseId, id: ids[1] });
    expect(one).toMatchObject({ state: "ok", reply: { recipient: "customer@example.invalid", proposal: { text: finalReplyText("SYNTHETIC reply 2.") }, authorizationBasis: "fixture.allow" } });
    expect(await readCaseReply(caseReplyReaders, { caseId: randomUUID(), id: ids[1] })).toEqual({ state: "not_found" });
    // 48e3e8a: the page passes the open case; the reader filters it in SQL, so another case's reply comes back null (not read, not decrypted).
    expect(await caseReplyReaders!.get({ validationId: ids[1]!, caseId: randomUUID() }, { env: () => ({}) })).toBeNull();
    expect(await caseReplyReaders!.get({ validationId: ids[1]!, caseId: s.caseId }, { env: () => ({}) })).toMatchObject({ id: ids[1], caseId: s.caseId });
    expect(await readCaseReply(caseReplyReaders, { caseId: s.caseId, id: randomUUID() })).toEqual({ state: "not_found" });
    // Cursor: a page of one, then the next page through the encoded cursor, then the end.
    const original = caseReplyReaders!.list;
    const small = { ...caseReplyReaders!, list: (input: Parameters<typeof original>[0], d: Parameters<typeof original>[1]) => original({ ...input, limit: 1 }, d) };
    const first = await readCaseReplies(small, { caseId: s.caseId });
    if (first.state !== "ok" || !first.next) throw Error("NO_NEXT");
    const second = await readCaseReplies(small, { caseId: s.caseId, cursor: first.next });
    expect(second.state === "ok" && second.items.map(item => item.id)).toEqual([ids[0]]);
  });
});
