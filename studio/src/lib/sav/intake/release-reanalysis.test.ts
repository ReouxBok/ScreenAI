/** A release (new code revision, hence a new configHash) must not re-open a decided dossier, and a re-analysis caused
 * only by a release must not consume the lifetime attempt budget. Synthetic data only: fake model and CRM, PGlite. */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeJournal, savIntakeHumanEvents, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { catchupSavIntake, claimSavIntakeRun, enqueueSavIntakeMessage, readSavIntakeCurrent } from "./runtime-store";
import { intakeBlockedCauseSql, refreshIntakeConsole } from "./console-store";
import { intakeBlockedRowLabel } from "./console-presentation";
import { readIntakeRunDiagnostics } from "./run-diagnostics";
import { analyseSavIntakeRuntime } from "./runtime";
import { recordIntakeHumanCommand } from "./human-commands";
import { consumeIntakeHumanEvent } from "./human-worker";
import { humanRevisionConfigHash } from "./human-binding";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { SAV_INTAKE_ATTEMPT_POLICY } from "./attempt-policy";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
/** One approved identification template, so an unknown sender gets a real V1 decision (request_identification). */
const text = "Synthetic approved identification template";
const identification = { resourceId: "synthetic-identification", revisionId: "synthetic-v1", sha256: createHash("sha256").update(text).digest("hex") };
const catalogue = () => [{ resource: identification, text, approvalId: "synthetic-approval", approvedBy: "synthetic-reviewer", approvedAt: new Date(Date.now() - 600_000).toISOString(), status: "approved" }];
function env(codeRevision: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: { identification } }, resources = catalogue();
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: codeRevision, SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(resources),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision, policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash(resources), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
/** Release n: only the code revision changes, as on every production delivery. */
const release = (n: number) => { const e = env(String(n % 10).repeat(39) + "f"); return { env: e, config: savIntakeRuntimeConfig(e)! as IntakeRuntimeConfig }; };
async function stored(text: string) {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  return m;
}
const kinds = async (runId: string) => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, runId))).map(j => j.kind);
const runsOf = (messageId: string) => f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId));
/** Fake model: one acknowledgement, or one support request, citing the current mail. */
function model(messageId: string, kind: "acknowledgement" | "support") {
  let calls = 0;
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      calls++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      const quoteId = data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id;
      const answer = kind === "acknowledgement" ? { messageId, requests: [{ id: "ack", kind, currentMessageId: messageId, quoteId }] }
        : { messageId, requests: [{ id: "r1", kind, currentMessageId: messageId, quoteId }], ticketSummary: { title: "Synchronisation agenda", description: "La synchronisation échoue.", requestIds: ["r1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) return Response.json({ total: 0, results: [] });
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, calls: () => calls };
}
async function blockedCause() {
  const result = await f.db.execute(sql`select ${intakeBlockedCauseSql(sql`${threadId}::uuid`)} as cause`);
  const rows = (Array.isArray(result) ? result : (result as { rows: Array<{ cause: string | null }> }).rows) as Array<{ cause: string | null }>;
  return rows[0]?.cause ?? null;
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("a decided acknowledgement (d691f0f4)", () => {
  async function decidedAck() {
    const m = await stored("Merci beaucoup, bien reçu.");
    const first = release(0), id = (await enqueueSavIntakeMessage(m.id, first.config))!;
    const fake = model(m.id, "acknowledgement");
    await analyseSavIntakeRuntime(id, first.config, { env: () => first.env, network: fake.network });
    const current = await readSavIntakeCurrent(threadId, first.config);
    expect(current?.payload.plan?.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "acknowledgement_only" });
    await refreshIntakeConsole();
    return { m, id, fake };
  }

  it("nine releases re-create its version under the current configuration without ever exhausting it (no manual_required)", async () => {
    const { m, fake } = await decidedAck();
    for (let n = 1; n <= SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage; n++) {
      const current = release(n);
      expect(await catchupSavIntake(current.config)).toBe(1);
      const next = (await runsOf(m.id)).find(r => r.isCurrent)!;
      expect(next.configHash).toBe(current.config.configHash);
      expect(await kinds(next.id)).toContain("release_reanalysis");
      await analyseSavIntakeRuntime(next.id, current.config, { env: () => current.env, network: fake.network });
      expect((await readSavIntakeCurrent(threadId, current.config))?.payload.plan?.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "acknowledgement_only" });
      expect(await kinds(next.id)).not.toContain("attempts_exhausted");
    }
    await refreshIntakeConsole();
    expect(await blockedCause()).toBeNull();
    expect((await readIntakeRunDiagnostics(threadId))?.attemptBudget).toMatchObject({ total: 1, exhausted: null });
  });

  it("an operator's reclassification after a release is processed once, under the current configuration (Astra, cd1d47eb)", async () => {
    const { m, fake } = await decidedAck();
    const current = release(1);
    // The release re-creates the version under the current configuration (release-only: no lifetime attempt).
    expect(await catchupSavIntake(current.config)).toBe(1);
    const next = (await runsOf(m.id)).find(r => r.isCurrent)!;
    await analyseSavIntakeRuntime(next.id, current.config, { env: () => current.env, network: fake.network });
    await refreshIntakeConsole();
    const run = (await readSavIntakeCurrent(threadId, current.config))!;
    expect(run.configHash).toBe(current.config.configHash);
    // The operator reclassifies the acknowledgement as a support request on the version the console shows.
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: `synthetic-${randomUUID()}`, email: "ugo@limova.ai", name: "Synthetic", role: "admin", active: true }).returning();
    state.user = { id: admin.clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
    const saved = await recordIntakeHumanCommand({ commandKey: randomUUID(), threadId, messageId: m.id, runId: run.id, version: run.version, sourceHash: run.sourceHash!,
      candidatesHash: intakeRuntimeHash([...(run.candidateContactIds ?? [])].sort()), kind: "classify", classification: "support", reason: "Synthetic verified operator evidence." });
    const [event] = await f.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, saved.eventId));
    expect(event.baseConfigHash).toBe(current.config.configHash);
    const readers = createSavIntakeHubspotReaders({ network: fake.network });
    const result = await consumeIntakeHumanEvent(saved.eventId, current.config, readers);
    expect(result).toHaveProperty("runId");
    const [consumed] = await f.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, saved.eventId));
    expect(consumed.state).toBe("consumed");
    // Processed once: a second pass finds nothing to do, one human revision only.
    expect(await consumeIntakeHumanEvent(saved.eventId, current.config, readers)).toEqual({ skipped: "not_claimed" });
    const runs = await runsOf(m.id);
    expect(runs.filter(r => r.configHash === humanRevisionConfigHash(current.config.configHash, saved.eventId))).toHaveLength(1);
    // Counters kept, no reset: every automatic attempt still recorded, only the first one counts in the lifetime cap.
    expect(runs.reduce((sum, r) => sum + r.attempts, 0)).toBe(2);
    expect((await readIntakeRunDiagnostics(threadId))?.attemptBudget).toMatchObject({ total: 1 });
    state.user = null;
  });

  it("a new mail in the thread re-opens it", async () => {
    await decidedAck();
    const reply = await stored("Finalement la synchronisation échoue encore avec une erreur 500.");
    const { config } = release(1);
    expect(await catchupSavIntake(config)).toBe(1);
    expect((await runsOf(reply.id)).map(r => r.state)).toEqual(["pending"]);
  });

  it("changed sources (new evidence on the same mail) re-open it, and that run counts as a normal attempt", async () => {
    const { m } = await decidedAck();
    // The thread gets a HubSpot ticket: part of the analysed sources, so the decision no longer stands on them.
    await f.db.update(savThreads).set({ hubspotTicketId: "4242" }).where(eq(savThreads.id, threadId));
    await refreshIntakeConsole();
    const { config } = release(1);
    expect(await catchupSavIntake(config)).toBe(1);
    const next = (await runsOf(m.id)).find(r => r.isCurrent)!;
    expect(next.version).toBe(2);
    expect(await kinds(next.id)).not.toContain("release_reanalysis");
  });
});

describe("a dossier still re-analysed after a release (decision waiting for its configuration-bound follow-up)", () => {
  it("nine releases on the same unchanged mail never exhaust it: release runs are outside the lifetime total (c1492918)", async () => {
    const m = await stored("Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.");
    let current = release(0), id = (await enqueueSavIntakeMessage(m.id, current.config))!;
    const fake = model(m.id, "support");
    await analyseSavIntakeRuntime(id, current.config, { env: () => current.env, network: fake.network });
    expect((await readSavIntakeCurrent(threadId, current.config))?.payload.plan).toBeTruthy();
    for (let n = 1; n <= SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage; n++) {
      current = release(n);
      id = (await enqueueSavIntakeMessage(m.id, current.config))!;
      expect(await kinds(id)).toContain("release_reanalysis");
      await analyseSavIntakeRuntime(id, current.config, { env: () => current.env, network: fake.network });
      expect(await kinds(id)).not.toContain("attempts_exhausted");
      expect((await readSavIntakeCurrent(threadId, current.config))?.payload.plan).toBeTruthy();
    }
    const runs = await runsOf(m.id);
    // Every attempt is still recorded (no refund, no rewrite); only the first one counts in the lifetime cap.
    expect(runs.reduce((sum, r) => sum + r.attempts, 0)).toBe(SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage + 1);
    const diagnostics = await readIntakeRunDiagnostics(threadId);
    expect(diagnostics?.totalAttempts).toBe(SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage + 1);
    expect(diagnostics?.attemptBudget).toMatchObject({ total: 1, exhausted: null });
    expect(diagnostics?.attemptsExhausted).toBe(false);
  });

  it("a failed analysis is not a release-only anchor: the next version counts its attempts", async () => {
    const m = await stored("Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.");
    const first = release(0), id = (await enqueueSavIntakeMessage(m.id, first.config))!;
    // A claimed attempt that ended without any analysis.
    expect(await claimSavIntakeRun(id, first.config)).toBeTruthy();
    await f.db.update(savIntakeRuns).set({ state: "waiting", leaseToken: null, leaseUntil: null }).where(eq(savIntakeRuns.id, id));
    const next = (await enqueueSavIntakeMessage(m.id, release(1).config))!;
    expect(await kinds(next)).not.toContain("release_reanalysis");
  });

  it("an already-exhausted dossier stays blocked: attempts recorded before the fix are never refunded", async () => {
    const m = await stored("Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.");
    // History of the releases before the fix: seven versions, one counted attempt each, no release marker.
    let current = release(0), id = (await enqueueSavIntakeMessage(m.id, current.config))!;
    for (let n = 1; n < SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage; n++) {
      const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id));
      await f.db.update(savIntakeRuns).set({ attempts: 1, state: "observed", payloadCiphertext: encryptSavPayload({ ...decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext), plan: { synthetic: true } }) }).where(eq(savIntakeRuns.id, id));
      current = release(n); id = (await enqueueSavIntakeMessage(m.id, current.config))!;
    }
    // The eighth (last counted) attempt is a real, accepted analysis on the current sources.
    await analyseSavIntakeRuntime(id, current.config, { env: () => current.env, network: model(m.id, "support").network });
    expect((await readSavIntakeCurrent(threadId, current.config))?.payload.plan).toBeTruthy();
    current = release(SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage);
    const next = (await enqueueSavIntakeMessage(m.id, current.config))!;
    // A release-only version, but the eight attempts recorded before it still count: no reset.
    expect(await kinds(next)).toContain("release_reanalysis");
    expect(await claimSavIntakeRun(next, current.config)).toBeNull();
    expect(await kinds(next)).toContain("attempts_exhausted");
    expect((await runsOf(m.id)).find(r => r.id === next)?.attempts).toBe(0);
  });
});

describe("a new customer mail on a dossier whose attempts are exhausted (SAV-120, N7 fix 1)", () => {
  it("gets its own attempt counter and is analysed; the exhausted version stays exhausted, its counter untouched", async () => {
    const m = await stored("Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.");
    // Pre-fix history: eight counted attempts on the first mail, then a version never scheduled again.
    let id = (await enqueueSavIntakeMessage(m.id, release(0).config))!, exhaustedConfig = release(0).config;
    for (let n = 1; n <= SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage; n++) {
      const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id));
      await f.db.update(savIntakeRuns).set({ attempts: 1, state: "observed", payloadCiphertext: encryptSavPayload({ ...decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext), plan: { synthetic: true } }) }).where(eq(savIntakeRuns.id, id));
      exhaustedConfig = release(n).config;
      id = (await enqueueSavIntakeMessage(m.id, exhaustedConfig))!;
    }
    // The lifetime total is reached: the version is never scheduled (the exact claim refusal is covered above).
    await f.db.update(savIntakeRuns).set({ updatedAt: new Date(Date.now() - 3600_000) }).where(eq(savIntakeRuns.id, id));
    await refreshIntakeConsole();
    expect(await blockedCause()).toBe("attempts_exhausted");
    const exhaustedKinds = await kinds(id);
    const before = (await runsOf(m.id)).map(r => ({ id: r.id, attempts: r.attempts })).sort((a, b) => a.id.localeCompare(b.id));
    // No new mail: nothing restarts (no replay), whatever the passes.
    expect(await catchupSavIntake(exhaustedConfig)).toBe(0);
    expect((await runsOf(m.id)).find(r => r.isCurrent)?.id).toBe(id);
    // The customer writes again: a new entry version, bound to the new mail.
    const reply = await stored("Toujours la même erreur 500 ce matin, pouvez-vous regarder ?");
    expect(await catchupSavIntake(exhaustedConfig)).toBe(1);
    const [next] = await runsOf(reply.id);
    expect(next).toMatchObject({ isCurrent: true, attempts: 0, state: "pending" });
    expect(await kinds(next.id)).not.toContain("attempts_exhausted");
    const lease = await claimSavIntakeRun(next.id, exhaustedConfig);
    expect(lease).toBeTruthy();
    expect((await runsOf(reply.id))[0].attempts).toBe(1);
    // Never a reset: the first mail keeps every counter and its marker.
    expect((await runsOf(m.id)).map(r => ({ id: r.id, attempts: r.attempts })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(before);
    expect(await kinds(id)).toEqual(expect.arrayContaining(exhaustedKinds));
    expect((await runsOf(m.id)).find(r => r.id === id)?.state).not.toBe("observed");
    expect((await readIntakeRunDiagnostics(threadId))?.attemptBudget).toMatchObject({ runAttempts: 1, total: 1, exhausted: null });
  });
});

describe("console label of an exhausted dossier never claimed again", () => {
  it("says the attempts are exhausted, not that the next pass will take it", async () => {
    const m = await stored("Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.");
    // Eight versions of the past, each with one counted attempt and no analysis kept on the sources (pre-fix history).
    let id = (await enqueueSavIntakeMessage(m.id, release(0).config))!;
    for (let n = 1; n <= SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage; n++) {
      const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id));
      await f.db.update(savIntakeRuns).set({ attempts: 1, state: "observed", payloadCiphertext: encryptSavPayload({ ...decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext), plan: { synthetic: true } }) }).where(eq(savIntakeRuns.id, id));
      id = (await enqueueSavIntakeMessage(m.id, release(n).config))!;
    }
    // The last version stays pending (the scheduler never takes it) for more than the incident threshold.
    await f.db.update(savIntakeRuns).set({ updatedAt: new Date(Date.now() - 3600_000), createdAt: new Date(Date.now() - 3600_000) }).where(eq(savIntakeRuns.id, id));
    expect((await runsOf(m.id)).find(r => r.isCurrent)?.state).toBe("pending");
    expect(await blockedCause()).toBe("attempts_exhausted");
    const label = intakeBlockedRowLabel({ blockedCause: await blockedCause(), status: "pending", reason: null });
    expect(label).toMatch(/tentatives d’analyse épuisées/);
    expect(label).not.toMatch(/prochain passage/);
  });
});
describe("why an attempt failed, as closed codes (SAV-120, N7 fix 3)", () => {
  /** Fake model that always cites a quote absent from the catalogue, with customer-looking words in its output. */
  function rejectingModel(messageId: string) {
    return vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
        const answer = { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: "Q-CLIENT-SECRET-TEXT" }] };
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
      }
      if (String(url).startsWith("https://api.hubapi.com/")) return Response.json({ total: 0, results: [] });
      throw Error("EXTERNAL_NETWORK_FORBIDDEN");
    });
  }

  it("journals a small attempt outcome the diagnostic can read, with codes only and no customer text", async () => {
    const m = await stored("Bonjour, mon numéro client est 123456 et la synchronisation échoue.");
    const { config, env: e } = release(0), id = (await enqueueSavIntakeMessage(m.id, config))!;
    await analyseSavIntakeRuntime(id, config, { env: () => e, network: rejectingModel(m.id) });
    const rows = await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, id));
    const outcome = rows.find(r => r.kind === "attempt_outcome");
    expect(outcome, rows.map(r => r.kind).join(",")).toBeTruthy();
    const value = decryptSavPayload<{ reason: string | null; traces: Array<Record<string, unknown>> }>(outcome!.payloadCiphertext);
    expect(value.traces.length).toBeGreaterThan(0);
    expect(value.traces.some(t => t.errorCode || t.validationFailure)).toBe(true);
    const text = JSON.stringify(value);
    for (const leaked of ["123456", "synchronisation", "CLIENT-SECRET", "client@example.invalid", "Bonjour"]) expect(text).not.toContain(leaked);
    expect(outcome!.payloadCiphertext.length).toBeLessThan(4096);
    const diagnostics = await readIntakeRunDiagnostics(threadId);
    const event = diagnostics!.runs.find(r => r.runId === id)!.events.find(ev => ev.kind === "attempt_outcome");
    expect(event?.diagnostic.readable).toBe(true);
    expect(event?.diagnostic.traces.some(t => t.errorCode || t.validationReason)).toBe(true);
  });
});

describe("attempt outcome allow-list (SAV-120, N7 fix 3)", () => {
  it("keeps closed codes, enums and byte counts only; free text and unknown values are dropped", async () => {
    const { intakeAttemptOutcome } = await import("./attempt-outcome");
    const outcome = intakeAttemptOutcome({ reason: "Le client dit: rembourse-moi", traces: [
      { phase: "understanding", accepted: true, errorCode: null },
      { method: "analyseMessage", phase: "understanding", accepted: false, errorCode: "SAV_INTAKE_MODEL_OUTPUT_REJECTED",
        validationFailure: { reason: "excerpt_not_in_source", stage: "evidence", path: "requests.0.quote", excerpt: "mon mot de passe est hunter2" },
        contextLimit: { stage: "wire", bytes: 900_000, limitBytes: 800_000, breakdown: { text: "corps du mail" } } },
      { operation: "ticket_history", status: "failed", reason: "history_body_unavailable", detail: "jean@example.invalid" },
      { phase: "understanding", accepted: false, errorCode: "erreur libre avec texte client" },
    ] });
    expect(outcome.reason).toBeNull();
    expect(outcome.traces).toHaveLength(3);
    expect(outcome.traces[0]).toMatchObject({ method: "analyseMessage", errorCode: "SAV_INTAKE_MODEL_OUTPUT_REJECTED",
      validationFailure: { reason: "excerpt_not_in_source", stage: "evidence" }, contextLimit: { stage: "wire", bytes: 900_000, limitBytes: 800_000 } });
    expect(outcome.traces[1]).toMatchObject({ operation: "ticket_history", status: "failed", reason: "history_body_unavailable" });
    expect(outcome.traces[2].errorCode).toBeNull();
    const text = JSON.stringify(outcome);
    for (const leaked of ["rembourse", "hunter2", "requests.0", "corps du mail", "jean@", "texte client"]) expect(text).not.toContain(leaked);
  });
});
