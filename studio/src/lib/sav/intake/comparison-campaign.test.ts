/** Lot 4: the separate comparison campaign on a frozen list of stored dossiers, through the real
 * readers, engine, dispatcher and both ledgers. Never on the live path, no write, own budget. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions, savIntakeExecutions, auditLogs } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { claimSavIntakeComparison, compareIntakeSides, readSavIntakeComparisonReport, reserveSavIntakeComparisonCall, runSavIntakeComparisonBatch, savIntakeComparisonSpend } from "./comparison-campaign";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
function env(mailbox: string, messageIds: string[], over: Record<string, unknown> = {}) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_COMPARISON_JSON: JSON.stringify({ campaignId: "sample-60", messageIds, maxNanoUsd: 5_000_000_000, until: new Date(Date.now() + 86_400_000).toISOString(), ...over }),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored(text = "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", attachments: unknown[] = []) {
  const threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments, headers: {} }),
    receivedAt: new Date(Date.now() - 86_400_000), createdAt: new Date(Date.now() - 86_400_000), analysisStatus: "intake_observed" }).returning();
  return m;
}
/** Synthetic Gemini for both readers and an empty, read-only CRM; records every request. */
function provider(options: { currentStatus?: number } = {}) {
  const seen: string[] = [], crm: { method: string; url: string }[] = [];
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), simple = typeof data.current === "string", messageId = data.message?.id ?? data.message?.messageId;
      seen.push(simple ? "simple" : "current");
      if (!simple && options.currentStatus) return new Response("{}", { status: options.currentStatus });
      const id = simple ? data.message.id : data.message.id;
      const answer = simple
        ? { messageId: id, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Synchronisation.", sourceIds: ["current"] }], ticketTitle: "Échec de synchronisation de l'agenda",
          ticketDescription: "Erreur 500.", identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Support." }
        : { messageId: id, requests: [{ id: "r1", kind: "support", currentMessageId: id, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500.", requestIds: ["r1"] } };
      void messageId;
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) { crm.push({ method: init?.method ?? "GET", url: String(url) }); return Response.json({ total: 0, results: [] }); }
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, seen, crm };
}
const ledger = () => f.db.select().from(auditLogs).where(and(eq(auditLogs.action, "sav_intake_comparison"), eq(auditLogs.entityType, "sav_intake_comparison")));

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("comparison campaign (lot 4)", () => {
  it("is off without its configuration", async () => {
    const e = env(mailboxId, [randomUUID()]); delete (e as Record<string, unknown>).SAV_INTAKE_COMPARISON_JSON;
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: provider().network })).toEqual({ skipped: "off" });
    expect(await ledger()).toEqual([]);
  });
  it("compares both readers on one frozen snapshot, on its own ledger, without touching runs, the live ledger or the CRM", async () => {
    const a = await stored(), b = await stored("Bonjour, ma connexion échoue encore."), p = provider(), e = env(mailboxId, [a.id, b.id]);
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 5 })).toMatchObject({ compared: [{ messageId: a.id, verdict: "identical" }, { messageId: b.id, verdict: "identical" }] });
    expect(p.seen.filter(s => s === "simple")).toHaveLength(2);
    expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
    expect(await f.db.select().from(savIntakeRuns)).toEqual([]);
    expect(p.crm.every(c => c.method === "GET" || c.url.endsWith("/search"))).toBe(true);
    expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report).toMatchObject({ configured: true, denominators: { listed: 2, done: 2, interrupted: 0, pending: 0 }, verdicts: { identical: 2 } });
    expect(report.configured && report.spend.nanoUsd).toBeGreaterThan(0);
    expect(report.configured && report.rows[0].detail).toMatchObject({ snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/), coverage: [] });
    // Already compared: a new batch does nothing.
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network })).toMatchObject({ compared: [] });
  });
  it("two concurrent batches never compare the same dossier twice (review P2)", async () => {
    const a = await stored(), b = await stored(), p = provider(), e = env(mailboxId, [a.id, b.id]);
    await Promise.all([runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 2 }), runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 2 })]);
    expect(p.seen.filter(s => s === "simple")).toHaveLength(2);
    expect((await ledger()).filter(x => x.technicalMetadata.event === "result")).toHaveLength(2);
    expect(await claimSavIntakeComparison("sample-60", a.id)).toBeNull();
  });
  it("an expired campaign cannot reserve another paid dispatch (review P2)", async () => {
    const a = await stored(), e = env(mailboxId, [a.id], { until: new Date(Date.now() - 1000).toISOString() });
    await expect(reserveSavIntakeComparisonCall(() => e, "sample-60", a.id, randomUUID(), "a".repeat(64), "gemini-3.6-flash")).rejects.toThrow("SAV_INTAKE_COMPARISON_EXPIRED");
    expect(await ledger()).toEqual([]);
  });
  it("spend does not depend on the order events are returned in (review P2)", () => {
    expect(savIntakeComparisonSpend([{ callId: "c", event: "settled", state: "settled", chargedNanoUsd: 1 }, { callId: "c", event: "reserved", reservedNanoUsd: 817152000 }])).toBe(1);
    expect(savIntakeComparisonSpend([{ callId: "c", event: "reserved", reservedNanoUsd: 817152000 }, { callId: "c", event: "settled", state: "uncertain", chargedNanoUsd: 0 }])).toBe(817152000);
    expect(savIntakeComparisonSpend([{ callId: "c", event: "reserved", reservedNanoUsd: 817152000 }])).toBe(817152000);
  });
  it("a failure of the current reader is technical evidence, never a divergence of judgement (review P2)", async () => {
    const a = await stored(), e = env(mailboxId, [a.id]);
    const result = await runSavIntakeComparisonBatch({ env: () => e, network: provider({ currentStatus: 500 }).network });
    expect(result).toMatchObject({ compared: [{ verdict: "incomplete" }] });
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.rows[0].detail).toMatchObject({ differences: ["current:SAV_AI_HTTP_500", "simple:ok"] });
    expect(compareIntakeSides({ summary: null, technical: "SAV_AI_HTTP_500", uncertain: false, calls: 1 }, { summary: { classification: "support" } as never, technical: null, uncertain: false, calls: 1 }, []).verdict).toBe("incomplete");
  });
  it("its own money cap stops the campaign, recorded as incomplete", async () => {
    const a = await stored(), p = provider(), e = env(mailboxId, [a.id], { maxNanoUsd: 1 });
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network })).toMatchObject({ compared: [{ verdict: "incomplete" }] });
    expect(p.seen).toEqual([]);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.spend.nanoUsd).toBe(0);
  });
  it("a dossier with attachments is reported as not comparable here, never as a judgement", async () => {
    const a = await stored("Voir la capture.", [{ filename: "capture.png" }]), e = env(mailboxId, [a.id]);
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: provider().network })).toMatchObject({ compared: [{ verdict: "non_comparable" }] });
  });
  it("an interrupted dossier (claim without result) is reported and never re-sent automatically", async () => {
    const a = await stored(), b = await stored(), p = provider(), e = env(mailboxId, [a.id, b.id]);
    await claimSavIntakeComparison("sample-60", a.id);
    await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 5 });
    expect(p.seen.filter(s => s === "simple")).toHaveLength(1);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report).toMatchObject({ denominators: { listed: 2, done: 1, interrupted: 1, pending: 0 } });
  });
});
