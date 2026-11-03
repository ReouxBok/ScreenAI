/**
 * V1 resume on an incomplete CRM history, from the real entry (`analyseSavIntakeRuntime`): a run that waits on a partial
 * history is resumed only when the CRM moved. No real model, no real CRM: every answer is synthetic.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savIntakeJournal, savIntakeModelCalls, savIntakeRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { enqueueSavIntakeMessage, pendingSavIntakeRuns, readSavIntakeBudget, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { isSavIntakeHubspotRead } from "./hubspot-readers";
import { SAV_INTAKE_RESUME_NO_PROGRESS, SAV_INTAKE_RESUME_PROBE_UNAVAILABLE } from "./resume-progress";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string, config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
function env(mailbox: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored(text = "La connexion ne marche plus.") {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Connexion fictive", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  return m;
}

/** One synthetic CRM and one synthetic model; the test moves the CRM between resumes. */
type History = "partial" | "complete" | "grown";
function world() {
  const stableNow = Date.now();
  const crm = { history: "partial" as History, ticketSubject: "Connexion fictive", down: false };
  const seen = { model: 0, crm: [] as { method: string; path: string }[] };
  const edge = (id: string) => ({ toObjectId: id, associationTypes: [{ typeId: 1, category: "HUBSPOT_DEFINED" }] });
  const note = (id: string, text: string) => ({ id, properties: { hs_note_body: text, hs_timestamp: new Date(stableNow - 20 * 86_400_000).toISOString() } });
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      seen.model++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), catalogue = data.citationCatalogue as { id: string; sourceId: string }[];
      const answer = !data.tickets ? { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: catalogue.find(x => x.sourceId === "current")!.id }],
        ticketSummary: { title: "Connexion fictive en panne", description: "La connexion fictive ne marche plus.", requestIds: ["r1"] } }
        : { investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r1"], evidenceIds: ["current", "ticket-201", "history-201"],
          rationale: "Même panne fictive", grounding: ["current", "ticket-201", "history-201"].map(sourceId => ({ quoteId: catalogue.find(x => x.sourceId === sourceId)!.id })) }] };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
    }
    const target = new URL(String(url)); seen.crm.push({ method: init?.method ?? "GET", path: target.pathname + target.search });
    if (crm.down) throw TypeError("Synthetic CRM outage");
    const path = target.pathname;
    if (path.endsWith("/contacts/search")) return Response.json({ results: [{ id: "101", properties: { email: "synthetic@example.invalid", hs_additional_emails: null } }], total: 1 });
    if (path.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages: ["1", "2", "3", "4"].map(id => ({ id, metadata: { isClosed: id === "4" } })) });
    if (path.endsWith("contacts/101/associations/tickets")) return Response.json({ results: [edge("201")] });
    if (path.endsWith("tickets/201/associations/contacts")) return Response.json({ results: [edge("101")] });
    if (path.endsWith("/tickets/batch/read")) return Response.json({ status: "COMPLETE", results: [{ id: "201", properties: { subject: crm.ticketSubject, content: "Panne de connexion fictive", createdate: new Date(stableNow - 30 * 86_400_000).toISOString(),
      hs_pipeline: "0", hs_pipeline_stage: "2", hubspot_owner_id: "301", hs_last_closed_date: new Date(stableNow - 5 * 86_400_000).toISOString() } }] });
    // The same page is offered again and again while the history is partial: the reader reports a pagination cycle, never an empty history.
    if (path.endsWith("tickets/201/associations/notes")) return Response.json(crm.history === "partial" ? { results: [edge("401")], paging: { next: { after: "page-2" } } }
      : { results: crm.history === "grown" ? [edge("401"), edge("402")] : [edge("401")] });
    if (path.endsWith("/notes/batch/read")) {
      const wanted = (JSON.parse(String(init?.body)).inputs as { id: string }[]).map(i => i.id);
      return Response.json({ status: "COMPLETE", results: wanted.map(id => note(id, id === "401" ? "Panne de connexion déjà investiguée" : "Nouvelle note fictive")) });
    }
    return Response.json({ results: [] });
  });
  return { crm, seen, network };
}
const kinds = async (runId: string) => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, runId))).map(j => j.kind);
const run = async (runId: string) => (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)))[0];
const payloadOf = async (runId: string) => decryptSavPayload<IntakeRuntimePayload>((await run(runId)).payloadCiphertext);
const analyse = (runId: string, w: ReturnType<typeof world>) => analyseSavIntakeRuntime(runId, config, { env: () => environment, network: w.network });
async function firstAttempt(w: ReturnType<typeof world>) {
  const id = (await enqueueSavIntakeMessage(messageId, config))!, result = await analyse(id, w);
  return { id, result };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning())[0].id;
  messageId = (await stored()).id; environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());

it("a normal run from the real entry (complete history) is unchanged: observed, no proof, no hold", async () => {
  const w = world(); w.crm.history = "complete";
  const { id, result } = await firstAttempt(w);
  expect(result).toMatchObject({ state: "observed" });
  expect((await payloadOf(id)).resumeProof).toBeUndefined();
  expect((await run(id)).attempts).toBe(1);
  expect(await kinds(id)).not.toEqual(expect.arrayContaining(["resume_held"]));
  expect(w.seen.model).toBe(2);
});

it("a partial history leaves a proof of what was read, without any content", async () => {
  const w = world(), { id, result } = await firstAttempt(w);
  expect(result).toMatchObject({ state: "waiting" });
  const current = await readSavIntakeCurrent(threadId, config), proof = (await payloadOf(id)).resumeProof;
  expect(current?.payload.reason).toBe("pagination_cycle");
  expect(proof).toMatchObject({ configHash: config.configHash, sourceHash: (await run(id)).sourceHash, truncated: false, incomplete: "pagination_cycle" });
  expect(proof!.reads.filter(r => r.status !== "complete").map(r => r.method)).toEqual(["ticketHistory"]);
  expect(JSON.stringify(proof)).not.toMatch(/Panne de connexion|Connexion fictive/);
  expect((await run(id)).attempts).toBe(1);
  expect(w.seen.model).toBe(1);
});

it("resuming an unchanged partial history (cron, wake or button, repeated) takes no attempt, makes no model call, writes nothing to the CRM and leaves one trace", async () => {
  const w = world(), { id } = await firstAttempt(w);
  const before = { model: w.seen.model, budget: await readSavIntakeBudget(config), payload: (await run(id)).payloadCiphertext };
  for (let n = 0; n < 4; n++) expect(await analyse(id, w)).toEqual({ skipped: SAV_INTAKE_RESUME_NO_PROGRESS });
  expect(w.seen.model).toBe(before.model);
  const after = await readSavIntakeBudget(config);
  expect([after.callCount, after.chargedNanoUsd, after.remainingNanoUsd]).toEqual([before.budget.callCount, before.budget.chargedNanoUsd, before.budget.remainingNanoUsd]);
  expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(before.budget.callCount);
  const row = await run(id);
  expect(row.attempts).toBe(1); expect(row.state).toBe("waiting"); expect(row.leaseUntil).toBeNull(); expect(row.payloadCiphertext).toBe(before.payload);
  expect(await kinds(id)).toEqual(expect.arrayContaining(["claimed", "waiting"]));
  expect((await kinds(id)).filter(k => k === "resume_held")).toHaveLength(1);
  expect((await kinds(id)).filter(k => k === "claimed")).toHaveLength(1);
  // Only reads: the allow-listed GET and search paths of the CRM readers, never anything else.
  expect(w.seen.crm.every(r => isSavIntakeHubspotRead(r.path, r.method))).toBe(true);
  const [marker] = await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
  expect(marker.technicalMetadata).toMatchObject({ state: "held", cause: "no_progress", holds: 4 });
  expect(JSON.stringify(marker)).not.toMatch(/@|Connexion/);
});

it("the scheduler leaves a held run alone until its next look, then looks again at no cost; the button never waits", async () => {
  const w = world(), { id } = await firstAttempt(w);
  expect((await pendingSavIntakeRuns(config)).map(r => r.id)).toContain(id);
  await analyse(id, w);
  expect((await pendingSavIntakeRuns(config)).map(r => r.id)).not.toContain(id);
  expect((await pendingSavIntakeRuns(config, new Date(Date.now() + 5 * 60_000))).map(r => r.id)).not.toContain(id);
  expect((await pendingSavIntakeRuns(config, new Date(Date.now() + 11 * 60_000))).map(r => r.id)).toContain(id);
  // The manual path probes at once, inside the delay, and still takes nothing while nothing moved.
  const reads = w.seen.crm.length;
  expect(await analyse(id, w)).toEqual({ skipped: SAV_INTAKE_RESUME_NO_PROGRESS });
  expect(w.seen.crm.length).toBeGreaterThan(reads);
  expect((await run(id)).attempts).toBe(1);
});

it("pagination completed: the run is resumed on that real progress, once, with the attempt and the model call of a normal resume", async () => {
  const w = world(), { id } = await firstAttempt(w);
  await analyse(id, w);
  w.crm.history = "complete";
  const modelBefore = w.seen.model, result = await analyse(id, w);
  expect(result).toMatchObject({ state: "observed" });
  expect((await run(id)).attempts).toBe(2);
  expect(w.seen.model).toBe(modelBefore + 1); // Understanding is reused; only the issue assessment is newly dispatched.
  const sequence = await kinds(id);
  expect(sequence.filter(k => k === "resume_progress")).toHaveLength(1);
  expect(sequence.filter(k => k === "claimed")).toHaveLength(2);
  const progress = decryptSavPayload<{ method: string; change: string }>((await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.kind, "resume_progress")))[0].payloadCiphertext);
  expect(progress).toMatchObject({ method: "ticketHistory", change: "completed" });
  expect((await payloadOf(id)).resumeProof).toBeUndefined();
  const [marker] = await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
  expect(marker.technicalMetadata).toMatchObject({ state: "released" });
});

it("a complete read that changed is progress even while the history is still partial; the next wait leaves a new proof and the two-attempt bound still ends it", async () => {
  const w = world(), { id } = await firstAttempt(w);
  w.crm.ticketSubject = "Connexion fictive, sujet modifié";
  expect(await analyse(id, w)).toMatchObject({ state: "waiting" });
  expect((await run(id)).attempts).toBe(2);
  expect(decryptSavPayload<{ method: string; change: string }>((await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.kind, "resume_progress")))[0].payloadCiphertext))
    .toMatchObject({ method: "ticketsForContact", change: "changed" });
  expect((await payloadOf(id)).resumeProof).toBeDefined();
  expect((await pendingSavIntakeRuns(config, new Date(Date.now() + 24 * 3600_000))).map(r => r.id)).not.toContain(id);
});

it("a history that grew while complete (new note) is progress when the read had been incomplete", async () => {
  const w = world(), { id } = await firstAttempt(w);
  w.crm.history = "grown";
  expect(await analyse(id, w)).toMatchObject({ state: "observed" });
  expect((await run(id)).attempts).toBe(2);
});

it("two simultaneous resumes of an unchanged state: both held, one trace, nothing taken", async () => {
  const w = world(), { id } = await firstAttempt(w);
  const modelBefore = w.seen.model;
  const results = await Promise.all([analyse(id, w), analyse(id, w)]);
  expect(results).toEqual(expect.arrayContaining([{ skipped: SAV_INTAKE_RESUME_NO_PROGRESS }, { skipped: "not_claimed" }]));
  expect(w.seen.model).toBe(modelBefore);
  expect((await run(id)).attempts).toBe(1);
  expect((await kinds(id)).filter(k => k === "resume_held")).toHaveLength(1);
});

it("two simultaneous resumes on real progress: exactly one takes the attempt and reads the message", async () => {
  const w = world(), { id } = await firstAttempt(w);
  w.crm.history = "complete";
  const modelBefore = w.seen.model, results = await Promise.all([analyse(id, w), analyse(id, w)]);
  expect(results.filter(r => "state" in r)).toHaveLength(1);
  expect(results.filter(r => "skipped" in r)).toHaveLength(1);
  expect((await run(id)).attempts).toBe(2);
  expect(w.seen.model).toBe(modelBefore + 1); // Understanding is reused; only the issue assessment is newly dispatched.
  expect((await kinds(id)).filter(k => k === "claimed")).toHaveLength(2);
});

it("a CRM that cannot be read at resume is never taken for progress: held at no cost, then the unchanged state is recognised once it answers again", async () => {
  const w = world(), { id } = await firstAttempt(w);
  const modelBefore = w.seen.model;
  w.crm.down = true;
  expect(await analyse(id, w)).toEqual({ skipped: SAV_INTAKE_RESUME_PROBE_UNAVAILABLE });
  expect((await run(id)).attempts).toBe(1); expect(w.seen.model).toBe(modelBefore);
  w.crm.down = false;
  expect(await analyse(id, w)).toEqual({ skipped: SAV_INTAKE_RESUME_NO_PROGRESS });
  expect((await run(id)).attempts).toBe(1);
  expect((await kinds(id)).filter(k => k === "resume_held")).toHaveLength(2);
});

it("a new message is a new input: the held run is not read again, the new one starts with fresh attempts and no proof", async () => {
  const w = world(), { id } = await firstAttempt(w);
  const second = await stored("Bonjour, toujours la même erreur et voici une capture de l’écran.");
  const newId = (await enqueueSavIntakeMessage(second.id, config))!;
  expect(newId).not.toBe(id);
  const modelBefore = w.seen.model;
  expect(await analyse(id, w)).toEqual({ skipped: "not_claimed" });
  expect(w.seen.model).toBe(modelBefore);
  expect((await run(id)).attempts).toBe(1);
  expect((await run(newId)).attempts).toBe(0);
  expect(await analyse(newId, w)).not.toHaveProperty("skipped");
  expect((await run(newId)).attempts).toBe(1);
});

it("operator information or an edited mail changes the content hash: the old proof no longer holds and the resume is the ordinary one", async () => {
  const w = world(), { id } = await firstAttempt(w);
  const row = await run(id), payload = decryptSavPayload<IntakeRuntimePayload>(row.payloadCiphertext);
  await f.db.update(savIntakeRuns).set({ payloadCiphertext: encryptSavPayload({ ...payload, resumeProof: { ...payload.resumeProof!, sourceHash: "another-content" } }) }).where(eq(savIntakeRuns.id, id));
  const modelBefore = w.seen.model;
  expect(await analyse(id, w)).toMatchObject({ state: "waiting" });
  expect((await run(id)).attempts).toBe(2);
  expect(w.seen.model).toBe(modelBefore); // Unchanged understanding is served from the settled result.
});

it("old data resumes as it always did: a wait recorded before this change (no proof) or an unreadable proof", async () => {
  for (const legacy of [undefined, { revision: "intake-resume-proof.v0" }, "garbage"]) {
    await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
    threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning())[0].id;
    messageId = (await stored()).id; environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
    const w = world(), { id } = await firstAttempt(w);
    const row = await run(id), payload = decryptSavPayload<IntakeRuntimePayload & { resumeProof?: unknown }>(row.payloadCiphertext);
    if (legacy === undefined) delete payload.resumeProof; else payload.resumeProof = legacy as never;
    await f.db.update(savIntakeRuns).set({ payloadCiphertext: encryptSavPayload(payload) }).where(eq(savIntakeRuns.id, id));
    const modelBefore = w.seen.model;
    expect(await analyse(id, w)).toMatchObject({ state: "waiting" });
    expect((await run(id)).attempts).toBe(2);
    expect(w.seen.model).toBe(modelBefore); // Unchanged understanding is served from the settled result.
    expect(await kinds(id)).not.toContain("resume_held");
  }
});

it("a held run is not blocked: it stays waiting with its two-attempt bound intact and no blocking marker", async () => {
  const w = world(), { id } = await firstAttempt(w);
  await analyse(id, w);
  const row = await run(id);
  expect(row.state).toBe("waiting"); expect(row.attempts).toBe(1);
  expect(await kinds(id)).not.toEqual(expect.arrayContaining(["attempts_exhausted"]));
  expect(await kinds(id)).not.toEqual(expect.arrayContaining(["deterministic_block"]));
  expect(await kinds(id)).not.toEqual(expect.arrayContaining(["source_invalid"]));
});

it("does not probe HubSpot after a dossier has been paused", async () => {
  const w = world(), { id } = await firstAttempt(w);
  const reads = w.seen.crm.length;
  await f.db.update(savThreads).set({ aiPaused: true, humanRequestedAt: new Date() }).where(eq(savThreads.id, threadId));
  expect(await analyse(id, w)).toEqual({ skipped: "not_claimed" });
  expect(w.seen.crm).toHaveLength(reads);
  expect((await run(id)).attempts).toBe(1);
});

it.each(["proof", "paused"] as const)("ignores a probe when %s changes during the network read", async mutation => {
  const w = world(), { id } = await firstAttempt(w);
  const before = w.seen.model;
  const payload = await payloadOf(id);
  w.crm.history = "complete";
  const [path] = w.seen.crm.slice(-1);
  expect(path).toBeDefined();
  w.network.mockImplementationOnce(async () => {
    if (mutation === "proof") {
      const proof = { ...payload.resumeProof!, incomplete: "different-read" };
      await f.db.update(savIntakeRuns).set({ payloadCiphertext: encryptSavPayload({ ...payload, resumeProof: proof }) }).where(eq(savIntakeRuns.id, id));
    } else {
      await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    }
    return Response.json({ results: [] });
  });
  expect(await analyse(id, w)).toEqual({ skipped: "not_claimed" });
  expect((await run(id)).attempts).toBe(1);
  expect(w.seen.model).toBe(before);
  expect(await kinds(id)).not.toContain("resume_progress");
});
