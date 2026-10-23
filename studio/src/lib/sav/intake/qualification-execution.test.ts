/** Independent qualification — B (HubSpot notes, uncertain effects) and D (executor concurrency).
 * Real execution store on PGlite, real HTTP adapters, synthetic fake provider.
 * See test/sav-qualification.ts for the [INV] / [CIBLE] convention. */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { barrier, stripHtmlComments, targetIt } from "../../../../test/sav-qualification";
import { savMailboxes, savThreads, savMessages, staffUsers, savIntakeEffects, savIntakeExecutions, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { savIntakeRuntimeConfig, intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION } from "./runtime-contract";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, revokeIntakeExecutionPolicy, type ExecutionPolicy } from "./execution-policy";
import { enqueueSavIntakeMessage, claimSavIntakeRun, saveSavIntakeResult } from "./runtime-store";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, getExecutionEffects, claimExecution, saveExecutionPayload, ensureExecutionEffect, markEffectDispatched, recordEffectAck } from "./execution-store";
import { executeIntakePass, readIntakeExecutionProgress, reconcileIntakeEffectsReadOnly, reconcileIntakeEffectCandidate, reconcileIntakeExecutor, pendingIntakeEffectRecoveries } from "./executor";
import { reconcileSavIntakeRuntime, enqueueConfiguredSavIntake } from "./runtime";
import { requestIntakeReinvestigation } from "./operator-recovery";
import { savIntakeRuns } from "@/db/schema";
import type { ExecutionOptions, EffectAck, EffectIntent } from "./execution-types";

let f: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, options: ExecutionOptions;
let environment: Record<string, string | undefined>, messageId: string, threadId: string, mailboxId: string;
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template"];
const template = "SYNTHETIC exact template.";
const TARGET = process.env.SAV_QUALIFICATION_TARGET === "1";
const NOTES = "/crm/v3/objects/notes";
const notePosts = () => p.calls.filter(c => c.method === "POST" && c.path === NOTES).length;
const noteLinks = () => p.calls.filter(c => c.method === "PUT" && /\/crm\/v4\/objects\/notes\/\d+\/associations\/default\/tickets\//.test(c.path));
const writes = () => p.calls.filter(c => ["PUT", "PATCH"].includes(c.method) || c.method === "POST" && !/\/(search|batch\/read)$/.test(c.path));
const effect = async (executionId: string, kind: string) => (await getExecutionEffects(executionId)).find(e => e.kind === kind);
/** Exactly the HubSpot transformation under qualification, applied after a real POST. */
function hubspotStripsNoteComments(extra?: (properties: Record<string, string | null>) => void) {
  const network = p.network;
  p.network = async (url, init) => {
    const response = await network(url, init);
    if ((init?.method ?? "GET") === "POST" && new URL(String(url)).pathname === NOTES) {
      const { id } = await response.clone().json() as { id: string };
      const row = p.objects.notes[id];
      row.properties.hs_note_body = stripHtmlComments(row.properties.hs_note_body ?? "");
      extra?.(row.properties);
    }
    return response;
  };
  options.adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment });
}
/** Reopen of a closed ticket yields a plan with noteText (return note). */
async function reopenAdmission(seed = true) {
  if (seed) p.seedTicket({ stage: "closed", closedAt: new Date(Date.now() - 1000).toISOString() });
  const runtime = options.runtime, id = (await enqueueSavIntakeMessage(messageId, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
  const plan = await planSavIntake(lease.input, { ...createSavIntakeHubspotReaders({ network: p.network }),
    analyseMessage: async () => ({ messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId }],
      ticketSummary: { title: "Synthetic connection failure", description: "The synthetic connection fails.", requestIds: ["r1"] } }),
    assessIssues: async ({ tickets, requests }) => ({ investigationComplete: true, tickets: tickets.map(({ ticket: t }) => ({
      ticketId: t.id, relation: "same", requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }),
  }, runtime.policy, {}, () => new Date());
  if (seed) expect(plan.noteText).toBeTruthy();
  await saveSavIntakeResult(lease, runtime, { revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input }, "observed");
  const row = await admitIntakeExecution(id, options);
  expect(row).not.toBeNull();
  return row!;
}
async function dueNow(executionId: string) {
  await f.db.update(savIntakeEffects).set({ nextReconcileAt: null }).where(eq(savIntakeEffects.executionId, executionId));
}

// Measured: ~1.2 s per reopen scenario alone; up to 5.2 s when the whole intake
// suite shares 4 CPUs (24 PGlite files). Environment constraint, not a product delay.
vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters");
  await f.client.exec("TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
  await f.db.insert(savSyncState).values({ key: "sav-intake-execution-schema-v1", status: "installed" }).onConflictDoNothing();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.user = { id: admin.clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread", customerEmail: "customer@example.invalid" }).returning())[0].id;
  const [m] = await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid",
    toEmails: ["support@example.invalid"], subject: "Synthetic connection failure", receivedAt: new Date(),
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }) }).returning();
  messageId = m.id;
  const ref = { resourceId: "synthetic-template", revisionId: "v1", sha256: createHash("sha256").update(template).digest("hex") };
  const catalogue = [{ resource: ref, text: template, approvalId: "synthetic-approval", approvedBy: "synthetic-admin", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved" }];
  const enginePolicy = { relationRevision: "synthetic-relations", admittedRelations: [{ category: "HUBSPOT_DEFINED", typeId: 449 }], resources: { identification: ref, registrationNotFound: ref } };
  environment = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake",
    SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(catalogue),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash(catalogue), maxCalls: 30, maxNanoUsd: 3000000000 }) };
  const runtime = savIntakeRuntimeConfig(environment)!;
  const policy: ExecutionPolicy = { revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash,
    resourcesHash: runtime.resourcesHash, createdAfter: runtime.createdAfter, receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 10, mutations, admission: { kind: "automatic" } };
  const grant = await approveIntakeExecutionPolicy(policy);
  environment = { ...environment, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash };
  p = executionProvider();
  p.setGmail(m.gmailMessageId!, "gmail-thread");
  options = { runtime, policy, config: intakeExecutionConfig(environment)!, env: () => environment, signal: AbortSignal.timeout(30000),
    adapters: createIntakeExecutorAdapters({ network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment }) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("[INV] B0 nominal reopen: one note POST, association bound to the confirmed note receipt, nothing else", async () => {
  const row = await reopenAdmission();
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  const create = (await effect(row.id, "note_create"))!, associate = (await effect(row.id, "note_associate"))!;
  const receipt = decryptSavPayload<EffectAck>(create.ackCiphertext!).id;
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(1);
  expect(noteLinks()[0].path).toContain(`/notes/${receipt}/`);
  expect(decryptSavPayload<EffectIntent>(associate.intentCiphertext).objectId).toBe(receipt);
  expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(0);
});

it("[INV] B1 stripped HTML comment after a real ACK: never a second POST nor an association before note_create confirmation", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission();
  const first = await executeIntakePass(row.id, options);
  // Whatever the verdict, the note was posted exactly once and the receipt is kept.
  expect(notePosts()).toBe(1);
  const create = (await effect(row.id, "note_create"))!;
  expect(decryptSavPayload<EffectAck>(create.ackCiphertext!).id).toBe(Object.keys(p.objects.notes)[0]);
  if (create.state !== "confirmed") {
    expect(first.state).toBe("uncertain");
    expect(noteLinks()).toHaveLength(0);
    expect(await effect(row.id, "note_associate")).toBeUndefined();
  }
  // Cron recovery and further passes are read-only for this effect.
  for (let n = 0; n < 6; n++) {
    await dueNow(row.id);
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  }
  expect(notePosts()).toBe(1);
  expect(noteLinks().length).toBeLessThanOrEqual(1);
  const after = (await effect(row.id, "note_create"))!;
  if (after.state !== "confirmed") {
    expect(after.reconcileAttempts).toBeLessThanOrEqual(5);
    expect(await readIntakeExecutionProgress(messageId)).toMatchObject({ confirmed: false });
  }
});

it("[REPRO→NR] B1: base keeps a stripped note uncertain forever; fixed code confirms exactly once", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission();
  await executeIntakePass(row.id, options);
  for (let n = 0; n < 6; n++) { await dueNow(row.id); await reconcileIntakeEffectsReadOnly(row.id, options.adapters); }
  const create = (await effect(row.id, "note_create"))!;
  if (TARGET) {
    expect(create.state).toBe("confirmed");
    expect(create.reconcileAttempts).toBe(0);
    expect(notePosts()).toBe(1);
    return;
  }
  expect(create.state).toBe("uncertain");
  expect(create.reconcileAttempts).toBe(5);
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(0);
});

targetIt("[CIBLE] B2 real ACK + exactly-proven comment removal confirms once, then association and stage", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission();
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(1);
  expect(p.calls.filter(c => c.method === "PATCH")).toHaveLength(1);
  expect(await readIntakeExecutionProgress(messageId)).toMatchObject({ confirmed: true });
});

targetIt("[CIBLE] B3 restart after ACK (crash before verification) resumes read-only and confirms without a second POST", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission();
  await executeIntakePass(row.id, options, { afterAck: async e => { if (e.kind === "note_create") throw Error("SYNTHETIC_CRASH_AFTER_ACK"); } });
  expect(notePosts()).toBe(1);
  await dueNow(row.id);
  await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
  expect((await effect(row.id, "note_create"))!.state).toBe("confirmed");
  await f.db.update((await import("@/db/schema")).savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1), updatedAt: new Date(Date.now() - 120000) });
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  expect(notePosts()).toBe(1);
});

it("[REPRO→NR] B4 POST without response: never a second POST; fixed format recovers by its visible marker", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission(), dispatch = options.adapters.dispatch;
  options.adapters.dispatch = async (intent, signal) => {
    const result = await dispatch(intent, signal);
    if (intent.kind === "note_create") throw Error("SYNTHETIC_LOST_RESPONSE");
    return result;
  };
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "uncertain" });
  options.adapters.dispatch = dispatch;
  for (let n = 0; n < 6; n++) {
    await dueNow(row.id);
    await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
    await f.db.update(savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000) });
    await executeIntakePass(row.id, options);
  }
  const create = (await effect(row.id, "note_create"))!;
  expect(notePosts()).toBe(1);
  if (TARGET) {
    // PR158 renders the marker as visible text, so search-based recovery is exact.
    expect(create.state).toBe("confirmed");
    expect(noteLinks()).toHaveLength(1);
    return;
  }
  expect(create.ackCiphertext).toBeNull();
  expect(create.state).not.toBe("confirmed");
  expect(noteLinks()).toHaveLength(0);
});

it("[REPRO→NR] B5 operator candidate on a lost-ACK note: no POST; accepted only on exact proof", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission(), dispatch = options.adapters.dispatch;
  options.adapters.dispatch = async (intent, signal) => {
    const result = await dispatch(intent, signal);
    if (intent.kind === "note_create") throw Error("SYNTHETIC_LOST_RESPONSE");
    return result;
  };
  await executeIntakePass(row.id, options);
  const create = (await effect(row.id, "note_create"))!, realId = Object.keys(p.objects.notes)[0];
  if (TARGET) {
    // Exact body + visible marker is a full proof; no tolerance is involved (see L3 for legacy).
    expect(await reconcileIntakeEffectCandidate(create.id, realId, "Synthetic operator picked the visible note", options.adapters)).toMatchObject({ confirmed: true });
    expect(decryptSavPayload<EffectAck>((await effect(row.id, "note_create"))!.ackCiphertext!)).not.toHaveProperty("operatorCandidate", false);
  } else {
    await expect(reconcileIntakeEffectCandidate(create.id, realId, "Synthetic operator picked the visible note", options.adapters)).rejects.toThrow();
    expect((await effect(row.id, "note_create"))!.state).not.toBe("confirmed");
  }
  expect(notePosts()).toBe(1);
});

it.each([
  ["body_changed", (props: Record<string, string | null>) => { props.hs_note_body = `${props.hs_note_body} (edited)`; }],
  ["timestamp_changed", (props: Record<string, string | null>) => { props.hs_timestamp = new Date(Date.parse(props.hs_timestamp!) + 60000).toISOString(); }],
  ["markup_rewritten", (props: Record<string, string | null>) => { props.hs_note_body = props.hs_note_body!.replace(/<br>/g, "<br/>").replace(/^<p>/, "<div>").replace(/<\/p>$/, "</div>"); }],
  ["body_emptied", (props: Record<string, string | null>) => { props.hs_note_body = ""; }],
] as const)("[INV] B6 real ACK but %s beyond the proven transformation is never confirmed", async (_name, change) => {
  hubspotStripsNoteComments(change);
  const row = await reopenAdmission();
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "uncertain" });
  for (let n = 0; n < 3; n++) { await dueNow(row.id); await reconcileIntakeEffectsReadOnly(row.id, options.adapters); }
  expect((await effect(row.id, "note_create"))!.state).not.toBe("confirmed");
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(0);
});

it("[INV] B7 ACK pointing to another ticket's note (wrong ID) is refused and never associated", async () => {
  // A pre-existing human note with the same visible text on the same day.
  p.objects.notes["555"] = { id: "555", properties: { hs_note_body: "decoy", hs_timestamp: new Date().toISOString() } };
  const row = await reopenAdmission(), dispatch = options.adapters.dispatch;
  options.adapters.dispatch = async (intent, signal) => {
    const result = await dispatch(intent, signal);
    if (intent.kind !== "note_create") return result;
    const posted = p.objects.notes[result.id!], body = posted.properties.hs_note_body!;
    // Same business text and timestamp, but no proof marker of this effect.
    p.objects.notes["555"].properties = { ...posted.properties, hs_note_body: stripHtmlComments(body).replace(/<p>\[Studio intake: [a-f0-9]+\]<\/p>$/, "") };
    return { id: "555" };
  };
  await executeIntakePass(row.id, options);
  expect((await effect(row.id, "note_create"))!.state).not.toBe("confirmed");
  expect(noteLinks()).toHaveLength(0);
  expect(notePosts()).toBe(1);
});

it("[INV] B8 two notes with the same stripped body (ambiguous recovery) are never matched by search", async () => {
  hubspotStripsNoteComments();
  const row = await reopenAdmission(), dispatch = options.adapters.dispatch;
  options.adapters.dispatch = async (intent, signal) => {
    const result = await dispatch(intent, signal);
    if (intent.kind !== "note_create") return result;
    const posted = p.objects.notes[result.id!];
    p.objects.notes["556"] = { id: "556", properties: { ...posted.properties } };
    throw Error("SYNTHETIC_LOST_RESPONSE");
  };
  await executeIntakePass(row.id, options);
  options.adapters.dispatch = dispatch;
  await dueNow(row.id);
  await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
  expect((await effect(row.id, "note_create"))!.state).not.toBe("confirmed");
  expect(notePosts()).toBe(1);
});

it("[INV] B9 marker preserved + lost response: RO recovery confirms by marker, one POST, then association", async () => {
  const row = await reopenAdmission(), dispatch = options.adapters.dispatch;
  options.adapters.dispatch = async (intent, signal) => {
    const result = await dispatch(intent, signal);
    if (intent.kind === "note_create") throw Error("SYNTHETIC_LOST_RESPONSE");
    return result;
  };
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "uncertain" });
  options.adapters.dispatch = dispatch;
  await dueNow(row.id);
  await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
  expect((await effect(row.id, "note_create"))!.state).toBe("confirmed");
  await f.db.update((await import("@/db/schema")).savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000) });
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(1);
});

it("[INV] B10 crash after the dispatch marker but before POST: zero POST, stays uncertain, visible", async () => {
  const row = await reopenAdmission();
  await executeIntakePass(row.id, options, { afterMarker: async e => { if (e.kind === "note_create") throw Error("SYNTHETIC_CRASH_AFTER_MARKER"); } });
  for (let n = 0; n < 3; n++) { await dueNow(row.id); await reconcileIntakeEffectsReadOnly(row.id, options.adapters); await executeIntakePass(row.id, options); }
  expect(notePosts()).toBe(0);
  expect((await effect(row.id, "note_create"))!.state).toBe("uncertain");
  expect(writes().filter(c => c.path.includes("/notes"))).toHaveLength(0);
  expect(await readIntakeExecutionProgress(messageId)).toMatchObject({ state: "uncertain", confirmed: false });
});

it("[INV] B11 'confirmed' requires a stored provider verification, not only a state flag", async () => {
  const row = await reopenAdmission();
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  for (const e of await getExecutionEffects(row.id)) {
    expect(e.state).toBe("confirmed");
    expect(e.verificationCiphertext).not.toBeNull();
    expect(e.ackCiphertext).not.toBeNull();
  }
});

// ── D. Concurrency and last-moment barriers on the durable action engine ──
const ticketPosts = () => p.calls.filter(c => c.method === "POST" && c.path === "/crm/v3/objects/tickets").length;

async function parallelExecutors() {
  const row = await reopenAdmission(false), dispatch = options.adapters.dispatch, inside = barrier(2);
  let release!: () => void; const released = new Promise<void>(r => { release = r; });
  options.adapters.dispatch = async (intent, signal) => {
    if (intent.kind === "ticket_create") { await inside(); await released; }
    return dispatch(intent, signal);
  };
  const first = executeIntakePass(row.id, options);
  await inside(); // worker 1 holds the lease and waits for the provider response
  const second = await executeIntakePass(row.id, options);
  const cron = await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  release();
  return { row, second, cron, first: await first };
}
it("[INV] D7 webhook-triggered and cron executors in parallel: one lease, one ticket POST, no reset", async () => {
  const { row, second, first } = await parallelExecutors();
  expect(second).toEqual({ skipped: "occupied" });
  expect(ticketPosts()).toBe(1);
  expect(["confirmed", "uncertain"]).toContain(first.state);
  const create = (await effect(row.id, "ticket_create"))!;
  expect(create.ackCiphertext).not.toBeNull();
});
it("[REPRO] D7-observed (finding F1): cron RO recovery downgrades an in-flight effect held under a live lease", async () => {
  const { row, first } = await parallelExecutors();
  if (TARGET) return; // the fixed expectation is D7b, which runs in target mode
  expect(first).toEqual({ state: "uncertain", executionId: row.id });
  const create = (await effect(row.id, "ticket_create"))!;
  expect(create.reconcileAttempts).toBe(1);
  expect(create.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now());
  expect(ticketPosts()).toBe(1);
});
targetIt("[CIBLE] D7b an effect dispatched under a live lease is not verified/deferred by a concurrent recovery", async () => {
  const { row, first } = await parallelExecutors();
  expect(first).toMatchObject({ state: "confirmed" });
  expect((await effect(row.id, "ticket_create"))!.reconcileAttempts).toBe(0);
  expect(ticketPosts()).toBe(1);
});

it.each(["pause", "revocation", "new_inbound", "human_marker"] as const)("[INV] D8 %s between admission and the last preflight forbids the external write", async kind => {
  const row = await reopenAdmission(false);
  const result = await executeIntakePass(row.id, options, { beforeMarker: async () => {
    if (kind === "pause") await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    if (kind === "revocation") await revokeIntakeExecutionPolicy(options.config.policyId, "Synthetic revocation during admission window");
    if (kind === "new_inbound") await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid",
      toEmails: ["support@example.invalid"], subject: "Synthetic follow-up", receivedAt: new Date(Date.now() + 1000),
      bodyCiphertext: encryptSavPayload({ text: "Another synthetic detail.", headers: { "message-id": "<next@example.invalid>" }, attachments: [] }) });
    if (kind === "human_marker") await f.db.update(savThreads).set({ humanRequestedAt: new Date() }).where(eq(savThreads.id, threadId));
  } });
  expect(result).toMatchObject({ state: "waiting" });
  expect(writes()).toHaveLength(0);
  expect((await getExecutionEffects(row.id)).every(e => e.state === "planned" && !e.dispatchedAt)).toBe(true);
});

it("[INV] D9 expired lease while a provider call is in flight: the late worker cannot dispatch the next effect", async () => {
  const row = await reopenAdmission(false), dispatch = options.adapters.dispatch;
  options.adapters.dispatch = async (intent, signal) => {
    const result = await dispatch(intent, signal);
    if (intent.kind === "ticket_create") await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeExecutions.id, row.id));
    return result;
  };
  await executeIntakePass(row.id, options);
  expect(ticketPosts()).toBe(1);
  // Only the ticket was written by the stale lease holder; it remains recoverable.
  expect(writes().filter(c => !c.path.endsWith("/tickets"))).toHaveLength(0);
  options.adapters.dispatch = dispatch;
  await f.db.update(savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000) }).where(eq(savIntakeExecutions.id, row.id));
  expect(await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters })).toMatchObject({ state: "confirmed" });
  expect(ticketPosts()).toBe(1);
});

it("[INV] D10 provider error on create (5xx) is uncertain, never retried blindly", async () => {
  const row = await reopenAdmission(false), network = p.network;
  p.network = async (url, init) => {
    if ((init?.method ?? "GET") === "POST" && new URL(String(url)).pathname === "/crm/v3/objects/tickets") { await network(url, init); return new Response("{}", { status: 502 }); }
    return network(url, init);
  };
  options.adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment });
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "uncertain" });
  for (let n = 0; n < 3; n++) { await f.db.update(savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000) }); await executeIntakePass(row.id, options); }
  expect(ticketPosts()).toBe(1);
});

// ── Legacy note format (notes created before PR158) — tolerance strictly bounded ──
const legacyBody = (text: string, marker: string) => `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>")}</p><!-- sav-intake:${marker} -->`;
/** Reproduces a historical note_create intent dispatched with the old HTML-comment marker,
 * then lets HubSpot transform the stored body. The worker lease is then expired. */
async function legacyDispatchedNote(transform: (body: string) => string, withAck: boolean) {
  const row = await reopenAdmission(), lease = (await claimExecution(row.id))!;
  lease.payload.baseline = await options.adapters.readCrm(lease.payload.plan, lease.payload.input, options.runtime, options.signal);
  await saveExecutionPayload(lease);
  const ticketId = "201", key = `note:${messageId}:${ticketId}`, marker = intakeRuntimeHash(key), text = lease.payload.plan.noteText!;
  const intent: EffectIntent = { kind: "note_create", permission: "append_ticket_note", key, ticketId, sourceMessageId: messageId, text, marker,
    properties: { hs_note_body: legacyBody(text, marker), hs_timestamp: lease.payload.plan.decision.receivedAt } };
  const marked = await markEffectDispatched(lease, await ensureExecutionEffect(lease, intent));
  const ack = await options.adapters.dispatch(intent, options.signal);
  const stored = p.objects.notes[ack.id!];
  stored.properties.hs_note_body = transform(stored.properties.hs_note_body!);
  if (withAck) await recordEffectAck(marked, ack);
  await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1), updatedAt: new Date(Date.now() - 120000) }).where(eq(savIntakeExecutions.id, row.id));
  return { row, noteId: ack.id!, effectId: marked.id };
}
targetIt("[CIBLE] L1 legacy note + real ACK + exact comment removal: confirmed once, association and stage, no second POST", async () => {
  const { row } = await legacyDispatchedNote(stripHtmlComments, true);
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(1);
  expect(p.calls.filter(c => c.method === "PATCH")).toHaveLength(1);
});
targetIt("[CIBLE] L2 legacy note + real ACK + comment removal + one trailing LF: confirmed", async () => {
  const { row } = await legacyDispatchedNote(body => `${stripHtmlComments(body)}\n`, true);
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  expect(notePosts()).toBe(1);
});
it("[INV] L3 legacy note, comment removed, no provider receipt: never confirmed, operator candidate refused, no POST", async () => {
  const { row, noteId, effectId } = await legacyDispatchedNote(stripHtmlComments, false);
  await executeIntakePass(row.id, options);
  for (let n = 0; n < 3; n++) { await dueNow(row.id); await reconcileIntakeEffectsReadOnly(row.id, options.adapters); }
  await expect(reconcileIntakeEffectCandidate(effectId, noteId, "Synthetic operator picked the stripped legacy note", options.adapters)).rejects.toThrow();
  const create = (await effect(row.id, "note_create"))!;
  expect(create.state).not.toBe("confirmed");
  expect(create.ackCiphertext).toBeNull();
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(0);
});
it.each([
  ["text_changed", (b: string) => stripHtmlComments(b).replace("</p>", " (edited)</p>")],
  ["markup_changed", (b: string) => stripHtmlComments(b).replace(/^<p>/, "<div>").replace(/<\/p>$/, "</div>")],
  ["two_trailing_lf", (b: string) => `${stripHtmlComments(b)}\n\n`],
  ["other_comment_removed_only_partially", (b: string) => b.replace(/sav-intake:[a-f0-9]+/, "sav-intake:")],
  ["leading_space", (b: string) => ` ${stripHtmlComments(b)}`],
] as const)("[INV] L4 legacy note + real ACK but %s beyond the proven transformation: never confirmed", async (_name, transform) => {
  const { row } = await legacyDispatchedNote(transform, true);
  await executeIntakePass(row.id, options);
  for (let n = 0; n < 3; n++) { await dueNow(row.id); await reconcileIntakeEffectsReadOnly(row.id, options.adapters); }
  expect((await effect(row.id, "note_create"))!.state).not.toBe("confirmed");
  expect(notePosts()).toBe(1);
  expect(noteLinks()).toHaveLength(0);
});

// ── Common defect 1: reconciliation while a worker holds a live lease ──
function countingVerify() {
  const verify = options.adapters.verify, calls: string[] = [];
  options.adapters.verify = async (intent, ...rest) => { calls.push(intent.kind); return verify(intent, ...rest); };
  return calls;
}
targetIt("[CIBLE] CD1 live lease during POST: concurrent reconcilers neither verify, defer nor consume an attempt", async () => {
  const row = await reopenAdmission(false), dispatch = options.adapters.dispatch, inside = barrier(2);
  let release!: () => void; const released = new Promise<void>(r => { release = r; });
  options.adapters.dispatch = async (intent, signal) => {
    if (intent.kind === "ticket_create") { await inside(); await released; }
    return dispatch(intent, signal);
  };
  const first = executeIntakePass(row.id, options);
  await inside();
  const verified = countingVerify();
  await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
  await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  const during = (await effect(row.id, "ticket_create"))!;
  expect(verified.filter(k => k === "ticket_create")).toHaveLength(0);
  expect(during.state).toBe("dispatched");
  expect(during.reconcileAttempts).toBe(0);
  expect(during.nextReconcileAt).toBeNull();
  release();
  expect(await first).toMatchObject({ state: "confirmed" });
  expect(ticketPosts()).toBe(1);
});
/** Marker + real POST, worker dies without recording the ACK; its lease then expires. */
async function crashedAfterPost() {
  const row = await reopenAdmission(false), lease = (await claimExecution(row.id))!;
  lease.payload.baseline = await options.adapters.readCrm(lease.payload.plan, lease.payload.input, options.runtime, options.signal);
  await saveExecutionPayload(lease);
  const plan = lease.payload.plan, key = `create:${messageId}`, marker = intakeRuntimeHash(key);
  const { savSupportTicketProperties } = await import("../hubspot-mapping");
  const intent: EffectIntent = { kind: "ticket_create", permission: "create_ticket", key, sourceMessageId: messageId, contactId: "101", marker,
    properties: savSupportTicketProperties({ title: plan.newTicket!.title, description: `${plan.newTicket!.description}\n\n[Studio intake: ${marker}]`, reviewedTitle: true }) };
  await markEffectDispatched(lease, await ensureExecutionEffect(lease, intent));
  await options.adapters.dispatch(intent, options.signal);
  return { row, lease };
}
it("[INV] CD2 after lease expiry the recovery is verifiable and never POSTs twice", async () => {
  const { row } = await crashedAfterPost();
  await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1), updatedAt: new Date(Date.now() - 120000) }).where(eq(savIntakeExecutions.id, row.id));
  await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1), updatedAt: new Date(Date.now() - 120000) }).where(eq(savIntakeExecutions.id, row.id));
  await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  const create = (await effect(row.id, "ticket_create"))!;
  expect(create.state).toBe("confirmed");
  expect(decryptSavPayload<EffectAck>(create.ackCiphertext!).id).toBe(Object.keys(p.objects.tickets)[0]);
  expect(ticketPosts()).toBe(1);
});
targetIt("[CIBLE] CD3 lease re-acquired between selection and verification: the reconciler re-checks atomically", async () => {
  const { row } = await crashedAfterPost();
  await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeExecutions.id, row.id));
  const selected = await pendingIntakeEffectRecoveries();
  // Selection may legitimately include it: the lease had expired at that instant.
  // A new worker then takes the lease before the reconciler processes the row.
  const fresh = await claimExecution(row.id);
  expect(fresh).not.toBeNull();
  const verified = countingVerify();
  if (selected.some(r => r.id === row.id)) await reconcileIntakeEffectsReadOnly(row.id, options.adapters);
  const create = (await effect(row.id, "ticket_create"))!;
  expect(verified).toHaveLength(0);
  expect(create.state).toBe("dispatched");
  expect(create.reconcileAttempts).toBe(0);
  expect(ticketPosts()).toBe(1);
});

// ── Common defect 2: no re-analysis of an already confirmed message ──
function processEnvironment() { for (const [k, v] of Object.entries(environment)) if (v !== undefined) vi.stubEnv(k, v); }
/** Global fetch: model calls are counted and answered, CRM goes to the fake provider. */
function countedModel() {
  const counts = { model: 0, other: 0, messages: [] as string[] };
  vi.stubGlobal("fetch", vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://generativelanguage.googleapis.com/")) {
      counts.model++;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), id = data.message.id;
      counts.messages.push(id);
      const answer = { messageId: id, requests: [{ id: "r1", kind: "support", currentMessageId: id, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
        ticketSummary: { title: "Synthetic follow-up", description: "Another synthetic detail.", requestIds: ["r1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
    }
    if (u.startsWith("https://api.hubapi.com/")) return p.network(url, init);
    counts.other++; throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  }));
  return counts;
}
async function confirmedDossier() {
  const row = await reopenAdmission(false);
  expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
  processEnvironment();
  return row;
}
const cronAndEvent = async (ids: string[]) => {
  for (const id of ids) await enqueueConfiguredSavIntake(id).catch(() => undefined);
  await reconcileSavIntakeRuntime();
  await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  await reconcileSavIntakeRuntime();
};
it("[INV] CD4 confirmed message: no new model call via cron or event, even after hubspotTicketId changes", async () => {
  const row = await confirmedDossier(), counts = countedModel();
  const before = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId));
  for (const ticket of [null, "999"]) {
    await f.db.update(savThreads).set({ hubspotTicketId: ticket }).where(eq(savThreads.id, threadId));
    await cronAndEvent([messageId]);
    await f.db.update(savIntakeRuns).set({ updatedAt: new Date(Date.now() - 3_600_000) });
    await cronAndEvent([messageId]);
  }
  const after = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId));
  expect(counts.messages.filter(id => id === messageId)).toEqual([]);
  expect(counts.model).toBe(0);
  expect(counts.other).toBe(0);
  expect(after.length).toBe(before.length);
  expect(after.reduce((s, r) => s + r.attempts, 0)).toBe(before.reduce((s, r) => s + r.attempts, 0));
  expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].state).toBe("confirmed");
  expect(ticketPosts()).toBe(1);
});
it("[INV] CD5 a genuinely new mail in the same thread is still analysed (not blocked by the confirmation fence)", async () => {
  await confirmedDossier();
  const counts = countedModel();
  const [next] = await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid",
    toEmails: ["support@example.invalid"], subject: "Synthetic follow-up", receivedAt: new Date(),
    bodyCiphertext: encryptSavPayload({ text: "Another synthetic detail.", headers: { "message-id": "<next@example.invalid>" }, attachments: [] }) }).returning();
  await cronAndEvent([next.id]);
  expect(counts.messages).toContain(next.id);
  expect(counts.messages).not.toContain(messageId);
  const current = (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).find(r => r.isCurrent)!;
  expect(current.messageId).toBe(next.id);
  expect(current.attempts).toBeLessThanOrEqual(2);
});
it("[INV] CD6 explicit operator reinvestigation stays available before dispatch, and keeps attempts", async () => {
  const row = await reopenAdmission(false);
  processEnvironment();
  const attempts = (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId))).reduce((s, r) => s + r.attempts, 0);
  const result = await requestIntakeReinvestigation({ threadId, messageId, reason: "Synthetic explicit operator reinvestigation" });
  expect(result).toMatchObject({ runId: expect.any(String) });
  expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId))).reduce((s, r) => s + r.attempts, 0)).toBe(attempts);
  expect((await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, row.id)))[0].state).toBe("waiting");
  expect(writes()).toHaveLength(0);
});
it("[INV] CD7 an uncertain effect is preserved by cron passes (no reset, no POST)", async () => {
  const { row } = await crashedAfterPost();
  // The provider lost the object: recovery can never prove it; it must stay uncertain, not be reset.
  p.objects.tickets = {};
  for (let n = 0; n < 7; n++) {
    await f.db.update(savIntakeExecutions).set({ leaseUntil: new Date(Date.now() - 1), updatedAt: new Date(Date.now() - 120000) }).where(eq(savIntakeExecutions.id, row.id));
    await dueNow(row.id);
    await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
  }
  const create = (await effect(row.id, "ticket_create"))!;
  expect(create.state).toBe("uncertain");
  expect(create.reconcileAttempts).toBe(5);
  expect(ticketPosts()).toBe(1);
  expect(await readIntakeExecutionProgress(messageId)).toMatchObject({ confirmed: false });
});
