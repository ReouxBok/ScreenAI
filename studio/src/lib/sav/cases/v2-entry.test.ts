import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savCases, savCaseTimers, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeJournal, savIntakeModelCalls, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { savAgentPauseKey } from "../intake/agent-pause";
import { analyseSavIntakeRuntime } from "../intake/runtime";
import type { IntakeRuntimeConfig } from "../intake/runtime-contract";
import { caseAdmissionStatus } from "./admission-policy";
import { readCaseBlockHold } from "./case-block-hold";
import { nextCaseTeamPartWait, readCaseTeamPartWait, SAV_CASE_TEAM_PART_WAIT_BOUNDS } from "./case-team-part-wait";
import { listCaseEvents, openCaseEvent, readCase, readCaseByTicket, readCaseDiagnostics, reevaluateCaseAdmission, updateCaseRecord } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays } from "./intake-boundary";
import { scheduleJ2ForConfirmedQuestion } from "./timer-store";
import { continueCaseAfterCommit, customerReturnGate, sweepCaseContinuations, v2EntryRelayDeps } from "./v2-entry";
import { SAV_V2_QUALIFICATION_SCOPE_SCHEMA, savV2QualificationScopeHash } from "./qualification-scope";
import { caseContinuationReport } from "./v2-entry-binding";

// The real entry of V1's runtime on the real stores (PGlite). Only the network is a double: every mail, ticket, owner and policy is SYNTHETIC, nothing is called for real.
let f: Awaited<ReturnType<typeof createSavTestDb>>, policyId: string, ticketSeq = 8_600_000;
const POLICY = "policy-syn", V2_OWNER = "900001", PERSON = "900777", STAFF = "20000000-0000-4000-8000-000000000001", AT = "2026-11-02T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access"], qualifiedRules: [], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-syn" } }, crmContext: "complete" as const, teamSignals: [] },
};
const T0 = new Date("2026-11-02T08:00:00.000Z"), SENT = new Date("2026-11-02T10:00:00.000Z"), T1 = new Date("2026-11-03T08:30:00.000Z");
const ON = { SAV_V2_ENTRY: "on", SAV_CASE_RECORDING: "on", SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: "900000", HUBSPOT_ACCESS_TOKEN: "syn-token-not-real" };
const noConfig = {} as IntakeRuntimeConfig;

let calls: string[] = [], ownerAnswer: string | null | "fail" = V2_OWNER;
const network = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  const ticket = /tickets\/([0-9]+)\?properties=hubspot_owner_id$/.exec(url);
  if (!ticket || ownerAnswer === "fail") return new Response("{}", { status: 403 });
  return new Response(JSON.stringify({ id: ticket[1], properties: { hubspot_owner_id: ownerAnswer } }), { status: 200, headers: { "content-type": "application/json" } });
});

async function inbound(threadId: string, mailboxId: string, input: { receivedAt: Date; headers?: Record<string, string>; subject?: string; text?: string }) {
  const gmail = `syn-${randomUUID().slice(0, 12)}`;
  const [row] = await f.db.insert(savMessages).values({ mailboxId, threadId, gmailMessageId: gmail, direction: "inbound", fromEmail: "client.fictif@example.invalid", toEmails: ["support@example.invalid"], subject: input.subject ?? "Re: Connexion fictive",
    receivedAt: input.receivedAt, analysisStatus: "intake_pending", bodyCiphertext: encryptSavPayload({ text: input.text ?? "Réponse fictive.", attachments: [], headers: input.headers ?? {} }) }).returning();
  return { id: row!.id, gmail };
}
const queuedRun = async (threadId: string, messageId: string, attempts = 0, version = 1) => (await f.db.insert(savIntakeRuns).values({ threadId, messageId, version, isCurrent: true, state: "pending", attempts, configHash: `syn-${version}`, policyHash: "syn",
  payloadCiphertext: encryptSavPayload({ revision: "syn", effects: "not_connected" }) }).returning())[0]!;
async function bareThread() {
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${randomUUID().slice(0, 8)}@example.invalid` }).returning();
  const [thread] = await f.db.insert(savThreads).values({ mailboxId: mailbox!.id, gmailThreadId: randomUUID(), customerEmail: "client.fictif@example.invalid" }).returning();
  return { mailboxId: mailbox!.id, threadId: thread!.id };
}
/** An agent case waiting for the customer, its J2 scheduled, and a new customer mail with its V1 run just queued. */
async function waitingWithReturn(input: { attempts?: number; headers?: Record<string, string>; subject?: string; text?: string } = {}) {
  const { mailboxId, threadId } = await bareThread();
  const first = await inbound(threadId, mailboxId, { receivedAt: T0 }), ticketId = String(++ticketSeq);
  const opened = await openCaseEvent({ ticketId, threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(first.gmail), sourceRef: { type: "email", id: first.gmail }, occurredAt: T0.toISOString(), opens: [{ id: "r1", summary: "Demande fictive" }] });
  const effect = `effect-${randomUUID().slice(0, 8)}`, timerId = randomUUID();
  const asked = await updateCaseRecord({ caseId: opened.case.caseId, expectedVersion: opened.case.version, actor: { type: "agent" }, body: { ...opened.case.body, questions: [{ id: "q1", text: "Question fictive", factKeys: [], askedAt: SENT.toISOString(), askedInEffect: effect }] } });
  await scheduleJ2ForConfirmedQuestion({ caseId: asked.caseId, expectedVersion: asked.version, currentPolicyRevision: POLICY, questionEffectId: effect, timerId, sentAt: SENT });
  const reply = await inbound(threadId, mailboxId, { receivedAt: T1, ...(input.headers ? { headers: input.headers } : {}), ...(input.subject ? { subject: input.subject } : {}), ...(input.text ? { text: input.text } : {}) });
  const run = await queuedRun(threadId, reply.id, input.attempts ?? 0);
  return { threadId, mailboxId, ticketId, caseId: asked.caseId, timerId, reply, run };
}
const runRow = async (id: string) => (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)))[0]!;
const timer = async (id: string) => (await f.db.select().from(savCaseTimers).where(eq(savCaseTimers.id, id)))[0]!;
const inboundCount = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "inbound_confirmed").length;
const failureMark = async (caseId: string) => (await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, caseId), eq(auditLogs.action, "sav_v2_continuation_failed"))))[0];
const setPause = async (agent: "v2" | "intake", level: "actions_paused" | "fully_paused" | null) => {
  const key = savAgentPauseKey(agent);
  await f.db.delete(savSyncState).where(eq(savSyncState.key, key));
  if (level) await f.db.insert(savSyncState).values({ key, status: "installed", cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
};
const entry = (overrides: object = {}) => ({ env: ON, network: network as unknown as typeof fetch, continuation: null, ...overrides });
let errors: ReturnType<typeof vi.spyOn>;
// The first canonical call loads V1's runtime and the entry dynamically.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "v2-entry-fixture-key-only-32-characters-x");
  f = await createSavTestDb(); state.db = f.db;
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `syn-entry-${run}`, email: `entry-${run}@example.invalid`, role: "admin" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "syn", state: "approved", administratorId: admin!.id, policyHash: "syn", payloadCiphertext: encryptSavPayload({}) }).returning();
  policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  // Each sweep scenario owns its queued cohort and starts a fresh lap. Previous tests' cases stay available for diagnostics.
  await f.db.update(savCases).set({ phase: "awaiting_customer" }).where(eq(savCases.phase, "queued"));
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-v2-sweep.v1:continuation"));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "v2-entry-fixture-key-only-32-characters-x");
  vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_V2_HUBSPOT_OWNER_ID", V2_OWNER);
  calls = []; ownerAnswer = V2_OWNER; network.mockClear(); vi.stubGlobal("fetch", network);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); errors.mockRestore(); await setPause("v2", null); await setPause("intake", null); });

describe("entrée de V1 : un retour sur dossier ouvert, avant toute classification modèle", () => {
  it("ticket au SAV Pilote : même dossier, J2 annulé, run V1 clos dans la même transaction, une seule lecture CRM et aucun appel modèle", async () => {
    const w = await waitingWithReturn();
    expect(await analyseSavIntakeRuntime(w.run.id, noConfig, { env: () => ON })).toEqual({ skipped: "v2_customer_return" });
    expect(calls).toEqual([`https://api.hubapi.com/crm/v3/objects/tickets/${w.ticketId}?properties=hubspot_owner_id`]);
    expect(await readCase(w.caseId)).toMatchObject({ owner: "agent", phase: "queued", ticketId: w.ticketId });
    expect(await inboundCount(w.caseId)).toBe(2);
    expect(await timer(w.timerId)).toMatchObject({ state: "cancelled", cancelReason: "customer_inbound" });
    expect(await runRow(w.run.id)).toMatchObject({ isCurrent: false, state: "superseded", attempts: 0 });
    expect(await f.db.select().from(savIntakeJournal).where(and(eq(savIntakeJournal.runId, w.run.id), eq(savIntakeJournal.kind, "v2_customer_return")))).toHaveLength(1);
    expect((await f.db.select().from(savMessages).where(eq(savMessages.id, w.reply.id)))[0]).toMatchObject({ analysisStatus: "intake_v2_return" });
    // Fermé par défaut tant que CE mail n'est pas requalifié : R02.
    expect(caseAdmissionStatus((await readCase(w.caseId))!, POLICY)).toEqual({ admitted: false, reason: "input_newer" });
    expect(await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, w.reply.id))).toHaveLength(0);
  });
  it("OFF : strict V1, ni lecture CRM ni écriture V2, quel que soit le réglage partiel", async () => {
    for (const env of [{}, { SAV_CASE_RECORDING: "on" }, { SAV_V2_ENTRY: "on" }, { SAV_V2_ENTRY: "ON", SAV_CASE_RECORDING: "on" }] as Record<string, string>[]) {
      const w = await waitingWithReturn();
      expect(await customerReturnGate(w.run.id, { env })).toBeNull();
      await analyseSavIntakeRuntime(w.run.id, noConfig, { env: () => env }).catch(() => null);
      expect(calls).toEqual([]);
      expect(await inboundCount(w.caseId)).toBe(1);
      expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
      expect((await runRow(w.run.id)).isCurrent).toBe(true);
    }
  });
  it("propriétaire illisible : le mail est gardé, rien n'est écrit, le run revient plus tard sans tentative consommée", async () => {
    const w = await waitingWithReturn();
    ownerAnswer = "fail";
    expect(await customerReturnGate(w.run.id, entry())).toEqual({ skipped: "v2_customer_return_hold" });
    expect(await inboundCount(w.caseId)).toBe(1);
    expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
    const held = await runRow(w.run.id);
    expect(held).toMatchObject({ isCurrent: true, state: "pending", attempts: 0 });
    expect(held.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    ownerAnswer = V2_OWNER;
    expect(await customerReturnGate(w.run.id, entry())).toEqual({ skipped: "v2_customer_return" });
    expect(await inboundCount(w.caseId)).toBe(2);
  });
  it("pause V2 : retenu sans lecture CRM ni écriture sur le dossier ; pause complète : aucune écriture, même sur le run", async () => {
    const w = await waitingWithReturn();
    await setPause("v2", "actions_paused");
    expect(await customerReturnGate(w.run.id, entry())).toEqual({ skipped: "v2_customer_return_hold" });
    expect(calls).toEqual([]);
    expect(await inboundCount(w.caseId)).toBe(1);
    expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
    await setPause("v2", null);
    const v = await waitingWithReturn(), before = await runRow(v.run.id);
    await setPause("intake", "fully_paused");
    expect(await customerReturnGate(v.run.id, entry())).toBeNull();
    expect(await analyseSavIntakeRuntime(v.run.id, noConfig, { env: () => ON })).toHaveProperty("skipped");
    expect(await inboundCount(v.caseId)).toBe(1);
    expect((await runRow(v.run.id)).attempts).toBe(0);
    expect((await runRow(v.run.id)).updatedAt).toEqual(before.updatedAt);
    expect((await runRow(v.run.id)).leaseUntil).toBeNull();
  });
  it("une personne a pris le ticket : le dossier part à l'équipe sans écriture CRM et V1 continue pour que le mail lui parvienne", async () => {
    const w = await waitingWithReturn();
    ownerAnswer = PERSON;
    expect(await customerReturnGate(w.run.id, entry())).toBeNull();
    expect(await readCase(w.caseId)).toMatchObject({ owner: "human", phase: "human_owned" });
    expect((await runRow(w.run.id)).isCurrent).toBe(true);
    expect(network.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });
  it("auto-réponse prouvée par ses en-têtes : pas de consommation, J2 conservé, aucun CRM, V1 garde son filtre sans modèle", async () => {
    const w = await waitingWithReturn({ subject: "Réponse automatique : Connexion fictive", text: "Je suis absent jusqu'au 10 novembre.", headers: { "x-studio-automation-headers": "singleton-v1", "x-studio-automation-body": "complete-plain-v1", "auto-submitted": "auto-replied", "in-reply-to": "<sav-fictif@studio.example.invalid>", "content-type": "text/plain; charset=UTF-8" } });
    expect(await customerReturnGate(w.run.id, entry())).toBeNull();
    expect(calls).toEqual([]);
    expect(await inboundCount(w.caseId)).toBe(1);
    expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
    expect((await runRow(w.run.id)).isCurrent).toBe(true);
  });
  it("mail sans dossier : V1 normal ; un run déjà engagé ou un fil en pause reste à V1", async () => {
    const lone = await bareThread(), mail = await inbound(lone.threadId, lone.mailboxId, { receivedAt: T1 }), run = await queuedRun(lone.threadId, mail.id);
    expect(await customerReturnGate(run.id, entry())).toBeNull();
    expect(calls).toEqual([]);
    const engaged = await waitingWithReturn({ attempts: 1 });
    expect(await customerReturnGate(engaged.run.id, entry())).toBeNull();
    expect(await inboundCount(engaged.caseId)).toBe(1);
    const paused = await waitingWithReturn();
    await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, paused.threadId));
    expect(await customerReturnGate(paused.run.id, entry())).toBeNull();
    expect(await inboundCount(paused.caseId)).toBe(1);
  });
  it("V1 engage le run pendant la lecture du propriétaire : tout est annulé, aucun mail consommé, V1 garde la main", async () => {
    const w = await waitingWithReturn();
    const racing = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await f.db.update(savIntakeRuns).set({ attempts: 1 }).where(eq(savIntakeRuns.id, w.run.id));
      return network(input, init);
    });
    expect(await customerReturnGate(w.run.id, entry({ network: racing }))).toBeNull();
    expect(await inboundCount(w.caseId)).toBe(1);
    expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
    expect((await runRow(w.run.id)).isCurrent).toBe(true);
  });
  it("deux passes en même temps : un seul enregistrement, et un run créé plus tard pour le même mail ne repart jamais vers le modèle", async () => {
    const w = await waitingWithReturn();
    await Promise.all([customerReturnGate(w.run.id, entry()), customerReturnGate(w.run.id, entry())]);
    expect(await inboundCount(w.caseId)).toBe(2);
    const again = await queuedRun(w.threadId, w.reply.id, 0, 2);
    expect(await customerReturnGate(again.id, entry())).toEqual({ skipped: "v2_customer_return" });
    expect(await runRow(again.id)).toMatchObject({ isCurrent: false, state: "superseded" });
    expect(await inboundCount(w.caseId)).toBe(2);
  });
});

describe("sonde de l'entrée canonique : mail déjà consommé, réessai V1 et fermeture concurrente", () => {
  const canonical = (runId: string, env: Record<string, string> = ON) => analyseSavIntakeRuntime(runId, noConfig, { env: () => env, network: network as unknown as typeof fetch });
  const consumed = async () => {
    const w = await waitingWithReturn();
    expect(await canonical(w.run.id)).toEqual({ skipped: "v2_customer_return" });
    calls = [];
    return { w, version: (await readCase(w.caseId))!.version };
  };
  const modelCalls = async (runId: string) => (await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.runId, runId))).length;
  /** The other, later run of the same mail that V1 may hold: `current` moves off the closed one, as a new configuration does. */
  const secondRun = async (w: { threadId: string; reply: { id: string } }, values: Partial<typeof savIntakeRuns.$inferInsert> = {}) => {
    const run = await queuedRun(w.threadId, w.reply.id, 0, 2);
    await f.db.update(savIntakeRuns).set({ ...values, updatedAt: new Date() }).where(eq(savIntakeRuns.id, run.id));
    return run;
  };
  const untouched = async (w: { caseId: string; timerId: string }, version: number) => {
    expect((await readCase(w.caseId))!.version).toBe(version);
    expect(await inboundCount(w.caseId)).toBe(2);
    expect(calls).toEqual([]);
  };

  it("sonde : réveil rejoué sur le run déjà fermé : arrêt explicite, ni CRM ni claim ni modèle", async () => {
    const { w, version } = await consumed();
    expect(await canonical(w.run.id)).toEqual({ skipped: "v2_customer_return" });
    expect(await runRow(w.run.id)).toMatchObject({ attempts: 0, state: "superseded", isCurrent: false });
    expect(await modelCalls(w.run.id)).toBe(0);
    await untouched(w, version);
  });
  it("sonde : run suivant déjà tenté par V1 (attempts=1, state waiting, bail expiré) : fermé sans repartir vers V1", async () => {
    const { w, version } = await consumed();
    const retry = await secondRun(w, { attempts: 1, state: "waiting", leaseToken: randomUUID(), leaseUntil: new Date(Date.now() - 60_000) });
    expect(await canonical(retry.id)).toEqual({ skipped: "v2_customer_return" });
    expect(await runRow(retry.id)).toMatchObject({ attempts: 1, isCurrent: false, state: "superseded" });
    expect(await modelCalls(retry.id)).toBe(0);
    await untouched(w, version);
  });
  it("sonde : deuxième passe qui lit avant le commit de la première : la barrière refuse, l'entrée dit « consommé », jamais V1", async () => {
    const w = await waitingWithReturn();
    let nested = false;
    const racing = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      if (!nested) { nested = true; expect(await customerReturnGate(w.run.id, entry())).toEqual({ skipped: "v2_customer_return" }); }
      return network(request, init);
    });
    expect(await customerReturnGate(w.run.id, entry({ network: racing }))).toEqual({ skipped: "v2_customer_return" });
    expect(await inboundCount(w.caseId)).toBe(2);
    expect(await f.db.select().from(savIntakeJournal).where(and(eq(savIntakeJournal.runId, w.run.id), eq(savIntakeJournal.kind, "v2_customer_return")))).toHaveLength(1);
    expect(await runRow(w.run.id)).toMatchObject({ attempts: 0, isCurrent: false });
  });
  it("sonde : donné à l'équipe puis réessai : ce n'est PAS une consommation, le run reste à V1 pour que le mail parvienne à la personne", async () => {
    const w = await waitingWithReturn();
    ownerAnswer = PERSON;
    expect(await customerReturnGate(w.run.id, entry())).toBeNull();
    ownerAnswer = V2_OWNER;
    expect(await customerReturnGate(w.run.id, entry())).toBeNull();
    expect(await runRow(w.run.id)).toMatchObject({ isCurrent: true, attempts: 0 });
    expect((await f.db.select().from(savMessages).where(eq(savMessages.id, w.reply.id)))[0]!.analysisStatus).toBe("intake_pending");
  });
  it("sonde : une passe décide « continuer » pendant qu'une autre donne le mail à l'équipe : la fermeture du run est annulée avec sa transaction", async () => {
    const w = await waitingWithReturn();
    let nested = false;
    const racing = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      if (!nested) { nested = true; ownerAnswer = PERSON; await customerReturnGate(w.run.id, entry()); ownerAnswer = V2_OWNER; }
      return network(request, init);
    });
    expect(await customerReturnGate(w.run.id, entry({ network: racing }))).toBeNull();
    expect(await readCase(w.caseId)).toMatchObject({ owner: "human" });
    expect(await runRow(w.run.id)).toMatchObject({ isCurrent: true, state: "pending" });
    expect(await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, w.run.id))).toHaveLength(0);
  });
  it("sonde : V1 vraiment engagé sur le mail consommé (bail vivant, exécution, à rapprocher) : rien n'est coupé", async () => {
    const { w } = await consumed();
    const live = await secondRun(w, { attempts: 1, state: "analysing", leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) });
    expect(await customerReturnGate(live.id, entry())).toBeNull();
    expect(await runRow(live.id)).toMatchObject({ isCurrent: true, state: "analysing" });
    await f.db.update(savIntakeRuns).set({ leaseToken: null, leaseUntil: null, state: "uncertain" }).where(eq(savIntakeRuns.id, live.id));
    expect(await customerReturnGate(live.id, entry())).toBeNull();
    await f.db.update(savIntakeRuns).set({ state: "waiting" }).where(eq(savIntakeRuns.id, live.id));
    await f.db.insert(savIntakeExecutions).values({ messageId: w.reply.id, threadId: w.threadId, runVersion: 1, policyId, policyHash: "syn", state: "running", ticketId: null, payloadCiphertext: encryptSavPayload({}) });
    expect(await customerReturnGate(live.id, entry())).toBeNull();
    expect((await runRow(live.id)).isCurrent).toBe(true);
  });
  it("sonde : pause complète sur un mail consommé : ni modèle ni écriture", async () => {
    const { w, version } = await consumed();
    const retry = await secondRun(w, { attempts: 1, state: "waiting" }), before = await runRow(retry.id);
    await setPause("intake", "fully_paused");
    expect(await canonical(retry.id)).toHaveProperty("skipped");
    expect(await runRow(retry.id)).toEqual(before);
    await untouched(w, version);
  });
  it("sonde : le relais et son rattrapage sur un mail consommé n'écrivent rien de plus", async () => {
    const { w, version } = await consumed();
    await recordCaseAfterConfirmedIntake(w.reply.id, { ...v2EntryRelayDeps(ON, { network: network as unknown as typeof fetch }), env: ON, readProgress: vi.fn(async () => null) });
    await untouched(w, version);
  });
});

describe("déclencheur réel après commit et reprise durable (CONTRAT-A-B)", () => {
  it("le déclencheur appelle le point après le commit : le mail est déjà enregistré quand il s'exécute", async () => {
    const w = await waitingWithReturn();
    const seen: number[] = [];
    const point = vi.fn(async ({ caseId }: { caseId: string }) => { seen.push(await inboundCount(caseId)); return { status: "started" }; });
    expect(await customerReturnGate(w.run.id, entry({ continuation: point }))).toEqual({ skipped: "v2_customer_return" });
    expect(point).toHaveBeenCalledWith({ caseId: w.caseId, trigger: "customer_return", env: ON });
    expect(seen).toEqual([2]);
    expect(await failureMark(w.caseId)).toBeUndefined();
  });
  it("le point échoue après commit : rien n'est annulé, l'erreur reste visible et durable, puis la reprise réussit et efface le marqueur", async () => {
    const w = await waitingWithReturn();
    const failing = vi.fn(async () => { throw Error("SAV_SYN_POINT_DOWN"); });
    expect(await customerReturnGate(w.run.id, entry({ continuation: failing }))).toEqual({ skipped: "v2_customer_return" });
    expect(await inboundCount(w.caseId)).toBe(2);
    expect(errors).toHaveBeenCalledWith("sav_v2_entry_continuation", { caseId: w.caseId, trigger: "customer_return", errorCode: "SAV_SYN_POINT_DOWN" });
    expect((await failureMark(w.caseId))?.technicalMetadata).toMatchObject({ code: "SAV_SYN_POINT_DOWN", failures: 1 });
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: failing }));
    expect((await failureMark(w.caseId))?.technicalMetadata).toMatchObject({ failures: 2 });
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "started" }) }));
    expect(await failureMark(w.caseId)).toBeUndefined();
  });
  it("owner stop is durable, no_reply cannot hide it, and explicit owner return resumes normally", async () => {
    const w = await waitingWithReturn();
    const before = await readCase(w.caseId);
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "skipped", reason: "ticket_owner_human" }) }));
    const mark = (await failureMark(w.caseId))!.technicalMetadata;
    expect(mark).toMatchObject({ code: "ticket_owner_human", responsible: "ticket_owner", nextAction: "return_ticket_to_v2", failures: 1 });
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "no_reply", reason: "no_reply" }) }));
    expect((await failureMark(w.caseId))!.technicalMetadata).toEqual(mark);
    expect(await readCase(w.caseId)).toEqual(before);
    expect((await readCaseDiagnostics(w.ticketId))?.continuationStop).toMatchObject({ code: "ticket_owner_human", since: mark.since });
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "queued" }) }));
    expect(await failureMark(w.caseId)).toBeUndefined();
  });
  it("a scope task retains its first date across retries and no_reply preserves an unexpected failure", async () => {
    const w = await waitingWithReturn();
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => { throw Error("SAV_SYN_FAILURE"); } }));
    const first = (await failureMark(w.caseId))!.technicalMetadata;
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "no_reply" }) }));
    expect((await failureMark(w.caseId))!.technicalMetadata).toEqual(first);
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "human_task_required", reason: "access_scope_changed" }) }));
    expect((await failureMark(w.caseId))!.technicalMetadata).toMatchObject({ since: first.since, responsible: "sav_administrator", nextAction: "review_scope_and_decision", code: "access_scope_changed" });
  });
  it("crash entre le commit et le réveil : la reprise retrouve le dossier depuis la base ; une pause l'arrête ; un dossier d'équipe n'est jamais repris", async () => {
    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry({ continuation: async () => { throw Error("SAV_SYN_CRASH"); } }));
    const team = await waitingWithReturn();
    ownerAnswer = PERSON;
    await customerReturnGate(team.run.id, entry());
    ownerAnswer = V2_OWNER;
    await setPause("v2", "actions_paused");
    expect(await sweepCaseContinuations(entry())).toEqual({ skipped: "paused" });
    await setPause("v2", null);
    const woken: string[] = [];
    await sweepCaseContinuations(entry({ limit: 20, continuation: async ({ caseId }: { caseId: string }) => { woken.push(caseId); return { status: "started" }; } }));
    expect(woken).toContain(w.caseId);
    expect(woken).not.toContain(team.caseId);
  });
  it("un dossier qui échoue sans cesse ne garde pas sa place : la passe suivante essaie les autres", async () => {
    await waitingWithReturn().then(w => customerReturnGate(w.run.id, entry()));
    await waitingWithReturn().then(w => customerReturnGate(w.run.id, entry()));
    const tried: string[] = [], failing = async ({ caseId }: { caseId: string }) => { tried.push(caseId); throw Error("SAV_SYN_POINT_DOWN"); };
    expect(await sweepCaseContinuations(entry({ limit: 1, continuation: failing }))).toEqual({ tried: 1, failed: { SAV_SYN_POINT_DOWN: 1 } });
    await sweepCaseContinuations(entry({ limit: 1, continuation: failing }));
    expect(tried).toHaveLength(2);
    expect(tried[1]).not.toBe(tried[0]);
  });
  it("binds the real continuation without an injected callback and preserves the execution-policy gate", async () => {
    const w = await waitingWithReturn();
    expect(await continueCaseAfterCommit(w.caseId, "sweep", { env: ON })).toEqual({ status: "investigation_off" });
    expect(await continueCaseAfterCommit(w.caseId, "sweep", { env: { ...ON, SAV_V2_INVESTIGATION: "observe" } })).toEqual({ status: "failed", code: "SAV_V2_EXECUTION_POLICY_ABSENT" });
    expect((await failureMark(w.caseId))?.technicalMetadata).toMatchObject({ code: "SAV_V2_EXECUTION_POLICY_ABSENT" });
  });
  it("sans point explicitement disponible : `point_not_bound` est dit et compté, jamais présenté comme repris", async () => {
    const w = await waitingWithReturn();
    expect(await continueCaseAfterCommit(w.caseId, "sweep", { env: ON, continuation: null })).toEqual({ status: "failed", code: "point_not_bound" });
    expect((await failureMark(w.caseId))?.technicalMetadata).toMatchObject({ code: "point_not_bound" });
    expect(await sweepCaseContinuations({ env: { SAV_CASE_RECORDING: "on" } })).toEqual({ skipped: "off" });
  });
});

describe("après V1 : le relais route d'abord, puis admet sur l'effet réel confirmé", () => {
  const execution = async (messageId: string, threadId: string, ticketId: string, classification: string) => {
    await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "syn", state: "confirmed", ticketId,
      payloadCiphertext: encryptSavPayload({ plan: { decision: { messageId, classification, requests: [{ id: "r0", kind: classification }] } } }) });
    return { readProgress: vi.fn(async () => ({ state: "confirmed", ticketId, confirmed: true })) };
  };
  const proven = (gmail: string) => ({ readAdmissionPolicy: async () => ADMITTED.policy, readQualification: async () => ({ ...ADMITTED.qualification, requests: [{ ...ADMITTED.qualification.requests[0]!, requestId: `${gmail}/r0` }] }) });
  const relay = (overrides: object) => ({ ...v2EntryRelayDeps(ON, { network: network as unknown as typeof fetch }), ...overrides });

  it("nouveau mail sans dossier, V1 confirmé, ticket au SAV Pilote lu à l'instant : dossier à l'agent, aucune écriture CRM", async () => {
    const t = await bareThread(), mail = await inbound(t.threadId, t.mailboxId, { receivedAt: T1 }), ticketId = String(++ticketSeq);
    const result = await recordCaseAfterConfirmedIntake(mail.id, relay({ env: ON, ...await execution(mail.id, t.threadId, ticketId, "support"), ...proven(mail.gmail) }));
    expect(result).toMatchObject({ created: true, appended: true, owner: "agent" });
    expect(network.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });
  it.each([["une personne", PERSON], ["personne", null], ["illisible", "fail"]] as const)("propriétaire %s : aucune appropriation, le dossier attend avec l'équipe", async (_name, owner) => {
    const t = await bareThread(), mail = await inbound(t.threadId, t.mailboxId, { receivedAt: T1 }), ticketId = String(++ticketSeq);
    ownerAnswer = owner;
    const result = await recordCaseAfterConfirmedIntake(mail.id, relay({ env: ON, ...await execution(mail.id, t.threadId, ticketId, "support"), ...proven(mail.gmail) }));
    expect(result).toMatchObject({ created: true, owner: "human" });
    expect(await readCaseByTicket(ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    expect(network.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });
  it("finance ou résiliation : à l'équipe, sans même lire le propriétaire", async () => {
    for (const classification of ["finance", "cancellation"]) {
      const t = await bareThread(), mail = await inbound(t.threadId, t.mailboxId, { receivedAt: T1 }), ticketId = String(++ticketSeq);
      calls = [];
      const result = await recordCaseAfterConfirmedIntake(mail.id, relay({ env: ON, ...await execution(mail.id, t.threadId, ticketId, classification), ...proven(mail.gmail) }));
      expect(result).toMatchObject({ created: true, owner: "human", admission: { target: "team" } });
      expect(calls).toEqual([]);
    }
  });
  it("R01 de bout en bout : V1 a confirmé le mail sur un AUTRE ticket alors qu'un dossier est ouvert sur le fil : l'ancien dossier et son J2 restent intacts, un nouveau dossier s'ouvre", async () => {
    const w = await waitingWithReturn(), otherTicket = String(++ticketSeq), before = (await readCase(w.caseId))!;
    const result = await recordCaseAfterConfirmedIntake(w.reply.id, relay({ env: ON, ...await execution(w.reply.id, w.threadId, otherTicket, "support"), ...proven(w.reply.gmail) }));
    expect(result).toMatchObject({ created: true, appended: true });
    expect((await readCase(w.caseId))!.version).toBe(before.version);
    expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
    expect(await readCaseByTicket(otherTicket)).not.toBeNull();
  });
  it("le rattrapage emprunte le même chemin : un mail V1 confirmé sur le ticket d'un dossier ouvert est routé, jamais relayé à l'aveugle quand le propriétaire est illisible", async () => {
    const w = await waitingWithReturn(), progress = await execution(w.reply.id, w.threadId, w.ticketId, "support");
    ownerAnswer = "fail";
    expect(await recordCaseAfterConfirmedIntake(w.reply.id, relay({ env: ON, ...progress }))).toEqual({ skipped: "customer_return_wait" });
    await sweepCaseRelays({ limit: 50, deps: relay({ env: ON, ...progress }) });
    expect(await inboundCount(w.caseId)).toBe(1);
    expect(await timer(w.timerId)).toMatchObject({ state: "scheduled" });
    ownerAnswer = V2_OWNER;
    await sweepCaseRelays({ limit: 50, deps: relay({ env: ON, ...progress }) });
    expect(await inboundCount(w.caseId)).toBe(2);
    expect(await timer(w.timerId)).toMatchObject({ state: "cancelled", cancelReason: "customer_inbound" });
  });
  it("requalification après consommation, sensible : le dossier repart à l'équipe et la reprise ne le réveille plus", async () => {
    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry());
    const current = (await readCase(w.caseId))!;
    await reevaluateCaseAdmission({ caseId: w.caseId, expectedVersion: current.version, sourceRef: { type: "email", id: w.reply.gmail },
      admission: { ...ADMITTED, qualification: { ...ADMITTED.qualification, requests: [{ requestId: "fin", family: "finance", provenance: { kind: "intake_hint", source: { type: "email", id: w.reply.gmail } } }] } } });
    const woken: string[] = [];
    await sweepCaseContinuations(entry({ limit: 20, continuation: async ({ caseId }: { caseId: string }) => { woken.push(caseId); return { status: "started" }; } }));
    expect(woken).not.toContain(w.caseId);
  });
});

describe("SAV-18 : un dossier retenu par son bloc (arrêt ou pause) attend de façon durable et visible, sans prendre les places de la reprise", () => {
  const BLOCK_KEY = "sav-block-switch.v1:access";
  const setBlock = async (mode: "off" | "auto" | null, paused = false) => {
    await f.db.delete(savSyncState).where(eq(savSyncState.key, BLOCK_KEY));
    if (mode) await f.db.insert(savSyncState).values({ key: BLOCK_KEY, status: "active", cursor: encryptSavPayload({ revision: "sav-block-switch.v1", blockId: "access", mode, paused,
      setBy: "fixture@example.invalid", setAt: new Date().toISOString(), reason: "réglage fictif" }) });
  };
  const OLD = new Date("2000-01-01T00:00:00.000Z");
  afterEach(async () => { await setBlock(null); });
  /** A committed return whose passage the block held; dated oldest so that, without the fix, it would take the sweep's first slots. */
  const heldCase = async (offsetMs: number) => {
    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry({ continuation: async () => ({ status: "block_held", reason: "block_off", detail: "access" }) }));
    await f.db.update(savCases).set({ updatedAt: new Date(OLD.getTime() + offsetMs) }).where(eq(savCases.id, w.caseId));
    return w;
  };

  it("le blocage est enregistré et lisible dans les diagnostics, puis effacé par un passage non retenu", async () => {
    await setBlock("off");
    const w = await heldCase(0);
    expect(await readCaseBlockHold(w.caseId)).toMatchObject({ blockId: "access", reason: "block_off" });
    expect((await readCaseDiagnostics(w.ticketId))?.blockHold).toMatchObject({ blockId: "access", reason: "block_off" });
    expect(await failureMark(w.caseId)).toBeUndefined();
    await continueCaseAfterCommit(w.caseId, "sweep", entry({ continuation: async () => ({ status: "awaiting_person" }) }));
    expect(await readCaseBlockHold(w.caseId)).toBeNull();
    expect((await readCaseDiagnostics(w.ticketId))?.blockHold).toBeNull();
  });
  it("5 dossiers retenus + 1 normal : le normal est repris dès la première passe (4 places), aucun retenu n'est réveillé", async () => {
    await setBlock("off");
    const held: string[] = [];
    for (let i = 0; i < 5; i++) held.push((await heldCase(i * 1000)).caseId);
    const normal = await waitingWithReturn();
    await customerReturnGate(normal.run.id, entry({ continuation: async () => { throw Error("SAV_SYN_CRASH"); } }));
    await f.db.delete(auditLogs).where(and(eq(auditLogs.entityId, normal.caseId), eq(auditLogs.action, "sav_v2_continuation_failed")));
    await f.db.update(savCases).set({ updatedAt: new Date(OLD.getTime() + 10_000) }).where(eq(savCases.id, normal.caseId));
    const woken: string[] = [];
    await sweepCaseContinuations(entry({ continuation: async ({ caseId }: { caseId: string }) => { woken.push(caseId); return { status: "started" }; } }));
    expect(woken).toContain(normal.caseId);
    expect(woken.filter(id => held.includes(id))).toEqual([]);
  });
  it("le bloc repasse en automatique : chaque dossier retenu est repris une seule fois par la passe suivante et son marqueur s'efface", async () => {
    await setBlock("off");
    const held: string[] = [];
    for (let i = 0; i < 3; i++) held.push((await heldCase(20_000 + i * 1000)).caseId);
    const woken: string[] = [], point = async ({ caseId }: { caseId: string }) => { woken.push(caseId); return { status: "started" }; };
    await sweepCaseContinuations(entry({ limit: 20, continuation: point }));
    expect(woken.filter(id => held.includes(id))).toEqual([]);
    await setBlock("auto");
    await sweepCaseContinuations(entry({ limit: 20, continuation: point }));
    for (const id of held) {
      expect(woken.filter(seen => seen === id)).toHaveLength(1);
      expect(await readCaseBlockHold(id)).toBeNull();
    }
  });
});

describe("qualification scope (15/11) : la reprise n'est plus affamée par des dossiers hors périmètre, et chaque saut est visible sans donnée personnelle", () => {
  const OLD = new Date("2000-01-01T00:00:00.000Z");
  const scoped = () => {
    const scope = { schema: SAV_V2_QUALIFICATION_SCOPE_SCHEMA as typeof SAV_V2_QUALIFICATION_SCOPE_SCHEMA, revision: `q-syn-entry-${randomUUID().slice(0, 8)}`, senderEmail: "client.fictif@example.invalid", hubspotContactId: "100000777",
      initialSubject: "Connexion fictive", notBefore: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    return { scope, env: { ...ON, SAV_V2_SCOPE_MODE: "qualification", SAV_V2_QUALIFICATION_SCOPE_JSON: JSON.stringify(scope) } };
  };
  const bind = async (scope: ReturnType<typeof scoped>["scope"], threadId: string) => f.db.insert(savSyncState).values({ key: `sav-v2-qualification-thread.v1:${scope.revision}`, status: "bound",
    cursor: JSON.stringify({ threadId, messageId: randomUUID(), configHash: savV2QualificationScopeHash(scope), boundAt: new Date().toISOString() }) });
  /** An agent case, queued after a crash between its commit and its continuation (no failure mark), dated so that the oldest come first. */
  const queuedCase = async (offsetMs: number) => {
    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry({ continuation: async () => { throw Error("SAV_SYN_CRASH"); } }));
    await f.db.delete(auditLogs).where(and(eq(auditLogs.entityId, w.caseId), eq(auditLogs.action, "sav_v2_continuation_failed")));
    await f.db.update(savCases).set({ updatedAt: new Date(OLD.getTime() + offsetMs) }).where(eq(savCases.id, w.caseId));
    return w;
  };
  let infos: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { infos = vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { infos.mockRestore(); });

  it("4 dossiers hors périmètre plus anciens + 1 dans le périmètre : le dossier du testeur est repris dès la première passe, les autres ne prennent aucune place", async () => {
    const { scope, env } = scoped();
    const outside: string[] = [];
    for (let i = 0; i < 4; i++) outside.push((await queuedCase(30_000 + i * 1000)).caseId);
    const tester = await queuedCase(40_000);
    await bind(scope, tester.threadId);
    const woken: string[] = [];
    const outcome = await sweepCaseContinuations({ ...entry({ continuation: async ({ caseId }: { caseId: string }) => { woken.push(caseId); return { status: "started" }; } }), env });
    expect(woken).toContain(tester.caseId);
    expect(woken.filter(id => outside.includes(id))).toEqual([]);
    expect(outcome).toMatchObject({ outOfScope: expect.any(Number) });
    expect((outcome as { outOfScope: number }).outOfScope).toBeGreaterThanOrEqual(4);
    const durable = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_v2_continuation_failed"));
    expect(durable.some(mark => String(mark.technicalMetadata.code).startsWith("qualification_"))).toBe(true);
  });
  it("50 exclus puis un admis : la qualification réelle atteint le 51e au deuxième passage", async () => {
    const { scope, env } = scoped(), tester = await queuedCase(60_000);
    await bind(scope, tester.threadId);
    const [template] = await f.db.select().from(savCases).where(eq(savCases.id, tester.caseId));
    await f.db.update(savCases).set({ phase: "awaiting_customer" }).where(eq(savCases.id, tester.caseId));
    const ids = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    await f.db.insert(savCases).values(ids.map((id, i) => ({ ...template!, id, ticketId: String(910_000 + i), threadIds: i === 50 ? [tester.threadId] : [] })));
    const continuation = vi.fn(async () => ({ status: "started" }));
    expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 0, failed: {}, outOfScope: 50 });
    expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 1, failed: {}, outOfScope: 49 });
    expect(continuation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ caseId: ids[50], trigger: "sweep" }));
  });
  it("un dossier hors périmètre : `sav_v2_continuation_skipped` avec seulement l'id du dossier et un code fermé ; `investigation_off` aussi", async () => {
    const { env } = scoped();
    const w = await queuedCase(50_000);
    expect(await continueCaseAfterCommit(w.caseId, "sweep", entry({ env, continuation: async () => ({ status: "started" }) }))).toEqual({ status: "qualification_out_of_scope" });
    expect(infos).toHaveBeenCalledWith("sav_v2_continuation_skipped", { caseId: w.caseId, reason: "qualification_thread_unbound" });
    expect((await failureMark(w.caseId))?.technicalMetadata).toMatchObject({ code: "qualification_thread_unbound", responsible: "sav_administrator", nextAction: "review_scope_and_decision" });
    expect(await continueCaseAfterCommit(w.caseId, "sweep", { env: ON })).toEqual({ status: "investigation_off" });
    expect(infos).toHaveBeenCalledWith("sav_v2_continuation_skipped", { caseId: w.caseId, reason: "investigation_off" });
    const logged = JSON.stringify(infos.mock.calls.filter((call: unknown[]) => call[0] === "sav_v2_continuation_skipped"));
    expect(logged).not.toMatch(/@|fictive|fictif|Connexion/i);
  });
});

describe("SAV-92 (revue batch 3, B1) : une partie équipe dont la notice ne peut pas être mise en file est une attente visible et bornée", () => {
  const refused = async () => ({ status: "proposal_refused", reason: "team_part_handoff_unavailable", detail: "disabled" });
  const pass = (caseId: string, continuation: () => Promise<{ status: string; reason?: string; detail?: string }>) => continueCaseAfterCommit(caseId, "sweep", entry({ continuation }));

  it("le code fermé du refus arrive jusqu'à l'entrée (rapport de continuation)", () => {
    expect(caseContinuationReport("proposal_refused", { code: "team_part_handoff_unavailable", detail: "disabled" }))
      .toEqual({ status: "proposal_refused", reason: "team_part_handoff_unavailable", detail: "disabled" });
  });

  it("le refus est marqué et lisible dans les diagnostics ; un passage suivant sans ce refus l'efface (cas transitoire)", async () => {
    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry({ continuation: refused }));
    expect(await readCaseTeamPartWait(w.caseId)).toMatchObject({ code: "team_part_handoff_unavailable", detail: "disabled", passes: 1, handedToTeam: null });
    expect((await readCaseDiagnostics(w.ticketId))?.teamPartWait).toMatchObject({ code: "team_part_handoff_unavailable", detail: "disabled", passes: 1, handedToTeam: null });
    expect(await failureMark(w.caseId)).toBeUndefined();
    expect((await readCase(w.caseId))?.owner).toBe("agent");
    await pass(w.caseId, async () => ({ status: "queued" }));
    expect(await readCaseTeamPartWait(w.caseId)).toBeNull();
    expect((await readCaseDiagnostics(w.ticketId))?.teamPartWait).toBeNull();
  });

  it(`après ${SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxPasses} passages refusés, le mail entier part à l'équipe (transfert visible), et la reprise ne le retente plus`, async () => {
    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry({ continuation: refused }));
    for (let i = 2; i < SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxPasses; i++) await pass(w.caseId, refused);
    expect(await readCaseTeamPartWait(w.caseId)).toMatchObject({ passes: SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxPasses - 1, handedToTeam: null });
    expect((await readCase(w.caseId))?.owner).toBe("agent");
    await pass(w.caseId, refused);
    const handed = (await readCase(w.caseId))!;
    expect(handed).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "team_part_handoff_unavailable" } } });
    const mark = await readCaseTeamPartWait(w.caseId);
    expect(mark).toMatchObject({ passes: SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxPasses, handedToTeam: expect.any(String) });
    expect((await readCaseDiagnostics(w.ticketId))?.teamPartWait?.handedToTeam).toBe(mark!.handedToTeam);
    const transfers = (await listCaseEvents(w.caseId)).filter(event => event.kind === "owner_changed" && (event.detail as { reason?: string } | null)?.reason === "team_part_handoff_unavailable");
    expect(transfers).toHaveLength(1);
    // The sweep only takes the agent's queued cases: the handed-off case is not retried any more.
    const woken: string[] = [];
    await sweepCaseContinuations(entry({ limit: 20, continuation: async ({ caseId }: { caseId: string }) => { woken.push(caseId); return refused(); } }));
    expect(woken).not.toContain(w.caseId);
  });

  it("borne de temps : au-delà de 2 heures depuis le premier refus, le passage refusé suivant remet le mail à l'équipe", async () => {
    const t0 = new Date("2026-11-15T08:00:00.000Z");
    const first = nextCaseTeamPartWait(null, "disabled", t0);
    expect(first).toMatchObject({ bounded: false, wait: { passes: 1, since: t0.toISOString() } });
    expect(nextCaseTeamPartWait(first.wait, "disabled", new Date(t0.getTime() + SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxWaitMs - 1)).bounded).toBe(false);
    expect(nextCaseTeamPartWait(first.wait, "disabled", new Date(t0.getTime() + SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxWaitMs)).bounded).toBe(true);
    // Unknown details are closed; a wait already handed to the team and refused again starts a new bounded wait.
    expect(nextCaseTeamPartWait(null, "some free text", t0).wait.detail).toBe("other");
    expect(nextCaseTeamPartWait(null, "no_record", t0).wait.detail).toBe("trigger_refused");
    expect(nextCaseTeamPartWait({ ...first.wait, passes: 9, handedToTeam: t0.toISOString() }, "disabled", t0).wait).toMatchObject({ passes: 1, handedToTeam: null });

    const w = await waitingWithReturn();
    await customerReturnGate(w.run.id, entry({ continuation: refused }));
    const old = { ...(await readCaseTeamPartWait(w.caseId))!, since: new Date(Date.now() - SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxWaitMs - 60_000).toISOString() };
    await f.db.update(auditLogs).set({ technicalMetadata: old }).where(and(eq(auditLogs.entityId, w.caseId), eq(auditLogs.action, "sav_v2_continuation_team_part_wait")));
    await pass(w.caseId, refused);
    expect(await readCase(w.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    expect(await readCaseTeamPartWait(w.caseId)).toMatchObject({ passes: 2, handedToTeam: expect.any(String) });
  });
});
