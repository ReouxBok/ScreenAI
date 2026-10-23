/** Independent qualification — D. Triggering, duplicates and concurrent workers.
 * Real runtime store on PGlite; model/CRM transport is a counted fake.
 * Concurrency uses explicit barriers, never sleeps. See test/sav-qualification.ts. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { barrier } from "../../../../test/sav-qualification";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, scheduled: [] as (() => unknown)[], accept: null as null | ((payload: unknown) => Promise<unknown>) }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("next/server", () => ({ after: (work: () => unknown) => { state.scheduled.push(work); } }));
vi.mock("@/lib/sav/gmail", () => ({
  verifyGmailWebhookRequest: async () => true,
  acceptGmailWebhook: (payload: unknown) => state.accept!(payload),
  processGmailReceipt: vi.fn(async () => undefined),
}));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { catchupSavIntake, enqueueSavIntakeMessage, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { POST as gmailWebhook } from "@/app/api/webhooks/gmail/route";

describe("webhook route contract", () => {
  const request = (body = "{}") => new Request("https://studio.example.invalid/api/webhooks/gmail", { method: "POST", body });
  beforeEach(() => { state.scheduled = []; vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("[INV] D1 a stored new notification schedules exactly one post-commit processing", async () => {
    state.accept = async () => ({ duplicate: false, receipt: { id: "r1" } });
    expect((await gmailWebhook(request())).status).toBe(204);
    expect(state.scheduled).toHaveLength(1);
  });
  it("[INV] D1b a duplicate/redelivered notification schedules nothing more", async () => {
    state.accept = async () => ({ duplicate: true, receipt: { id: "r1" } });
    expect((await gmailWebhook(request())).status).toBe(204);
    expect(state.scheduled).toHaveLength(0);
  });
  it("[INV] D1c storage failure answers 5xx (Pub/Sub redelivers) and schedules nothing", async () => {
    state.accept = async () => { throw Error("DB_DOWN"); };
    expect((await gmailWebhook(request())).status).toBe(500);
    expect(state.scheduled).toHaveLength(0);
  });
  it("[INV] D1d invalid JSON is refused before storage", async () => {
    state.accept = vi.fn(async () => ({ duplicate: false, receipt: { id: "r1" } }));
    expect((await gmailWebhook(request("{"))).status).toBe(400);
    expect(state.accept).not.toHaveBeenCalled();
  });
});

describe("runtime concurrency", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
  function env(mailbox: string) {
    const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
    return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
      SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
      SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
  }
  async function stored(options: { thread?: string; mailbox?: string; receivedAt?: Date; text?: string } = {}) {
    return (await f.db.insert(savMessages).values({ mailboxId: options.mailbox ?? mailboxId, threadId: options.thread ?? threadId, direction: "inbound", fromEmail: "client@example.invalid",
      toEmails: ["support@example.invalid"], subject: "Synchronisation", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: options.text ?? "La synchronisation échoue.", attachments: [], headers: {} }),
      receivedAt: options.receivedAt ?? new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning())[0];
  }
  /** Fake transport; `hold` blocks the first model call until the test releases it. */
  function provider(answerFor: () => string, hold?: { reached: () => Promise<void>; release: Promise<void> }) {
    const counts = { model: 0, crm: 0 };
    const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
        counts.model++;
        if (hold && counts.model === 1) { await hold.reached(); await hold.release; }
        const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), id = answerFor();
        const answer = { messageId: id, requests: [{ id: "s1", kind: "support", currentMessageId: id, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Synchronisation", description: "La synchronisation échoue.", requestIds: ["s1"] } };
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
      }
      if (String(url).startsWith("https://api.hubapi.com/")) { counts.crm++; return Response.json({ total: 0, results: [] }); }
      throw Error("EXTERNAL_NETWORK_FORBIDDEN");
    });
    return { counts, network };
  }
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
  afterAll(async () => { await f?.client.close(); });
  beforeEach(async () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
    await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
    threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
    environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("[INV] D2 webhook worker and cron worker on the same run: one analysis, one model call, one result", async () => {
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!;
    const reached = barrier(2);
    let release!: () => void; const released = new Promise<void>(r => { release = r; });
    const { counts, network } = provider(() => m.id, { reached, release: released });
    const webhookWorker = analyseSavIntakeRuntime(id, config, { env: () => environment, network });
    await reached(); // first worker is inside its model call, holding the lease
    const cronWorker = await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
    expect(cronWorker).toEqual({ skipped: "not_claimed" });
    release();
    expect((await webhookWorker).state).toBe("waiting");
    expect(counts.model).toBe(1);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
    expect((await f.db.select().from(savIntakeRuns))[0].attempts).toBe(1);
    expect(await f.db.select().from(savActions)).toHaveLength(0);
  });

  it("[INV] D3 a new inbound during analysis fences the old result; the new message becomes current", async () => {
    const m = await stored({ receivedAt: new Date(Date.now() - 5_000) }), id = (await enqueueSavIntakeMessage(m.id, config))!;
    const reached = barrier(2);
    let release!: () => void; const released = new Promise<void>(r => { release = r; });
    const { network } = provider(() => m.id, { reached, release: released });
    const running = analyseSavIntakeRuntime(id, config, { env: () => environment, network });
    await reached();
    const newer = await stored();
    const next = await enqueueSavIntakeMessage(newer.id, config);
    release();
    const result = await running;
    expect(result.state).not.toBe("observed");
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.messageId).toBe(newer.id);
    expect(current?.id).toBe(next);
    expect(current?.payload.plan).toBeUndefined();
    const old = (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)))[0];
    expect(old.isCurrent).toBe(false);
  });

  it("[INV] D4 concurrent enqueues of the same new mail (duplicate notifications) create a single run", async () => {
    const m = await stored();
    const ids = await Promise.all([enqueueSavIntakeMessage(m.id, config), enqueueSavIntakeMessage(m.id, config), catchupSavIntake(config)]);
    expect(ids[0]).toBe(ids[1]);
    expect(await f.db.select().from(savIntakeRuns)).toHaveLength(1);
  });

  it("[INV] D5 another mailbox and pre-activation history are never (re)launched", async () => {
    const [foreign] = await f.db.insert(savMailboxes).values({ email: "other@example.invalid" }).returning();
    const [foreignThread] = await f.db.insert(savThreads).values({ mailboxId: foreign.id, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning();
    const outside = await stored({ mailbox: foreign.id, thread: foreignThread.id });
    const [oldThread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "old@example.invalid" }).returning();
    const history = await stored({ thread: oldThread.id, receivedAt: new Date(Date.parse(config.receivedAfter) - 60_000) });
    expect(await enqueueSavIntakeMessage(outside.id, config)).toBeNull();
    expect(await enqueueSavIntakeMessage(history.id, config)).toBeNull();
    expect(await catchupSavIntake(config)).toBe(0);
    expect(await f.db.select().from(savIntakeRuns)).toHaveLength(0);
  });

  it("[INV] D6 pause posted while the model answers: no publication, usage kept, no action", async () => {
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!;
    const reached = barrier(2);
    let release!: () => void; const released = new Promise<void>(r => { release = r; });
    const { counts, network } = provider(() => m.id, { reached, release: released });
    const running = analyseSavIntakeRuntime(id, config, { env: () => environment, network });
    await reached();
    await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    release();
    expect((await running).state).not.toBe("observed");
    expect(counts.model).toBe(1);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
    expect((await readSavIntakeCurrent(threadId, config))?.state).not.toBe("observed");
    expect(await f.db.select().from(savActions)).toHaveLength(0);
  });
});
