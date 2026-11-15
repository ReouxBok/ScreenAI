import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeConsole, savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeConfigurationHash, intakeRuntimeHash, savIntakeRuntimeConfig, savIntakeRuntimePins } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeBudget, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { readIntakeRunDiagnostics } from "./run-diagnostics";
import { readIntakeNoiseSenderHistory } from "./noise-filter-runtime";
import { replaySavIntakeNoiseFilter } from "./noise-filter-replay";

// SAV-92 noise filter on the real intake chain (local database, model and CRM mocked at the network boundary).
// Synthetic data only.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
const daemon = "mailer-daemon@mx.example.invalid";
const base = { "x-studio-automation-headers": "singleton-v1", "x-studio-noise-headers": "v1", "auto-submitted": "", "in-reply-to": "", references: "" };
const dsn = { ...base, "content-type": 'multipart/report; report-type=delivery-status; boundary="synthetic"' };
const groupAlias = { ...base, "content-type": "text/plain; charset=UTF-8", precedence: "list", "list-id": "present", "list-unsubscribe": "present" };
const bounceText = "Address not found. Your message could not be delivered.";
function env(mailbox: string, mode?: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    ...(mode === undefined ? {} : { SAV_INTAKE_NOISE_FILTER: mode }),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) } as Record<string, string | undefined>;
}
type MailOptions = { from?: string; headers?: Record<string, string>; direction?: "inbound" | "outbound"; to?: string[]; threadTicket?: string; body?: string; subject?: string; receivedAt?: Date; attachments?: unknown[] };
async function mail(options: MailOptions = {}) {
  const from = options.from ?? daemon;
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: from, hubspotTicketId: options.threadTicket ?? null }).returning();
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: options.direction ?? "inbound", fromEmail: from, toEmails: options.to ?? ["support@example.invalid"],
    subject: options.subject ?? "Delivery Status Notification (Failure)", gmailMessageId: randomUUID(),
    bodyCiphertext: encryptSavPayload({ text: options.body ?? bounceText, attachments: options.attachments ?? [], headers: options.headers ?? dsn }),
    receivedAt: options.receivedAt ?? new Date(), createdAt: new Date() }).returning();
  return m;
}
const customer = (over: MailOptions = {}) => mail({ from: "client@example.invalid", subject: "Problème de connexion", body: "Bonjour, je n'arrive plus à me connecter, pouvez-vous m'aider ?", headers: groupAlias, ...over });
// A valid model answer for any mail: the normal path only needs to run.
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
const projectOther = (m: { id: string; threadId: string }) => f.db.insert(savIntakeConsole).values({ threadId: m.threadId, messageId: m.id, mailboxId, view: "other", status: "qualified_other" });
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
  const hash = intakeRuntimeConfigurationHash(pins, environment);
  expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_INTAKE_NOISE_FILTER: "off" })).toBe(hash);
  expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_INTAKE_NOISE_FILTER: "observe" })).toBe(hash);
  expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_INTAKE_NOISE_FILTER: "on" })).not.toBe(hash);
  expect(savIntakeRuntimeConfig(environment)!.noiseFilter).toBeUndefined();
  expect(savIntakeRuntimeConfig({ ...environment, SAV_INTAKE_NOISE_FILTER: "observe" })!.noiseFilter).toBe("observe");
  expect(() => savIntakeRuntimeConfig({ ...environment, SAV_INTAKE_NOISE_FILTER: "yes" })).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
});

it("off computes nothing and observe changes nothing but the stored verdict and one code-only log line", async () => {
  const off = await run(undefined, await mail());
  const observe = await run("observe", await mail({ from: "postmaster@mx2.example.invalid" }));
  expect(off.current?.payload.noise).toBeUndefined(); expect(off.logs).toEqual([]);
  expect(observe.result.state).toBe(off.result.state);
  expect(observe.current?.payload.reason).toBe(off.current?.payload.reason);
  expect(observe.current?.payload.plan?.decision.classification).toBe(off.current?.payload.plan?.decision.classification);
  expect(observe.current?.payload.plan?.decision.disposition).toEqual(off.current?.payload.plan?.decision.disposition);
  expect(observe.fetcher.mock.calls.length).toBe(off.fetcher.mock.calls.length);
  expect(observe.fetcher).toHaveBeenCalled();
  expect(observe.current?.payload.noise).toMatchObject({ mode: "observe", verdict: "noise", strength: "strong", reason: "SAV_NOISE_DELIVERY_STATUS", guard: null, routed: false });
  expect(observe.logs).toHaveLength(1);
  expect(observe.logs[0]).not.toMatch(/@|example|Address/);
  const diagnostic = (await readIntakeRunDiagnostics(observe.current!.threadId))?.runs[0].diagnostic;
  expect(diagnostic).toMatchObject({ noiseFilter: { mode: "observe", verdict: "noise", strength: "strong", reason: "SAV_NOISE_DELIVERY_STATUS", routed: false } });
});

it("on routes a proven delivery report from a new mailer-daemon to Autre with no model or CRM call and no budget", async () => {
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

it("P1 on: a first customer mail through a group alias or a helpdesk is never filtered, weak rules are only measured", async () => {
  for (const [headers, reason] of [
    [groupAlias, "SAV_NOISE_WEAK_LIST_HEADERS"],
    [{ ...base, "content-type": "text/plain", "auto-submitted": "auto-generated" }, "SAV_NOISE_WEAK_AUTO_GENERATED"],
    [{ ...base, "content-type": "text/plain", precedence: "bulk" }, "SAV_NOISE_WEAK_PRECEDENCE"],
    [{ ...base, "content-type": "text/plain", "auto-submitted": "auto-forwarded" }, "SAV_NOISE_WEAK_AUTO_SUBMITTED_OTHER"],
  ] as const) {
    const on = await run("on", await customer({ from: `client-${randomUUID()}@example.invalid`, headers }));
    expect(on.fetcher).toHaveBeenCalled();
    expect(on.current?.payload.noise).toMatchObject({ verdict: "keep", strength: "weak", reason, guard: "SAV_NOISE_KEEP_WEAK_ONLY", routed: false });
    expect(on.current?.payload.plan?.progress.kind).not.toBe("qualified_other");
  }
});

it("P2a on: a second bounce from the same mailer-daemon is filtered once the first is in Autre; a customer served before is kept", async () => {
  const first = await mail({ receivedAt: new Date(Date.now() - 600_000) });
  await projectOther(first);
  const second = await run("on", await mail());
  expect(second.fetcher).not.toHaveBeenCalled();
  expect(second.current?.payload.noise).toMatchObject({ verdict: "noise", routed: true });

  // The same mailer-daemon with one earlier mail NOT proven automatic (not in Autre) stays on the normal path.
  const other = "mailer-daemon@other.example.invalid";
  await mail({ from: other, receivedAt: new Date(Date.now() - 600_000) });
  const unproven = await run("on", await mail({ from: other }));
  expect(unproven.current?.payload.noise).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_KNOWN_SENDER" });
  expect(unproven.fetcher).toHaveBeenCalled();

  // A customer who already had a ticket: even an absence reply with a strong rule is kept.
  const client = "served@example.invalid";
  await mail({ from: client, threadTicket: "4242", headers: { ...base, "content-type": "text/plain" }, subject: "Question", body: "Bonjour." , receivedAt: new Date(Date.now() - 600_000) });
  const served = await run("on", await mail({ from: client, headers: { ...base, "content-type": "text/plain", "auto-submitted": "auto-replied" }, subject: "Réponse automatique", body: "Je suis absent jusqu'à lundi." }));
  expect(served.current?.payload.noise).toMatchObject({ verdict: "keep", reason: "SAV_NOISE_AUTO_REPLIED", guard: "SAV_NOISE_GUARD_KNOWN_SENDER" });
  expect(served.fetcher).toHaveBeenCalled();
});

it("review 2 on: a person writing from postmaster@ about a non-delivery, and a bare mailer-daemon, stay on the normal path", async () => {
  const plain = { ...base, "content-type": "text/plain; charset=UTF-8" };
  const person = await run("on", await mail({ from: "postmaster@client.example.invalid", headers: plain, subject: "Mail non remis", body: "Bonjour, votre mail n'a pas pu être remis, pouvez-vous vérifier ?" }));
  expect(person.current?.payload.noise).toMatchObject({ verdict: "keep", strength: "weak", reason: "SAV_NOISE_WEAK_DAEMON_SENDER", routed: false });
  expect(person.fetcher).toHaveBeenCalled();
  expect(person.current?.payload.plan?.progress.kind).not.toBe("qualified_other");
  const bare = await run("on", await mail({ from: "mailer-daemon@bare.example.invalid", headers: plain }));
  expect(bare.current?.payload.noise).toMatchObject({ verdict: "keep", strength: "weak", reason: "SAV_NOISE_WEAK_DAEMON_SENDER", routed: false });
  expect(bare.fetcher).toHaveBeenCalled();
});

it("P2b on: a delivery report with its attached original goes to Autre, never to a vague wait", async () => {
  const on = await run("on", await mail({ attachments: [{ filename: "original.eml", mimeType: "message/rfc822" }] }));
  expect(on.fetcher).not.toHaveBeenCalled();
  expect(on.result.state).toBe("observed");
  expect(on.current?.payload.reason).toBe("SAV_INTAKE_NOISE_FILTERED");
  expect(on.current?.payload.plan?.progress).toMatchObject({ kind: "qualified_other", view: "other" });
});

it("on never filters a ticketed thread or a finance mail: the normal model path runs", async () => {
  const ticketed = await run("on", await mail({ from: "mailer-daemon@t.example.invalid", threadTicket: "4242" }));
  expect(ticketed.current?.payload.noise).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_THREAD_TICKET" });
  expect(ticketed.fetcher).toHaveBeenCalled();
  const finance = await run("on", await mail({ from: "mailer-daemon@f.example.invalid", body: `${bounceText} Votre facture fictive.` }));
  expect(finance.current?.payload.noise).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_SENSITIVE" });
  expect(finance.fetcher).toHaveBeenCalled();
});

it("reads the sender history locally, case-insensitively, and separates proven-automatic mails", async () => {
  const current = await mail({ from: "Someone@Example.invalid" });
  expect(await readIntakeNoiseSenderHistory(f.db, { mailboxId, messageId: current.id, address: "someone@example.invalid" })).toEqual({ priorInbound: 0, priorInboundNotAutomatic: 0, outboundTo: 0, ticketThreads: 0 });
  await projectOther(await mail({ from: "SOMEONE@example.invalid", headers: {} }));
  await mail({ from: "someone@example.invalid", headers: {} });
  await mail({ from: "support@example.invalid", direction: "outbound", to: ["someone@EXAMPLE.invalid"], headers: {} });
  await projectOther(await mail({ from: "someone@example.invalid", threadTicket: "99", headers: {} }));
  expect(await readIntakeNoiseSenderHistory(f.db, { mailboxId, messageId: current.id, address: "Someone@Example.invalid" })).toEqual({ priorInbound: 3, priorInboundNotAutomatic: 2, outboundTo: 1, ticketThreads: 1 });
});

it("offline replay: read-only counts per rule and guard, ids only, as of each mail's receipt", async () => {
  const noise = await mail({ from: "mailer-daemon@fresh.example.invalid" });
  const weak = await customer();
  const later = await mail({ from: "mailer-daemon@fresh.example.invalid", receivedAt: new Date(Date.now() + 1000) });
  for (const [m, view] of [[noise, "other"], [weak, "to_validate"], [later, "to_validate"]] as const)
    await f.db.insert(savIntakeConsole).values({ threadId: m.threadId, messageId: m.id, mailboxId, view, status: view === "other" ? "qualified_other" : "synthetic" });
  const before = await f.db.select().from(savMessages);
  const report = await f.db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return replaySavIntakeNoiseFilter(tx, { mailboxId }); });
  // The later bounce sees the earlier one already in Autre: it is filtered too.
  expect(report).toMatchObject({ total: 3, scanned: 3, unreadable: 0, headersCaptured: 3, byView: { other: 1, to_validate: 2 },
    noiseByReason: { SAV_NOISE_DELIVERY_STATUS: 2 }, weakOnlyByReason: { SAV_NOISE_WEAK_LIST_HEADERS: 1 }, noiseFromToValidate: [later.id] });
  expect(JSON.stringify(report)).not.toMatch(/@|example|Bonjour|Address/);
  expect(await f.db.select().from(savMessages)).toEqual(before);
});
