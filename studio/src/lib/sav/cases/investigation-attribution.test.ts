import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import type { CaseAdmissionInput } from "./admission-policy";
import { listCaseEvents, openCaseEvent, readCaseByTicket, transitionCaseOwner, v1IntentHash } from "./case-store";
import { caseDedupeKey, type CaseAttributionProof } from "./case-types";
import { latestInvestigationInput } from "./investigation-runner";

/*
 * Contract v9 (pole A f16d477): a relayed case waits with the team until V1's verified V2 owner effect, then the relay
 * gives it to the agent (`v2_attribution`). That attribution is not new information: the business input stays the
 * customer's mail, and its budget is the mail's. Run on A's real store, with the V1 ledger row the proof requires.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 7_800_000, mailboxId = "", policyId = "";
const AT = "2026-10-30T09:00:00.000Z", V2_OWNER = "90000001", STAFF = "20000000-0000-4000-8000-000000000001";
const ADMITTED: CaseAdmissionInput = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access", provenance: { kind: "human", staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [] },
};

/** A V1 execution of one synthetic mail and its confirmed `owner_assign` effect, as the executor leaves them. */
async function confirmedOwnerEffect(ticketId: string): Promise<CaseAttributionProof> {
  const threadId = randomUUID(), messageId = randomUUID();
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: "client@example.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthétique", bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date(AT), gmailMessageId: `gm-${messageId}` });
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({}) }).returning();
  const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
  const [effect] = await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
    intentHash: v1IntentHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() }).returning();
  return { kind: "hubspot_owner_verified", executionId: execution!.id, effectId: effect!.id, ticketId, ownerId: V2_OWNER };
}
const relay = (ticketId: string, threadId: string, gmail: string, attribution: "pending" | CaseAttributionProof, occurredAt = AT) => openCaseEvent({
  ticketId, threadId, admission: ADMITTED, attribution, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt,
});
const inboundKey = async (caseId: string, gmail: string) => `in:${(await listCaseEvents(caseId)).find(event => event.sourceRef.id === gmail)!.id}`;
const attributions = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "owner_changed" && event.detail?.transition === "v2_attribution").length;

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "attribution-input-fixture-key-32-chars");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-attribution-admin", email: "attribution-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "attribution-input-fixture-key-32-chars"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the V2 attribution is not an input: the case is investigated on the customer's mail (pole A D4)", () => {
  it("a mail never handled, then attributed: the input stays the mail, not the attribution event", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID();
    const { case: waiting } = await relay(ticketId, threadId, "gm-attr-1", "pending");
    expect(waiting).toMatchObject({ owner: "human", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    const { case: attributed } = await relay(ticketId, threadId, "gm-attr-1", await confirmedOwnerEffect(ticketId));
    expect(attributed.owner).toBe("agent");
    expect(await attributions(attributed.caseId)).toBe(1);
    expect(latestInvestigationInput(await listCaseEvents(attributed.caseId))).toBe(await inboundKey(attributed.caseId, "gm-attr-1"));
  });

  it("a replayed relay with the same proof appends nothing and keeps the same input", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID();
    await relay(ticketId, threadId, "gm-attr-2", "pending");
    const proof = await confirmedOwnerEffect(ticketId);
    const { case: c } = await relay(ticketId, threadId, "gm-attr-2", proof);
    const before = await listCaseEvents(c.caseId);
    const { case: again } = await relay(ticketId, threadId, "gm-attr-2", proof);
    expect(again.version).toBe(c.version);
    expect(await listCaseEvents(c.caseId)).toHaveLength(before.length);
    expect(latestInvestigationInput(await listCaseEvents(c.caseId))).toBe(await inboundKey(c.caseId, "gm-attr-2"));
  });

  it("a second mail while waiting is the input once attributed; a new mail after the attribution opens its own input", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID();
    await relay(ticketId, threadId, "gm-attr-3a", "pending");
    await relay(ticketId, threadId, "gm-attr-3b", "pending", "2026-10-30T09:05:00.000Z");
    const { case: c } = await relay(ticketId, threadId, "gm-attr-3b", await confirmedOwnerEffect(ticketId));
    expect(c.owner).toBe("agent");
    expect(latestInvestigationInput(await listCaseEvents(c.caseId))).toBe(await inboundKey(c.caseId, "gm-attr-3b"));
    await relay(ticketId, threadId, "gm-attr-3c", "pending", "2026-10-30T09:10:00.000Z");
    expect(latestInvestigationInput(await listCaseEvents(c.caseId))).toBe(await inboundKey(c.caseId, "gm-attr-3c"));
  });

  it("a person giving the case back after an attribution still opens a new input (`back:`)", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID();
    await relay(ticketId, threadId, "gm-attr-4", "pending");
    await relay(ticketId, threadId, "gm-attr-4", await confirmedOwnerEffect(ticketId));
    let c = (await readCaseByTicket(ticketId))!;
    await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `takeover-${ticketId}`, reason: "fixture" });
    c = (await readCaseByTicket(ticketId))!;
    await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `back-${ticketId}`, reason: "fixture", to: "agent", admission: ADMITTED });
    const events = await listCaseEvents(c.caseId), back = events.filter(event => event.detail?.transition === "hand_back").at(-1)!;
    expect(latestInvestigationInput(events)).toBe(`back:${back.id}`);
  });
});
