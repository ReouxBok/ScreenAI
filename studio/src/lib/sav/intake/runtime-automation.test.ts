import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeBudget, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";

// Synthetic mails only; the model and CRM are fakes and any other network call fails the test.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
let config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
const supportId = "<sav-synthetic-action@studio.example.invalid>", campaignId = "<synthetic-campaign@marketing.example.invalid>";
const absence = { "x-studio-automation-headers": "singleton-v1", "auto-submitted": "auto-replied", "content-type": "text/plain; charset=UTF-8", "in-reply-to": campaignId, references: campaignId };
function env(mailbox: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function mail(options: { direction?: "inbound" | "outbound"; from?: string; subject?: string; text?: string; headers?: Record<string, string>; receivedAt?: Date; legacy?: true }) {
  const body = options.legacy ? { text: options.text ?? "" } : { text: options.text ?? "", attachments: [], headers: options.headers ?? {} };
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: options.direction ?? "inbound", fromEmail: options.from ?? "synthetic@example.invalid",
    toEmails: [options.direction === "outbound" ? "synthetic@example.invalid" : "support@example.invalid"], subject: options.subject ?? "Connexion fictive", gmailMessageId: randomUUID(),
    bodyCiphertext: encryptSavPayload(body), receivedAt: options.receivedAt ?? new Date(), analysisStatus: options.direction === "outbound" ? "done" : "pending" }).returning();
  return m;
}
const forbidden = () => vi.fn(async (): Promise<Response> => { throw Error("NETWORK_FORBIDDEN"); });
/** The existing runtime fake: one model answer (support), then an empty CRM lookup. */
const modelAndCrm = (messageId: string) => vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
    const answer = { messageId, requests: [{ id: "support-1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
      ticketSummary: { title: "Connexion fictive en panne", description: "La connexion fictive ne marche plus.", requestIds: ["support-1"] } };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
  }
  expect(String(url)).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
  return Response.json({ total: 0, results: [] });
});
async function excluded(messageId: string, code: string) {
  const current = await readSavIntakeCurrent(threadId, config);
  expect(current?.payload.reason).toBe(code);
  if (code === "SAV_INTAKE_AUTOMATED_REPLY") {
    expect(current?.payload.plan?.decision).toMatchObject({ classification: "acknowledgement", requests: [],
      disposition: { kind: "no_ticket", qualifiedInformation: "verified_automatic_reply", reason: "acknowledgement_only" },
      evidence: expect.arrayContaining([expect.objectContaining({ source: "automation_headers", sourceId: messageId })]) });
  } else {
    expect(current?.payload.plan?.decision).toMatchObject({ classification: "unknown", requests: [], disposition: { kind: "collect_context" } });
    expect(current?.payload.plan?.progress).toMatchObject({ kind: "human_choice", questionCode: "request_scope_uncertain", view: "to_validate" });
  }
  expect(current?.payload.traces).toEqual([expect.objectContaining({ phase: "automation_gate", code, modelCalled: false })]);
  expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  expect((await readSavIntakeBudget(config)).callCount).toBe(0);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
  // The mail is kept, unprocessed, for a person.
  const [m] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  expect(m.processedAt).toBeNull(); expect(m.analysisStatus).toBe("intake_observed");
}
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  await f.client.exec("TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_occupations, sav.intake_executions, sav.intake_execution_policies, sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning(); mailboxId = mailbox.id;
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning(); threadId = thread.id;
  environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());

it("a proven absence becomes an acknowledgement without a model or CRM call", async () => {
  const m = await mail({ subject: "Réponse automatique : Offre fictive", text: "Je suis absent jusqu'au 10 novembre.", headers: absence });
  const network = forbidden();
  expect(await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(m.id, config))!, config, { env: () => environment, network })).toMatchObject({ state: "observed" });
  expect(network).not.toHaveBeenCalled();
  await excluded(m.id, "SAV_INTAKE_AUTOMATED_REPLY");
});
it("a human reply with the same subject, or legacy mail without headers, follows the normal path to the model", async () => {
  for (const legacy of [false, true] as const) {
    const m = await mail({ subject: "Réponse automatique : Connexion fictive", text: "Auto-Submitted: auto-replied\nLa connexion ne marche plus.",
      receivedAt: new Date(Date.now() + (legacy ? 2 : 1)), ...(legacy ? { legacy: true as const } : { headers: { "content-type": "text/plain", "in-reply-to": campaignId } }) });
    const network = modelAndCrm(m.id);
    await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(m.id, config))!, config, { env: () => environment, network });
    expect(network.mock.calls.some(([url]) => String(url).startsWith("https://generativelanguage.googleapis.com/"))).toBe(true);
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    expect(JSON.stringify(current?.payload.traces)).not.toContain("automation_gate");
  }
});
it("a delivery report about a support mail keeps the proof and a follow-up for the team, without a classification", async () => {
  const sent = await mail({ direction: "outbound", from: "support@example.invalid", subject: "Re: Connexion fictive", text: "Réponse fictive du support.",
    headers: { "x-studio-automation-headers": "singleton-v1", "message-id": supportId }, receivedAt: new Date(Date.now() - 60_000) });
  const m = await mail({ from: "mailer-daemon@example.invalid", subject: "Delivery Status Notification (Failure)", text: "Adresse introuvable.",
    headers: { "x-studio-automation-headers": "singleton-v1", "auto-submitted": "auto-replied", "content-type": 'multipart/report; report-type=delivery-status; boundary="synthetic"', "in-reply-to": supportId, references: supportId } });
  const network = forbidden();
  expect(await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(m.id, config))!, config, { env: () => environment, network })).toMatchObject({ state: "observed" });
  expect(network).not.toHaveBeenCalled();
  await excluded(m.id, "SAV_INTAKE_SUPPORT_DELIVERY_FAILURE");
  expect((await f.db.select().from(savMessages).where(eq(savMessages.id, sent.id)))[0].analysisStatus).toBe("done");
});
it("a new human reply after an excluded absence reply is analysed normally", async () => {
  const automatic = await mail({ text: "Je suis absent.", headers: absence, receivedAt: new Date(Date.now() - 1000) });
  await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(automatic.id, config))!, config, { env: () => environment, network: forbidden() });
  const human = await mail({ text: "De retour : la connexion ne marche plus.", headers: { "content-type": "text/plain", "in-reply-to": campaignId } });
  const network = modelAndCrm(human.id);
  await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(human.id, config))!, config, { env: () => environment, network });
  expect(network).toHaveBeenCalled();
  expect((await readSavIntakeCurrent(threadId, config))?.payload.plan?.decision.classification).toBe("support");
  expect(await f.db.select().from(savMessages).where(eq(savMessages.id, automatic.id))).toHaveLength(1);
});
it("a resumed run of an old waiting absence reply is stopped before any reservation", async () => {
  const m = await mail({ text: "Je suis absent.", headers: absence });
  const runId = (await enqueueSavIntakeMessage(m.id, config))!;
  // An attempt recorded before this filter existed, left waiting.
  await f.db.update(savIntakeRuns).set({ state: "waiting", attempts: 1 }).where(eq(savIntakeRuns.id, runId));
  const network = forbidden();
  expect(await analyseSavIntakeRuntime(runId, config, { env: () => environment, network })).toMatchObject({ state: "observed" });
  expect(network).not.toHaveBeenCalled();
  await excluded(m.id, "SAV_INTAKE_AUTOMATED_REPLY");
});

function minimalBudget() {
  environment.SAV_INTAKE_RUNTIME_CONFIG = JSON.stringify({ ...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),
    budgetProfile: "operational_utc_v1", maxNanoUsd: 1, maxRollingNanoUsd: 90_000_000_000, maxCalls: 300 });
  config = savIntakeRuntimeConfig(environment)!;
}

it("under the operational cap only a proven automatic mail gets through; a subsequent human inbound is deferred", async () => {
  minimalBudget();
  const first = await mail({ headers: absence, text: "Je suis absent.", receivedAt: new Date(Date.now() - 300) });
  const network = forbidden();
  const id = (await enqueueSavIntakeMessage(first.id, config))!;
  expect(await analyseSavIntakeRuntime(id, config, { env: () => environment, network })).toMatchObject({ state: "observed" });
  await excluded(first.id, "SAV_INTAKE_AUTOMATED_REPLY");
  const next = await mail({ text: "Je suis absent. Mon compte ne fonctionne plus.", headers: absence });
  await analyseSavIntakeRuntime((await enqueueSavIntakeMessage(next.id, config))!, config, { env: () => environment, network });
  expect(await readSavIntakeCurrent(threadId, config)).toMatchObject({ attempts: 0, payload: { reason: "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED" } });
  expect(network).not.toHaveBeenCalled();
});

it("an uncertain reservation from another run for the same mail prevents the automatic result", async () => {
  minimalBudget();
  const m = await mail({ headers: absence, text: "Je suis absent." }), id = (await enqueueSavIntakeMessage(m.id, config))!;
  await f.db.insert(savIntakeModelCalls).values({ messageKey: intakeRuntimeHash(m.id), requestHash: intakeRuntimeHash("unknown"),
    state: "uncertain", reservedNanoUsd: 817152000, chargedNanoUsd: 817152000, payloadCiphertext: encryptSavPayload({}) });
  const network = forbidden();
  await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
  expect(await readSavIntakeCurrent(threadId, config)).toMatchObject({ state: "uncertain", attempts: 0 });
  expect(network).not.toHaveBeenCalled();
});
