/** The pipeline switch through the real runtime, dispatcher and ledger: fixed when a
 * run is created, outside configHash, and never changing an analysis in flight. */
import { randomUUID } from "node:crypto";
import { encodeSimpleWireFixture } from "./simple-wire.fixture";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions, savIntakeExecutions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { catchupSavIntake, claimSavIntakeRun, enqueueSavIntakeMessage, pendingSavIntakeRuns, readSavIntakeCurrent } from "./runtime-store";
import { intakeBlockedRunSql, intakeRetryAtSql } from "./console-store";
import { savIntakeJournal } from "@/db/schema";
import { sql } from "drizzle-orm";
import { analyseSavIntakeRuntime } from "./runtime";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { SAV_INTAKE_SIMPLE_REVISION } from "./simple-readers";
import { SAV_INTAKE_CALL_POLICY, SAV_INTAKE_TRANSIENT_RETRY } from "./attempt-policy";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
function env(mailbox: string, pipeline?: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]", ...(pipeline ? { SAV_INTAKE_PIPELINE: pipeline } : {}),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored() {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  return m;
}
/** Synthetic Gemini answering both reader formats, and an empty CRM. */
function provider(messageId: string, failures: number[] = []) {
  const revisions: string[] = [];
  let gemini = 0;
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const status = failures[gemini++];
      if (status) return new Response("{}", { status });
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
      const simple = typeof data.current === "string";
      revisions.push(simple ? SAV_INTAKE_SIMPLE_REVISION : SAV_INTAKE_MODEL_REVISION);
      const answer = simple
        ? { messageId, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Synchronisation en échec.", sourceIds: ["current"] }],
          ticketTitle: "Échec de synchronisation de l'agenda", ticketDescription: "Erreur 500 à la synchronisation.",
          identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Demande support." }
        : { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500 à la synchronisation.", requestIds: ["r1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(simple ? encodeSimpleWireFixture(answer, data.outputReferences) : answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) return Response.json({ total: 0, results: [] });
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, revisions, calls: () => gemini };
}
const payloadOf = async (runId: string) => decryptSavPayload<IntakeRuntimePayload>((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)))[0].payloadCiphertext);

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("pipeline switch", () => {
  it("is outside configHash: flipping it never re-enqueues an open dossier", () => {
    const base = env("00000000-0000-4000-8000-000000000001");
    const current = savIntakeRuntimeConfig(base)!, simple = savIntakeRuntimeConfig({ ...base, SAV_INTAKE_PIPELINE: "simple" })!;
    expect(simple.configHash).toBe(current.configHash);
    expect(current.pipeline).toBe("current"); expect(simple.pipeline).toBe("simple");
    expect(() => savIntakeRuntimeConfig({ ...base, SAV_INTAKE_PIPELINE: "fast" })).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  });
  it("a run created under simple is analysed by one simple call through the real dispatcher and ledger", async () => {
    const environment = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    expect((await payloadOf(id)).pipeline).toBe("simple");
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    expect(p.revisions).toEqual([SAV_INTAKE_SIMPLE_REVISION]);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.pipeline).toBe("simple");
    expect(current?.payload.semantics?.validatorRevision).toBe(SAV_INTAKE_SIMPLE_REVISION);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    // The accepted judgement summary is kept for the team handoff.
    expect(current?.payload.traces).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "simple_judgement", rationale: "Demande support." })]));
    // Observe mode: a plan, never an effect.
    expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
  });
  it("a run keeps the pipeline it was created with when the switch flips before its analysis, both ways", async () => {
    for (const [created, flipped, revision] of [["simple", undefined, SAV_INTAKE_SIMPLE_REVISION], [undefined, "simple", SAV_INTAKE_MODEL_REVISION]] as const) {
      await f.client.exec("TRUNCATE sav.intake_model_calls, sav.intake_runs CASCADE");
      const base = env(mailboxId), withPipeline = (value?: string) => { const e: Record<string, string | undefined> = { ...base }; if (value) e.SAV_INTAKE_PIPELINE = value; else delete e.SAV_INTAKE_PIPELINE; return e; };
      const before = withPipeline(created), after = withPipeline(flipped);
      const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, savIntakeRuntimeConfig(before)!))!, p = provider(m.id);
      const config = savIntakeRuntimeConfig(after)!;
      // The same run is still the current one: no new version for the flip.
      expect(await enqueueSavIntakeMessage(m.id, config)).toBe(id);
      await catchupSavIntake(config);
      expect(await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, m.id))).toHaveLength(1);
      await analyseSavIntakeRuntime(id, config, { env: () => after, network: p.network });
      expect(p.revisions[0]).toBe(revision);
    }
  });
});

describe("transient provider failures (lot 2)", () => {
  const due = (runId: string) => f.db.update(savIntakeRuns).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(savIntakeRuns.id, runId));
  const kinds = async (runId: string) => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, runId))).map(j => j.kind);
  const run = async (runId: string) => (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)))[0];
  for (const pipeline of ["simple", undefined] as const) it(`429 then success: retried automatically at a durable due time, as a new reserved dispatch (${pipeline ?? "current"})`, async () => {
    const environment = env(mailboxId, pipeline), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id, [429]);
    const first = await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    expect(first).toMatchObject({ state: "waiting", retryAt: expect.any(String) });
    expect(Date.parse((first as { retryAt: string }).retryAt)).toBeGreaterThan(Date.now() + 60_000);
    expect((await run(id)).attempts).toBe(0);
    expect(await kinds(id)).toContain("retry_scheduled");
    // Not before its due time: neither listed nor claimable.
    expect(await pendingSavIntakeRuns(config)).toEqual([]);
    expect(await claimSavIntakeRun(id, config)).toBeNull();
    // The console shows a next action, not an incident.
    const [{ blocked, retry }] = ((await f.db.execute(sql`select ${intakeBlockedRunSql(sql`${threadId}::uuid`)} as blocked, ${intakeRetryAtSql(sql`${threadId}::uuid`)} as retry`)) as unknown as { rows: { blocked: boolean; retry: unknown }[] }).rows;
    expect(blocked).toBe(false); expect(retry).toBeTruthy();
    await due(id);
    expect((await pendingSavIntakeRuns(config)).map(r => r.id)).toContain(id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    expect(current?.payload.reason).toBeUndefined();
    // Every dispatch has its own settled reservation; no reuse of the consumed one.
    const ledger = await f.db.select().from(savIntakeModelCalls);
    expect(ledger.every(r => r.state === "settled")).toBe(true);
    expect(new Set(ledger.map(r => r.requestHash)).size).toBe(ledger.length);
    expect(await f.db.select().from(savActions)).toHaveLength(0);
  });
  it("repeated 503 never announce a retry the call budget forbids: retries stop, with a visible terminal cause", async () => {
    const environment = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id, [503, 503, 503, 503, 503, 503]);
    for (let n = 0; n < 5; n++) { await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network }); await due(id); }
    const journal = await kinds(id);
    // Retries are bounded by the smaller of the retry schedule and the remaining dispatch budget;
    // no retry is ever announced beyond it.
    const retries = Math.min(SAV_INTAKE_TRANSIENT_RETRY.delaysMinutes.length, SAV_INTAKE_CALL_POLICY.perVersion - 1, SAV_INTAKE_CALL_POLICY.perMessage - 1);
    expect(journal.filter(k => k === "retry_scheduled")).toHaveLength(retries);
    expect(journal.some(k => k === "retry_exhausted" || k === "retry_ineligible")).toBe(true);
    // Terminal exit: visibly blocked, never claimed or dispatched again.
    expect(journal).toContain("attempts_exhausted");
    expect(await claimSavIntakeRun(id, config)).toBeNull();
    expect(p.calls()).toBe(retries + 1);
    expect((await run(id)).attempts).toBeGreaterThan(0);
    expect((await f.db.select().from(savIntakeModelCalls)).every(r => r.state === "settled" && r.chargedNanoUsd === 0)).toBe(true);
  });
  it("a lost answer after dispatch stays uncertain: no retry, no zero settlement, until reconciliation", async () => {
    const environment = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!;
    const network = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).startsWith("https://generativelanguage.googleapis.com/")) throw Error("socket hang up");
      return Response.json({ total: 0, results: [] });
    });
    const result = await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
    expect(result).toMatchObject({ state: "uncertain" });
    expect(await kinds(id)).not.toContain("retry_scheduled");
    const [row] = await f.db.select().from(savIntakeModelCalls);
    expect(row.state).toBe("uncertain"); expect(row.chargedNanoUsd).toBe(row.reservedNanoUsd);
  });
  it.each([["modified", true], ["unchanged", false]] as const)("429, then a deployment (%s config) during the wait: the retry keeps its due time and lineage, then really succeeds", async (_, redeploy) => {
    const base = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(base)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id, [429]);
    await analyseSavIntakeRuntime(id, config, { env: () => base, network: p.network });
    const deployed = redeploy ? { ...base, SAV_CODE_REVISION: "b".repeat(40), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(base.SAV_INTAKE_RUNTIME_CONFIG), codeRevision: "b".repeat(40) }) } : base;
    const next = savIntakeRuntimeConfig(deployed)!, version = (await enqueueSavIntakeMessage(m.id, next))!;
    expect(version === id).toBe(!redeploy);
    // Not before the inherited due time.
    expect(await pendingSavIntakeRuns(next)).toEqual([]);
    await due(version);
    await analyseSavIntakeRuntime(version, next, { env: () => deployed, network: p.network });
    const after = await readSavIntakeCurrent(threadId, next);
    expect(after?.payload.reason).toBeUndefined();
    expect(after?.payload.plan?.decision.classification).toBe("support");
    const ledger = await f.db.select().from(savIntakeModelCalls);
    expect(ledger).toHaveLength(2); expect(new Set(ledger.map(r => r.requestHash)).size).toBe(2);
  });
  it.each(["pause", "new_mail"] as const)("a %s during the wait forbids the old dispatch", async change => {
    const environment = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id, [429]);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    if (change === "pause") await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    else await stored();
    await due(id);
    expect(await claimSavIntakeRun(id, config)).toBeNull();
    expect((await pendingSavIntakeRuns(config)).map(r => r.id)).not.toContain(id);
    expect(p.calls()).toBe(1);
  });
});

describe("simple pipeline with dates and deployments (lot 3)", () => {
  it("a provider date in the future is analysed normally on the simple pipeline", async () => {
    const environment = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(environment)!;
    const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
      subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", attachments: [], headers: {} }),
      receivedAt: new Date(Date.now() + 21 * 3600_000), createdAt: new Date(), analysisStatus: "pending" }).returning();
    const id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.reason).not.toBe("SAV_INTAKE_INPUT_INVALID");
    expect(current?.payload.plan?.decision.classification).toBe("support");
  });
  it("after a deployment the new version keeps the simple pipeline; an unchanged dossier reuses its settled judgement at no cost", async () => {
    const base = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(base)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => base, network: p.network });
    const deployed = { ...base, SAV_CODE_REVISION: "b".repeat(40), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(base.SAV_INTAKE_RUNTIME_CONFIG), codeRevision: "b".repeat(40) }) };
    const next = savIntakeRuntimeConfig(deployed)!, version = (await enqueueSavIntakeMessage(m.id, next))!;
    expect(version).not.toBe(id);
    expect((await payloadOf(version)).pipeline).toBe("simple");
    await analyseSavIntakeRuntime(version, next, { env: () => deployed, network: p.network });
    // Same sources, same request body: the ledger serves the settled result; no new dispatch, no budget consumed.
    expect(p.revisions).toEqual([SAV_INTAKE_SIMPLE_REVISION]);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
    expect((await readSavIntakeCurrent(threadId, next))?.payload.plan?.decision.classification).toBe("support");
  });
});
