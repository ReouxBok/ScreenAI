/** V1 stability: attempts survive deployments without freezing healthy dossiers,
 * deterministic input errors never loop, and a provider date in the future is bounded. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeJournal } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { catchupSavIntake, claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun, pendingSavIntakeRuns, readSavIntakeCurrent } from "./runtime-store";
import { listIntakeConsole } from "./console-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { intakeAttemptBudget, SAV_INTAKE_ATTEMPT_POLICY } from "./attempt-policy";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
function env(mailbox: string, codeRevision = "a".repeat(40)) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: codeRevision, SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision, policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
const deploy = (n: number) => savIntakeRuntimeConfig(env(mailboxId, String(n % 10).repeat(40)))!;
async function stored(receivedAt = new Date(), createdAt = new Date(), text = "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.") {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments: [], headers: {} }),
    receivedAt, createdAt, analysisStatus: "pending" }).returning();
  return m;
}
/** Records an attempt that ended with an analysis, as a healthy observed run does. */
async function observe(runId: string) {
  const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  const payload = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
  await f.db.update(savIntakeRuns).set({ attempts: run.attempts + 1, state: "observed", leaseUntil: null, leaseToken: null,
    payloadCiphertext: encryptSavPayload({ ...payload, plan: { synthetic: true } }) }).where(eq(savIntakeRuns.id, runId));
}
const markers = async (runId: string) => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, runId))).map(j => j.kind);
function provider(messageId: string) {
  let model = 0;
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      model++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      const quoteId = data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id;
      const answer = { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId }],
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
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
  environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());

describe("attempt policy", () => {
  it("separates per-version, failed and lifetime attempts", () => {
    const analysed = encryptSavPayload({ plan: {} }), failed = encryptSavPayload({ reason: "SAV_INTAKE_MODEL_CONTEXT_LIMIT" });
    expect(intakeAttemptBudget("v3", [{ id: "v1", attempts: 1, payloadCiphertext: analysed }, { id: "v2", attempts: 1, payloadCiphertext: analysed }, { id: "v3", attempts: 0, payloadCiphertext: failed }]))
      .toEqual({ runAttempts: 0, failed: 0, unknown: 0, total: 2, exhausted: false });
    expect(intakeAttemptBudget("v2", [{ id: "v1", attempts: 2, payloadCiphertext: failed }, { id: "v2", attempts: 2, payloadCiphertext: failed }]).exhausted).toBe("per_version");
    expect(intakeAttemptBudget("v3", [{ id: "v1", attempts: 2, payloadCiphertext: failed }, { id: "v2", attempts: 2, payloadCiphertext: failed }, { id: "v3", attempts: 0, payloadCiphertext: failed }]).exhausted).toBe("failed_per_message");
    expect(intakeAttemptBudget("v9", Array.from({ length: 9 }, (_, i) => ({ id: `v${i + 1}`, attempts: i < 8 ? 1 : 0, payloadCiphertext: analysed }))).exhausted).toBe("total_per_message");
  });
});

describe("deployments", () => {
  it("two successive deployments never freeze a dossier that was analysed successfully (defect B)", async () => {
    const m = await stored();
    const v1 = (await enqueueSavIntakeMessage(m.id, config))!;
    await observe(v1);
    const v2 = (await enqueueSavIntakeMessage(m.id, deploy(1)))!;
    await observe(v2);
    const latest = deploy(2), v3 = (await enqueueSavIntakeMessage(m.id, latest))!;
    expect(new Set([v1, v2, v3]).size).toBe(3);
    expect((await pendingSavIntakeRuns(latest)).map(r => r.id)).toContain(v3);
    expect(await claimSavIntakeRun(v3, latest)).toBeTruthy();
    expect(await markers(v3)).not.toContain("attempts_exhausted");
  });

  it("the lifetime cap survives any number of deployments: no infinite relaunch, one durable marker", async () => {
    const m = await stored();
    let id = (await enqueueSavIntakeMessage(m.id, config))!, last = config;
    for (let n = 1; n <= SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage; n++) { await observe(id); last = deploy(n); id = (await enqueueSavIntakeMessage(m.id, last))!; }
    expect(await pendingSavIntakeRuns(last)).toEqual([]);
    expect(await claimSavIntakeRun(id, last)).toBeNull();
    expect(await claimSavIntakeRun(id, last)).toBeNull();
    expect((await markers(id)).filter(k => k === "attempts_exhausted")).toHaveLength(1);
    const runs = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, m.id));
    expect(runs.reduce((sum, r) => sum + r.attempts, 0)).toBe(SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage);
  });
});

describe("deterministic input errors", () => {
  it("give the attempt back, block the run durably and are never claimed again", async () => {
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!;
    const lease = (await claimSavIntakeRun(id, config))!;
    await failSavIntakeRun(lease, { revision: "x", effects: "not_connected", reason: "SAV_INTAKE_INPUT_INVALID" } as never, false, { deterministic: true });
    const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id));
    expect(run.attempts).toBe(0);
    expect(await markers(id)).toContain("deterministic_block");
    expect(await pendingSavIntakeRuns(config)).toEqual([]);
    await f.db.update(savIntakeRuns).set({ leaseUntil: null }).where(eq(savIntakeRuns.id, id));
    expect(await claimSavIntakeRun(id, config)).toBeNull();
  });
});

describe("provider date in the future (defect A)", () => {
  it("is bounded by storage time for analysis; the raw date stays on the row", async () => {
    const future = new Date(Date.now() + 21 * 3600_000), m = await stored(future);
    const id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.reason).not.toBe("SAV_INTAKE_INPUT_INVALID");
    expect(p.calls()).toBe(1);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    const [row] = await f.db.select().from(savMessages).where(eq(savMessages.id, m.id));
    expect(row.receivedAt.getTime()).toBe(future.getTime());
  });
});

describe("an older message stored with a future provider date (review P1)", () => {
  it("never masks a newer reply: enqueue, catch-up, analysis and console all follow the new message", async () => {
    const before = new Date(Date.now() - 500);
    const old = await stored(new Date(Date.now() + 21 * 3600_000), before, "Premier message, daté dans le futur par le fournisseur.");
    const reply = await stored(new Date(), new Date(), "Bonjour, toujours la même erreur 500 sur la synchronisation de mon agenda.");
    const id = await enqueueSavIntakeMessage(reply.id, config);
    expect(id).toBeTruthy();
    expect(await enqueueSavIntakeMessage(old.id, config)).toBeNull();
    await catchupSavIntake(config);
    const runs = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.isCurrent, true));
    expect(runs.map(r => r.messageId)).toEqual([reply.id]);
    const p = provider(reply.id);
    await analyseSavIntakeRuntime(id!, config, { env: () => environment, network: p.network });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.messageId).toBe(reply.id);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    expect(p.calls()).toBe(1);
    const console = await listIntakeConsole({ search: "Synchronisation" });
    if (console.installed) expect(console.rows.map(r => r.messageId)).toEqual([reply.id]);
    // The raw provider date is never rewritten.
    expect((await f.db.select().from(savMessages).where(eq(savMessages.id, old.id)))[0].receivedAt.getTime()).toBeGreaterThan(Date.now());
  });
});
