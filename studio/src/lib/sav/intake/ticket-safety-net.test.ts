/** SAV-88: the safety net is a trigger, never a writer. One recorded rescue attempt per message, consumed by the
 * normal V1 claim; a failed rescue is terminal and "à traiter à la main". Synthetic data only. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeJournal, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun, pendingSavIntakeRuns, readSavIntakeCurrent, saveSavIntakeResult, savIntakeSourceSnapshot } from "./runtime-store";
import { expireIntakeReadRecoveries } from "./read-recovery-store";
import { newReadRecovery } from "./read-recovery";
import { SAV_INTAKE_RESUME_REVISION } from "./resume-progress";
import { listIntakeConsole } from "./console-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { SAV_INTAKE_ATTEMPT_POLICY } from "./attempt-policy";
import { savAgentPauseKey, SAV_AGENT_PAUSE_REVISION } from "./agent-pause";
import { listTicketSafetyNet, readTicketSafetyNetBacklog, reconcileTicketSafetyNet } from "./ticket-safety-net";

const KEY = "synthetic-intake-runtime-encryption-key";
const HOUR = 3_600_000;
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, pins: { receivedAfter: string; createdAfter: string; expiresAt: string };
function env(codeRevision = "0".repeat(40), extra: Record<string, string> = {}) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: codeRevision, SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, ...pins, codeRevision, policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }),
    ...extra } as Record<string, string | undefined>;
}
const configOf = (e: Record<string, string | undefined>) => savIntakeRuntimeConfig(e)!;
const revision = (n: number) => String(n % 10).repeat(40);
const execute = (n: number) => env(revision(n), { SAV_INTAKE_TICKET_SAFETY_NET: "execute" });

async function message(ageMs: number, text = "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.") {
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning();
  // Received `ageMs` ago, stored just now (inside the configuration window): the age is the reception's.
  const at = new Date(Date.now() - ageMs), stored = new Date(Date.now() - 1000);
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments: [], headers: {} }),
    receivedAt: at, createdAt: stored, analysisStatus: "pending" }).returning();
  return m;
}
async function observe(runId: string) {
  const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  const payload = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
  await f.db.update(savIntakeRuns).set({ attempts: run.attempts + 1, state: "observed", leaseUntil: null, leaseToken: null,
    payloadCiphertext: encryptSavPayload({ ...payload, plan: { synthetic: true } }) }).where(eq(savIntakeRuns.id, runId));
}
/** A message whose lifetime attempts were used up by successive deployments (production pattern of 12/11), ending on
 * deployment `n` with the re-created version exactly as production leaves it: never claimed, no attempts_exhausted marker. */
async function exhausted(ageMs = 30 * HOUR, n = SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage, text?: string) {
  const m = await message(ageMs, text);
  let id = (await enqueueSavIntakeMessage(m.id, configOf(env(revision(0)))))!;
  for (let i = 1; i <= n; i++) { await observe(id); id = (await enqueueSavIntakeMessage(m.id, configOf(env(revision(i)))))!; }
  return { m, runId: id, config: configOf(env(revision(n))) };
}
const journal = async (runId: string) => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, runId))).map(j => j.kind);
const kinds = async (kind: string) => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.kind, kind))).length;
function provider(messageId: string, kind = "support") {
  let model = 0;
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      model++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      const quoteId = data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id;
      const answer = { messageId, requests: [{ id: "r1", kind, currentMessageId: messageId, quoteId }],
        ticketSummary: { title: "Synchronisation agenda", description: "La synchronisation échoue.", requestIds: ["r1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) return Response.json({ total: 0, results: [] });
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, calls: () => model };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("EXTERNAL_NETWORK_FORBIDDEN"); }));
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state WHERE key LIKE 'sav-agent-pause%'");
  const now = Date.now();
  pins = { receivedAfter: new Date(now - 30 * 24 * HOUR).toISOString(), createdAfter: new Date(now - 600_000).toISOString(), expiresAt: new Date(now + HOUR).toISOString() };
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("SAV-88 rescue through V1", () => {
  it("observe (default) lists and counts the exhausted dossier, writes nothing and calls nothing", async () => {
    const { runId } = await exhausted();
    const report = await reconcileTicketSafetyNet({ env: env(revision(8)) });
    expect(report).toMatchObject({ mode: "observe", eligible: 1, granted: 0, withoutTicketOver24h: 1 });
    expect(report.items).toMatchObject([{ category: "rescue_eligible", cause: "attempts_exhausted", over24h: true }]);
    expect(await kinds("rescue_granted")).toBe(0);
    expect(await journal(runId)).not.toContain("rescue_granted");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("execute grants ONE rescue that the normal V1 claim consumes once; a V1 decision reached by the rescue is the end of the rescue, not a failure", async () => {
    const { m, runId, config } = await exhausted();
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(1);
    expect((await pendingSavIntakeRuns(config)).map(r => r.id)).toContain(runId);
    const p = provider(m.id, "acknowledgement");
    await analyseSavIntakeRuntime(runId, config, { env: () => execute(8), network: p.network });
    expect(p.calls()).toBeLessThanOrEqual(1);
    expect(await journal(runId)).toEqual(expect.arrayContaining(["rescue_granted", "rescue_claimed", "claimed", "observed"]));
    expect(await journal(runId)).not.toContain("rescue_failed");
    const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
    expect(run).toMatchObject({ attempts: 1, state: "observed" });
    // V1's own decision (here: an acknowledgement, no ticket by the V1 rule): not listed, not « à la main ».
    expect(await listTicketSafetyNet(config)).toEqual([]);
    expect((await listIntakeConsole({ mailboxId })).rows.find(r => r.threadId === m.threadId)?.blockedCause ?? null).toBeNull();
    await f.db.update(savIntakeRuns).set({ state: "waiting", leaseUntil: null, leaseToken: null }).where(eq(savIntakeRuns.id, runId));
    expect(await claimSavIntakeRun(runId, config)).toBeNull();
    expect(await kinds("rescue_claimed")).toBe(1);
  });

  it("a legitimate V1 human choice reached by the rescue goes to the team's queue (observed), never « à la main »", async () => {
    const { m, runId, config } = await exhausted(30 * HOUR, 8, "Merci de me rappeler cet après-midi, j'ai manqué votre appel.");
    await reconcileTicketSafetyNet({ env: execute(8) });
    await analyseSavIntakeRuntime(runId, config, { env: () => execute(8), network: provider(m.id, "acknowledgement").network });
    const current = await readSavIntakeCurrent(m.threadId, config);
    expect(current?.payload.plan?.progress.kind).toBe("human_choice");
    expect(await journal(runId)).not.toContain("rescue_failed");
    expect(await listTicketSafetyNet(config)).toMatchObject([{ messageId: m.id, category: "human_decision" }]);
  });

  it("B2: a rescue that ends in a dead-end wait (collect_context without a human choice) is « à traiter à la main », in the list and the console", async () => {
    const { m, runId, config } = await exhausted();
    await reconcileTicketSafetyNet({ env: execute(8) });
    // Support request, no HubSpot contact, no approved identification resource: V1 waits on private_resource_unavailable.
    await analyseSavIntakeRuntime(runId, config, { env: () => execute(8), network: provider(m.id).network });
    const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
    expect(run.state).toBe("waiting");
    expect(await journal(runId)).toContain("rescue_failed");
    expect(await listTicketSafetyNet(config)).toMatchObject([{ messageId: m.id, category: "manual", cause: "rescue_failed" }]);
    expect((await listIntakeConsole({ mailboxId })).rows.find(r => r.threadId === m.threadId)?.blockedCause).toBe("manual_required");
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(0);
  });

  it("B2: a full agent pause during the rescue gives it back (attempt and rescue), it runs once after the resume and is never marked failed", async () => {
    const { runId, config } = await exhausted();
    await reconcileTicketSafetyNet({ env: execute(8) });
    const lease = (await claimSavIntakeRun(runId, config))!;
    await failSavIntakeRun(lease, { revision: "x", effects: "not_connected", reason: "SAV_INTAKE_AGENT_FULLY_PAUSED" } as never);
    expect(await journal(runId)).toEqual(expect.arrayContaining(["rescue_claimed", "agent_paused", "rescue_returned"]));
    expect(await journal(runId)).not.toContain("rescue_failed");
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)))[0].attempts).toBe(0);
    expect(await listTicketSafetyNet(config)).toMatchObject([{ category: "rescue_pending" }]);
    expect((await pendingSavIntakeRuns(config)).map(r => r.id)).toContain(runId);
    expect(await claimSavIntakeRun(runId, config)).toBeTruthy();
    expect(await kinds("rescue_claimed")).toBe(2);
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(0);
  });

  it("a failed rescue is terminal: rescue_failed, never scheduled or rescued again, « à traiter à la main » in the console and the morning list", async () => {
    const { m, runId, config } = await exhausted();
    await reconcileTicketSafetyNet({ env: execute(8) });
    const lease = (await claimSavIntakeRun(runId, config))!;
    expect(lease).toBeTruthy();
    await failSavIntakeRun(lease, { revision: "x", effects: "not_connected", reason: "SAV_AI_HTTP_400" } as never);
    expect(await journal(runId)).toContain("rescue_failed");
    expect(await pendingSavIntakeRuns(config)).toEqual([]);
    expect(await claimSavIntakeRun(runId, config)).toBeNull();
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(0);
    expect(await listTicketSafetyNet(config)).toMatchObject([{ messageId: m.id, category: "manual", cause: "rescue_failed" }]);
    expect((await listIntakeConsole({ mailboxId })).rows.find(r => r.threadId === m.threadId)?.blockedCause).toBe("manual_required");
    expect(await readTicketSafetyNetBacklog(execute(8))).toMatchObject({ available: true, manual: 1, withoutTicketOver24h: 1, dossiers: [{ messageId: m.id, category: "manual" }] });
  });

  it("exactly one rescue per message, even with three concurrent passes and three concurrent claims", async () => {
    const { runId, config } = await exhausted();
    const passes = await Promise.all([1, 2, 3].map(() => reconcileTicketSafetyNet({ env: execute(8) })));
    expect(passes.reduce((s, r) => s + r.granted, 0)).toBe(1);
    expect(await kinds("rescue_granted")).toBe(1);
    const leases = await Promise.all([1, 2, 3].map(() => claimSavIntakeRun(runId, config)));
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect(await kinds("rescue_claimed")).toBe(1);
  });

  it("a rescue already used is not given again on a later version: listed « à traiter à la main »", async () => {
    const { m, runId, config } = await exhausted();
    await reconcileTicketSafetyNet({ env: execute(8) });
    await observe((await claimSavIntakeRun(runId, config))!.run.id);
    // Production path: the deployment re-creates a version that V1 never claims (lifetime cap), so it carries no marker.
    const next = (await enqueueSavIntakeMessage(m.id, configOf(env(revision(9)))))!;
    expect((await pendingSavIntakeRuns(configOf(env(revision(9))))).map(r => r.id)).not.toContain(next);
    expect((await reconcileTicketSafetyNet({ env: execute(9) })).granted).toBe(0);
    expect(await listTicketSafetyNet(configOf(env(revision(9))))).toMatchObject([{ messageId: m.id, category: "manual", cause: "rescue_used" }]);
    expect((await listIntakeConsole({ mailboxId })).rows.find(r => r.threadId === m.threadId)?.blockedCause).toBe("manual_required");
    // If V1 ever claimed it, the exhaustion would be recorded as the end of the rescue, never as a fresh attempts_exhausted.
    expect(await claimSavIntakeRun(next, configOf(env(revision(9))))).toBeNull();
    expect(await journal(next)).toEqual(expect.arrayContaining(["rescue_failed"]));
    expect(await journal(next)).not.toContain("attempts_exhausted");
  });

  it("a configuration change between the grant and the claim strands nothing: the new version can take the unused rescue", async () => {
    const { m } = await exhausted();
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(1);
    const next = (await enqueueSavIntakeMessage(m.id, configOf(env(revision(9)))))!;
    expect(await claimSavIntakeRun(next, configOf(env(revision(9))))).toBeNull();
    expect(await listTicketSafetyNet(configOf(env(revision(9))))).toMatchObject([{ category: "rescue_eligible" }]);
    expect((await reconcileTicketSafetyNet({ env: execute(9) })).granted).toBe(1);
    expect(await claimSavIntakeRun(next, configOf(env(revision(9))))).toBeTruthy();
  });

  it("bounded batch, oldest first; blocked-only dossiers are listed but never take a slot", async () => {
    const stuck = await message(90 * HOUR), cfg0 = configOf(env(revision(0)));
    const stuckRun = (await enqueueSavIntakeMessage(stuck.id, cfg0))!;
    await failSavIntakeRun((await claimSavIntakeRun(stuckRun, cfg0))!, { revision: "x", effects: "not_connected", reason: "SAV_INTAKE_INPUT_INVALID" } as never, false, { deterministic: true });
    const dossiers = [];
    for (let i = 0; i < 7; i++) dossiers.push(await exhausted((80 - i) * HOUR));
    const first = await reconcileTicketSafetyNet({ env: execute(8), batch: 5 });
    expect(first).toMatchObject({ eligible: 7, granted: 5 });
    const granted = async () => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.kind, "rescue_granted"))).map(j => j.runId);
    expect(new Set(await granted())).toEqual(new Set(dossiers.slice(0, 5).map(d => d.runId)));
    expect((await reconcileTicketSafetyNet({ env: execute(8), batch: 5 })).granted).toBe(2);
    expect(first.items.find(i => i.messageId === stuck.id)).toMatchObject({ category: "manual" });
  });

  it("a rescue on a run that holds a CRM resume proof is claimed after the probe (the second, fenced pass keeps the rescue)", async () => {
    const { m, runId, config } = await exhausted();
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(1);
    const [row] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
    const [stored] = await f.db.select().from(savMessages).where(eq(savMessages.id, m.id));
    const resumeProof = { revision: SAV_INTAKE_RESUME_REVISION, configHash: config.configHash, sourceHash: (await savIntakeSourceSnapshot(f.db as never, stored, new Date())).sourceHash,
      incomplete: "SAV_INTAKE_READ_FAILED", truncated: false, reads: [{ method: "ticketsForContact" as const, arg: "synthetic-contact", status: "failed" as const, digest: "a".repeat(64) }] };
    // A version that waited on an incomplete CRM read holds the proof (state waiting, as runtime.ts leaves it).
    await f.db.update(savIntakeRuns).set({ state: "waiting", payloadCiphertext: encryptSavPayload({ ...decryptSavPayload<IntakeRuntimePayload>(row.payloadCiphertext), resumeProof }) }).where(eq(savIntakeRuns.id, runId));
    const probe = vi.fn(async () => ({ state: "progress" as const, method: "ticketsForContact" as const, change: "completed" as const, checked: 1 }));
    const lease = await claimSavIntakeRun(runId, config, new Date(), { probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(lease).toBeTruthy();
    expect(await kinds("rescue_claimed")).toBe(1);
  });

  it("a rescue left waiting on a read recovery that then expires ends « à traiter à la main », never an open rescue", async () => {
    const { m, runId, config } = await exhausted();
    expect((await reconcileTicketSafetyNet({ env: execute(8) })).granted).toBe(1);
    expect((await pendingSavIntakeRuns(config)).map(r => r.id)).toContain(runId);
    const lease = (await claimSavIntakeRun(runId, config))!;
    const readRecovery = { ...newReadRecovery(config, lease.sourceHash), state: "scheduled" as const, operation: "ticketsForContact", code: "SAV_HUBSPOT_HTTP_503", attempts: 1,
      retryAt: new Date(Date.now() + 60_000).toISOString() };
    await saveSavIntakeResult(lease, config, { ...decryptSavPayload<IntakeRuntimePayload>(lease.run.payloadCiphertext), reason: "SAV_HUBSPOT_HTTP_503", readRecovery,
      plan: { decision: { messageId: m.id, classification: "support", disposition: { kind: "collect_context", reasons: ["crm_read_incomplete"] }, evidence: [] }, progress: { kind: "processing" } } } as never, "waiting");
    // A legitimate pending read retry is not a failure yet.
    expect(await journal(runId)).not.toContain("rescue_failed");
    const later = new Date(Date.parse(readRecovery.expiresAt) + 1000);
    expect(await expireIntakeReadRecoveries(config, later)).toBe(1);
    expect(await pendingSavIntakeRuns(config, later)).toEqual([]);
    expect(await journal(runId)).toContain("rescue_failed");
    expect(await listTicketSafetyNet(config, later)).toMatchObject([{ messageId: m.id, category: "manual", cause: "rescue_failed" }]);
    expect((await listIntakeConsole({ mailboxId })).rows.find(r => r.threadId === m.threadId)?.blockedCause).toBe("manual_required");
  });

  it("a full agent pause grants nothing", async () => {
    await exhausted();
    await f.db.insert(savSyncState).values({ key: savAgentPauseKey("intake"), status: "set", cursor: encryptSavPayload({ revision: SAV_AGENT_PAUSE_REVISION, agent: "intake", level: "fully_paused",
      setBy: "synthetic-admin", setAt: new Date().toISOString(), reason: "synthetic pause" }) });
    expect(await reconcileTicketSafetyNet({ env: execute(8) })).toMatchObject({ granted: 0, skipped: "agent_paused" });
    expect(await kinds("rescue_granted")).toBe(0);
  });

  it("V1 decisions are never contradicted: no-ticket mails are not listed, human decisions and pending executions are listed as such, young dossiers are not", async () => {
    const plan = (disposition: Record<string, unknown>, progress = { kind: "processing" }) => ({ decision: { messageId: "x", classification: "support", disposition }, progress });
    const cases: [Record<string, unknown>, string | null][] = [
      [plan({ kind: "no_ticket", reason: "outside_support" }), null],
      [plan({ kind: "no_ticket", reason: "acknowledgement_only" }), null],
      [plan({ kind: "collect_context", reasons: ["same_issue_unresolved"] }, { kind: "human_choice" }), "human_decision"],
      [plan({ kind: "ticket", target: { operation: "create" } }), "execution_pending"],
    ];
    const ids: string[] = [];
    for (const [p] of cases) {
      const m = await message(30 * HOUR), id = (await enqueueSavIntakeMessage(m.id, configOf(env(revision(0)))))!;
      await f.db.update(savIntakeRuns).set({ state: "observed", attempts: 1, payloadCiphertext: encryptSavPayload({ revision: "x", effects: "not_connected", plan: p }) }).where(eq(savIntakeRuns.id, id));
      ids.push(m.id);
    }
    const young = await message(2 * HOUR);
    await enqueueSavIntakeMessage(young.id, configOf(env(revision(0))));
    const items = await listTicketSafetyNet(configOf(env(revision(0))));
    cases.forEach(([, category], i) => expect(items.find(x => x.messageId === ids[i])?.category ?? null).toBe(category));
    expect(items.find(x => x.messageId === young.id)).toBeUndefined();
    expect((await reconcileTicketSafetyNet({ env: { ...env(revision(0)), SAV_INTAKE_TICKET_SAFETY_NET: "execute" } })).granted).toBe(0);
    expect(await f.db.select().from(savIntakeJournal).where(and(eq(savIntakeJournal.kind, "rescue_granted")))).toEqual([]);
  });

  it("SAV-90: a dossier under a human pause is a human decision (human_hold), never « in progress / pending » nor a rescue", async () => {
    // A pending version recreated by deployments on a paused thread (production pattern), and an exhausted one.
    const pending = await message(200 * HOUR);
    await enqueueSavIntakeMessage(pending.id, configOf(env(revision(0))));
    const { m: spent } = await exhausted();
    const young = await message(2 * HOUR);
    await enqueueSavIntakeMessage(young.id, configOf(env(revision(8))));
    for (const m of [pending, spent, young]) await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, m.threadId));
    const items = await listTicketSafetyNet(configOf(env(revision(8))));
    expect(items.find(x => x.messageId === pending.id)).toMatchObject({ category: "human_decision", cause: "human_hold", over24h: true });
    expect(items.find(x => x.messageId === spent.id)).toMatchObject({ category: "human_decision", cause: "human_hold" });
    expect(items.find(x => x.messageId === young.id)).toBeUndefined();
    const report = await reconcileTicketSafetyNet({ env: execute(8) });
    expect(report).toMatchObject({ eligible: 0, granted: 0 });
    expect(await kinds("rescue_granted")).toBe(0);
    // The pause lifted, the same dossier is listed as before (no change to the other categories).
    await f.db.update(savThreads).set({ aiPaused: false }).where(eq(savThreads.id, pending.threadId));
    expect((await listTicketSafetyNet(configOf(env(revision(8))))).find(x => x.messageId === pending.id)).toMatchObject({ category: "in_progress" });
  });
});
