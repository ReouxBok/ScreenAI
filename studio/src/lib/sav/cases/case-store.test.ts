import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { withoutSyncStateRow } from "../../../../test/sav-sync-state-row";
import { savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The case record never touches HubSpot: importing a HubSpot module from it fails the file.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import {
  CaseVersionStaleError, appendCaseEvent, claimCaseForDecision, fireCaseTimer, listCaseEvents, listCaseTimers, openCaseEvent, readCase, readCaseByTicket, readCaseDiagnostics,
  listCaseIdsForPolicyRevalidation, listCasesPage, listDueCaseTimers, recordCaseObservation, reevaluateCaseAdmission, releaseCaseClaim, revalidateCaseAdmissionForPolicy, scheduleCaseTimer, transitionCaseOwner, updateCaseRecord,
} from "./case-store";
import { encryptSavPayload } from "../crypto";
import { caseAdmissionStatus, decideCaseAdmission, type CaseAdmissionInput } from "./admission-policy";
import { SAV_CASE_ADMISSION_REASONS, caseDedupeKey, currentCaseFacts, type CaseAdmissionQualification, type CaseFact, type CaseSensitivity } from "./case-types";

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 7_100_000;
const ticket = () => String(++ticketSeq);
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001" };
const AT = "2026-10-27T09:00:00.000Z";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT };
const byHuman = { kind: "human" as const, staffUserId: staff.staffUserId, at: AT };
const hint = (id = "gm-hint") => ({ kind: "intake_hint" as const, source: { type: "email" as const, id } });
type Requests = CaseAdmissionQualification["requests"];
const qualified = (requests: Requests, patch: Partial<CaseAdmissionQualification> = {}): CaseAdmissionQualification => ({
  requests, identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [], ...patch,
});
const ADMITTED: CaseAdmissionInput = { policy: POLICY, qualification: qualified([{ requestId: "r1", family: "access", provenance: byHuman }]) };
const UNQUALIFIED: CaseAdmissionInput = { policy: null, qualification: qualified([{ requestId: "r1", family: "unknown", provenance: hint() }]) };
const sensitive = (family: "finance" | "cancellation"): CaseAdmissionInput => ({ policy: POLICY, qualification: qualified([{ requestId: "r1", family, provenance: hint() }]) });
const admissionOf = (value: CaseSensitivity | CaseAdmissionInput) => typeof value === "string" ? value === "none" ? ADMITTED : sensitive(value) : value;
const inbound = (ticketId: string, gmailId: string, admission: CaseSensitivity | CaseAdmissionInput = ADMITTED, threadId = randomUUID()) => openCaseEvent({
  ticketId, threadId, admission: admissionOf(admission), kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailId), sourceRef: { type: "email", id: gmailId }, occurredAt: RECEIVED,
});
const keys = async (caseId: string) => (await listCaseEvents(caseId)).map(e => e.dedupeKey);
const RECEIVED = "2026-10-27T08:00:00.000Z";
const rows = async (sqlText: string, params: unknown[] = []) => (await f.client.query<Record<string, unknown>>(sqlText, params)).rows;

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("switch and schema guard", () => {
  it("writes nothing while SAV_CASE_RECORDING is not exactly on", async () => {
    const ticketId = ticket();
    for (const value of [undefined, "", "off", "ON", "true"]) {
      vi.stubEnv("SAV_CASE_RECORDING", value as string);
      await expect(inbound(ticketId, `gm-off-${value}`)).rejects.toThrow("SAV_CASE_RECORDING_OFF");
    }
    expect(await readCaseByTicket(ticketId)).toBeNull();
    expect(await rows("SELECT count(*)::int AS n FROM sav.case_events e JOIN sav.cases c ON c.id=e.case_id WHERE c.ticket_id=$1", [ticketId])).toEqual([{ n: 0 }]);
  });
  it("fails closed when the 0048 schema marker is missing", async () => {
    await withoutSyncStateRow(f.client, "sav-case-schema-v4", () => expect(inbound(ticket(), "gm-schema")).rejects.toThrow("SAV_CASE_SCHEMA_MISSING"));
  });
});

describe("one case per ticket, deduplicated per case", () => {
  it("creates one case and makes a replayed event a no-op", async () => {
    const ticketId = ticket(), threadId = randomUUID();
    const first = await inbound(ticketId, "gm-1", "none", threadId);
    expect(first).toMatchObject({ created: true, appended: true, case: { ticketId, version: 3, owner: "agent", phase: "queued", sensitivity: "none", threadIds: [threadId] } });
    const replay = await inbound(ticketId, "gm-1", "none", threadId);
    expect(replay).toMatchObject({ created: false, appended: false, case: { caseId: first.case.caseId, version: 3 } });
    expect((await listCaseEvents(first.case.caseId)).map(e => [e.kind, e.dedupeKey, e.caseVersion]))
      .toEqual([["inbound_confirmed", "inbound:gm-1", 2], ["admission_decided", "admission:v3:policy-r1", 3]]);
  });
  it("keeps several threads on the same ticket's case", async () => {
    const ticketId = ticket(), [a, b] = [randomUUID(), randomUUID()];
    await inbound(ticketId, "gm-thread-a", "none", a);
    const second = await inbound(ticketId, "gm-thread-b", "none", b);
    expect(second.case.threadIds).toEqual([a, b]);
    expect(second.case.version).toBe(5);
  });
  it("lets one mail feed two tickets: one event in each case, never a global suppression", async () => {
    const [t1, t2] = [ticket(), ticket()], threadId = randomUUID();
    const one = await inbound(t1, "gm-shared", "none", threadId), two = await inbound(t2, "gm-shared", "none", threadId);
    expect(one.case.caseId).not.toBe(two.case.caseId);
    expect(two).toMatchObject({ created: true, appended: true });
    expect(await inbound(t1, "gm-shared", "none", threadId)).toMatchObject({ appended: false, case: { version: 3 } });
    for (const id of [one.case.caseId, two.case.caseId]) expect(await keys(id)).toEqual(["inbound:gm-shared", "admission:v3:policy-r1"]);
  });
  it("deduplicates appendCaseEvent too and validates keys per kind", async () => {
    const { case: c } = await inbound(ticket(), "gm-append");
    const timer = { caseId: c.caseId, kind: "timer_fired" as const, dedupeKey: caseDedupeKey.timer("j2-1"), sourceRef: { type: "timer" as const, id: "j2-1" } };
    expect(await appendCaseEvent(timer)).toEqual({ appended: true, version: 4 });
    expect(await appendCaseEvent(timer)).toEqual({ appended: false, version: 4 });
    await expect(appendCaseEvent({ ...timer, dedupeKey: "inbound:gm-append" })).rejects.toThrow("SAV_CASE_DEDUPE_KEY_INVALID");
    await expect(appendCaseEvent({ ...timer, kind: "crm_observed", dedupeKey: "crm:missing-date" })).rejects.toThrow("SAV_CASE_DEDUPE_KEY_INVALID");
    await expect(appendCaseEvent({ ...timer, caseId: randomUUID() })).rejects.toThrow("SAV_CASE_NOT_FOUND");
  });
  it("rejects a second case row for the same ticket at the database", async () => {
    const ticketId = ticket();
    await inbound(ticketId, "gm-unique");
    await expect(rows("INSERT INTO sav.cases(ticket_id,owner,phase,contract_revision,payload_ciphertext) VALUES ($1,'human','handoff_pending','x','x')", [ticketId])).rejects.toThrow("unique");
  });
});

describe("encryption", () => {
  it("keeps customer text only inside ciphertext", async () => {
    const secret = "Texte client synthétique : impossible de me connecter depuis lundi";
    const { case: c } = await inbound(ticket(), "gm-crypto");
    const body = { ...c.body, facts: [{ id: "f1", text: secret, source: { type: "email" as const, id: "gm-crypto" }, at: "2026-10-27T10:00:00.000Z", kind: "customer_statement" as const, key: null }] };
    const updated = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body });
    expect(updated.body.facts[0]!.text).toBe(secret);
    const raw = JSON.stringify(await rows("SELECT c.*, e.* FROM sav.cases c JOIN sav.case_events e ON e.case_id=c.id WHERE c.id=$1", [c.caseId]));
    expect(raw).not.toContain("impossible");
    expect((await rows("SELECT payload_ciphertext FROM sav.cases WHERE id=$1", [c.caseId]))[0]!.payload_ciphertext).toMatch(/^v1\./);
  });
  it("refuses to read a payload written with another key", async () => {
    const { case: c } = await inbound(ticket(), "gm-key");
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "another-fixture-key-only-32-characters!!");
    await expect(readCase(c.caseId)).rejects.toThrow();
  });
  it("rejects a body outside the contract", async () => {
    const { case: c } = await inbound(ticket(), "gm-body");
    const body = { ...c.body, facts: [{ id: "f1", text: "x", source: { type: "email", id: "gm" }, at: "hier", kind: "observed", key: null }] };
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: body as never })).rejects.toThrow("SAV_CASE_BODY_INVALID");
  });
});

describe("lock and CAS version", () => {
  it("rejects a stale version and reports the current one", async () => {
    const { case: c } = await inbound(ticket(), "gm-cas");
    await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase: "acting" });
    const stale = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase: "queued" }).catch(e => e);
    expect(stale).toBeInstanceOf(CaseVersionStaleError);
    expect(stale.currentVersion).toBe(c.version + 1);
    expect((await readCase(c.caseId))!.phase).toBe("acting");
  });
  it("makes a decision prepared before a new inbound event stale", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-c1-a");
    await inbound(ticketId, "gm-c1-b");
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase: "acting" })).rejects.toThrow("SAV_CASE_VERSION_STALE");
  });
  it("lets exactly one of two concurrent writers win; the loser re-reads and retries", async () => {
    const { case: c } = await inbound(ticket(), "gm-race");
    const write = (phase: "acting" | "technical_wait") => updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase });
    const results = await Promise.allSettled([write("acting"), write("technical_wait")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(CaseVersionStaleError);
    const fresh = (await readCase(c.caseId))!;
    expect(fresh.version).toBe(c.version + 1);
    expect((await updateCaseRecord({ caseId: c.caseId, expectedVersion: fresh.version, actor: { type: "agent" }, phase: "needs_review" })).version).toBe(c.version + 2);
  });
  it("serialises concurrent first events for one ticket into a single case", async () => {
    const ticketId = ticket();
    const results = await Promise.all([inbound(ticketId, "gm-p1"), inbound(ticketId, "gm-p2"), inbound(ticketId, "gm-p1")]);
    expect(new Set(results.map(r => r.case.caseId)).size).toBe(1);
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect((await keys(results[0]!.case.caseId)).filter(key => key.startsWith("inbound:")).sort()).toEqual(["inbound:gm-p1", "inbound:gm-p2"]);
  });
});

describe("owner and explicit transitions", () => {
  it("records finance/cancellation for the team and never hands them back to the agent, even with an admitted qualification", async () => {
    const { case: c } = await inbound(ticket(), "gm-fin", "finance");
    expect(c).toMatchObject({ owner: "human", phase: "handoff_pending", sensitivity: "finance", admission: { target: "team", reasons: ["sensitive_family"] } });
    await expect(transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "hand_back", actor: staff, commandKey: "cmd-fin", reason: "manual", admission: ADMITTED }))
      .rejects.toThrow("SAV_CASE_SENSITIVE_HUMAN_ONLY");
    const held = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "organisational_hold", actor: staff, commandKey: "cmd-fin-hold", reason: "audit" });
    await expect(transitionCaseOwner({ caseId: c.caseId, expectedVersion: held.case.version, transition: "hold_release", to: "agent", actor: staff, commandKey: "cmd-fin-rel", reason: "audit", admission: ADMITTED }))
      .rejects.toThrow("SAV_CASE_SENSITIVE_HUMAN_ONLY");
    await expect(rows("UPDATE sav.cases SET owner='agent', phase='queued' WHERE id=$1", [c.caseId])).rejects.toThrow();
  });
  it("withdraws an admitted case once on a later refund request, never downgrades", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-esc-1");
    const escalated = await inbound(ticketId, "gm-esc-2", "cancellation");
    expect(escalated.case).toMatchObject({ owner: "human", phase: "handoff_pending", sensitivity: "cancellation", version: c.version + 3, body: { handoff: { reason: "sensitive_family" } } });
    expect(await inbound(ticketId, "gm-esc-2", "cancellation")).toMatchObject({ appended: false, case: { version: escalated.case.version } });
    const later = await inbound(ticketId, "gm-esc-3", "none");
    expect(later.case).toMatchObject({ owner: "human", sensitivity: "cancellation", admission: { target: "team", reasons: ["case_sensitive"] } });
    expect(await keys(c.caseId)).toEqual([
      "inbound:gm-esc-1", "admission:v3:policy-r1", "inbound:gm-esc-2", "admission:v5:policy-r1", "rule:admission:v5", "inbound:gm-esc-3", "admission:v8:policy-r1",
    ]);
    expect((await listCaseEvents(c.caseId)).find(e => e.dedupeKey === "rule:admission:v5")?.detail).toMatchObject({ transition: "admission_withdrawn", from: "agent", to: "human" });
  });
  it("hands over to a human, keeps the agent observe-only, and replays the command as a no-op", async () => {
    const { case: c } = await inbound(ticket(), "gm-human");
    const taken = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: staff, commandKey: "takeover-1", reason: "crm_owner_changed" });
    expect(taken).toMatchObject({ replayed: false, case: { owner: "human", phase: "human_owned", version: c.version + 1 } });
    expect(taken.case.body.handoff?.humanSince).toBeTruthy();
    expect(await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: staff, commandKey: "takeover-1", reason: "crm_owner_changed" }))
      .toMatchObject({ replayed: true, case: { version: taken.case.version } });
    const v = taken.case.version, agent = { type: "agent" as const };
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: v, actor: agent, phase: "handoff_pending" })).rejects.toThrow("SAV_CASE_OBSERVE_ONLY");
    const question = { id: "q1", text: "Question fictive", factKeys: [], askedAt: "2026-10-27T10:00:00.000Z", askedInEffect: "effect-1" };
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: v, actor: agent, body: { ...taken.case.body, questions: [question] } })).rejects.toThrow("SAV_CASE_OBSERVE_ONLY");
    const fact = { id: "f1", text: "Observation fictive", source: { type: "hubspot_note" as const, id: "note-1" }, at: "2026-10-27T10:00:00.000Z", kind: "observed" as const, key: null };
    const observed = await updateCaseRecord({ caseId: c.caseId, expectedVersion: v, actor: agent, body: { ...taken.case.body, facts: [fact] } });
    expect(observed.body.facts).toHaveLength(1);
    const back = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: observed.version, transition: "hand_back", actor: staff, commandKey: "back-1", reason: "resolved_by_team", admission: ADMITTED });
    expect(back.case).toMatchObject({ owner: "agent", phase: "queued", body: { handoff: null }, version: observed.version + 2 });
    const events = await listCaseEvents(c.caseId);
    expect(events.filter(e => e.kind === "owner_changed").map(e => [e.dedupeKey, e.detail?.transition, e.detail?.from, e.detail?.to]))
      .toEqual([["cmd:takeover-1", "human_takeover", "agent", "human"], ["cmd:back-1", "hand_back", "human", "agent"]]);
  });
  it("allows owner changes only through the declared transitions and actors", async () => {
    const { case: c } = await inbound(ticket(), "gm-forbid");
    const base = { caseId: c.caseId, expectedVersion: c.version, reason: "fixture" };
    await expect(transitionCaseOwner({ ...base, transition: "hand_back", actor: staff, commandKey: "f1" })).rejects.toThrow("SAV_CASE_TRANSITION_FORBIDDEN");
    await expect(transitionCaseOwner({ ...base, transition: "organisational_hold", actor: { type: "agent" }, commandKey: "f2" })).rejects.toThrow("SAV_CASE_TRANSITION_FORBIDDEN");
    await expect(transitionCaseOwner({ ...base, transition: "hold_release", actor: staff, commandKey: "f3" })).rejects.toThrow("SAV_CASE_TRANSITION_FORBIDDEN");
    await expect(transitionCaseOwner({ ...base, expectedVersion: c.version - 1, transition: "handoff", actor: { type: "agent" }, commandKey: "f4" })).rejects.toThrow("SAV_CASE_VERSION_STALE");
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: staff, phase: "human_owned" })).rejects.toThrow("SAV_CASE_PHASE_OWNER_MISMATCH");
    const handed = await transitionCaseOwner({ ...base, transition: "handoff", actor: { type: "agent" }, commandKey: "f5", reason: "customer_asked_human" });
    expect(handed.case).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "customer_asked_human" } } });
    const held = await transitionCaseOwner({ ...base, expectedVersion: handed.case.version, transition: "organisational_hold", actor: staff, commandKey: "f6" });
    expect(held.case).toMatchObject({ owner: "system_hold", phase: "handoff_pending" });
    const released = await transitionCaseOwner({ ...base, expectedVersion: held.case.version, transition: "hold_release", to: "agent", actor: staff, commandKey: "f7", admission: ADMITTED });
    expect(released.case).toMatchObject({ owner: "agent", phase: "queued" });
  });
});

describe("journal and diagnostics", () => {
  it("refuses UPDATE and DELETE on case events", async () => {
    const { case: c } = await inbound(ticket(), "gm-append-only");
    await expect(rows("UPDATE sav.case_events SET kind='timer_fired' WHERE case_id=$1", [c.caseId])).rejects.toThrow("SAV_CASE_EVENTS_APPEND_ONLY");
    await expect(rows("DELETE FROM sav.case_events WHERE case_id=$1", [c.caseId])).rejects.toThrow("SAV_CASE_EVENTS_APPEND_ONLY");
  });
  it("exposes a read-only diagnostics field without decrypting content", async () => {
    const ticketId = ticket();
    await inbound(ticketId, "gm-diag");
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "");
    expect(await readCaseDiagnostics(ticketId)).toMatchObject({ version: 3, owner: "agent", phase: "queued", sensitivity: "none", threadCount: 1, eventCount: 2, lastEventKind: "admission_decided",
      admission: { target: "agent", reason: "admitted", policyRevision: "policy-r1", inputNewer: false } });
    expect(await readCaseDiagnostics("not-a-ticket")).toBeNull();
  });
});

describe("v2 evidence for the decision validator (SAV-6)", () => {
  const at = "2026-10-27T10:00:00.000Z", later = "2026-10-27T11:00:00.000Z", procedure = { knowledgeId: "kb-1", contentVersionId: "kv-1" };
  const request = { id: "r1", summary: "Demande fictive", family: "access" as const, status: "open" as const, openedAt: RECEIVED };
  const trial = { id: "t1", requestId: "r1", procedure, askedAt: at, outcome: "pending" as const, resultAt: null };
  it("stores fact keys, question fact keys, request families and trial outcomes", async () => {
    const { case: c } = await inbound(ticket(), "gm-v2-body");
    const body = { ...c.body, openRequests: [request],
      facts: [{ id: "f1", text: "Fait fictif", source: { type: "email" as const, id: "gm-v2-body" }, at, kind: "customer_statement" as const, key: "login_error" }],
      questions: [{ id: "q1", text: "Question fictive", factKeys: ["login_error", "account_email"], askedAt: at, askedInEffect: "effect-1" }],
      trials: [{ ...trial, outcome: "failed" as const, resultAt: later, result: { text: "Échec fictif", source: { type: "email" as const, id: "gm-v2-reply" } } }] };
    const saved = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body });
    expect((await readCase(c.caseId))!.body).toEqual(saved.body);
    expect(saved.body).toMatchObject({ openRequests: [{ family: "access", openedAt: RECEIVED }], facts: [{ key: "login_error" }], questions: [{ factKeys: ["login_error", "account_email"] }],
      trials: [{ requestId: "r1", outcome: "failed", resultAt: later }] });
  });
  it("rejects incomplete or inconsistent evidence", async () => {
    const { case: c } = await inbound(ticket(), "gm-v2-invalid");
    const write = (patch: Record<string, unknown>) => updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, openRequests: [request], ...patch } as never });
    for (const patch of [
      { openRequests: [{ ...request, family: undefined }] },
      { openRequests: [{ ...request, openedAt: undefined }] },
      { admission: { target: "agent" } },
      { openRequests: [{ ...request, family: "billing" }] },
      { openRequests: [request, request] },
      { facts: [{ id: "f1", text: "x", source: { type: "email", id: "gm" }, at, kind: "observed" }] },
      { facts: [{ id: "f1", text: "x", source: { type: "email", id: "gm" }, at, kind: "observed", key: "Not A Key" }] },
      { questions: [{ id: "q1", text: "x", factKeys: ["login_error", "login_error"], askedAt: at, askedInEffect: "e" }] },
      { trials: [{ ...trial, requestId: "r-unknown" }] },
      { trials: [{ ...trial, resultAt: later }] },
      { trials: [{ ...trial, outcome: "failed" }] },
      { trials: [{ ...trial, outcome: undefined }] },
    ]) await expect(write(patch)).rejects.toThrow("SAV_CASE_BODY_INVALID");
    expect((await readCase(c.caseId))!.version).toBe(c.version);
  });
  it("never records a finance or cancellation request on a case that is not that sensitive", async () => {
    const { case: plain } = await inbound(ticket(), "gm-v2-plain");
    await expect(updateCaseRecord({ caseId: plain.caseId, expectedVersion: plain.version, actor: { type: "agent" }, body: { ...plain.body, openRequests: [{ ...request, family: "finance" }] } }))
      .rejects.toThrow("SAV_CASE_SENSITIVE_FAMILY_UNRECORDED");
    const { case: fin } = await inbound(ticket(), "gm-v2-fin", "finance");
    const ok = await updateCaseRecord({ caseId: fin.caseId, expectedVersion: fin.version, actor: staff, body: { ...fin.body, openRequests: [{ ...request, family: "finance" }] } });
    expect(ok.body.openRequests[0]!.family).toBe("finance");
    await expect(updateCaseRecord({ caseId: fin.caseId, expectedVersion: ok.version, actor: staff, body: { ...ok.body, openRequests: [{ ...request, id: "r2", family: "cancellation" }] } }))
      .rejects.toThrow("SAV_CASE_SENSITIVE_FAMILY_UNRECORDED");
  });
  it("dates every event at its source and records who wrote each message", async () => {
    const { case: c } = await inbound(ticket(), "gm-v2-dir");
    const outbound = { caseId: c.caseId, kind: "outbound_observed" as const, dedupeKey: caseDedupeKey.outbound("gm-v2-out"), sourceRef: { type: "email" as const, id: "gm-v2-out" } };
    await expect(appendCaseEvent({ ...outbound, occurredAt: later })).rejects.toThrow("SAV_CASE_DIRECTION_INVALID");
    await expect(appendCaseEvent({ ...outbound, direction: "human_outbound" })).rejects.toThrow("SAV_CASE_OCCURRED_AT_REQUIRED");
    await expect(appendCaseEvent({ ...outbound, direction: "customer_inbound", occurredAt: later })).rejects.toThrow("SAV_CASE_DIRECTION_INVALID");
    await expect(appendCaseEvent({ ...outbound, direction: "human_outbound", occurredAt: "hier" })).rejects.toThrow("SAV_CASE_OCCURRED_AT_INVALID");
    const timer = { caseId: c.caseId, kind: "timer_fired" as const, dedupeKey: caseDedupeKey.timer("j2-dir"), sourceRef: { type: "timer" as const, id: "j2-dir" } };
    await expect(appendCaseEvent({ ...timer, direction: "agent_outbound" })).rejects.toThrow("SAV_CASE_DIRECTION_INVALID");
    expect(await appendCaseEvent({ ...outbound, direction: "human_outbound", occurredAt: later })).toEqual({ appended: true, version: c.version + 1 });
    expect(await appendCaseEvent({ ...outbound, direction: "agent_outbound", occurredAt: at })).toEqual({ appended: false, version: c.version + 1 });
    await appendCaseEvent(timer);
    const events = await listCaseEvents(c.caseId);
    expect(events.map(e => [e.kind, e.direction])).toEqual([["inbound_confirmed", "customer_inbound"], ["admission_decided", "internal"], ["outbound_observed", "human_outbound"], ["timer_fired", "internal"]]);
    expect([events[0]!.occurredAt, events[2]!.occurredAt]).toEqual([RECEIVED, later]);
    expect(Math.abs(Date.parse(events[3]!.occurredAt) - Date.now())).toBeLessThan(60_000);
  });
  it("keeps kind and direction consistent at the database", async () => {
    const { case: c } = await inbound(ticket(), "gm-v2-sql");
    const insert = (kind: string, direction: string) => rows("INSERT INTO sav.case_events(case_id,kind,dedupe_key,case_version,direction,occurred_at,payload_ciphertext) VALUES ($1,$2,$3,99,$4,now(),'x')",
      [c.caseId, kind, `${kind}:sql-${direction}`, direction]);
    for (const [kind, direction] of [["inbound_confirmed", "internal"], ["outbound_observed", "customer_inbound"], ["timer_fired", "human_outbound"], ["owner_changed", "nobody"]])
      await expect(insert(kind!, direction!)).rejects.toThrow();
  });
});

describe("admission policy (SAV-44), pure", () => {
  const decide = (input: CaseAdmissionInput, caseSensitivity: CaseSensitivity = "none") => decideCaseAdmission({ ...input, caseSensitivity });
  const q = (requests: Requests, patch?: Partial<CaseAdmissionQualification>) => qualified(requests, patch);
  const access = { requestId: "r1", family: "access" as const, provenance: byHuman };
  const table: Array<[string, CaseAdmissionInput, CaseSensitivity, string, string[]]> = [
    ["case already finance", ADMITTED, "finance", "team", ["case_sensitive"]],
    ["finance hint only", sensitive("finance"), "none", "team", ["sensitive_family"]],
    ["support + finance", { policy: POLICY, qualification: q([access, { requestId: "r2", family: "finance", provenance: hint() }]) }, "none", "team", ["sensitive_family", "mixed_sensitive"]],
    ["subscription", { policy: POLICY, qualification: q([{ ...access, family: "subscription" }]) }, "none", "team", ["sensitive_family"]],
    ["confirmed bug", { policy: POLICY, qualification: q([access], { teamSignals: [{ kind: "confirmed_bug", source: { type: "hubspot_note", id: "n1" } }] }) }, "none", "team", ["confirmed_bug"]],
    ["out of capability", { policy: POLICY, qualification: q([access], { teamSignals: [{ kind: "out_of_capability", source: { type: "hubspot_note", id: "n2" } }] }) }, "none", "team", ["out_of_capability"]],
    ["no policy", { ...ADMITTED, policy: null }, "none", "qualification", ["policy_missing"]],
    ["policy listing a non admissible family", { ...ADMITTED, policy: { ...POLICY, admittedFamilies: ["technical"] } }, "none", "qualification", ["policy_invalid"]],
    ["free boolean instead of a policy", { ...ADMITTED, policy: { admitted: true } }, "none", "qualification", ["policy_invalid"]],
    ["no request", { policy: POLICY, qualification: q([]) }, "none", "qualification", ["no_request"]],
    ["unknown family", { policy: POLICY, qualification: q([{ ...access, family: "unknown" }]) }, "none", "qualification", ["family_unknown"]],
    ["ambiguous identity", { policy: POLICY, qualification: q([access], { identity: { status: "ambiguous" } }) }, "none", "qualification", ["identity_unconfirmed"]],
    ["CRM read incomplete", { policy: POLICY, qualification: q([access], { crmContext: "incomplete" }) }, "none", "qualification", ["context_incomplete"]],
    ["technical family", { policy: POLICY, qualification: q([{ ...access, family: "technical" }]) }, "none", "qualification", ["family_not_admitted"]],
    ["usage not listed by this policy", { policy: { ...POLICY, admittedFamilies: ["access"] }, qualification: q([{ ...access, family: "usage" }]) }, "none", "qualification", ["family_not_admitted"]],
    ["access from a model hint", { policy: POLICY, qualification: q([{ ...access, provenance: hint() }]) }, "none", "qualification", ["qualification_unproven"]],
    ["rule not listed", { policy: POLICY, qualification: q([{ ...access, provenance: { kind: "qualified_rule", ruleId: "rule-x", revision: "r1", at: AT } }]) }, "none", "qualification", ["qualification_unproven"]],
    ["listed rule outside its families", { policy: POLICY, qualification: q([{ ...access, family: "usage", provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }]) }, "none", "qualification", ["qualification_unproven"]],
    ["listed rule", { policy: POLICY, qualification: q([{ ...access, provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }]) }, "none", "agent", ["admitted"]],
    ["human qualification", ADMITTED, "none", "agent", ["admitted"]],
    ["everything unknown", { policy: null, qualification: q([{ ...access, family: "unknown", provenance: hint() }], { identity: { status: "unknown" }, crmContext: "unknown" }) }, "none", "qualification",
      ["policy_missing", "family_unknown", "identity_unconfirmed", "context_incomplete"]],
  ];
  it.each(table)("%s", (_name, input, caseSensitivity, target, reasons) => {
    const decision = decide(input, caseSensitivity);
    expect(decision).toMatchObject({ target, reasons, nextStep: target === "agent" ? "none" : target === "team" ? "team_takeover" : "qualify" });
  });
  it("covers every reason and keeps exclusions first", () => {
    const seen = new Set(table.flatMap(([, input, sensitivity]) => decide(input, sensitivity).reasons));
    expect([...seen].sort()).toEqual([...SAV_CASE_ADMISSION_REASONS].sort());
    const all = decide({ policy: null, qualification: q([{ ...access, family: "unknown" }, { requestId: "r2", family: "cancellation", provenance: hint() }], { crmContext: "unknown" }) });
    expect(all).toMatchObject({ target: "team", sensitivity: "cancellation", reasons: ["sensitive_family", "mixed_sensitive", "policy_missing", "family_unknown", "context_incomplete"] });
  });
  it("throws on a malformed qualification instead of defaulting", () => {
    expect(() => decide({ policy: POLICY, qualification: q([access], { identity: { status: "confirmed" } }) })).toThrow("SAV_CASE_ADMISSION_INPUT_INVALID");
    expect(() => decide({ policy: POLICY, qualification: { requests: [access] } as never })).toThrow("SAV_CASE_ADMISSION_INPUT_INVALID");
  });
  it("reports freshness: owner agent alone is never enough", () => {
    const record = { ...decide(ADMITTED), decidedAt: AT, version: 3, inputVersion: 2, qualification: ADMITTED.qualification };
    const snapshot = { owner: "agent" as const, admission: record, admissionInputVersion: 2 };
    expect(caseAdmissionStatus(snapshot, "policy-r1")).toEqual({ admitted: true });
    expect(caseAdmissionStatus({ ...snapshot, owner: "human" }, "policy-r1")).toEqual({ admitted: false, reason: "owner_not_agent" });
    expect(caseAdmissionStatus({ ...snapshot, admission: null }, "policy-r1")).toEqual({ admitted: false, reason: "no_admission" });
    expect(caseAdmissionStatus({ ...snapshot, admission: { ...record, target: "qualification" } }, "policy-r1")).toEqual({ admitted: false, reason: "not_admitted" });
    expect(caseAdmissionStatus({ ...snapshot, admissionInputVersion: 4 }, "policy-r1")).toEqual({ admitted: false, reason: "input_newer" });
    expect(caseAdmissionStatus(snapshot, null)).toEqual({ admitted: false, reason: "policy_missing" });
    expect(caseAdmissionStatus(snapshot, "policy-r2")).toEqual({ admitted: false, reason: "policy_changed" });
  });
});

describe("admission on the case record (SAV-44)", () => {
  const commandBase = (caseId: string, expectedVersion: number) => ({ caseId, expectedVersion, actor: staff, reason: "fixture" });
  it("never gives the agent a case without a positive admission, in code and in the database", async () => {
    const { case: c } = await inbound(ticket(), "gm-adm-none", UNQUALIFIED);
    expect(c).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "policy_missing" } },
      admission: { target: "qualification", reasons: ["policy_missing", "family_unknown"], nextStep: "qualify", policyRevision: null } });
    expect(caseAdmissionStatus(c, null)).toEqual({ admitted: false, reason: "owner_not_agent" });
    expect(await readCaseDiagnostics(c.ticketId)).toMatchObject({ owner: "human", admission: { target: "qualification", reason: "policy_missing" } });
    await expect(rows("UPDATE sav.cases SET owner='agent', phase='queued' WHERE id=$1", [c.caseId])).rejects.toThrow("sav_cases_agent_admitted");
    await expect(rows("INSERT INTO sav.cases(ticket_id,owner,phase,contract_revision,payload_ciphertext) VALUES ($1,'agent','queued','x','x')", [ticket()])).rejects.toThrow("sav_cases_agent_admitted");
    await expect(rows("INSERT INTO sav.cases(ticket_id,owner,phase,contract_revision,payload_ciphertext,admission_target) VALUES ($1,'agent','queued','x','x','team')", [ticket()])).rejects.toThrow("sav_cases_agent_admitted");
    await expect(rows("UPDATE sav.cases SET sensitivity='finance' WHERE id=$1", [(await inbound(ticket(), "gm-adm-ok")).case.caseId])).rejects.toThrow();
  });
  it("keeps a mixed support + finance mail entirely with the team", async () => {
    const mixed = { policy: POLICY, qualification: qualified([{ requestId: "r1", family: "access", provenance: byHuman }, { requestId: "r2", family: "finance", provenance: hint() }]) };
    const { case: c } = await inbound(ticket(), "gm-adm-mixed", mixed);
    expect(c).toMatchObject({ owner: "human", phase: "handoff_pending", sensitivity: "finance", admission: { target: "team", reasons: ["sensitive_family", "mixed_sensitive"] } });
  });
  it("makes a late inbound invalidate a prepared decision, and a non-inbound input stale until re-evaluated", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-late-1");
    const second = await inbound(ticketId, "gm-late-2");
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, phase: "acting" })).rejects.toThrow("SAV_CASE_VERSION_STALE");
    expect(caseAdmissionStatus(second.case, "policy-r1")).toEqual({ admitted: true });
    const crm = await appendCaseEvent({ caseId: c.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("t1", "2026-10-27T10:00:00Z"), sourceRef: { type: "hubspot_object", id: "t1" } });
    expect(caseAdmissionStatus((await readCase(c.caseId))!, "policy-r1")).toEqual({ admitted: false, reason: "input_newer" });
    const ref = { type: "hubspot_object" as const, id: "t1" };
    await expect(reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: second.case.version, admission: ADMITTED, sourceRef: ref })).rejects.toThrow("SAV_CASE_VERSION_STALE");
    const fresh = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: crm.version, admission: ADMITTED, sourceRef: ref });
    expect(caseAdmissionStatus(fresh, "policy-r1")).toEqual({ admitted: true });
  });
  it("treats a changed or removed policy as stale and withdraws the case when the new policy refuses it", async () => {
    const { case: c } = await inbound(ticket(), "gm-policy");
    expect(caseAdmissionStatus(c, "policy-r2")).toEqual({ admitted: false, reason: "policy_changed" });
    expect(caseAdmissionStatus(c, null)).toEqual({ admitted: false, reason: "policy_missing" });
    const narrowed = { ...POLICY, revision: "policy-r2", admittedFamilies: ["usage"] };
    const after = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: c.version, admission: { ...ADMITTED, policy: narrowed }, sourceRef: { type: "studio_command", id: "policy-r2" } });
    expect(after).toMatchObject({ owner: "human", phase: "handoff_pending", version: c.version + 2, admission: { target: "qualification", reasons: ["family_not_admitted"], policyRevision: "policy-r2" } });
    // A wider policy later does not hand the case back by itself: the human keeps it.
    const widened = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: after.version, admission: { ...ADMITTED, policy: { ...POLICY, revision: "policy-r3" } }, sourceRef: { type: "studio_command", id: "policy-r3" } });
    expect(widened).toMatchObject({ owner: "human", admission: { target: "agent", policyRevision: "policy-r3" } });
    expect(caseAdmissionStatus(widened, "policy-r3")).toEqual({ admitted: false, reason: "owner_not_agent" });
  });
  it("keeps a human owner on a new inbound, whatever the admission says", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-h-1");
    const taken = await transitionCaseOwner({ ...commandBase(c.caseId, c.version), transition: "human_takeover", commandKey: "h-take" });
    const next = await inbound(ticketId, "gm-h-2");
    expect(next.case).toMatchObject({ owner: "human", phase: "human_owned", version: taken.case.version + 2, admission: { target: "agent" } });
    expect(caseAdmissionStatus(next.case, "policy-r1")).toEqual({ admitted: false, reason: "owner_not_agent" });
    expect((await inbound(ticketId, "gm-h-3", UNQUALIFIED)).case).toMatchObject({ owner: "human", phase: "human_owned" });
  });
  it("re-validates hand_back and hold_release under the same lock, with no override", async () => {
    const { case: c } = await inbound(ticket(), "gm-back");
    const handed = await transitionCaseOwner({ ...commandBase(c.caseId, c.version), transition: "handoff", actor: { type: "agent" }, commandKey: "b-handoff" });
    const v = handed.case.version, before = await keys(c.caseId);
    await expect(transitionCaseOwner({ ...commandBase(c.caseId, v), transition: "hand_back", commandKey: "b-none" })).rejects.toThrow("SAV_CASE_ADMISSION_REQUIRED");
    await expect(transitionCaseOwner({ ...commandBase(c.caseId, v), transition: "hand_back", commandKey: "b-unq", admission: UNQUALIFIED })).rejects.toThrow("SAV_CASE_ADMISSION_REFUSED");
    await expect(transitionCaseOwner({ ...commandBase(c.caseId, v), transition: "hand_back", commandKey: "b-mixed", admission: sensitive("finance") })).rejects.toThrow("SAV_CASE_ADMISSION_REFUSED");
    expect(await keys(c.caseId)).toEqual(before);
    expect((await readCase(c.caseId))!).toMatchObject({ version: v, owner: "human" });
    const held = await transitionCaseOwner({ ...commandBase(c.caseId, v), transition: "organisational_hold", commandKey: "b-hold" });
    await expect(transitionCaseOwner({ ...commandBase(c.caseId, held.case.version), transition: "hold_release", to: "agent", commandKey: "b-rel-unq", admission: UNQUALIFIED }))
      .rejects.toThrow("SAV_CASE_ADMISSION_REFUSED");
    const released = await transitionCaseOwner({ ...commandBase(c.caseId, held.case.version), transition: "hold_release", to: "agent", commandKey: "b-rel", admission: ADMITTED });
    expect(released.case).toMatchObject({ owner: "agent", phase: "queued", version: held.case.version + 2 });
    expect(caseAdmissionStatus(released.case, "policy-r1")).toEqual({ admitted: true });
  });
  it("applies a doubled or concurrent hand_back command once", async () => {
    const { case: c } = await inbound(ticket(), "gm-dup");
    const handed = await transitionCaseOwner({ ...commandBase(c.caseId, c.version), transition: "handoff", actor: { type: "agent" }, commandKey: "d-handoff" });
    const back = () => transitionCaseOwner({ ...commandBase(c.caseId, handed.case.version), transition: "hand_back", commandKey: "d-back", admission: ADMITTED });
    const results = await Promise.all([back(), back()]);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(await back()).toMatchObject({ replayed: true, case: { version: handed.case.version + 2 } });
    expect((await keys(c.caseId)).filter(key => key === "cmd:d-back")).toHaveLength(1);
    await expect(transitionCaseOwner({ ...commandBase(c.caseId, handed.case.version), transition: "handoff", actor: { type: "agent" }, commandKey: "d-other" }))
      .rejects.toThrow("SAV_CASE_VERSION_STALE");
  });
  it("makes no HubSpot or network call on any admission path", async () => {
    const fetchSpy = vi.fn(() => { throw Error("NETWORK_NOT_ALLOWED"); });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-net-1");
      await inbound(ticketId, "gm-net-2", "finance");
      const { case: u } = await inbound(ticket(), "gm-net-3", UNQUALIFIED);
      const held = await transitionCaseOwner({ ...commandBase(u.caseId, u.version), transition: "human_takeover", commandKey: "n-take" });
      await reevaluateCaseAdmission({ caseId: u.caseId, expectedVersion: held.case.version, admission: ADMITTED, sourceRef: { type: "studio_command", id: "n" } });
      expect((await readCase(c.caseId))!.owner).toBe("human");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

const setV2Pause = async (level: "running" | "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};
const claim = (caseId: string, expectedVersion: number, extra: Partial<Parameters<typeof claimCaseForDecision>[0]> = {}) =>
  claimCaseForDecision({ caseId, expectedVersion, holder: "sav7-runner", currentPolicyRevision: "policy-r1", ttlSeconds: 120, settleSeconds: 0, ...extra });

describe("decision claim and observation record (SAV-6/7, contract v4)", () => {
  afterEach(() => setV2Pause(null));
  it("refuses a claim before any model call for finance, a human owner, a missing or stale admission, and a status change alone", async () => {
    const { case: fin } = await inbound(ticket(), "gm-cl-fin", "finance");
    expect(await claim(fin.caseId, fin.version)).toMatchObject({ claimed: false, reason: "owner_not_agent" });
    const { case: unq } = await inbound(ticket(), "gm-cl-unq", UNQUALIFIED);
    expect(await claim(unq.caseId, unq.version)).toMatchObject({ claimed: false, reason: "owner_not_agent" });
    const { case: ok } = await inbound(ticket(), "gm-cl-ok");
    expect(await claim(ok.caseId, ok.version, { currentPolicyRevision: "policy-r2" })).toMatchObject({ claimed: false, reason: "policy_changed" });
    expect(await claim(ok.caseId, ok.version, { currentPolicyRevision: null })).toMatchObject({ claimed: false, reason: "policy_missing" });
    // HubSpot moving the ticket back to "Nouveau" is an input, never a permission: it makes the admission stale.
    const stage = await appendCaseEvent({ caseId: ok.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("t-new", "2026-10-27T11:00:00Z"), sourceRef: { type: "hubspot_object", id: "t-new" }, detail: { stage: "new" } });
    expect(await claim(ok.caseId, stage.version)).toMatchObject({ claimed: false, reason: "input_newer" });
    await expect(claim(ok.caseId, ok.version)).rejects.toThrow("SAV_CASE_VERSION_STALE");
    expect(await rows("SELECT count(*)::int AS n FROM sav.cases WHERE claim_token IS NOT NULL AND id = ANY($1::uuid[])", [[fin.caseId, unq.caseId, ok.caseId]])).toEqual([{ n: 0 }]);
  });
  it("holds one live claim per case, changes no version, and lets an expired claim be replaced", async () => {
    const { case: c } = await inbound(ticket(), "gm-cl-one");
    const first = await claim(c.caseId, c.version, { now: new Date(AT) });
    expect(first).toMatchObject({ claimed: true, actionsPaused: false, case: { version: c.version }, claim: { version: c.version, holder: "sav7-runner" } });
    expect(await claim(c.caseId, c.version, { now: new Date("2026-10-27T09:01:00.000Z") })).toMatchObject({ claimed: false, reason: "claimed_elsewhere" });
    if (!first.claimed) throw new Error("fixture failed to claim");
    await expect(recordCaseObservation({ caseId: c.caseId, claimToken: first.claim.token, currentPolicyRevision: "policy-r1",
      requireLiveClaimAt: () => new Date(first.claim.until), observation: { record: { outcome: "handoff" } } })).rejects.toThrow("SAV_CASE_CLAIM_LOST");
    const second = await claim(c.caseId, c.version, { now: new Date("2026-10-27T09:03:00.000Z") });
    expect(second).toMatchObject({ claimed: true });
    const old = (first as { claim: { token: string } }).claim.token, current = (second as { claim: { token: string } }).claim.token;
    await expect(recordCaseObservation({ caseId: c.caseId, claimToken: old, currentPolicyRevision: "policy-r1", observation: { record: { outcome: "late" } } })).rejects.toThrow("SAV_CASE_CLAIM_LOST");
    expect(await releaseCaseClaim({ caseId: c.caseId, claimToken: old })).toBe(false);
    expect(await releaseCaseClaim({ caseId: c.caseId, claimToken: current })).toBe(true);
    expect((await readCase(c.caseId))!.version).toBe(c.version);
    expect(await readCaseDiagnostics(c.ticketId)).toMatchObject({ claim: null });
  });
  it("keeps the work and the new message when a customer writes during the analysis, and applies neither stale decision", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-cl-race-1");
    const taken = await claim(c.caseId, c.version) as { claim: { token: string } };
    await inbound(ticketId, "gm-cl-race-2");
    const question = { id: "q1", text: "Question fictive", factKeys: [], askedAt: AT, askedInEffect: "effect-q1" };
    const result = await recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1",
      observation: { record: { decision: "ask", readings: ["lecture fictive"] }, body: { ...c.body, questions: [question] }, phase: "awaiting_customer" } });
    expect(result).toMatchObject({ replayed: false, applied: false, reason: "version_moved", case: { phase: "queued", body: { questions: [] } } });
    const events = await listCaseEvents(c.caseId);
    expect(events.map(e => e.dedupeKey)).toContain("inbound:gm-cl-race-2");
    expect(events.find(e => e.kind === "observation_recorded")?.detail).toMatchObject({ applied: false, reason: "version_moved", claimVersion: c.version, record: { readings: ["lecture fictive"] } });
    expect(await recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1", observation: { record: {} } }))
      .toMatchObject({ replayed: true, applied: false, reason: "version_moved" });
    expect(await rows("SELECT claim_token FROM sav.cases WHERE id=$1", [c.caseId])).toEqual([{ claim_token: null }]);
  });
  it("applies a fresh observation in one write and keeps its record encrypted", async () => {
    const { case: c } = await inbound(ticket(), "gm-cl-apply");
    const taken = await claim(c.caseId, c.version) as { claim: { token: string } };
    const fact = { id: "f1", text: "Constat fictif", source: { type: "email" as const, id: "gm-cl-apply" }, at: AT, kind: "customer_statement" as const, key: null };
    const result = await recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1",
      observation: { record: { secretMarker: "lecture-confidentielle-fictive" }, body: { ...c.body, facts: [fact] }, phase: "acting" } });
    expect(result).toMatchObject({ applied: true, reason: null, case: { phase: "acting", version: c.version + 1, body: { facts: [{ id: "f1" }] } } });
    const dump = JSON.stringify(await rows("SELECT * FROM sav.case_events WHERE case_id=$1", [c.caseId]));
    expect(dump).not.toContain("lecture-confidentielle-fictive");
    await expect(recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1",
      observation: { record: {}, extra: true } as never })).rejects.toThrow("SAV_CASE_OBSERVATION_INVALID");
  });
  it("does not apply an observation once the admission is lost, and withdrawal clears the claim", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-cl-lost");
    const taken = await claim(c.caseId, c.version) as { claim: { token: string } };
    const policyMoved = await recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r2", observation: { record: { decision: "answer" } } });
    expect(policyMoved).toMatchObject({ applied: false, reason: "admission_lost" });
    const again = await claim(c.caseId, policyMoved.case.version);
    expect(again).toMatchObject({ claimed: true });
    const refund = await inbound(ticketId, "gm-cl-lost-refund", "finance");
    expect(refund.case).toMatchObject({ owner: "human", sensitivity: "finance" });
    expect(await rows("SELECT claim_token, claim_version FROM sav.cases WHERE id=$1", [c.caseId])).toEqual([{ claim_token: null, claim_version: null }]);
    await expect(rows("UPDATE sav.cases SET claim_token=gen_random_uuid(), claim_version=1, claim_holder='x', claim_until=now() WHERE id=$1", [c.caseId])).rejects.toThrow("sav_cases_claim_agent_only");
  });
  it("follows the V2 agent pause: no claim when fully paused, observe-only flag when actions are paused", async () => {
    const { case: c } = await inbound(ticket(), "gm-cl-pause");
    await setV2Pause("fully_paused");
    expect(await claim(c.caseId, c.version)).toMatchObject({ claimed: false, reason: "agent_paused" });
    await setV2Pause("actions_paused");
    expect(await claim(c.caseId, c.version)).toMatchObject({ claimed: true, actionsPaused: true });
  });
});

describe("J2 timers kept through a technical pause (SAV-8, contract v4)", () => {
  afterEach(() => setV2Pause(null));
  const SENT = "2026-10-28T08:00:00.000Z", DUE = "2026-10-29T09:00:00.000Z";
  async function asked(gmail: string, effect = "effect-j2") {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, gmail);
    const question = { id: `q-${effect}`, text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: effect };
    const withQuestion = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [...c.body.questions, question] } });
    return { ticketId, c: withQuestion };
  }
  const schedule = (caseId: string, expectedVersion: number, id = randomUUID(), effect = "effect-j2") =>
    scheduleCaseTimer({ caseId, expectedVersion, currentPolicyRevision: "policy-r1", reasonCode: "j2_question", timer: { id, questionEffectId: effect, sentAt: SENT, dueAt: DUE } });

  it("schedules once with the case waiting on it, never revives a key, and has no pause cancel reason", async () => {
    const { c } = await asked("gm-j2-sched");
    const id = randomUUID(), first = await schedule(c.caseId, c.version, id);
    expect(first).toMatchObject({ scheduled: true, timer: { id, state: "scheduled", dueAt: DUE, key: `timer:j2:${c.caseId}:effect-j2` },
      case: { phase: "awaiting_customer", version: c.version + 1, body: { waiting: { kind: "customer", timerId: id, dueAt: DUE } } } });
    expect(await schedule(c.caseId, c.version, randomUUID())).toMatchObject({ scheduled: false, reason: "already_exists", existing: { id } });
    expect(await schedule(c.caseId, c.version + 1, randomUUID(), "effect-unknown")).toMatchObject({ scheduled: false, reason: "question_unknown" });
    await expect(rows("UPDATE sav.case_timers SET state='cancelled', cancel_reason='pause', cancelled_at=now() WHERE id=$1", [id])).rejects.toThrow();
    // The due date of a scheduled timer is fixed at creation: nobody postpones it in place.
    await expect(rows("UPDATE sav.case_timers SET due_at = due_at + interval '1 day' WHERE id=$1", [id])).rejects.toThrow("SAV_CASE_TIMER_IMMUTABLE");
  });
  it("keeps question, timer and due date through a technical pause, then fires once", async () => {
    const { c } = await asked("gm-j2-pause");
    const id = randomUUID();
    await schedule(c.caseId, c.version, id);
    await setV2Pause("fully_paused");
    expect(await readCaseDiagnostics(c.ticketId)).toMatchObject({ followUp: { state: "scheduled", dueAt: DUE, cancelReason: null, suspendedByPause: true } });
    await setV2Pause("running");
    const kept = await listCaseTimers(c.caseId);
    expect(kept).toMatchObject([{ id, state: "scheduled", dueAt: DUE, sentAt: SENT }]);
    expect((await readCase(c.caseId))!.body.questions.map(q => q.askedInEffect)).toEqual(["effect-j2"]);
    expect(await fireCaseTimer({ timerId: id, now: new Date("2026-10-29T08:59:59.000Z") })).toMatchObject({ fired: false, timer: { state: "scheduled" } });
    const fired = await fireCaseTimer({ timerId: id, now: new Date("2026-10-29T10:00:00.000Z") });
    expect(fired).toMatchObject({ fired: true, timer: { state: "fired", firedAt: "2026-10-29T10:00:00.000Z", dueAt: DUE } });
    expect(await fireCaseTimer({ timerId: id, now: new Date("2026-10-29T11:00:00.000Z") })).toMatchObject({ fired: false });
    expect((await listCaseEvents(c.caseId)).filter(e => e.kind === "timer_fired").map(e => [e.dedupeKey, e.sourceRef])).toEqual([[`timer:${id}`, { type: "timer", id }]]);
    await expect(rows("UPDATE sav.case_timers SET due_at = due_at + interval '1 day' WHERE id=$1", [id])).rejects.toThrow("SAV_CASE_TIMER_IMMUTABLE");
    await expect(rows("DELETE FROM sav.case_timers WHERE id=$1", [id])).rejects.toThrow("SAV_CASE_TIMER_IMMUTABLE");
  });
  it("cancels in the same transaction as a customer reply, so a due timer that crosses it fires nothing", async () => {
    const { ticketId, c } = await asked("gm-j2-reply");
    const id = randomUUID();
    await schedule(c.caseId, c.version, id);
    await inbound(ticketId, "gm-j2-reply-answer");
    expect(await listCaseTimers(c.caseId)).toMatchObject([{ id, state: "cancelled", cancelReason: "customer_inbound" }]);
    expect(await fireCaseTimer({ timerId: id, now: new Date("2026-10-30T10:00:00.000Z") })).toMatchObject({ fired: false, timer: { state: "cancelled" } });
    expect((await listCaseEvents(c.caseId)).some(e => e.kind === "timer_fired")).toBe(false);
  });
  it("cancels on a human takeover and never revives it when the case is handed back", async () => {
    const { c } = await asked("gm-j2-human");
    const id = randomUUID(), scheduled = await schedule(c.caseId, c.version, id) as { case: { version: number } };
    const taken = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: scheduled.case.version, transition: "human_takeover", actor: staff, commandKey: "j2-take", reason: "fixture" });
    expect(await listCaseTimers(c.caseId)).toMatchObject([{ state: "cancelled", cancelReason: "owner_changed" }]);
    const back = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: taken.case.version, transition: "hand_back", actor: staff, commandKey: "j2-back", reason: "fixture", admission: ADMITTED });
    expect(await schedule(c.caseId, back.case.version, randomUUID())).toMatchObject({ scheduled: false, reason: "already_exists", existing: { id, state: "cancelled" } });
    expect(await fireCaseTimer({ timerId: id, now: new Date("2026-10-30T10:00:00.000Z") })).toMatchObject({ fired: false });
  });
  it("creates no timer when the customer wrote after the question, and a newer question replaces the older timer", async () => {
    const { ticketId, c } = await asked("gm-j2-cross");
    const late = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-j2-cross-2"),
      sourceRef: { type: "email", id: "gm-j2-cross-2" }, occurredAt: "2026-10-28T08:30:00.000Z" });
    expect(await schedule(c.caseId, late.case.version)).toMatchObject({ scheduled: false, reason: "inbound_after_question" });
    const { c: d } = await asked("gm-j2-new", "effect-a");
    const a = randomUUID(), first = await schedule(d.caseId, d.version, a, "effect-a") as { case: { version: number; body: typeof d.body } };
    const second = { id: "q-b", text: "Autre question fictive", factKeys: [], askedAt: SENT, askedInEffect: "effect-b" };
    const updated = await updateCaseRecord({ caseId: d.caseId, expectedVersion: first.case.version, actor: { type: "agent" }, body: { ...first.case.body, questions: [...first.case.body.questions, second] } });
    const b = randomUUID();
    expect(await schedule(d.caseId, updated.version, b, "effect-b")).toMatchObject({ scheduled: true });
    expect((await listCaseTimers(d.caseId)).map(t => [t.id, t.state, t.cancelReason])).toEqual([[a, "cancelled", "new_question"], [b, "scheduled", null]]);
  });
  it("records an admission withdrawal as the cancel reason when a refund request arrives", async () => {
    const { ticketId, c } = await asked("gm-j2-refund");
    await schedule(c.caseId, c.version);
    await inbound(ticketId, "gm-j2-refund-2", "finance");
    // The customer message cancels first; the withdrawal finds nothing left to cancel.
    expect((await listCaseTimers(c.caseId)).map(t => t.cancelReason)).toEqual(["customer_inbound"]);
    const { c: d } = await asked("gm-j2-policy");
    const scheduled = await schedule(d.caseId, d.version) as { case: { version: number } };
    await reevaluateCaseAdmission({ caseId: d.caseId, expectedVersion: scheduled.case.version, admission: { ...ADMITTED, policy: { ...POLICY, revision: "policy-r2", admittedFamilies: ["usage"] } }, sourceRef: { type: "studio_command", id: "policy-r2" } });
    expect((await listCaseTimers(d.caseId)).map(t => t.cancelReason)).toEqual(["admission_withdrawn"]);
  });
});

describe("anticipated reading risks (contract v5)", () => {
  const fact = (id: string, patch: Partial<CaseFact> = {}): CaseFact => ({ id, text: `Fait fictif ${id}`, source: { type: "email", id: `gm-${id}` }, at: AT, key: "app_version", kind: "customer_statement", ...patch });
  it("corrects a fact by replacing it, never by editing or deleting it, whoever writes", async () => {
    const { case: c } = await inbound(ticket(), "gm-facts");
    const agent = { type: "agent" as const };
    const v1 = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: agent, body: { ...c.body, facts: [fact("f1")] } });
    const later = "2026-10-27T10:00:00.000Z";
    const v2 = await updateCaseRecord({ caseId: c.caseId, expectedVersion: v1.version, actor: agent, body: { ...v1.body, facts: [...v1.body.facts, fact("f2", { at: later, replaces: "f1" })] } });
    expect(currentCaseFacts(v2.body).map(f => f.id)).toEqual(["f2"]);
    expect(v2.body.facts.map(f => f.id)).toEqual(["f1", "f2"]);
    for (const actor of [agent, staff]) {
      await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: v2.version, actor, body: { ...v2.body, facts: [v2.body.facts[0]!] } })).rejects.toThrow("SAV_CASE_FACT_IMMUTABLE");
      await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: v2.version, actor, body: { ...v2.body, facts: [{ ...v2.body.facts[0]!, text: "Réécrit" }, v2.body.facts[1]!] } })).rejects.toThrow("SAV_CASE_FACT_IMMUTABLE");
    }
  });
  it("rejects a replacement that is unknown, doubled, of another key, weaker, older or circular", async () => {
    const { case: c } = await inbound(ticket(), "gm-facts-bad");
    const write = (facts: CaseFact[]) => updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, facts } });
    const later = "2026-10-27T10:00:00.000Z";
    for (const facts of [
      [fact("a", { replaces: "missing" })],
      [fact("a", { replaces: "a" })],
      [fact("a"), fact("b", { at: later, replaces: "a" }), fact("c", { at: later, replaces: "a" })],
      [fact("a"), fact("b", { at: later, key: "browser", replaces: "a" })],
      [fact("a", { kind: "observed" }), fact("b", { at: later, replaces: "a" })],
      [fact("a", { at: later }), fact("b", { replaces: "a" })],
      [fact("a", { replaces: "b" }), fact("b", { replaces: "a" })],
      [fact("a"), fact("a")],
    ]) await expect(write(facts)).rejects.toThrow("SAV_CASE_BODY_INVALID");
    // An observation may replace a customer statement.
    expect((await write([fact("a"), fact("b", { at: later, kind: "observed", replaces: "a" })])).body.facts).toHaveLength(2);
  });
  it("names a full list as its own error, so the case is handed over instead of retried", async () => {
    const { case: c } = await inbound(ticket(), "gm-facts-full");
    const many = Array.from({ length: 501 }, (_, i) => fact(`f${i}`, { key: null }));
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, facts: many } })).rejects.toThrow("SAV_CASE_BODY_LIMIT_REACHED");
  });
  it("reads an older revision through its declared upgrade, rewrites it once under the lock, and refuses an undeclared one visibly", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-upgrade");
    await rows("UPDATE sav.cases SET contract_revision='sav-case-2026-10-27.v4' WHERE id=$1", [c.caseId]);
    expect(await readCase(c.caseId)).toMatchObject({ contractRevision: "sav-case-2026-10-27.v10", version: c.version });
    expect(await readCaseDiagnostics(ticketId)).toMatchObject({ contractRevision: "sav-case-2026-10-27.v4", contractSupported: true });
    const appended = await appendCaseEvent({ caseId: c.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("t-up", "2026-10-27T12:00:00Z"), sourceRef: { type: "hubspot_object", id: "t-up" } });
    expect(appended.version).toBe(c.version + 1);
    expect(await rows("SELECT contract_revision FROM sav.cases WHERE id=$1", [c.caseId])).toEqual([{ contract_revision: "sav-case-2026-10-27.v10" }]);
    // v9 changed no body field and v10 only adds an optional subject: v8 and v9 rows read unchanged.
    for (const older of ["sav-case-2026-10-27.v8", "sav-case-2026-10-27.v9"]) {
      await rows("UPDATE sav.cases SET contract_revision=$2 WHERE id=$1", [c.caseId, older]);
      expect(await readCase(c.caseId)).toMatchObject({ contractRevision: "sav-case-2026-10-27.v10", version: c.version + 1 });
    }
    await rows("UPDATE sav.cases SET contract_revision='sav-case-2026-10-27.v2' WHERE id=$1", [c.caseId]);
    await expect(readCase(c.caseId)).rejects.toThrow("SAV_CASE_CONTRACT_UNSUPPORTED");
    expect(await readCaseDiagnostics(ticketId)).toMatchObject({ contractRevision: "sav-case-2026-10-27.v2", contractSupported: false, version: c.version + 1 });
    await expect(appendCaseEvent({ caseId: c.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("t-up", "2026-10-27T13:00:00Z"), sourceRef: { type: "hubspot_object", id: "t-up" } })).rejects.toThrow("SAV_CASE_CONTRACT_UNSUPPORTED");
    expect(await rows("SELECT count(*)::int AS n FROM sav.case_events WHERE case_id=$1", [c.caseId])).toEqual([{ n: 3 }]);
  });
  it("reads a long journal by pages after a known version", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-page-1");
    await inbound(ticketId, "gm-page-2");
    expect((await listCaseEvents(c.caseId, { afterVersion: 2, limit: 1 })).map(e => [e.caseVersion, e.dedupeKey])).toEqual([[3, "admission:v3:policy-r1"]]);
    expect((await listCaseEvents(c.caseId, { afterVersion: 3 })).map(e => e.dedupeKey)).toEqual(["inbound:gm-page-2", "admission:v5:policy-r1"]);
    await expect(listCaseEvents(c.caseId, { limit: 501 })).rejects.toThrow("SAV_CASE_PAGE_INVALID");
  });
  it("waits 5 minutes by default for a burst of mails to settle before a claim", async () => {
    const { case: c } = await inbound(ticket(), "gm-settle");
    const byDefault = { settleSeconds: undefined };
    const soon = await claim(c.caseId, c.version, { ...byDefault, now: new Date() });
    expect(soon).toMatchObject({ claimed: false, reason: "inbound_settling", retryAt: expect.any(String) });
    expect(await claim(c.caseId, c.version, { ...byDefault, now: new Date(Date.now() + 290_000) })).toMatchObject({ claimed: false, reason: "inbound_settling" });
    expect(await claim(c.caseId, c.version, { ...byDefault, now: new Date(Date.now() + 301_000) })).toMatchObject({ claimed: true });
    await expect(claim(c.caseId, c.version, { settleSeconds: 3601 })).rejects.toThrow("SAV_CASE_CLAIM_SETTLE_INVALID");
  });
});

describe("contract v6: a CRM note keeps the admission, and races keep one outcome", () => {
  const crm = (caseId: string, at: string, detail?: Record<string, unknown>) =>
    appendCaseEvent({ caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("t-v6", at), sourceRef: { type: "hubspot_object", id: "t-v6" }, ...(detail ? { detail } : {}) });
  it("keeps the admission on a note alone, and makes it stale on any other or untyped CRM change", async () => {
    const { case: c } = await inbound(ticket(), "gm-v6-note");
    const note = await crm(c.caseId, "2026-10-28T09:00:00Z", { crmChange: "note_added" });
    expect(caseAdmissionStatus((await readCase(c.caseId))!, "policy-r1")).toEqual({ admitted: true });
    expect(await claim(c.caseId, note.version)).toMatchObject({ claimed: true });
    expect((await listCaseEvents(c.caseId)).at(-1)).toMatchObject({ kind: "crm_observed", detail: { crmChange: "note_added" } });
    for (const [i, crmChange] of (["status_changed", "owner_changed", "properties_changed", "unknown", undefined] as const).entries()) {
      const { case: other } = await inbound(ticket(), `gm-v6-change-${i}`);
      const moved = await crm(other.caseId, `2026-10-28T10:0${i}:00Z`, crmChange ? { crmChange } : { stage: "new" });
      expect(moved.version).toBe(other.version + 1);
      expect(caseAdmissionStatus((await readCase(other.caseId))!, "policy-r1")).toEqual({ admitted: false, reason: "input_newer" });
      expect((await listCaseEvents(other.caseId)).at(-1)?.detail).toMatchObject({ crmChange: crmChange ?? "unknown" });
    }
    await expect(crm(c.caseId, "2026-10-28T11:00:00Z", { crmChange: "anything" })).rejects.toThrow("SAV_CASE_CRM_CHANGE_INVALID");
  });
  // On PGlite these run serialised; with SAV_TEST_POSTGRES_URL (CI sav-native) they race on a real pool.
  it("gives a live claim to exactly one of several concurrent runners", async () => {
    const { case: c } = await inbound(ticket(), "gm-v6-claims");
    const results = await Promise.all(["runner-a", "runner-b", "runner-c", "runner-d"].map(holder => claim(c.caseId, c.version, { holder })));
    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(results.filter(r => !r.claimed).map(r => (r as { reason: string }).reason)).toEqual(["claimed_elsewhere", "claimed_elsewhere", "claimed_elsewhere"]);
    expect(await rows("SELECT claim_version FROM sav.cases WHERE id=$1", [c.caseId])).toEqual([{ claim_version: c.version }]);
  });
  it("never loses the mail nor the work when a mail and an observation cross", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-v6-cross-1");
    const taken = await claim(c.caseId, c.version) as { claim: { token: string } };
    const question = { id: "q-cross", text: "Question fictive", factKeys: [], askedAt: AT, askedInEffect: "effect-cross" };
    const [observed] = await Promise.all([
      recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1", observation: { record: { decision: "ask" }, body: { ...c.body, questions: [question] } } }),
      inbound(ticketId, "gm-v6-cross-2"),
    ]);
    const events = await listCaseEvents(c.caseId);
    expect(events.filter(e => e.dedupeKey === "inbound:gm-v6-cross-2")).toHaveLength(1);
    expect(events.filter(e => e.kind === "observation_recorded")).toHaveLength(1);
    const final = (await readCase(c.caseId))!;
    // Either order is legal; what is forbidden is an applied decision older than the mail.
    if (observed.applied) expect(events.findIndex(e => e.kind === "observation_recorded")).toBeLessThan(events.findIndex(e => e.dedupeKey === "inbound:gm-v6-cross-2"));
    else expect(final.body.questions).toEqual([]);
  });
  it("ends a due timer crossing a customer reply in exactly one terminal state", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gm-v6-timer");
    const SENT = "2026-10-28T08:00:00.000Z", question = { id: "q-t", text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: "effect-t" };
    const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [question] } });
    const id = randomUUID();
    await scheduleCaseTimer({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question", timer: { id, questionEffectId: "effect-t", sentAt: SENT, dueAt: "2026-10-29T09:00:00.000Z" } });
    const [fired] = await Promise.all([fireCaseTimer({ timerId: id, now: new Date("2026-10-29T10:00:00.000Z") }), inbound(ticketId, "gm-v6-timer-reply")]);
    const [timer] = await listCaseTimers(c.caseId);
    expect(timer!.state).toBe(fired.fired ? "fired" : "cancelled");
    expect((await listCaseEvents(c.caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(fired.fired ? 1 : 0);
  });
});

// ---- Contract v7: Ugo's product decisions of 28/10 (Q6, Q8, Q9, Q10, Q11), on the real store.
import { classifyCaseExit } from "./case-outcomes";
import { caseAttachmentRef } from "./case-types";
describe("contract v7: holds keep the J2, customer content never becomes a finding, exits are classified", () => {
  afterEach(() => setV2Pause(null));
  const SENT = "2026-10-28T08:00:00.000Z", DUE = "2026-10-29T09:00:00.000Z", AFTER_DUE = new Date("2026-10-29T10:00:00.000Z");
  const commandBase = (caseId: string, expectedVersion: number) => ({ caseId, expectedVersion, actor: staff, reason: "fixture" });
  async function waiting(gmail: string) {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, gmail);
    const question = { id: "q-hold", text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: "effect-hold" };
    const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [question] } });
    const id = randomUUID();
    const scheduled = await scheduleCaseTimer({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question",
      timer: { id, questionEffectId: "effect-hold", sentAt: SENT, dueAt: DUE } }) as { case: { version: number } };
    return { ticketId, caseId: c.caseId, timerId: id, version: scheduled.case.version };
  }

  it("Q9: a technical hold keeps the J2 and its due date, fires nothing while held, and resumes only after a fresh admission", async () => {
    const w = await waiting("gm-v7-hold");
    const held = await transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "technical_hold", actor: { type: "system" }, commandKey: "v7-hold" });
    expect(held.case).toMatchObject({ owner: "system_hold", phase: "awaiting_customer" });
    expect(await listCaseTimers(w.caseId)).toMatchObject([{ id: w.timerId, state: "scheduled", dueAt: DUE, cancelReason: null }]);
    expect(await readCaseDiagnostics(w.ticketId)).toMatchObject({ followUp: { state: "scheduled", dueAt: DUE, suspendedByHold: true } });
    expect(await fireCaseTimer({ timerId: w.timerId, now: AFTER_DUE })).toMatchObject({ fired: false, reason: "case_on_hold", timer: { state: "scheduled" } });
    expect((await listCaseEvents(w.caseId)).some(e => e.kind === "timer_fired")).toBe(false);
    expect(await claim(w.caseId, held.case.version)).toMatchObject({ claimed: false, reason: "owner_not_agent" });
    await expect(transitionCaseOwner({ ...commandBase(w.caseId, held.case.version), transition: "hold_release", to: "agent", commandKey: "v7-rel-unq", admission: UNQUALIFIED }))
      .rejects.toThrow("SAV_CASE_ADMISSION_REFUSED");
    const released = await transitionCaseOwner({ ...commandBase(w.caseId, held.case.version), transition: "hold_release", to: "agent", commandKey: "v7-rel", admission: ADMITTED });
    expect(released.case).toMatchObject({ owner: "agent" });
    expect(await readCaseDiagnostics(w.ticketId)).toMatchObject({ followUp: { state: "scheduled", dueAt: DUE, suspendedByHold: false } });
    expect(await fireCaseTimer({ timerId: w.timerId, now: AFTER_DUE })).toMatchObject({ fired: true, timer: { state: "fired", dueAt: DUE } });
    expect((await listCaseEvents(w.caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(1);
  });
  it("Q9: an organisational hold keeps the J2 too, a customer reply during the hold still ends it, and only a human may set it", async () => {
    const w = await waiting("gm-v7-org");
    await expect(transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "organisational_hold", actor: { type: "system" }, commandKey: "v7-org-sys" }))
      .rejects.toThrow("SAV_CASE_TRANSITION_FORBIDDEN");
    await transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "organisational_hold", commandKey: "v7-org" });
    expect(await listCaseTimers(w.caseId)).toMatchObject([{ state: "scheduled", cancelReason: null }]);
    await inbound(w.ticketId, "gm-v7-org-reply");
    expect(await listCaseTimers(w.caseId)).toMatchObject([{ state: "cancelled", cancelReason: "customer_inbound" }]);
    expect((await readCase(w.caseId))!.owner).toBe("system_hold");
  });
  it("Q9: a hold released to a person, like a personal takeover, cancels the old J2", async () => {
    const w = await waiting("gm-v7-person");
    const held = await transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "technical_hold", commandKey: "v7-p-hold" });
    const released = await transitionCaseOwner({ ...commandBase(w.caseId, held.case.version), transition: "hold_release", to: "human", commandKey: "v7-p-rel" });
    expect(released.case).toMatchObject({ owner: "human", phase: "human_owned" });
    expect(await listCaseTimers(w.caseId)).toMatchObject([{ state: "cancelled", cancelReason: "owner_changed" }]);
    expect(await fireCaseTimer({ timerId: w.timerId, now: AFTER_DUE })).toMatchObject({ fired: false, timer: { state: "cancelled" } });
    const w2 = await waiting("gm-v7-person-2");
    await transitionCaseOwner({ ...commandBase(w2.caseId, w2.version), transition: "human_takeover", commandKey: "v7-p-take" });
    expect(await listCaseTimers(w2.caseId)).toMatchObject([{ state: "cancelled", cancelReason: "owner_changed" }]);
  });
  it("Q9: refuses the ambiguous admin_hold as a new command and writes nothing", async () => {
    const w = await waiting("gm-v7-retired");
    const before = await keys(w.caseId);
    await expect(transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "admin_hold", commandKey: "v7-admin" })).rejects.toThrow("SAV_CASE_TRANSITION_RETIRED");
    expect(await keys(w.caseId)).toEqual(before);
    expect((await readCase(w.caseId))!).toMatchObject({ owner: "agent", version: w.version });
    expect(await listCaseTimers(w.caseId)).toMatchObject([{ state: "scheduled" }]);
  });
  it("Q9: a hold crossing a due timer ends in exactly one consistent state", async () => {
    const w = await waiting("gm-v7-race");
    const [fired] = await Promise.all([
      fireCaseTimer({ timerId: w.timerId, now: AFTER_DUE }),
      transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "technical_hold", commandKey: "v7-race" }).catch(error => error),
    ]);
    const [timer] = await listCaseTimers(w.caseId);
    expect(timer!.state).toBe(fired.fired ? "fired" : "scheduled");
    expect((await listCaseEvents(w.caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(fired.fired ? 1 : 0);
  });

  // v8 (C's finding of 28/10): released to the agent, a case held while waiting goes back to its wait, same J2.
  const release = (w: { caseId: string }, version: number, commandKey: string) =>
    transitionCaseOwner({ ...commandBase(w.caseId, version), transition: "hold_release", to: "agent", commandKey, admission: ADMITTED });
  for (const [transition, actor] of [["technical_hold", { type: "system" as const }], ["organisational_hold", staff]] as const) {
    it(`v8: released from a ${transition}, the case waits for the customer again with the same J2 and due date`, async () => {
      const w = await waiting(`gm-v8-back-${transition}`);
      const before = (await readCase(w.caseId))!.body.waiting;
      const held = await transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition, actor, commandKey: `v8-back-${transition}` });
      const released = await release(w, held.case.version, `v8-back-rel-${transition}`);
      expect(released.case).toMatchObject({ owner: "agent", phase: "awaiting_customer", body: { waiting: before } });
      expect((await listCaseEvents(w.caseId)).at(-1)!.detail).toMatchObject({ transition: "hold_release", toPhase: "awaiting_customer" });
      expect(await listCaseTimers(w.caseId)).toMatchObject([{ id: w.timerId, state: "scheduled", dueAt: DUE }]);
      expect(await fireCaseTimer({ timerId: w.timerId, now: AFTER_DUE })).toMatchObject({ fired: true, timer: { dueAt: DUE } });
    });
  }
  it("v8: a J2 fired before the hold keeps the wait too, so its follow-up can still be judged", async () => {
    const w = await waiting("gm-v8-back-fired");
    const fired = await fireCaseTimer({ timerId: w.timerId, now: AFTER_DUE });
    const held = await transitionCaseOwner({ ...commandBase(w.caseId, fired.version), transition: "technical_hold", commandKey: "v8-back-fired" });
    expect((await release(w, held.case.version, "v8-back-fired-rel")).case).toMatchObject({ phase: "awaiting_customer" });
  });
  it("v8: no wait comes back after a customer reply during the hold, nor after a personal takeover", async () => {
    const w = await waiting("gm-v8-back-reply");
    await transitionCaseOwner({ ...commandBase(w.caseId, w.version), transition: "technical_hold", commandKey: "v8-reply-hold" });
    const reply = await inbound((await readCase(w.caseId))!.ticketId, "gm-v8-back-reply-2");
    expect((await release(w, reply.case.version, "v8-reply-rel")).case).toMatchObject({ owner: "agent", phase: "queued" });
    expect(await listCaseTimers(w.caseId)).toMatchObject([{ state: "cancelled", cancelReason: "customer_inbound" }]);
    const p = await waiting("gm-v8-back-person");
    const taken = await transitionCaseOwner({ ...commandBase(p.caseId, p.version), transition: "human_takeover", commandKey: "v8-person-take" });
    const back = await transitionCaseOwner({ ...commandBase(p.caseId, taken.case.version), transition: "hand_back", commandKey: "v8-person-back", admission: ADMITTED });
    expect(back.case).toMatchObject({ owner: "agent", phase: "queued" });
    expect(await listCaseTimers(p.caseId)).toMatchObject([{ state: "cancelled", cancelReason: "owner_changed" }]);
    // Held after the agent had moved on from the wait: its phase is not brought back, even with the J2 still scheduled.
    const moved = await waiting("gm-v8-back-moved");
    const acting = await updateCaseRecord({ caseId: moved.caseId, expectedVersion: moved.version, actor: { type: "agent" }, phase: "acting" });
    const held = await transitionCaseOwner({ ...commandBase(moved.caseId, acting.version), transition: "technical_hold", commandKey: "v8-moved-hold" });
    expect((await release(moved, held.case.version, "v8-moved-rel")).case).toMatchObject({ phase: "queued" });
    expect(await listCaseTimers(moved.caseId)).toMatchObject([{ state: "scheduled" }]);
  });

  const factAt = "2026-10-28T09:00:00.000Z";
  it("Q6: an attachment is cited by mail and part, and must belong to one of the case's customer mails", async () => {
    const { case: c } = await inbound(ticket(), "gmv7att");
    const statement = (id: string, source: { type: "attachment"; id: string }) => ({ id, text: "Capture fictive", source, at: factAt, kind: "customer_statement" as const, key: null });
    const saved = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, facts: [statement("f-att", { type: "attachment", id: caseAttachmentRef("gmv7att", "1.2") })] } });
    expect(saved.body.facts[0]!.source).toEqual({ type: "attachment", id: "gmv7att:1.2" });
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: saved.version, actor: { type: "agent" }, body: { ...saved.body, facts: [...saved.body.facts, statement("f-other", { type: "attachment", id: "gmother:2" })] } }))
      .rejects.toThrow("SAV_CASE_ATTACHMENT_SOURCE_UNKNOWN");
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: saved.version, actor: { type: "agent" }, body: { ...saved.body, facts: [...saved.body.facts, statement("f-bad", { type: "attachment", id: "gmv7att:ANGjdJ_long-attachment-id" })] } }))
      .rejects.toThrow("SAV_CASE_BODY_INVALID");
  });
  it("Q8: a customer mail or its attachment never becomes an observed fact, through a write or an observation", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv7q8");
    const observedFrom = (id: string, source: { type: "email" | "attachment"; id: string }) => ({ id, text: "Constat fictif", source, at: factAt, kind: "observed" as const, key: null });
    for (const source of [{ type: "email" as const, id: "gmv7q8" }, { type: "attachment" as const, id: "gmv7q8:1" }])
      await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, facts: [observedFrom("f-obs", source)] } }))
        .rejects.toThrow("SAV_CASE_FACT_OBSERVED_FROM_CUSTOMER");
    const taken = await claim(c.caseId, c.version) as { claim: { token: string } };
    await expect(recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1",
      observation: { record: { decision: "fixture" }, body: { ...c.body, facts: [observedFrom("f-obs", { type: "email", id: "gmv7q8" })] } } })).rejects.toThrow("SAV_CASE_FACT_OBSERVED_FROM_CUSTOMER");
    expect((await readCase(c.caseId))!.body.facts).toEqual([]);
  });
  it("Q8: a dated finding and its history stay; the customer's new statement only moves the current state", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv7hist");
    const request = { id: "r1", summary: "Demande fictive", family: "access" as const, status: "open" as const, openedAt: RECEIVED };
    const finding = { id: "f-crm", text: "Accès bloqué constaté", source: { type: "hubspot_object" as const, id: "201" }, at: factAt, kind: "observed" as const, key: "login_error" };
    const found = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, openRequests: [request], facts: [finding] } });
    const reply = await inbound(ticketId, "gmv7hist-reply");
    const said = { id: "f-said", text: "Le client dit que ça marche", source: { type: "email" as const, id: "gmv7hist-reply" }, at: "2026-10-28T10:00:00.000Z", kind: "customer_statement" as const, key: "login_error" };
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: reply.case.version, actor: { type: "agent" }, body: { ...found.body, facts: [finding, { ...said, replaces: "f-crm" }] } }))
      .rejects.toThrow("SAV_CASE_BODY_INVALID");
    const resolved = await updateCaseRecord({ caseId: c.caseId, expectedVersion: reply.case.version, actor: { type: "agent" }, phase: "resolved",
      body: { ...found.body, openRequests: [{ ...request, status: "resolved" }], facts: [finding, said] } });
    expect(resolved).toMatchObject({ phase: "resolved", body: { openRequests: [{ status: "resolved" }] } });
    expect(currentCaseFacts(resolved.body).map(fact => [fact.id, fact.kind])).toEqual([["f-crm", "observed"], ["f-said", "customer_statement"]]);
  });
  it("Q10: a human case stays human when re-evaluated with an approved rule, and a model hint never admits", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv7q10");
    const taken = await transitionCaseOwner({ ...commandBase(c.caseId, c.version), transition: "human_takeover", commandKey: "v7-q10-take" });
    const byRule = { policy: POLICY, qualification: qualified([{ requestId: "r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }]) };
    const again = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: taken.case.version, admission: byRule, sourceRef: { type: "email", id: "gmv7q10" } });
    expect(again).toMatchObject({ owner: "human", phase: "human_owned", admission: { target: "agent" } });
    expect(caseAdmissionStatus(again, "policy-r1")).toEqual({ admitted: false, reason: "owner_not_agent" });
    expect(decideCaseAdmission({ policy: POLICY, qualification: qualified([{ requestId: "r1", family: "access", provenance: hint() }]), caseSensitivity: "none" }).target).not.toBe("agent");
  });
  it("Q10: an agent case continues on an approved rule without a human, and goes to the team with a reason when out of scope", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv7cont");
    const reply = await inbound(ticketId, "gmv7cont-2");
    const byRule = (family: "access" | "usage") => ({ policy: POLICY, qualification: qualified([{ requestId: "r1", family, provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }]) });
    const continued = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: reply.case.version, admission: byRule("access"), sourceRef: { type: "email", id: "gmv7cont-2" } });
    expect(continued.owner).toBe("agent");
    expect(caseAdmissionStatus(continued, "policy-r1")).toEqual({ admitted: true });
    const third = await inbound(ticketId, "gmv7cont-3");
    // The rule is qualified for access only: usage is out of its scope.
    const out = await reevaluateCaseAdmission({ caseId: c.caseId, expectedVersion: third.case.version, admission: byRule("usage"), sourceRef: { type: "email", id: "gmv7cont-3" } });
    expect(out).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "qualification_unproven" } } });
    const exits = (await listCaseEvents(c.caseId)).map(classifyCaseExit).filter(category => category !== null);
    expect(exits).toEqual(["business_transfer"]);
  });
  it("Q11: a human takeover crossing a running decision is never answered over: the observation is not applied", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv7cross");
    const taken = await claim(c.caseId, c.version) as { claim: { token: string } };
    await transitionCaseOwner({ ...commandBase(c.caseId, c.version), transition: "human_takeover", commandKey: "v7-cross-take" });
    const late = await recordCaseObservation({ caseId: c.caseId, claimToken: taken.claim.token, currentPolicyRevision: "policy-r1", observation: { record: { decision: "answer" }, phase: "acting" } })
      .catch(error => error as Error);
    if (late instanceof Error) expect(late.message).toBe("SAV_CASE_CLAIM_LOST");
    else expect(late).toMatchObject({ applied: false });
    expect((await readCase(c.caseId))!).toMatchObject({ owner: "human", phase: "human_owned" });
    expect((await listCaseEvents(c.caseId)).map(classifyCaseExit).filter(category => category !== null)).toEqual(["human_initiative"]);
  });
  it("names the unique and foreign keys of the case tables as the Drizzle snapshot does", async () => {
    const names = await rows("SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'sav' AND contype IN ('u','f') AND conrelid::regclass::text IN ('sav.cases','sav.case_events','sav.case_timers') ORDER BY 1");
    expect(names.map(row => row.conname)).toEqual(["case_events_case_id_cases_id_fk", "case_timers_case_id_cases_id_fk", "case_timers_key_unique", "cases_ticket_id_unique"]);
  });
  it("Q5/Q11: a full case goes to the team by a system takeover the measure counts as a technical block", async () => {
    const { case: c } = await inbound(ticket(), "gmv7full");
    const moved = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: { type: "system" }, commandKey: "v7-full", reason: "body_limit_reached" });
    expect(moved.case).toMatchObject({ owner: "human", body: { handoff: { reason: "body_limit_reached" } } });
    expect((await listCaseEvents(c.caseId)).map(classifyCaseExit).filter(category => category !== null)).toEqual(["technical_block"]);
  });
});

describe("Q5 at the way back: a full memory is never given back to the agent (night review 29/10)", () => {
  const commandBase = (caseId: string, expectedVersion: number) => ({ caseId, expectedVersion, actor: staff, reason: "fixture" });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `filler-${i}`, summary: "Demande synthétique", family: "usage" as const, status: "resolved" as const, openedAt: RECEIVED }));
  const opened = (ticketId: string, gmail: string) => openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: RECEIVED, opens: [{ id: `${gmail}/r0`, summary: "Demande synthétique" }] });
  async function filled(gmail: string, n: number) {
    const ticketId = ticket(), { case: c } = await opened(ticketId, gmail);
    const full = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: staff, body: { ...c.body, openRequests: [...c.body.openRequests, ...filler(n)] } });
    return { ticketId, caseId: c.caseId, version: full.version };
  }
  const back = { hold: "hold_release", human: "hand_back" } as const;
  for (const put of ["hold", "human"] as const) {
    it(`${put}: a mail the full memory could not take keeps the case with the team, released or handed back`, async () => {
      const f = await filled(`gm-q5b-${put}`, 49);
      const moved = put === "hold"
        ? await transitionCaseOwner({ ...commandBase(f.caseId, f.version), transition: "technical_hold", actor: { type: "system" }, commandKey: `q5b-${put}` })
        : await transitionCaseOwner({ ...commandBase(f.caseId, f.version), transition: "human_takeover", commandKey: `q5b-${put}` });
      const reply = await opened(f.ticketId, `gm-q5b-${put}-2`);
      expect(reply.case).toMatchObject({ owner: moved.case.owner });
      expect(reply.case.body.openRequests.map(r => r.id)).not.toContain(`gm-q5b-${put}-2/r0`);
      const before = await keys(f.caseId);
      await expect(transitionCaseOwner({ ...commandBase(f.caseId, reply.case.version), transition: back[put], ...(put === "hold" ? { to: "agent" as const } : {}), commandKey: `q5b-${put}-back`, admission: ADMITTED }))
        .rejects.toThrow("SAV_CASE_BODY_LIMIT_REACHED");
      expect(await keys(f.caseId)).toEqual(before);
      expect((await readCase(f.caseId))!).toMatchObject({ owner: moved.case.owner, version: reply.case.version });
      if (put === "hold") expect((await transitionCaseOwner({ ...commandBase(f.caseId, reply.case.version), transition: "hold_release", to: "human", commandKey: "q5b-hold-team" })).case).toMatchObject({ owner: "human" });
    });
  }
  it("keeps the requests a mail opened: the agent may only move their status, a person may still edit them", async () => {
    const two = await openCaseEvent({ ticketId: ticket(), threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-q5b-stable"),
      sourceRef: { type: "email", id: "gm-q5b-stable" }, occurredAt: RECEIVED, opens: [{ id: "gm-q5b-stable/r0", summary: "Demande synthétique" }, { id: "gm-q5b-stable/r1", summary: "Demande synthétique" }] });
    const c = two.case, [r0, r1] = c.body.openRequests as [typeof c.body.openRequests[number], typeof c.body.openRequests[number]];
    const write = (openRequests: typeof c.body.openRequests, actor: { type: "agent" } | typeof staff = { type: "agent" }) =>
      updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor, body: { ...c.body, openRequests } });
    for (const changed of [[r1], [{ ...r0, family: "usage" as const }, r1], [{ ...r0, id: "gm-q5b-stable/other" }, r1], [{ ...r0, summary: "Autre" }, r1], [{ ...r0, openedAt: AT }, r1]])
      await expect(write(changed)).rejects.toThrow("SAV_CASE_REQUEST_IMMUTABLE");
    expect((await readCase(c.caseId))!.version).toBe(c.version);
    expect((await write([{ ...r0, status: "resolved" }, r1])).body.openRequests.map(r => r.status)).toEqual(["resolved", "open"]);
    const now = (await readCase(c.caseId))!;
    expect((await updateCaseRecord({ caseId: c.caseId, expectedVersion: now.version, actor: staff, body: { ...now.body, openRequests: [r1] } })).body.openRequests).toEqual([r1]);
  });
  it("a memory with room left still goes back to the agent, as before", async () => {
    const f = await filled("gm-q5b-room", 48);
    const taken = await transitionCaseOwner({ ...commandBase(f.caseId, f.version), transition: "human_takeover", commandKey: "q5b-room" });
    expect((await transitionCaseOwner({ ...commandBase(f.caseId, taken.case.version), transition: "hand_back", commandKey: "q5b-room-back", admission: ADMITTED })).case).toMatchObject({ owner: "agent" });
  });
});

describe("contract v8: integration findings of 28/10 (CRM key, due timers, policy revalidation)", () => {
  it("accepts a HubSpot ISO date in the CRM key, as the same key as its milliseconds, so a re-read appends nothing", async () => {
    const iso = "2026-10-28T10:15:30.123Z";
    expect(caseDedupeKey.crm("301", iso)).toBe(`crm:301:${Date.parse(iso)}`);
    expect(caseDedupeKey.crm("301", "2026-10-28T11:15:30.123+01:00")).toBe(caseDedupeKey.crm("301", iso));
    expect(caseDedupeKey.crm("301", String(Date.parse(iso)))).toBe(caseDedupeKey.crm("301", iso));
    for (const bad of ["", "hier", "2026-10-28", "12.5", "-1"]) expect(() => caseDedupeKey.crm("301", bad)).toThrow("SAV_CASE_CRM_DATE_INVALID");
    const { case: c } = await inbound(ticket(), "gmv8crm");
    const crm = (updatedAt: string) => appendCaseEvent({ caseId: c.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("301", updatedAt), sourceRef: { type: "hubspot_object", id: "301" }, detail: { crmChange: "status_changed" } });
    expect(await crm(iso)).toMatchObject({ appended: true });
    expect(await crm(String(Date.parse(iso)))).toMatchObject({ appended: false });
  });

  // Due before every other fixture timer in this file (none is due before 2026-10-29), after the mail.
  const SENT = "2026-10-27T08:30:00.000Z", NOW = new Date("2026-10-28T12:00:00.000Z");
  async function waitingUntil(gmail: string, dueAt: string) {
    const { case: c } = await inbound(ticket(), gmail);
    const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" },
      body: { ...c.body, questions: [{ id: "q", text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: `effect-${gmail}` }] } });
    const id = randomUUID();
    const scheduled = await scheduleCaseTimer({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question",
      timer: { id, questionEffectId: `effect-${gmail}`, sentAt: SENT, dueAt } }) as { case: { version: number } };
    return { caseId: c.caseId, timerId: id, version: scheduled.case.version };
  }
  it("lists due J2 timers oldest first, bounded, skipping held cases so they never starve the others, and each fires once", async () => {
    const held = await waitingUntil("gmv8-due-held", "2026-10-28T09:00:00.000Z");
    const first = await waitingUntil("gmv8-due-1", "2026-10-28T10:00:00.000Z");
    const second = await waitingUntil("gmv8-due-2", "2026-10-28T11:00:00.000Z");
    const later = await waitingUntil("gmv8-due-later", "2026-12-31T09:00:00.000Z");
    await transitionCaseOwner({ caseId: held.caseId, expectedVersion: held.version, transition: "technical_hold", actor: { type: "system" }, commandKey: "v8-due-hold", reason: "fixture" });
    for (const limit of [0, 501, 1.5]) await expect(listDueCaseTimers({ now: NOW, limit })).rejects.toThrow("SAV_CASE_PAGE_INVALID");
    const due = await listDueCaseTimers({ now: NOW, limit: 2 });
    expect(due.map(timer => timer.id)).toEqual([first.timerId, second.timerId]);
    expect(due.every(timer => timer.state === "scheduled")).toBe(true);
    const ids = (await listDueCaseTimers({ now: NOW, limit: 500 })).map(timer => timer.id);
    expect(ids).not.toContain(held.timerId);
    expect(ids).not.toContain(later.timerId);
    expect(await fireCaseTimer({ timerId: first.timerId, now: NOW })).toMatchObject({ fired: true });
    expect(await fireCaseTimer({ timerId: first.timerId, now: NOW })).toMatchObject({ fired: false });
    expect((await listDueCaseTimers({ now: NOW, limit: 500 })).map(timer => timer.id)).not.toContain(first.timerId);
    expect((await listCaseEvents(first.caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(1);
    // Q9 on the v8 store: released to the agent with a fresh admission, the held J2 is due again, same date.
    const heldCase = (await readCase(held.caseId))!;
    await transitionCaseOwner({ caseId: held.caseId, expectedVersion: heldCase.version, transition: "hold_release", to: "agent", actor: staff, commandKey: "v8-due-rel", reason: "fixture", admission: ADMITTED });
    expect((await listDueCaseTimers({ now: NOW, limit: 1 }))).toMatchObject([{ id: held.timerId, dueAt: "2026-10-28T09:00:00.000Z" }]);
  });
  it("uses the partial index on scheduled due dates", async () => {
    const plan = await rows("EXPLAIN SELECT t.id FROM sav.case_timers t JOIN sav.cases c ON c.id = t.case_id WHERE t.state = 'scheduled' AND t.due_at <= now() AND c.owner <> 'system_hold' ORDER BY t.due_at, t.id LIMIT 10");
    expect(JSON.stringify(plan)).not.toBe("[]");
    expect(await rows("SELECT indexdef FROM pg_indexes WHERE schemaname = 'sav' AND indexname = 'sav_case_timers_due'")).toEqual([{ indexdef: expect.stringContaining("WHERE (state = 'scheduled'::text)") }]);
  });

  const RULE = { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT };
  const byRule: CaseAdmissionInput = { policy: POLICY, qualification: qualified([{ requestId: "r1", family: "access", provenance: RULE }]) };
  it("revalidates an agent case under a new policy revision with its recorded qualification only, and withdraws it when the rule is gone", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv8pol", byRule);
    const next = { ...POLICY, revision: "policy-r2" };
    expect(caseAdmissionStatus(c, "policy-r2")).toEqual({ admitted: false, reason: "policy_changed" });
    const kept = await revalidateCaseAdmissionForPolicy({ caseId: c.caseId, expectedVersion: c.version, policy: next });
    expect(kept).toMatchObject({ revalidated: true, case: { owner: "agent", admission: { target: "agent", policyRevision: "policy-r2" } } });
    expect(kept.case.admission!.qualification).toEqual(c.admission!.qualification);
    expect(caseAdmissionStatus(kept.case, "policy-r2")).toEqual({ admitted: true });
    // The new revision no longer lists the rule: the case goes to the team, counted as a business transfer.
    const withoutRule = { ...POLICY, revision: "policy-r3", qualifiedRules: [] };
    const gone = await revalidateCaseAdmissionForPolicy({ caseId: c.caseId, expectedVersion: kept.case.version, policy: withoutRule });
    expect(gone).toMatchObject({ revalidated: true, case: { owner: "human", phase: "handoff_pending", body: { handoff: { reason: "qualification_unproven" } } } });
    expect((await listCaseEvents(c.caseId)).map(classifyCaseExit).filter(category => category !== null)).toEqual(["business_transfer"]);
  });
  it("lists, by pages, only agent cases admitted under another revision, for B's sweep", async () => {
    const stale = await inbound(ticket(), "gmv8list-a", byRule), current = await inbound(ticket(), "gmv8list-b", { ...byRule, policy: { ...POLICY, revision: "policy-r9" } });
    const human = await inbound(ticket(), "gmv8list-h", UNQUALIFIED);
    for (const limit of [0, 501]) await expect(listCaseIdsForPolicyRevalidation({ currentPolicyRevision: "policy-r9", after: null, limit })).rejects.toThrow("SAV_CASE_PAGE_INVALID");
    await expect(listCaseIdsForPolicyRevalidation({ currentPolicyRevision: "policy-r9", after: "x", limit: 1 })).rejects.toThrow("SAV_CASE_PAGE_INVALID");
    const all: string[] = [];
    // Bounded: a cursor that does not move must fail here, not loop.
    for (let after: string | null = null, page: string[] = ["start"], turns = 0; page.length; turns++) {
      expect(turns).toBeLessThan(1000);
      page = await listCaseIdsForPolicyRevalidation({ currentPolicyRevision: "policy-r9", after, limit: 2 });
      expect(page.length).toBeLessThanOrEqual(2);
      all.push(...page); after = page.at(-1) ?? after;
    }
    expect(all).toEqual([...all].sort());
    expect(all).toContain(stale.case.caseId);
    expect(all).not.toContain(current.case.caseId);
    expect(all).not.toContain(human.case.caseId);
    expect(new Set(all).size).toBe(all.length);
  });
  it("never revalidates past a newer input, nor a case the agent does not own", async () => {
    const ticketId = ticket(), { case: c } = await inbound(ticketId, "gmv8pol-new", byRule);
    const next = { ...POLICY, revision: "policy-r2" };
    // A status change is an input: the recorded qualification no longer covers everything known.
    const moved = await appendCaseEvent({ caseId: c.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("302", "2026-10-28T10:00:00Z"), sourceRef: { type: "hubspot_object", id: "302" }, detail: { crmChange: "status_changed" } });
    const reply = { case: { version: moved.version } };
    expect(await revalidateCaseAdmissionForPolicy({ caseId: c.caseId, expectedVersion: reply.case.version, policy: next })).toMatchObject({ revalidated: false, reason: "input_newer" });
    const human = await inbound(ticket(), "gmv8pol-human", UNQUALIFIED);
    expect(await revalidateCaseAdmissionForPolicy({ caseId: human.case.caseId, expectedVersion: human.case.version, policy: next })).toMatchObject({ revalidated: false, reason: "owner_not_agent" });
    await expect(revalidateCaseAdmissionForPolicy({ caseId: c.caseId, expectedVersion: c.version, policy: next })).rejects.toThrow("SAV_CASE_VERSION_STALE");
    expect((await readCase(c.caseId))!.version).toBe(reply.case.version);
  });
});

describe("listCasesPage: the V2 list for the UX, read only", () => {
  it("pages by latest change to the microsecond, filters by phase and owner, binds its cursor to them, and decrypts or writes nothing", async () => {
    // In 2031, ahead of every other case of this file; payloads that are not ciphertexts prove nothing is decrypted.
    const id = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;
    const seed: Array<[number, string, string, string, string]> = [
      [1, "agent", "queued", "2031-01-01T00:00:03.000000Z", "sav-case-2026-10-27.v10"],
      [2, "human", "handoff_pending", "2031-01-01T00:00:02.000700Z", "sav-case-2026-10-27.v9"],
      [4, "human", "handoff_pending", "2031-01-01T00:00:02.000300Z", "sav-case-2026-10-27.v10"],
      [3, "human", "human_owned", "2031-01-01T00:00:02.000300Z", "fixture-unsupported"],
      [5, "agent", "queued", "2031-01-01T00:00:01.000000Z", "sav-case-2026-10-27.v10"],
    ];
    for (const [n, owner, phase, at, revision] of seed) await f.client.query(
      `INSERT INTO sav.cases(id, ticket_id, owner, phase, contract_revision, payload_ciphertext, created_at, updated_at, admission_target, admission_reason, admission_version, admission_input_version)
       VALUES ($1, $2, $3, $4, $5, 'not-a-ciphertext', '2031-01-01T00:00:00Z', $6, $7, $8, $9, 1)`,
      // The database requires an agent case to be admitted for the agent.
      [id(n), `99000${n}`, owner, phase, revision, at, n === 2 ? "team" : owner === "agent" ? "agent" : null, n === 2 ? "awaiting_v2_attribution" : null, n === 2 || owner === "agent" ? 1 : null]);
    const before = await rows("SELECT id, version, updated_at::text FROM sav.cases ORDER BY id");
    const all = async (filters: Parameters<typeof listCasesPage>[0], pages: number) => {
      const seen: string[][] = [];
      let cursor: string | null = null;
      for (let i = 0; i < pages; i++) {
        const page = await listCasesPage({ ...filters, cursor });
        seen.push(page.items.map(item => item.caseId));
        cursor = page.nextCursor;
      }
      return { seen, cursor };
    };
    // 2 then 4: same millisecond, different microseconds; 4 then 3: same instant, by id.
    expect((await all({ limit: 2 }, 2)).seen).toEqual([[id(1), id(2)], [id(4), id(3)]]);
    expect((await all({ limit: 1, owner: "human", phase: "handoff_pending" }, 2)).seen).toEqual([[id(2)], [id(4)]]);
    expect((await listCasesPage({ owner: "agent", phase: "queued", limit: 2 })).items.map(item => item.caseId)).toEqual([id(1), id(5)]);
    expect((await listCasesPage({ owner: "human", limit: 3 })).items.map(item => item.caseId)).toEqual([id(2), id(4), id(3)]);
    expect((await listCasesPage({ phase: "queued", limit: 2 })).items.map(item => item.caseId)).toEqual([id(1), id(5)]);
    const [second] = (await listCasesPage({ limit: 2 })).items.slice(1);
    expect(second).toEqual({ caseId: id(2), ticketId: "990002", owner: "human", phase: "handoff_pending", sensitivity: "none", version: 1, threadCount: 0,
      contractRevision: "sav-case-2026-10-27.v9", contractSupported: true, admission: { target: "team", reason: "awaiting_v2_attribution", inputNewer: false },
      claimUntil: null, createdAt: "2031-01-01T00:00:00.000Z", updatedAt: "2031-01-01T00:00:02.000Z" });
    expect((await listCasesPage({ owner: "human", phase: "human_owned", limit: 1 })).items[0]).toMatchObject({ caseId: id(3), contractSupported: false, admission: null });
    // A cursor serves only the filters it was made for; a forged or malformed one is refused, as are bad limits and filters.
    const humanCursor = (await listCasesPage({ owner: "human", limit: 1 })).nextCursor!;
    for (const bad of [{ cursor: humanCursor }, { cursor: humanCursor, owner: "agent" as const }, { cursor: "not a cursor" }, { cursor: Buffer.from(JSON.stringify({ at: "2031-01-01T00:00:02.000Z", id: id(2), filters: "*|*" })).toString("base64url") },
      { limit: 0 }, { limit: 101 }, { limit: 2.5 }, { phase: "lost" as never }, { owner: "robot" as never }])
      await expect(listCasesPage(bad)).rejects.toThrow("SAV_CASE_PAGE_INVALID");
    expect(await rows("SELECT id, version, updated_at::text FROM sav.cases ORDER BY id")).toEqual(before);
  });
});
