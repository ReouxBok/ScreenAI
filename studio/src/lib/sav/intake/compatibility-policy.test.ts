import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ row: null as unknown, staff: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => ({ select: () => ({ from: (table: unknown) => ({ where: async () => {
  const { staffUsers, savIntakeExecutionPolicies } = await import("@/db/schema");
  if (table === staffUsers) return state.staff ? [state.staff] : [];
  if (table === savIntakeExecutionPolicies) return state.row ? [state.row] : [];
  throw Error("SYNTHETIC_READ_ONLY_DB");
} }) }) }) }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => null }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { SAV_INTAKE_COMPATIBILITY } from "./compatibility";
import { executionPolicySchema, intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
const a = "a".repeat(40), b = "b".repeat(40), id = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-23T12:00:00Z");
function install(change: Record<string, unknown> = {}) {
  const policy = executionPolicySchema.parse({ revision: "sav-intake-execution-2026-10-21.v1", mailboxId: id, codeRevision: a, compatibility: SAV_INTAKE_COMPATIBILITY,
    enginePolicyHash: "c".repeat(64), resourcesHash: "d".repeat(64), receivedAfter: "2026-10-23T11:00:00Z", createdAfter: "2026-10-23T11:00:00Z", expiresAt: "2026-10-23T13:00:00Z",
    maxDossiers: 1, mutations: ["create_ticket"], admission: { kind: "automatic" }, ...change });
  const policyHash = intakeRuntimeHash(policy);
  state.row = { id, state: "approved", administratorId: id, policyHash, payloadCiphertext: encryptSavPayload(policy) };
  return { policyId: id, policyHash, codeRevision: b };
}
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-only-encryption-key-at-least-32-characters");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  state.staff = { id, active: true, email: "contact@limova.ai", role: "admin" };
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("reads a stored approval on a compatible different deployment without adding permissions", async () => {
  const config = install(); const result = await readIntakeExecutionAuthority(config, now);
  expect(result.policy.codeRevision).toBe(a); expect(result.policy.mutations).toEqual(["create_ticket"]); expect(result.policy.maxDossiers).toBe(1);
});
it("refuses incompatible and legacy approvals on another commit", async () => {
  await expect(readIntakeExecutionAuthority(install({ compatibility: "f".repeat(64) }), now)).rejects.toThrow();
  const config = install({ compatibility: undefined });
  await expect(readIntakeExecutionAuthority(config, now)).rejects.toThrow();
  expect((await readIntakeExecutionAuthority({ ...config, codeRevision: a }, now)).policy.codeRevision).toBe(a);
});
it("preserves the historical parsed policy hash without compatibility", () => {
  const config = install({ compatibility: undefined });
  const row = state.row as { payloadCiphertext: string };
  const p = executionPolicySchema.parse(decryptSavPayload(row.payloadCiphertext));
  const historical = { revision: p.revision, mailboxId: p.mailboxId, codeRevision: p.codeRevision,
    enginePolicyHash: p.enginePolicyHash, resourcesHash: p.resourcesHash, receivedAfter: p.receivedAfter, createdAfter: p.createdAfter,
    expiresAt: p.expiresAt, maxDossiers: p.maxDossiers, mutations: p.mutations, admission: p.admission };
  expect(config.policyHash).toBe(intakeRuntimeHash(historical));
});
it("preserves revocation and administrator permission checks", async () => {
  const config = install(); state.row = { ...state.row as object, state: "revoked" };
  await expect(readIntakeExecutionAuthority(config, now)).rejects.toThrow("PERMISSION_REVOKED");
  install(); state.staff = { id, active: false, role: "admin", email: "contact@limova.ai" };
  await expect(readIntakeExecutionAuthority(config, now)).rejects.toThrow("PERMISSION_REVOKED");
});
it("preserves expiry, integrity and valid deployed SHA checks", async () => {
  await expect(readIntakeExecutionAuthority(install({ expiresAt: "2026-10-23T11:30:00Z" }), now)).rejects.toThrow();
  const config = install();
  await expect(readIntakeExecutionAuthority({ ...config, codeRevision: "" }, now)).rejects.toThrow();
  await expect(readIntakeExecutionAuthority({ ...config, policyHash: "f".repeat(64) }, now)).rejects.toThrow();
});
it.each([{ SAV_WRITES_DISABLED: "true" }, { SAV_INTAKE_EXECUTION_KILL_SWITCH: "1" }])("preserves kill switch %j", change => {
  expect(() => intakeExecutionConfig({ SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: id, SAV_INTAKE_EXECUTION_POLICY_SHA256: "c".repeat(64), VERCEL_GIT_COMMIT_SHA: b, ...change })).toThrow("EXECUTION_DISABLED");
});
it.each([{ maxDossiers: 101 }, { mutations: ["delete_contact"] }, { admission: { kind: "qualification", runIds: [] } }])("does not relax policy schema %j", change => {
  expect(() => install(change)).toThrow();
});
