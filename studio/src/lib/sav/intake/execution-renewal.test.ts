import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, afterEach, it, expect, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savMailboxes, staffUsers, savSyncState, savIntakeExecutionPolicies, savIntakeExecutionBudget } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("DB_FORBIDDEN"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { approveIntakeExecutionPolicy, revokeIntakeExecutionPolicy, readIntakeExecutionAuthorityState, executionPolicySchema, type ExecutionPolicy } from "./execution-policy";
import { previewIntakeExecutionRenewal, commitIntakeExecutionRenewal } from "./execution-renewal";

// Synthetic data only: example.invalid mailbox, fixed fake revisions, no provider/CRM/Gmail.
let db: Awaited<ReturnType<typeof createSavTestDb>>;
const OLD = "a".repeat(40), NEW = "b".repeat(40);
let admin: typeof staffUsers.$inferSelect, other: typeof staffUsers.$inferSelect, mailboxId: string, pins: Record<string, unknown>, enginePolicy: object, sourceId: string, sourceHash: string, source: ExecutionPolicy;
const as = (u: typeof staffUsers.$inferSelect) => { state.user = { id: u.clerkId, primaryEmailAddress: { emailAddress: u.email, verification: { status: "verified" } } }; };
function env(revision: string, change: Record<string, unknown> = {}, extra: Record<string, string | undefined> = {}) {
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: revision, SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake",
    SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...pins, codeRevision: revision, ...change }),
    SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: sourceId, SAV_INTAKE_EXECUTION_POLICY_SHA256: sourceHash, ...extra } as Record<string, string | undefined>;
}
async function approveSource(change: Partial<ExecutionPolicy> = {}) {
  const policy: ExecutionPolicy = { revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: OLD, enginePolicyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash([]),
    createdAfter: pins.createdAfter as string, receivedAfter: pins.receivedAfter as string, expiresAt: pins.expiresAt as string, maxDossiers: 7,
    mutations: ["create_ticket", "append_ticket_note", "associate_email"], admission: { kind: "qualification", runIds: [randomUUID(), randomUUID()] }, ...change } as ExecutionPolicy;
  const grant = await approveIntakeExecutionPolicy(policy);
  sourceId = grant.id; sourceHash = grant.policyHash; source = policy;
  return grant;
}
const policyRows = () => db.db.select().from(savIntakeExecutionPolicies);
const sourceRow = async () => (await db.db.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, sourceId)))[0];

beforeAll(async () => { db = await createSavTestDb(); state.db = db.db; }, 30000);
afterAll(async () => { if (db) await db.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-renewal-encryption-key-32-characters");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  await db.client.exec("TRUNCATE sav.intake_execution_policies, sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state WHERE key LIKE 'sav-intake-renewal-preview:%'");
  [admin] = await db.db.insert(staffUsers).values({ clerkId: "synthetic-renewal-admin", email: "ugo@limova.ai", name: "Synthetic", role: "admin", active: true }).returning();
  [other] = await db.db.insert(staffUsers).values({ clerkId: "synthetic-renewal-other", email: "reouven@limova.ai", name: "Synthetic other", role: "admin", active: true }).returning();
  as(admin);
  mailboxId = (await db.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  enginePolicy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
  pins = { mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    codeRevision: OLD, policyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash([]), maxCalls: 30, maxNanoUsd: 3000000000 };
  await approveSource();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("renews the configured policy for the deployed revision only: every other field copied, source preserved, receipt and audit, no external effect", async () => {
  const before = await sourceRow(), budgetBefore = await db.db.select().from(savIntakeExecutionBudget);
  const deployed = env(NEW), commandId = randomUUID();
  const preview = await previewIntakeExecutionRenewal(commandId, "", deployed);
  expect(preview).toMatchObject({ previewId: commandId, sourcePolicyId: sourceId, sourcePolicyHash: sourceHash, fromCodeRevision: OLD, toCodeRevision: NEW,
    summary: { maxDossiers: 7, mutations: ["create_ticket", "append_ticket_note", "associate_email"], admission: { kind: "qualification", runCount: 2 }, expiresAt: source.expiresAt, budgetProfile: null } });
  expect(Date.parse(preview.expiresAt) - Date.now()).toBeLessThanOrEqual(600000);
  expect(await policyRows()).toHaveLength(1);
  expect(await previewIntakeExecutionRenewal(commandId, "", deployed)).toEqual(preview);
  const receipt = await commitIntakeExecutionRenewal(commandId, preview.hash, deployed);
  expect(receipt).toMatchObject({ policyId: commandId, sourcePolicyId: sourceId, sourcePolicyHash: sourceHash, fromCodeRevision: OLD, toCodeRevision: NEW });
  const [created] = (await policyRows()).filter(r => r.id === receipt.policyId);
  const renewed = decryptSavPayload<ExecutionPolicy>(created.payloadCiphertext);
  expect(renewed).toEqual({ ...source, codeRevision: NEW });
  expect(created).toMatchObject({ state: "approved", administratorId: admin.id, policyHash: intakeRuntimeHash(renewed) });
  expect(receipt.policyHash).toBe(created.policyHash);
  expect(await sourceRow()).toEqual(before);
  expect(await readIntakeExecutionAuthorityState(env(NEW, {}, { SAV_INTAKE_EXECUTION_POLICY_ID: receipt.policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: receipt.policyHash }))).toBe("valid");
  expect(await readIntakeExecutionAuthorityState(deployed)).toBe("code_revision_changed");
  expect(await commitIntakeExecutionRenewal(commandId, preview.hash, deployed)).toEqual(receipt);
  expect(await policyRows()).toHaveLength(2);
  const audit = await db.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_intake_execution_policy_renewed"));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ entityId: receipt.policyId, technicalMetadata: { sourcePolicyId: sourceId, fromCodeRevision: OLD, toCodeRevision: NEW } });
  expect(await db.db.select().from(savIntakeExecutionBudget)).toEqual(budgetBefore);
  expect(await db.db.select().from(savSyncState).where(like(savSyncState.key, "sav-intake-launch:%"))).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("a typed source UUID keeps an operational automatic policy exactly (maxDossiers, mutation list, bounds, budget profile)", async () => {
  const expiresAt = new Date(Date.now() + 5 * 86400000).toISOString();
  pins = { ...pins, expiresAt, budgetProfile: "operational_utc_v1", maxRollingNanoUsd: 90000000000, maxCalls: 300, maxNanoUsd: 5000000000 };
  await approveSource({ expiresAt, budgetProfile: "operational_utc_v1", maxDossiers: 100, mutations: ["link_ticket"], admission: { kind: "automatic" } });
  const commandId = randomUUID(), deployed = env(NEW, {}, { SAV_INTAKE_EXECUTION_POLICY_ID: undefined, SAV_INTAKE_EXECUTION_POLICY_SHA256: undefined });
  const preview = await previewIntakeExecutionRenewal(commandId, ` ${sourceId} `, deployed);
  const receipt = await commitIntakeExecutionRenewal(commandId, preview.hash, deployed);
  const [created] = (await policyRows()).filter(r => r.id === receipt.policyId);
  expect(decryptSavPayload(created.payloadCiphertext)).toEqual({ ...source, codeRevision: NEW });
});

it("refuses explicitly: unknown, revoked, incoherent, expired source, approver without access, nothing to renew, env hash mismatch, missing revision", async () => {
  const deployed = env(NEW), go = (source: string, e = deployed) => previewIntakeExecutionRenewal(randomUUID(), source, e);
  await expect(go(randomUUID())).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_UNKNOWN");
  await expect(go("not-a-uuid")).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_INVALID");
  await expect(go("", env(NEW, {}, { SAV_INTAKE_EXECUTION_POLICY_ID: undefined }))).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_REQUIRED");
  await expect(go("", env(NEW, {}, { SAV_INTAKE_EXECUTION_POLICY_SHA256: "c".repeat(64) }))).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_CONFIGURATION_MISMATCH");
  await expect(go("", env(OLD))).rejects.toThrow("SAV_INTAKE_RENEWAL_NOT_NEEDED");
  await expect(go("", env(NEW, {}, { SAV_CODE_REVISION: "not-a-sha" }))).rejects.toThrow("SAV_INTAKE_RENEWAL_CODE_REVISION_REQUIRED");
  // Incoherent: payload no longer matches the stored fingerprint.
  const original = await sourceRow();
  await db.db.update(savIntakeExecutionPolicies).set({ payloadCiphertext: encryptSavPayload({ ...source, maxDossiers: 100 }) }).where(eq(savIntakeExecutionPolicies.id, sourceId));
  await expect(go("")).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_INCOHERENT");
  await db.db.update(savIntakeExecutionPolicies).set({ payloadCiphertext: "garbage" }).where(eq(savIntakeExecutionPolicies.id, sourceId));
  await expect(go("")).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_INCOHERENT");
  await db.db.update(savIntakeExecutionPolicies).set({ payloadCiphertext: original.payloadCiphertext }).where(eq(savIntakeExecutionPolicies.id, sourceId));
  // Expired: a stored source whose term passed is never prolonged.
  const expired = executionPolicySchema.parse({ ...source, expiresAt: new Date(Date.now() - 1000).toISOString() }), expiredId = randomUUID();
  await db.db.insert(savIntakeExecutionPolicies).values({ id: expiredId, revision: source.revision, state: "approved", administratorId: admin.id, policyHash: intakeRuntimeHash(expired), payloadCiphertext: encryptSavPayload(expired) });
  await expect(go(expiredId)).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_EXPIRED");
  // Approver who lost access.
  as(other); const grantByOther = await approveSource(); as(admin);
  await db.db.update(staffUsers).set({ active: false }).where(eq(staffUsers.id, other.id));
  await expect(go(grantByOther.id, env(NEW))).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_APPROVER_UNAUTHORIZED");
  // Revoked: never resurrected.
  await revokeIntakeExecutionPolicy(original.id, "Synthetic revocation for the renewal test.");
  await expect(go(original.id)).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_REVOKED");
  expect((await policyRows()).filter(r => r.state === "approved")).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses an invalid runtime or a runtime whose business pins drifted from the source", async () => {
  const go = (e: Record<string, string | undefined>) => previewIntakeExecutionRenewal(randomUUID(), "", e);
  await expect(go(env(NEW, {}, { SAV_INTAKE_RUNTIME_MODE: "off" }))).rejects.toThrow("SAV_INTAKE_RENEWAL_RUNTIME_INVALID");
  await expect(go(env(NEW, {}, { VERCEL_GIT_COMMIT_SHA: "c".repeat(40) }))).rejects.toThrow("SAV_INTAKE_RENEWAL_RUNTIME_INVALID");
  await expect(go(env(NEW, { expiresAt: new Date(Date.now() + 7200000).toISOString() }))).rejects.toThrow("SAV_INTAKE_RENEWAL_RUNTIME_DRIFT");
  await expect(go(env(NEW, { receivedAfter: new Date(Date.now() - 1800000).toISOString() }))).rejects.toThrow("SAV_INTAKE_RENEWAL_RUNTIME_DRIFT");
  const otherEngine = { relationRevision: "synthetic-2", admittedRelations: [], resources: {} };
  await expect(go({ ...env(NEW, { policyHash: intakeRuntimeHash(otherEngine) }), SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(otherEngine) })).rejects.toThrow("SAV_INTAKE_RENEWAL_RUNTIME_DRIFT");
  expect(await policyRows()).toHaveLength(1);
});

it("binds the preview to its actor, hash and 10-minute expiry; a non administrator cannot preview", async () => {
  const deployed = env(NEW), commandId = randomUUID();
  const preview = await previewIntakeExecutionRenewal(commandId, "", deployed);
  as(other);
  await expect(previewIntakeExecutionRenewal(commandId, "", deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_CONFLICT");
  await expect(commitIntakeExecutionRenewal(commandId, preview.hash, deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_CONFLICT");
  as(admin);
  await expect(commitIntakeExecutionRenewal(commandId, "f".repeat(64), deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_CONFLICT");
  await expect(commitIntakeExecutionRenewal(randomUUID(), preview.hash, deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_REQUIRED");
  // Tampered stored intent (target changed, hash kept) is refused.
  const [row] = await db.db.select().from(savSyncState).where(eq(savSyncState.key, `sav-intake-renewal-preview:${commandId}`));
  const value = decryptSavPayload<Record<string, unknown>>(row.cursor!);
  await db.db.update(savSyncState).set({ cursor: encryptSavPayload({ ...value, toCodeRevision: "c".repeat(40) }) }).where(eq(savSyncState.key, row.key));
  await expect(commitIntakeExecutionRenewal(commandId, preview.hash, deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_CONFLICT");
  await db.db.update(savSyncState).set({ cursor: row.cursor }).where(eq(savSyncState.key, row.key));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 601000);
  await expect(commitIntakeExecutionRenewal(commandId, preview.hash, deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_EXPIRED");
  vi.useRealTimers();
  const [member] = await db.db.insert(staffUsers).values({ clerkId: "synthetic-renewal-member", email: "contact@limova.ai", name: "Member", role: "member", active: true }).returning();
  as(member);
  await expect(previewIntakeExecutionRenewal(randomUUID(), "", deployed)).rejects.toThrow("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
  expect(await policyRows()).toHaveLength(1);
});

it("revocation or redeploy between preview and commit refuses; the lease is released; concurrent commits create one policy", async () => {
  const deployed = env(NEW);
  const first = await previewIntakeExecutionRenewal(randomUUID(), "", deployed);
  await expect(commitIntakeExecutionRenewal(first.previewId, first.hash, env("c".repeat(40)))).rejects.toThrow("SAV_INTAKE_RENEWAL_PREVIEW_STALE");
  await revokeIntakeExecutionPolicy(sourceId, "Synthetic revocation between preview and commit.");
  await expect(commitIntakeExecutionRenewal(first.previewId, first.hash, deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_REVOKED");
  await expect(commitIntakeExecutionRenewal(first.previewId, first.hash, deployed)).rejects.toThrow("SAV_INTAKE_RENEWAL_SOURCE_REVOKED");
  expect(await policyRows()).toHaveLength(1);
  await approveSource();
  const second = await previewIntakeExecutionRenewal(randomUUID(), "", env(NEW));
  const results = await Promise.allSettled([commitIntakeExecutionRenewal(second.previewId, second.hash, env(NEW)), commitIntakeExecutionRenewal(second.previewId, second.hash, env(NEW))]);
  const ok = results.filter(r => r.status === "fulfilled"), refused = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
  expect(ok.length).toBeGreaterThanOrEqual(1);
  for (const r of refused) expect(String(r.reason)).toContain("SAV_INTAKE_RENEWAL_COMMIT_PENDING");
  expect((await policyRows()).filter(r => r.id === second.previewId)).toHaveLength(1);
  expect(await policyRows()).toHaveLength(3);
});

it("the source re-check runs inside the canonical approval transaction: a refusal there creates no policy", async () => {
  const before = (await policyRows()).length, id = randomUUID();
  await expect(approveIntakeExecutionPolicy({ ...source, codeRevision: NEW }, id, async () => { throw Error("SAV_INTAKE_RENEWAL_SOURCE_REVOKED"); })).rejects.toThrow("SOURCE_REVOKED");
  expect(await policyRows()).toHaveLength(before);
  expect(await db.db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).toHaveLength(0);
});
