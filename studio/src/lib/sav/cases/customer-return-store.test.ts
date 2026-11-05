import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCaseEvents, savCaseReplyValidations, savCaseTimers, savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Nothing here may reach HubSpot or Gmail: the owner is a simulated port and no write port exists.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { caseAdmissionStatus } from "./admission-policy";
import { decideCaseEffect } from "./case-effects";
import { claimCaseForDecision, listCaseEvents, openCaseEvent, readCase, reevaluateCaseAdmission, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { routeCustomerReturn, type CustomerReturnDeps } from "./customer-return-store";
import { scheduleJ2ForConfirmedQuestion } from "./timer-store";

// V2 customer return on the real case store (PGlite). Mails, tickets, owners and policies are SYNTHETIC; V1's records are simulated ports where a test says so.
let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_400_000;
const POLICY = "policy-r1", V2_OWNER = "900001", TEAM_OWNER = "900000", PERSON = "900777";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001" };
const AT = "2026-11-02T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const T0 = new Date("2026-11-02T08:00:00.000Z"), SENT = new Date("2026-11-02T10:00:00.000Z"), T1 = new Date("2026-11-03T08:30:00.000Z");

async function mail(threadId: string, mailboxId: string, input: { receivedAt: Date; gmail?: string; direction?: "inbound" | "outbound"; subject?: string; text?: string; headers?: Record<string, string> }) {
  const gmail = input.gmail ?? `syn-${randomUUID().slice(0, 12)}`;
  const [row] = await f.db.insert(savMessages).values({ mailboxId, threadId, gmailMessageId: gmail, direction: input.direction ?? "inbound", fromEmail: "client.fictif@example.invalid",
    toEmails: ["support@example.invalid"], subject: input.subject ?? "Re: Connexion fictive", receivedAt: input.receivedAt,
    bodyCiphertext: encryptSavPayload({ text: input.text ?? "Toujours pas de connexion.", attachments: [], headers: input.headers ?? {} }) }).returning();
  return { id: row!.id, gmail };
}

/** An agent case on one thread, its access request open, a question sent and its J2 scheduled: the case waits for the customer. */
async function waiting() {
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${randomUUID().slice(0, 8)}@example.invalid` }).returning();
  const [thread] = await f.db.insert(savThreads).values({ mailboxId: mailbox!.id, gmailThreadId: randomUUID(), customerEmail: "client.fictif@example.invalid" }).returning();
  const first = await mail(thread!.id, mailbox!.id, { receivedAt: T0, subject: "Connexion fictive" });
  const ticketId = String(++ticketSeq);
  const opened = await openCaseEvent({ ticketId, threadId: thread!.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(first.gmail),
    sourceRef: { type: "email", id: first.gmail }, occurredAt: T0.toISOString(), opens: [{ id: "r1", summary: "Demande fictive d'accès" }] });
  const effect = `effect-${randomUUID().slice(0, 8)}`;
  const asked = await updateCaseRecord({ caseId: opened.case.caseId, expectedVersion: opened.case.version, actor: { type: "agent" },
    body: { ...opened.case.body, questions: [{ id: "q1", text: "Question fictive", factKeys: [], askedAt: SENT.toISOString(), askedInEffect: effect }] } });
  const timerId = randomUUID();
  const scheduled = await scheduleJ2ForConfirmedQuestion({ caseId: asked.caseId, expectedVersion: asked.version, currentPolicyRevision: POLICY, questionEffectId: effect, timerId, sentAt: SENT });
  if (!scheduled.scheduled) throw Error(`not scheduled: ${scheduled.reason}`);
  return { mailboxId: mailbox!.id, threadId: thread!.id, ticketId, caseId: asked.caseId, timerId, first };
}

const env = { SAV_CASE_RECORDING: "on", SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER };
function ports(overrides: Partial<CustomerReturnDeps> & { owner?: string | null | (() => string | null | undefined) } = {}) {
  const { owner = V2_OWNER, ...rest } = overrides;
  const readTicketOwner = vi.fn(async () => typeof owner === "function" ? owner() : owner);
  const deps: CustomerReturnDeps = { env, readTicketOwner, readAdmissionPolicy: async () => ADMITTED.policy,
    readAcknowledgement: async () => false, readV1Target: async () => "none", readAutomated: async () => false, ...rest };
  return { deps, readTicketOwner };
}
const timerState = async (timerId: string) => (await f.db.select().from(savCaseTimers).where(eq(savCaseTimers.id, timerId)))[0]!;
const inboundKeys = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "inbound_confirmed").map(event => event.dedupeKey);
const setV2Pause = async (level: "running" | "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
};

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(async () => { vi.unstubAllEnvs(); await setV2Pause(null); });

describe("open V2 case: the customer's answer continues the same case", () => {
  it("same thread, new mail, ticket still the V2 owner's: one event on the SAME case, J2 cancelled, wait over, the admission waits for this mail's own qualification", async () => {
    const w = await waiting(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    const { deps, readTicketOwner } = ports();
    const outcome = await routeCustomerReturn(reply.id, deps);
    expect(outcome).toMatchObject({ route: { route: "continue", reason: "open_case_v2_owner" }, caseId: w.caseId, written: true,
      record: { replayed: false, admission: "stale_requalification_required", reopenedRequests: [], supersededReminders: 0 } });
    expect(readTicketOwner).toHaveBeenCalledTimes(1);
    expect(await inboundKeys(w.caseId)).toEqual([caseDedupeKey.inbound(w.first.gmail), caseDedupeKey.inbound(reply.gmail)]);
    expect(await timerState(w.timerId)).toMatchObject({ state: "cancelled", cancelReason: "customer_inbound" });
    const after = (await readCase(w.caseId))!;
    expect(after).toMatchObject({ owner: "agent", phase: "queued", ticketId: w.ticketId });
    expect(after.body.waiting).toBeNull();
    expect(after.body.openRequests.map(request => [request.id, request.status])).toEqual([["r1", "open"]]);
    // Nothing is claimed on what an earlier mail proved: this mail's content is requalified first.
    expect(caseAdmissionStatus(after, POLICY)).toEqual({ admitted: false, reason: "input_newer" });
    expect(await claimCaseForDecision({ caseId: w.caseId, expectedVersion: after.version, holder: "test", currentPolicyRevision: POLICY, ttlSeconds: 60, settleSeconds: 0 })).toMatchObject({ claimed: false });
    const event = (await listCaseEvents(w.caseId)).find(row => row.dedupeKey === caseDedupeKey.inbound(reply.gmail))!;
    expect(event.detail).toMatchObject({ messageId: reply.id, relay: { kind: "v2_customer_return", route: "continue" } });
  });

  it.each([
    ["explicit failed trial", "J’ai suivi toutes les étapes, mais je ne reçois toujours pas le code.", "client.fictif@example.invalid", "failed"],
    ["negative symptom without confirming any attempt", "Toujours rien.", "client.fictif@example.invalid", "pending"],
    ["someone other than the recipient", "J’ai suivi toutes les étapes, mais toujours rien.", "autre@example.invalid", "pending"],
    ["clear own statement before quoted history", "J’ai suivi toutes les étapes, mais toujours rien.\n> Vos instructions", "client.fictif@example.invalid", "failed"],
    ["correction below the signature separator", "J’ai tout essayé, mais toujours rien.\n--\nFinalement maintenant ça fonctionne.", "client.fictif@example.invalid", "pending"],
    ["unprefixed correction under the reply header", "J’ai tout essayé, mais toujours rien.\nLe lundi, Camille a écrit :\n> Avez-vous réessayé ?\nFinalement maintenant ça fonctionne.", "client.fictif@example.invalid", "pending"],
    ["clean prefixed history under the reply header", "J’ai tout essayé, mais toujours rien.\nLe lundi, Camille a écrit :\n> Avez-vous réessayé ?", "client.fictif@example.invalid", "failed"],
    ["fragments separated by an inline quotation", "J’ai suivi toutes les étapes,\n> Avez-vous vérifié le code ?\nmais toujours rien.", "client.fictif@example.invalid", "pending"],
    ["a quoted report", "Merci.\n> J’ai suivi toutes les étapes, mais toujours rien.", "client.fictif@example.invalid", "pending"],
  ])("binds the trial outcome to the confirmed answer: %s", async (_name, text, recipient, expected) => {
    const w = await waiting();
    const [thread] = await f.db.select().from(savThreads).where(eq(savThreads.id, w.threadId));
    const first = (await readCase(w.caseId))!;
    const confirmed = await recordConfirmedCaseReply({ proposal: { caseId: w.caseId, caseVersion: first.version, triggerEventId: caseDedupeKey.inbound(w.first.gmail),
      inboundMessageId: w.first.id, purpose: "answer", recipient, subject: "Connexion", text: "Vérifiez les étapes de connexion.",
      procedures: [{ requestId: "r1", procedure: { knowledgeId: "article-syn", contentVersionId: "rev-syn" } }] },
      effectId: randomUUID(), gmailMessageId: randomUUID(), gmailThreadId: thread!.gmailThreadId, sentAt: SENT, currentPolicyRevision: POLICY });
    expect(confirmed.trials).toBe("recorded");
    const reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1, text });
    const { deps } = ports();
    expect(await routeCustomerReturn(reply.id, deps)).toMatchObject({ written: true, route: { route: "continue" } });
    const after = (await readCase(w.caseId))!;
    expect(after.body.trials).toHaveLength(1);
    expect(after.body.trials[0]).toMatchObject(expected === "failed" ? { outcome: expected, resultAt: T1.toISOString(), result: { text: text.split("\n")[0], source: { type: "email", id: reply.gmail } } }
      : { outcome: "pending", resultAt: null });
    expect(await routeCustomerReturn(reply.id, deps)).toMatchObject({ written: false });
    expect((await readCase(w.caseId))!.body.trials).toEqual(after.body.trials);
  });

  it("a replay, two passes at once, or V1's relay first: the mail is recorded once and nothing is decided twice", async () => {
    const w = await waiting(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    const { deps } = ports();
    const both = await Promise.all([routeCustomerReturn(reply.id, deps), routeCustomerReturn(reply.id, deps)]);
    expect(both.filter(outcome => "written" in outcome && outcome.written && !outcome.record.replayed)).toHaveLength(1);
    expect(await inboundKeys(w.caseId)).toHaveLength(2);
    const version = (await readCase(w.caseId))!.version;
    expect(await routeCustomerReturn(reply.id, deps)).toMatchObject({ route: { route: "already_recorded" }, written: false });
    expect((await readCase(w.caseId))!.version).toBe(version);
    const admissions = (await listCaseEvents(w.caseId)).filter(event => event.kind === "admission_decided");
    expect(admissions).toHaveLength(1); // the opening one only: this return decides nothing until its own qualification

    // V1's relay recorded the mail first: the joint writes nothing and the existing re-evaluation path keeps it.
    const v = await waiting(), relayed = await mail(v.threadId, v.mailboxId, { receivedAt: T1 });
    await openCaseEvent({ ticketId: v.ticketId, threadId: v.threadId, admission: ADMITTED, admissionMode: "exclusions_only", kind: "inbound_confirmed",
      dedupeKey: caseDedupeKey.inbound(relayed.gmail), sourceRef: { type: "email", id: relayed.gmail }, occurredAt: T1.toISOString() });
    const owner = ports();
    expect(await routeCustomerReturn(relayed.id, owner.deps)).toMatchObject({ route: { route: "already_recorded" }, written: false });
    expect(owner.readTicketOwner).not.toHaveBeenCalled();
  });

  it("a J2 reminder nobody approved is superseded; an approved one still unsent keeps the admission stale so the effect gate cancels it (new_input)", async () => {
    const proposedCase = await waiting(), r1 = await mail(proposedCase.threadId, proposedCase.mailboxId, { receivedAt: T1 });
    // Born a proposal (the table's guard), then decided, as the store does.
    const reminder = async (caseId: string, timerId: string, stateName: "proposed" | "approved") => {
      const rows = await f.db.insert(savCaseReplyValidations).values({ caseId, replyKey: `reply:${caseId}:timer:${timerId}`, payloadHash: "a".repeat(64), caseVersion: 1,
        recipient: "client.fictif@example.invalid", proposalCiphertext: encryptSavPayload({ synthetic: true }) }).returning();
      if (stateName === "approved") await f.db.update(savCaseReplyValidations).set({ state: "approved", decidedBy: staff.staffUserId, decidedAt: new Date(), authorizationBasis: "fixture" })
        .where(eq(savCaseReplyValidations.id, rows[0]!.id));
      return rows;
    };
    const [proposed] = await reminder(proposedCase.caseId, proposedCase.timerId, "proposed");
    expect(await routeCustomerReturn(r1.id, ports().deps)).toMatchObject({ written: true, record: { supersededReminders: 1, admission: "stale_requalification_required" } });
    expect((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed!.id)))[0]!.state).toBe("superseded");

    const approvedCase = await waiting(), r2 = await mail(approvedCase.threadId, approvedCase.mailboxId, { receivedAt: T1 });
    await reminder(approvedCase.caseId, approvedCase.timerId, "approved");
    expect(await routeCustomerReturn(r2.id, ports().deps)).toMatchObject({ route: { route: "continue" }, written: true, record: { admission: "stale_reminder_approved" } });
    const stale = (await readCase(approvedCase.caseId))!;
    const admission = caseAdmissionStatus(stale, POLICY);
    expect(admission).toEqual({ admitted: false, reason: "input_newer" });
    expect(decideCaseEffect("planned", { mode: "supervised", pause: { intake: "running", v2: "running" }, leaseValid: true, admission, recipient: "match", approval: "ok" }))
      .toEqual({ action: "cancel", code: "new_input" });
  });

  it("an automatic reply proven by its stored Gmail headers neither continues the case nor cancels the J2; no owner is read", async () => {
    const w = await waiting();
    const outOfOffice = await mail(w.threadId, w.mailboxId, { receivedAt: T1, subject: "Réponse automatique : Connexion fictive", text: "Je suis absent jusqu'au 10 novembre.",
      headers: { "x-studio-automation-headers": "singleton-v1", "x-studio-automation-body": "complete-plain-v1", "auto-submitted": "auto-replied",
        "in-reply-to": "<sav-fictif@studio.example.invalid>", "content-type": "text/plain; charset=UTF-8" } });
    const { deps, readTicketOwner } = ports({ readAutomated: undefined });
    expect(await routeCustomerReturn(outOfOffice.id, deps)).toEqual({ route: { route: "ignore_automated", reason: "automated" }, caseId: w.caseId, written: false });
    expect(readTicketOwner).not.toHaveBeenCalled();
    expect(await timerState(w.timerId)).toMatchObject({ state: "scheduled" });
    expect(await inboundKeys(w.caseId)).toHaveLength(1);
    // The same words from a person, without the headers, are a real answer.
    const human = await mail(w.threadId, w.mailboxId, { receivedAt: new Date(T1.getTime() + 60_000), subject: "Réponse automatique : Connexion fictive", text: "Je suis absent jusqu'au 10 novembre." });
    expect(await routeCustomerReturn(human.id, deps)).toMatchObject({ route: { route: "continue" }, written: true });
  });
});

describe("who owns it: a person's ticket is never touched", () => {
  it("the ticket now belongs to a person: the case goes to the team with the mail, the J2 ends, no CRM write exists", async () => {
    const w = await waiting(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    const { deps, readTicketOwner } = ports({ owner: PERSON });
    expect(await routeCustomerReturn(reply.id, deps)).toMatchObject({ route: { route: "hand_to_team", reason: "human_owner" }, written: true });
    expect(readTicketOwner).toHaveBeenCalledTimes(1);
    expect(await readCase(w.caseId)).toMatchObject({ owner: "human", phase: "human_owned", body: { handoff: { reason: "human_owner" } } });
    expect(await timerState(w.timerId)).toMatchObject({ state: "cancelled" });
    expect((await listCaseEvents(w.caseId)).filter(event => event.kind === "owner_changed").map(event => event.detail)).toEqual([expect.objectContaining({ transition: "human_takeover", reason: "human_owner" })]);
  });

  it("nobody owns the ticket now (V2 owner removed): to the team; a case already with the team or on hold is left as it is, unread", async () => {
    const removed = await waiting(), r1 = await mail(removed.threadId, removed.mailboxId, { receivedAt: T1 });
    expect(await routeCustomerReturn(r1.id, ports({ owner: null }).deps)).toMatchObject({ route: { route: "hand_to_team", reason: "v2_owner_removed" }, written: true });

    const team = await waiting(), r2 = await mail(team.threadId, team.mailboxId, { receivedAt: T1 });
    const c = (await readCase(team.caseId))!;
    await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: staff, commandKey: `take-${team.caseId}`, reason: "prise_fictive" });
    const before = (await readCase(team.caseId))!.version;
    const { deps, readTicketOwner } = ports();
    expect(await routeCustomerReturn(r2.id, deps)).toEqual({ route: { route: "leave_to_owner", reason: "case_with_team" }, caseId: team.caseId, written: false });
    expect(readTicketOwner).not.toHaveBeenCalled();
    expect((await readCase(team.caseId))!.version).toBe(before);
  });

  it("an owner that cannot be read, or a pause, waits: nothing written, the mail and the J2 kept for the next pass", async () => {
    const w = await waiting(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    expect(await routeCustomerReturn(reply.id, ports({ owner: () => { throw Error("CRM_DOWN"); } }).deps)).toMatchObject({ route: { route: "wait", reason: "owner_unread" }, written: false });
    expect(await routeCustomerReturn(reply.id, ports({ owner: () => undefined }).deps)).toMatchObject({ route: { route: "wait", reason: "owner_unread" } });
    await setV2Pause("actions_paused");
    const paused = ports();
    expect(await routeCustomerReturn(reply.id, paused.deps)).toMatchObject({ route: { route: "wait", reason: "paused" }, written: false });
    expect(paused.readTicketOwner).not.toHaveBeenCalled();
    expect(await timerState(w.timerId)).toMatchObject({ state: "scheduled" });
    expect(await inboundKeys(w.caseId)).toHaveLength(1);
    await setV2Pause(null);
    expect(await routeCustomerReturn(reply.id, ports().deps)).toMatchObject({ route: { route: "continue" }, written: true });
  });
});

describe("after closure: same incident reopens, a new subject is a new admission, a thanks or an automatic reply reopens nothing", () => {
  async function resolved() {
    const w = await waiting();
    const c = (await readCase(w.caseId))!;
    const closed = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase: "resolved",
      body: { ...c.body, waiting: null, cycle: { number: 1, endedBy: "resolved" }, openRequests: c.body.openRequests.map(request => ({ ...request, status: "resolved" as const })) } });
    return { ...w, version: closed.version };
  }
  it("V1 confirmed the mail on the same ticket (its 15-day same-subject reopen): a new cycle of the SAME case, the request open again, decided on THIS mail's V1 qualification", async () => {
    const w = await resolved(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    const outcome = await routeCustomerReturn(reply.id, ports({ readV1Target: async () => "same_ticket", readMailAdmission: async () => ADMITTED }).deps);
    expect(outcome).toMatchObject({ route: { route: "reopen", reason: "same_incident_v1_confirmed" }, written: true, record: { reopenedRequests: ["r1"], admission: "readmitted" } });
    const after = (await readCase(w.caseId))!;
    expect(after).toMatchObject({ owner: "agent", phase: "queued", body: { cycle: { number: 2 } } });
    expect(after.body.cycle.endedBy).toBeUndefined();
    expect(after.body.openRequests.map(request => request.status)).toEqual(["open"]);
  });
  it("another ticket (a new subject), a thanks, an automatic reply or V1 not done yet: the closed case is not touched", async () => {
    const w = await resolved();
    const cases: Array<[Partial<CustomerReturnDeps>, unknown]> = [
      [{ readV1Target: async () => "other_ticket" }, { route: "normal_admission", reason: "new_subject" }],
      [{ readAcknowledgement: async () => true, readV1Target: async () => "same_ticket" }, { route: "keep_closed", reason: "acknowledgement" }],
      [{ readAutomated: async () => true, readV1Target: async () => "same_ticket" }, { route: "keep_closed", reason: "automated" }],
      [{}, { route: "wait", reason: "v1_pending" }],
    ];
    for (const [overrides, route] of cases) {
      const reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
      const { deps, readTicketOwner } = ports(overrides);
      expect(await routeCustomerReturn(reply.id, deps)).toEqual({ route, caseId: w.caseId, written: false });
      expect(readTicketOwner).not.toHaveBeenCalled();
    }
    expect(await readCase(w.caseId)).toMatchObject({ phase: "resolved", version: w.version });
  });
});

describe("the link must be durable and unique", () => {
  it("a thread no case holds, or that two cases hold, goes to V1's normal admission; a mail older than the case too", async () => {
    const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${randomUUID().slice(0, 8)}@example.invalid` }).returning();
    const [thread] = await f.db.insert(savThreads).values({ mailboxId: mailbox!.id, gmailThreadId: randomUUID(), customerEmail: "client.fictif@example.invalid" }).returning();
    const lone = await mail(thread!.id, mailbox!.id, { receivedAt: T1 });
    expect(await routeCustomerReturn(lone.id, ports().deps)).toEqual({ route: { route: "normal_admission", reason: "no_case" }, caseId: null, written: false });

    const w = await waiting(), other = String(++ticketSeq), g = `syn-${randomUUID().slice(0, 12)}`;
    await openCaseEvent({ ticketId: other, threadId: w.threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(g), sourceRef: { type: "email", id: g }, occurredAt: T0.toISOString() });
    const reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    expect(await routeCustomerReturn(reply.id, ports().deps)).toMatchObject({ route: { route: "normal_admission", reason: "several_cases" }, written: false });

    const v = await waiting(), old = await mail(v.threadId, v.mailboxId, { receivedAt: new Date(T0.getTime() - 86_400_000) });
    expect(await routeCustomerReturn(old.id, ports().deps)).toMatchObject({ route: { route: "normal_admission", reason: "before_case" }, written: false });
    expect(await f.db.select().from(savCaseEvents).where(and(eq(savCaseEvents.caseId, v.caseId), eq(savCaseEvents.dedupeKey, caseDedupeKey.inbound(old.gmail))))).toHaveLength(0);
  });
});

describe("revue d70a : contre-exemple 2, un nouveau mail ne réutilise jamais la qualification déjà enregistrée", () => {
  it("après un accès admis, le retour consommé avant toute analyse laisse l'admission périmée : la qualification « access » de l'ancien mail ne l'admet pas", async () => {
    const w = await waiting(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1, text: "Remboursez-moi cette facture et résiliez mon abonnement." });
    expect(await routeCustomerReturn(reply.id, ports().deps)).toMatchObject({ route: { route: "continue" }, written: true });
    const after = (await readCase(w.caseId))!;
    expect(caseAdmissionStatus(after, POLICY)).toEqual({ admitted: false, reason: "input_newer" });
    expect((await listCaseEvents(w.caseId)).filter(event => event.kind === "admission_decided")).toHaveLength(1);
    expect(await claimCaseForDecision({ caseId: w.caseId, expectedVersion: after.version, holder: "test", currentPolicyRevision: POLICY, ttlSeconds: 60, settleSeconds: 0 })).toMatchObject({ claimed: false });
  });
});

describe("revue d70a : le mail du retour décide, jamais celui d'avant", () => {
  const FINANCE = { ...ADMITTED, qualification: { ...ADMITTED.qualification, requests: [{ requestId: "fin", family: "finance" as const, provenance: { kind: "intake_hint" as const, source: { type: "email" as const, id: "syn-fin" } } }] } };
  const MIXED = { ...ADMITTED, qualification: { ...ADMITTED.qualification, requests: [...ADMITTED.qualification.requests, ...FINANCE.qualification.requests] } };
  it.each([["finance", FINANCE], ["mixte accès + finance", MIXED]])("réouverture confirmée par V1 sur un mail %s : retiré à l'équipe, dossier sensible", async (_name, admission) => {
    const w = await waiting(), c = (await readCase(w.caseId))!;
    await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase: "resolved", body: { ...c.body, waiting: null, cycle: { number: 1, endedBy: "resolved" }, openRequests: c.body.openRequests.map(request => ({ ...request, status: "resolved" as const })) } });
    const reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
    expect(await routeCustomerReturn(reply.id, ports({ readV1Target: async () => "same_ticket", readMailAdmission: async () => admission }).deps)).toMatchObject({ route: { route: "reopen" }, written: true, record: { admission: "withdrawn" } });
    expect(await readCase(w.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending", sensitivity: "finance" });
  });
  it("retour consommé avant V1, requalifié sur son contenu par le chemin de B : simple, il reste au dossier ; sensible ou mixte, il part à l'équipe sans décision de l'agent", async () => {
    const consumed = async () => {
      const w = await waiting(), reply = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
      await routeCustomerReturn(reply.id, ports().deps);
      return { w, reply, current: (await readCase(w.caseId))! };
    };
    const simple = await consumed();
    const admitted = await reevaluateCaseAdmission({ caseId: simple.w.caseId, expectedVersion: simple.current.version, admission: ADMITTED, sourceRef: { type: "email", id: simple.reply.gmail } });
    expect(admitted).toMatchObject({ owner: "agent", phase: "queued" });
    expect(caseAdmissionStatus(admitted, POLICY)).toEqual({ admitted: true });
    for (const admission of [FINANCE, MIXED]) {
      const sensitive = await consumed();
      expect(await reevaluateCaseAdmission({ caseId: sensitive.w.caseId, expectedVersion: sensitive.current.version, admission, sourceRef: { type: "email", id: sensitive.reply.gmail } }))
        .toMatchObject({ owner: "human", phase: "handoff_pending", sensitivity: "finance" });
      expect(await claimCaseForDecision({ caseId: sensitive.w.caseId, expectedVersion: (await readCase(sensitive.w.caseId))!.version, holder: "test", currentPolicyRevision: POLICY, ttlSeconds: 60, settleSeconds: 0 })).toMatchObject({ claimed: false });
    }
  });
});

describe("revue R03 : une réponse plus ancienne reçue après un mail neuf", () => {
  const latestInbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "inbound_confirmed").at(-1)!.sourceRef!.id;
  it("ne devient pas le dernier entrant, n'écrit rien, et ne touche ni au mail neuf ni à son J2", async () => {
    const w = await waiting();
    const older = await mail(w.threadId, w.mailboxId, { receivedAt: T1, text: "Toujours bloqué." }), newer = await mail(w.threadId, w.mailboxId, { receivedAt: new Date(T1.getTime() + 30_000), text: "C'est résolu." });
    await routeCustomerReturn(newer.id, ports().deps);
    // V2 asked again after the new mail: this J2 belongs to the new exchange.
    const c = (await readCase(w.caseId))!, effect = `effect-${randomUUID().slice(0, 8)}`, timerId = randomUUID(), sentAt = new Date(T1.getTime() + 60_000);
    const proven = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: c.version, admission: ADMITTED, sourceRef: { type: "email", id: newer.gmail } });
    const asked = await updateCaseRecord({ caseId: proven.caseId, expectedVersion: proven.version, actor: { type: "agent" }, body: { ...proven.body, questions: [...proven.body.questions, { id: "q2", text: "Autre question fictive", factKeys: [], askedAt: sentAt.toISOString(), askedInEffect: effect }] } });
    expect(await scheduleJ2ForConfirmedQuestion({ caseId: asked.caseId, expectedVersion: asked.version, currentPolicyRevision: POLICY, questionEffectId: effect, timerId, sentAt })).toMatchObject({ scheduled: true });
    const before = (await readCase(w.caseId))!, { deps, readTicketOwner } = ports();
    expect(await routeCustomerReturn(older.id, deps)).toEqual({ route: { route: "keep_latest", reason: "older_than_latest" }, caseId: w.caseId, written: false });
    expect(readTicketOwner).not.toHaveBeenCalled();
    expect(await latestInbound(w.caseId)).toBe(newer.gmail);
    expect((await readCase(w.caseId))!.version).toBe(before.version);
    expect(await timerState(timerId)).toMatchObject({ state: "scheduled" });
  });
  it("égalité de date et d'enregistrement : le dernier entrant est le même quel que soit l'ordre d'arrivée, et un doublon n'ajoute rien", async () => {
    const twins = async () => {
      const w = await waiting(), one = await mail(w.threadId, w.mailboxId, { receivedAt: T1 }), two = await mail(w.threadId, w.mailboxId, { receivedAt: T1 });
      await f.db.update(savMessages).set({ createdAt: T1 }).where(and(eq(savMessages.threadId, w.threadId), eq(savMessages.receivedAt, T1)));
      const [low, high] = [one, two].sort((a, b) => a.id < b.id ? -1 : 1);
      return { w, low: low!, high: high! };
    };
    const inOrder = await twins();
    expect(await routeCustomerReturn(inOrder.low.id, ports().deps)).toMatchObject({ route: { route: "continue" }, written: true });
    expect(await routeCustomerReturn(inOrder.high.id, ports().deps)).toMatchObject({ route: { route: "continue" }, written: true });
    expect(await latestInbound(inOrder.w.caseId)).toBe(inOrder.high.gmail);
    const reversed = await twins();
    expect(await routeCustomerReturn(reversed.high.id, ports().deps)).toMatchObject({ route: { route: "continue" }, written: true });
    expect(await routeCustomerReturn(reversed.low.id, ports().deps)).toMatchObject({ route: { route: "keep_latest" }, written: false });
    expect(await latestInbound(reversed.w.caseId)).toBe(reversed.high.gmail);
    const version = (await readCase(reversed.w.caseId))!.version;
    expect(await routeCustomerReturn(reversed.high.id, ports().deps)).toMatchObject({ route: { route: "already_recorded" }, written: false });
    expect((await readCase(reversed.w.caseId))!.version).toBe(version);
  });
});
