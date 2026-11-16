import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
import { appendCaseEvent, listCaseTimers, openCaseEvent, readCase, updateCaseRecord } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { type CaseReplyProposal } from "./case-effects";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { closeAfterConfirmedJ2 } from "./j2-confirmed-closure";
import { enqueueCaseTicketStage } from "./case-ticket-stage-queue";
import { savCaseEffectExecutions, savIntakeExecutionPolicies, staffUsers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSavPayload } from "../crypto";
import type { TicketStagePayload } from "./case-ticket-stage";


// SAV-10 x SAV-8: what the case records once a reply is CONFIRMED. Real SAV-5 store (PGlite); no Gmail, no HubSpot, no model.
let policyId: string;
let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 9_100_000;
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000003" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const SENT = new Date("2026-10-28T08:00:00.000Z"); // Wednesday morning, Paris
/** The case version a person saw when the case was opened by the customer's mail: a proposal is prepared on THAT version, not on a constant. */
const seenVersion = new Map<string, number>();
async function opened(gmail: string) {
  const ticketId = String(++ticketSeq);
  const { case: c } = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: "2026-10-28T07:00:00.000Z" });
  seenVersion.set(c.caseId, c.version);
  return { caseId: c.caseId, ticketId, threadId: c.threadIds[0]! };
}
const proposalFor = (caseId: string, purpose: CaseReplyProposal["purpose"], trigger: string): CaseReplyProposal => ({
  caseId, caseVersion: seenVersion.get(caseId) ?? 1, triggerEventId: trigger, inboundMessageId: randomUUID(), purpose, recipient: "customer@example.invalid", subject: "Synthetic", text: "SYNTHETIC text.",
  ...(purpose === "question" ? { question: { id: "q1", text: "SYNTHETIC question?", factKeys: [] } } : {}),
});
const confirmed = (proposal: CaseReplyProposal, effectId: string, gmailMessageId: string) => ({ proposal, effectId, gmailMessageId, gmailThreadId: "gmail-thread", sentAt: SENT, currentPolicyRevision: POLICY });

beforeAll(async () => {
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-j2-admin", email: "admin@example.invalid", name: "Synthetic", role: "admin", active: true }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "synthetic", state: "approved", administratorId: admin!.id, policyHash: "synthetic", payloadCiphertext: "fixture-unused" }).returning();
  policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); })); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const env = { SAV_V2_J2_CONTEXTUAL: "on", SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "2", SAV_V2_STAGE_CLOSED: "4" };
async function waitFor(gmail: string) {
  const c = await opened(gmail);
  await recordConfirmedCaseReply(confirmed(proposalFor(c.caseId, "question", `inbound:${gmail}`), `effect-${gmail}`, `sent-${gmail}`));
  const timer = (await listCaseTimers(c.caseId))[0]!;
  return { ...c, proposal: proposalFor(c.caseId, "reminder", `timer:${timer.id}`), timer };
}
describe("confirmed J2 administrative closure on the real store", () => {
  it("keeps the case open until the confirmed receipt, then closes and queues exactly one existing stage effect", async () => {
    const c = await waitFor("j2-close");
    expect((await readCase(c.caseId))!.phase).toBe("awaiting_customer");
    const key = `reply:${c.caseId}:${c.proposal.triggerEventId}`;
    const apply = () => f.db.transaction(async tx => {
      const closure = await closeAfterConfirmedJ2(tx, c.proposal, key, SENT, env);
      expect(closure).not.toBeNull();
      return enqueueCaseTicketStage(tx, { ...closure!, policy: { id: policyId, hash: "synthetic" }, env: () => env });
    });
    const first = await apply(), again = await apply();
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false });
    const snapshot = (await readCase(c.caseId))!;
    expect(snapshot).toMatchObject({ phase: "closed_no_reply", body: { cycle: { number: 1, endedBy: "closed_no_reply" }, waiting: null } });
    expect(snapshot.body.openRequests.every(r => r.status !== "resolved")).toBe(true);
    const rows = await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, c.caseId));
    expect(rows).toHaveLength(1);
    expect(decryptSavPayload<TicketStagePayload>(rows[0]!.payloadCiphertext)).toMatchObject({ intent: { target: "closed", stageId: "4" }, trigger: { kind: "j2_confirmed", replyKey: key } });
  });
  it("OFF leaves the existing wait and phase identical", async () => {
    const c = await waitFor("j2-off"), before = await readCase(c.caseId);
    expect(await f.db.transaction(tx => closeAfterConfirmedJ2(tx, c.proposal, "unused", SENT, {}))).toBeNull();
    expect(await readCase(c.caseId)).toEqual(before);
  });
  it("a customer return before receipt prevents closure even if its mail is dated before the send", async () => {
    const c = await waitFor("j2-return");
    await openCaseEvent({ ticketId: c.ticketId, threadId: c.threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("j2-new-input"), sourceRef: { type: "email", id: "j2-new-input" }, occurredAt: "2026-10-28T07:59:00Z" });
    expect(await f.db.transaction(tx => closeAfterConfirmedJ2(tx, c.proposal, "unused", SENT, env))).toBeNull();
    expect((await readCase(c.caseId))!.phase).not.toBe("closed_no_reply");
  });
  it("a very late old receipt cannot close the next cycle, even when that cycle is already administratively closed", async () => {
    const c = await waitFor("j2-late-cycle");
    await appendCaseEvent({ caseId: c.caseId, kind: "inbound_confirmed", direction: "customer_inbound", dedupeKey: "inbound:j2-later-cycle",
      sourceRef: { type: "email", id: "j2-later-cycle" }, occurredAt: "2026-10-28T07:59:00Z" });
    const current = (await readCase(c.caseId))!;
    await updateCaseRecord({ caseId: c.caseId, expectedVersion: current.version, actor: { type: "agent" }, phase: "closed_no_reply",
      body: { ...current.body, waiting: null, cycle: { number: 2, endedBy: "closed_no_reply" } } });
    expect(await f.db.transaction(tx => closeAfterConfirmedJ2(tx, c.proposal, "old-reply", SENT, env))).toBeNull();
  });
  it("a non-procedure answer can schedule its single follow-up only with the contextual feature on", async () => {
    const c = await opened("j2-impossible");
    const outcome = await recordConfirmedCaseReply(confirmed(proposalFor(c.caseId, "answer", "inbound:j2-impossible"), "effect-impossible", "sent-impossible"), { contextualJ2: true });
    expect(outcome.j2).toBe("scheduled");
    expect(await listCaseTimers(c.caseId)).toHaveLength(1);
    expect((await readCase(c.caseId))!.body.questions[0]!.text).toBe("Suivi de la réponse envoyée.");
  });
});
