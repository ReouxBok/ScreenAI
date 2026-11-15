import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeConfigurationHash, intakeRuntimeHash, savIntakeRuntimeConfig, savIntakeRuntimePins } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeBudget, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { readIntakeRunDiagnostics } from "./run-diagnostics";
import { readIntakeNoiseSenderHistory } from "./noise-filter-runtime";

// SAV-92 noise filter on the real intake chain (local database, model and CRM mocked at the network boundary).
// Synthetic data only.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
const sender = "news@lists.example.invalid";
const newsletter = { "x-studio-automation-headers": "singleton-v1", "x-studio-noise-headers": "v1", "content-type": "text/plain; charset=UTF-8",
  "list-id": "present", "list-unsubscribe": "present", precedence: "bulk", "auto-submitted": "", "in-reply-to": "", references: "" };
function env(mailbox: string, mode?: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    ...(mode === undefined ? {} : { SAV_INTAKE_NOISE_FILTER: mode }),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) } as Record<string, string | undefined>;
}
async function mail(options: { from?: string; headers?: Record<string, string>; direction?: "inbound" | "outbound"; to?: string[]; threadTicket?: string; body?: string; receivedAt?: Date } = {}) {
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: options.from ?? sender, hubspotTicketId: options.threadTicket ?? null }).returning();
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: options.direction ?? "inbound", fromEmail: options.from ?? sender, toEmails: options.to ?? ["support@example.invalid"],
    subject: "Lettre fictive de novembre", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: options.body ?? "Les nouveautés fictives du mois. Se désinscrire.", attachments: [], headers: options.headers ?? newsletter }),
    receivedAt: options.receivedAt ?? new Date(), createdAt: new Date() }).returning();
  return m;
}
// A valid model answer for any mail: the off/observe comparison only needs the same normal path.
const network = (messageId: string) => vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
    const answer = { messageId, requests: [{ id: "support-1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
      ticketSummary: { title: "Sujet fictif", description: "Description fictive.", requestIds: ["support-1"] } };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
  }
  return Response.json({ total: 0, results: [] });
});
async function run(mode: string | undefined, m: { id: string; threadId: string }) {
  const environment = env(mailboxId, mode), config = savIntakeRuntimeConfig(environment)!;
  const id = await enqueueSavIntakeMessage(m.id, config), fetcher = network(m.id), log = vi.spyOn(console, "info").mockImplementation(() => {});
  const result = await analyseSavIntakeRuntime(id!, config, { env: () => environment, network: fetcher });
  const current = await readSavIntakeCurrent(m.threadId, config);
  const logs = log.mock.calls.map(call => String(call[0])).filter(line => line.includes("sav_intake_noise_filter"));
  log.mockRestore();
  return { result, current, fetcher, config, logs, budget: await readSavIntakeBudget(config) };
}
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  await f.client.exec("TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_occupations, sav.intake_executions, sav.intake_execution_policies, sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning(); mailboxId = mailbox.id;
});
afterEach(() => vi.unstubAllEnvs());

it("configHash: off and observe keep the previous hash, on is a new launch configuration, a typo is refused", () => {
  const environment = env(randomUUID()), pins = savIntakeRuntimePins.parse(JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!));
  const base = intakeRuntimeConfigurationHash(pins, environment);
  expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_INTAKE_NOISE_FILTER: "off" })).toBe(base);
  expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_INTAKE_NOISE_FILTER: "observe" })).toBe(base);
  expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_INTAKE_NOISE_FILTER: "on" })).not.toBe(base);
  expect(savIntakeRuntimeConfig(environment)!.noiseFilter).toBeUndefined();
  expect(savIntakeRuntimeConfig({ ...environment, SAV_INTAKE_NOISE_FILTER: "observe" })!.noiseFilter).toBe("observe");
  expect(() => savIntakeRuntimeConfig({ ...environment, SAV_INTAKE_NOISE_FILTER: "yes" })).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
});

it("off computes nothing and observe changes nothing but the stored verdict and one code-only log line", async () => {
  const off = await run(undefined, await mail());
  const observe = await run("observe", await mail({ from: "news2@lists.example.invalid" }));
  expect(off.current?.payload.noise).toBeUndefined(); expect(off.logs).toEqual([]);
  expect(observe.result.state).toBe(off.result.state);
  expect(observe.current?.payload.reason).toBe(off.current?.payload.reason);
  expect(observe.current?.payload.plan?.decision.classification).toBe(off.current?.payload.plan?.decision.classification);
  expect(observe.current?.payload.plan?.decision.disposition).toEqual(off.current?.payload.plan?.decision.disposition);
  expect(observe.fetcher.mock.calls.length).toBe(off.fetcher.mock.calls.length);
  expect(observe.fetcher).toHaveBeenCalled();
  expect(observe.current?.payload.noise).toMatchObject({ mode: "observe", verdict: "noise", reason: "SAV_NOISE_PRECEDENCE", guard: null, routed: false });
  expect(observe.logs).toHaveLength(1);
  expect(observe.logs[0]).not.toMatch(/@|lists|fictive|Lettre/);
  const diagnostic = (await readIntakeRunDiagnostics(observe.current!.threadId))?.runs[0].diagnostic;
  expect(diagnostic).toMatchObject({ noiseFilter: { mode: "observe", verdict: "noise", reason: "SAV_NOISE_PRECEDENCE", routed: false } });
});

it("on routes a proven newsletter from an unknown sender to Autre with no model or CRM call and no budget", async () => {
  const m = await mail();
  const on = await run("on", m);
  expect(on.fetcher).not.toHaveBeenCalled();
  expect(on.budget.callCount).toBe(0);
  expect(on.result.state).toBe("observed");
  expect(on.current?.payload.reason).toBe("SAV_INTAKE_NOISE_FILTERED");
  expect(on.current?.payload.plan?.decision).toMatchObject({ classification: "other", disposition: { kind: "no_ticket", reason: "qualified_other", qualifiedInformation: "automated_noise" } });
  expect(on.current?.payload.plan?.progress).toMatchObject({ kind: "qualified_other", view: "other" });
  expect(on.current?.payload.noise).toMatchObject({ mode: "on", verdict: "noise", routed: true });
  expect(JSON.parse(on.logs[0])).toMatchObject({ mode: "on", routed: true, messageId: m.id });
});

it("on never filters a known sender, a ticketed thread or a finance mail: the normal model path runs", async () => {
  // A sender who wrote before, in another thread.
  await mail({ headers: {}, receivedAt: new Date(Date.now() - 600_000) });
  const known = await run("on", await mail());
  expect(known.fetcher).toHaveBeenCalled();
  expect(known.current?.payload.noise).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_KNOWN_SENDER", routed: false });
  expect(known.current?.payload.plan?.progress.kind).not.toBe("qualified_other");

  const ticketed = await run("on", await mail({ from: "other@lists.example.invalid", threadTicket: "4242" }));
  expect(ticketed.current?.payload.noise).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_THREAD_TICKET" });
  expect(ticketed.fetcher).toHaveBeenCalled();

  const finance = await run("on", await mail({ from: "third@lists.example.invalid", body: "Votre facture fictive est disponible. Se désinscrire." }));
  expect(finance.current?.payload.noise).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_SENSITIVE" });
  expect(finance.fetcher).toHaveBeenCalled();
});

it("reads the sender history locally, case-insensitively, across threads and directions", async () => {
  const current = await mail({ from: "Someone@Example.invalid" });
  expect(await readIntakeNoiseSenderHistory(f.db, { mailboxId, messageId: current.id, address: "someone@example.invalid" })).toEqual({ priorInbound: 0, outboundTo: 0, ticketThreads: 0 });
  await mail({ from: "SOMEONE@example.invalid", headers: {} });
  await mail({ from: "support@example.invalid", direction: "outbound", to: ["someone@EXAMPLE.invalid"], headers: {} });
  await mail({ from: "someone@example.invalid", threadTicket: "99", headers: {} });
  expect(await readIntakeNoiseSenderHistory(f.db, { mailboxId, messageId: current.id, address: "Someone@Example.invalid" })).toEqual({ priorInbound: 2, outboundTo: 1, ticketThreads: 1 });
});

it("offline replay: read-only counts per rule and guard, ids only, as of each mail's receipt", async () => {
  const { savIntakeConsole } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");
  const { replaySavIntakeNoiseFilter } = await import("./noise-filter-replay");
  const noise = await mail({ from: "fresh@lists.example.invalid" });
  const legacy = await mail({ from: "client@example.invalid", headers: { "x-studio-automation-headers": "singleton-v1", "content-type": "text/plain" }, body: "Bonjour, mon accès est bloqué." });
  const later = await mail({ from: "fresh@lists.example.invalid", receivedAt: new Date(Date.now() + 1000) });
  for (const [m, view] of [[noise, "other"], [legacy, "to_validate"], [later, "to_validate"]] as const)
    await f.db.insert(savIntakeConsole).values({ threadId: m.threadId, messageId: m.id, mailboxId, view, status: "synthetic" });
  const before = await f.db.select().from(savMessages);
  const report = await f.db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return replaySavIntakeNoiseFilter(tx, { mailboxId }); });
  expect(report).toMatchObject({ total: 3, scanned: 3, unreadable: 0, headersCaptured: 2, byView: { other: 1, to_validate: 2 },
    noiseByReason: { SAV_NOISE_PRECEDENCE: 1 }, keptWithSignalByGuard: { SAV_NOISE_GUARD_KNOWN_SENDER: 1 }, noiseFromToValidate: [] });
  expect(JSON.stringify(report)).not.toMatch(/@|example|Bonjour|Lettre/);
  expect(await f.db.select().from(savMessages)).toEqual(before);
});
