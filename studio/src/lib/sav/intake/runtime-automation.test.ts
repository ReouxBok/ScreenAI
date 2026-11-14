import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savSyncState, savActions, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeEffects, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { SAV_EXTERNAL_COMPLETION, SAV_EXTERNAL_COMPLETION_REVERTED } from "../external-completion";
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { claimSavIntakeRun, pendingSavIntakeRuns, enqueueSavIntakeMessage, readSavIntakeBudget, readSavIntakeCurrent, savIntakeSourceSnapshot } from "./runtime-store";
import { executionMessageHash } from "./execution-store";
import { analyseSavIntakeRuntime } from "./runtime";

// Synthetic mails only; the model and CRM are fakes and any other network call fails the test.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
let config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
const supportId = "<sav-synthetic-action@studio.example.invalid>", campaignId = "<synthetic-campaign@marketing.example.invalid>";
const absence = { "x-studio-automation-body": "complete-plain-v1", "x-studio-automation-headers": "singleton-v1", "auto-submitted": "auto-replied", "content-type": "text/plain; charset=UTF-8", "in-reply-to": campaignId, references: campaignId };
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
    toEmails: [options.direction === "outbound" ? "synthetic@example.invalid" : "support@example.invalid"], subject: options.subject ?? "Re : Connexion fictive", gmailMessageId: randomUUID(),
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
  // Reading Gmail is a separate worker. Analysis preserves the original message.
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

// SAV-92: only a call that may still settle holds the mail; a definitively uncertain one stays counted, never blocks forever.
it.each([["in flight", "dispatched", 0, true], ["definitively uncertain", "uncertain", 0, false], ["dispatched past the settlement horizon", "dispatched", 16 * 60_000, false]] as const)(
  "a %s reservation from another run for the same mail: blocks the automatic result = %s", async (_, state, ageMs, blocks) => {
  minimalBudget();
  const m = await mail({ headers: absence, text: "Je suis absent." }), id = (await enqueueSavIntakeMessage(m.id, config))!;
  await f.db.insert(savIntakeModelCalls).values({ messageKey: intakeRuntimeHash(m.id), requestHash: intakeRuntimeHash("unknown"),
    state, reservedNanoUsd: 817152000, chargedNanoUsd: 817152000, payloadCiphertext: encryptSavPayload({}), createdAt: new Date(Date.now() - ageMs) });
  const network = forbidden();
  await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
  const current = await readSavIntakeCurrent(threadId, config);
  if (blocks) expect(current).toMatchObject({ state: "uncertain", attempts: 0 });
  else { expect(current).toMatchObject({ attempts: 1 }); expect(current?.state).not.toBe("uncertain"); }
  expect(network).not.toHaveBeenCalled();
  // The uncertain charge is never released or reset.
  expect((await f.db.select().from(savIntakeModelCalls))[0]).toMatchObject({ state, chargedNanoUsd: 817152000 });
});

it.each(["thread", "agent"] as const)("a %s pause prevents model-free classification at the cap", async kind => {
  minimalBudget();
  const mailRow = await mail({ headers: absence, text: "Je suis absent." }), id = (await enqueueSavIntakeMessage(mailRow.id, config))!;
  const pauseKey = "sav-agent-pause.v1:intake";
  try {
    if (kind === "thread") await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    else await f.db.insert(savSyncState).values({ key: pauseKey, status: "active", updatedAt: new Date(),
      cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "intake", level: "fully_paused", setBy: "operator@example.invalid", setAt: new Date().toISOString(), reason: "test pause" }) });
    const network = forbidden();
    expect(await analyseSavIntakeRuntime(id, config, { env: () => environment, network })).toMatchObject({ skipped: "not_claimed" });
    expect(await readSavIntakeCurrent(threadId, config)).toMatchObject({ attempts: 0 });
    expect(network).not.toHaveBeenCalled();
  } finally {
    if (kind === "agent") await f.db.delete(savSyncState).where(eq(savSyncState.key, pauseKey));
  }
});

it("four older capped runs leave a scheduling slot for the next model-free notice", async () => {
  minimalBudget();
  const ids: string[] = [];
  for (let n = 0; n < 5; n++) {
    const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning();
    threadId = thread.id;
    const m = n === 4 ? await mail({ text: "Je suis absent.", headers: absence }) : await mail({ text: "Connexion impossible." });
    const id = (await enqueueSavIntakeMessage(m.id, config))!;
    ids.push(id);
    const time = new Date(Date.now() - (5 - n) * 1000);
    await f.db.update(savIntakeRuns).set({ createdAt: time, updatedAt: time }).where(eq(savIntakeRuns.id, id));
  }
  // SAV-92 fix 4: all five mails are recent, so the newest (the notice) is served first, before the capped runs.
  const batch = await pendingSavIntakeRuns(config);
  expect(batch.map(r => r.id)).toEqual([ids[4], ids[3], ids[2], ids[1]]);
  for (const id of ids.slice(0, 4)) expect(await claimSavIntakeRun(id, config)).toBeNull();
  expect((await pendingSavIntakeRuns(config))[0].id).toBe(ids[4]);
});

it.each(["absence", "delivery"] as const)("keeps an earlier unhandled request visible when a %s becomes the newest inbound", async kind => {
  minimalBudget();
  const request = await mail({ text: "Mon accès est bloqué.", receivedAt: new Date(Date.now() - 2000) });
  const oldId = (await enqueueSavIntakeMessage(request.id, config))!;
  expect(await claimSavIntakeRun(oldId, config)).toBeNull();
  await mail({ direction: "outbound", from: "support@example.invalid", text: "Message du support.",
    headers: { "x-studio-automation-headers": "singleton-v1", "message-id": supportId }, receivedAt: new Date(Date.now() - 1000) });
  const headers: Record<string, string> = kind === "absence" ? { ...absence, "in-reply-to": supportId, references: supportId } :
    { "x-studio-automation-headers": "singleton-v1", "content-type": "multipart/report; report-type=delivery-status", "in-reply-to": supportId };
  const notice = await mail({ text: kind === "absence" ? "Je suis absent." : "Avis de distribution.", headers });
  const id = (await enqueueSavIntakeMessage(notice.id, config))!, network = forbidden();
  await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
  expect(await readSavIntakeCurrent(threadId, config)).toMatchObject({ id, state: "observed",
    payload: { reason: "SAV_INTAKE_PRIOR_REQUEST_PENDING", plan: { progress: { view: "to_validate" }, decision: {
      evidence: expect.arrayContaining([expect.objectContaining({ sourceId: request.id, source: "customer_history" })]) } } } });
  expect(network).not.toHaveBeenCalled();
});

it("four released threads with an old human timestamp can finish, leaving a slot for the human mail", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid",
      aiPaused: false, humanRequestedAt: new Date("2025-01-01T00:00:00Z") }).returning();
    threadId = thread.id;
    const m = index === 4 ? await mail({ text: "Mon accès est bloqué." }) : await mail({ headers: absence, text: "Je suis absent." });
    const id = (await enqueueSavIntakeMessage(m.id, config))!;
    ids.push(id);
    await f.db.update(savIntakeRuns).set({ updatedAt: new Date(Date.now() - (5 - index) * 1000) }).where(eq(savIntakeRuns.id, id));
  }
  // SAV-92 fix 4: recent mail, newest first.
  const batch = await pendingSavIntakeRuns(config);
  expect(batch.map(r => r.id)).toEqual([ids[4], ids[3], ids[2], ids[1]]);
  for (const id of ids.slice(0, 4)) {
    const network = forbidden();
    expect(await analyseSavIntakeRuntime(id, config, { env: () => environment, network })).toMatchObject({ state: "observed" });
    expect(network).not.toHaveBeenCalled();
  }
  expect((await pendingSavIntakeRuns(config)).map(r => r.id)).toEqual([ids[4]]);
});

it.each(["completed", "to_validate", "reverted"] as const)("only a terminal, unreversed prior administrative decision (%s) allows the shortcut", async disposition => {
  minimalBudget();
  const old = await mail({ text: "Demande antérieure.", receivedAt: new Date(Date.now() - 2000) });
  const batchId = randomUUID();
  const [mark] = await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", entityType: "sav_message", entityId: old.id, action: SAV_EXTERNAL_COMPLETION,
    technicalMetadata: { version: 1, threadId, batchId, receivedBefore: new Date().toISOString(), reason: "processed_outside_studio",
      disposition: disposition === "to_validate" ? "to_validate" : "completed" } }).returning();
  if (disposition === "reverted") await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", entityType: "sav_message", entityId: old.id,
    action: SAV_EXTERNAL_COMPLETION_REVERTED, technicalMetadata: { version: 1, batchId, completionId: mark.id } });
  const notice = await mail({ text: "Je suis absent.", headers: absence });
  const run = (await enqueueSavIntakeMessage(notice.id, config))!, network = forbidden();
  await analyseSavIntakeRuntime(run, config, { env: () => environment, network });
  const result = await readSavIntakeCurrent(threadId, config);
  if (disposition === "completed") {
    expect(result).toMatchObject({ state: "observed", payload: { reason: "SAV_INTAKE_AUTOMATED_REPLY" } });
  } else {
    expect(result).toMatchObject({ state: "observed", payload: { reason: "SAV_INTAKE_PRIOR_REQUEST_PENDING", plan: { progress: { view: "to_validate" } } } });
  }
  expect(network).not.toHaveBeenCalled();
});

it("never loses the original customer request when a funded reader would call the new notice an acknowledgement", async () => {
  const earlier = await mail({ text: "Ma connexion est bloquée.", receivedAt: new Date(Date.now() - 2000) });
  const first = (await enqueueSavIntakeMessage(earlier.id, config))!;
  const notice = await mail({ text: "Je suis absent.", headers: absence });
  const id = (await enqueueSavIntakeMessage(notice.id, config))!;
  const network = ackModel(notice.id);
  await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
  expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, first)))[0].state).toBe("superseded");
  const result = (await readSavIntakeCurrent(threadId, config))?.payload.plan;
  expect(result?.decision.disposition.kind).toBe("collect_context");
  expect(result?.progress).toMatchObject({ kind: "human_choice", view: "to_validate" });
  expect(result?.decision.evidence).toContainEqual(expect.objectContaining({ source: "customer_history", sourceId: earlier.id }));
  expect(network).not.toHaveBeenCalled();
});

function ackModel(messageId: string) {
  return vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/generativelanguage.googleapis.com\//);
    const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    const answer = { messageId, requests: [{ id: "ack", kind: "acknowledgement", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }] };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
  });
}

it.each(["valid", "wrong_hash", "effect_pending"] as const)("an earlier execution receipt must match its original mail and association (%s)", async variant => {
  const old = await mail({ text: "Le compte est bloqué.", receivedAt: new Date(Date.now() - 1500) });
  const runId = (await enqueueSavIntakeMessage(old.id, config))!;
  const snapshot = await f.db.transaction(tx => savIntakeSourceSnapshot(tx, old, new Date()));
  const [staff] = await f.db.insert(staffUsers).values({ clerkId: randomUUID(), email: `${randomUUID()}@example.invalid`, name: "Test", role: "admin" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: randomUUID(), state: "approved", administratorId: staff.id, policyHash: config.policyHash, payloadCiphertext: encryptSavPayload({}) }).returning();
  const [execution] = await f.db.insert(savIntakeExecutions).values({ threadId, messageId: old.id, runId, runVersion: 1, policyId: policy.id,
    policyHash: config.policyHash, state: "confirmed", ticketId: "101", payloadCiphertext: encryptSavPayload({ completion: { sourceHash: snapshot.sourceHash,
      messageHash: variant === "wrong_hash" ? "wrong" : executionMessageHash(old) } }) }).returning();
  await f.db.insert(savIntakeEffects).values({ executionId: execution.id, businessKey: randomUUID(), permission: "hubspot_email", kind: "email_associate",
    state: variant === "effect_pending" ? "planned" : "confirmed", intentHash: intakeRuntimeHash({}), intentCiphertext: encryptSavPayload({}),
    verificationCiphertext: variant === "effect_pending" ? null : encryptSavPayload({}), confirmedAt: variant === "effect_pending" ? null : new Date() });
  const notice = await mail({ headers: absence, text: "Je suis absent." });
  const id = (await enqueueSavIntakeMessage(notice.id, config))!, network = forbidden();
  await analyseSavIntakeRuntime(id, config, { env: () => environment, network });
  const result = await readSavIntakeCurrent(threadId, config);
  expect(result?.payload.reason).toBe(variant === "valid" ? "SAV_INTAKE_AUTOMATED_REPLY" : "SAV_INTAKE_PRIOR_REQUEST_PENDING");
  expect(result?.payload.plan?.decision.disposition.kind).toBe(variant === "valid" ? "no_ticket" : "collect_context");
  expect(network).not.toHaveBeenCalled();
});
