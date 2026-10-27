import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, staff: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("./execution-policy", () => ({ executionAdministrator: async () => { if (!state.staff) throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"); return state.staff; } }));
import { readIntakeBudgetPanel, setIntakeDailyBudget } from "./budget-admin";
import { readIntakeBudgetOverride } from "./budget-override";
import { parseUsdToNano } from "./budget-amount";

let f: Awaited<ReturnType<typeof createSavTestDb>>;
const ugo = { id: "u", email: "ugo@limova.ai", role: "owner", active: true };
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; });
afterAll(async () => { await f?.client.close(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-budget-encryption-key-32-characters"); state.staff = ugo; await f.db.delete(savSyncState); await f.db.delete(auditLogs); });

it("only ugo@limova.ai can read or change the Studio cap, other administrators included", async () => {
  for (const staff of [null, { ...ugo, email: "admin@limova.ai", role: "admin" }, { ...ugo, email: "other@limova.ai" }]) {
    state.staff = staff;
    await expect(setIntakeDailyBudget({ maxNanoUsd: 5_000_000_000, reason: "test" })).rejects.toThrow("SAV_INTAKE_BUDGET_UNAUTHORIZED");
    await expect(readIntakeBudgetPanel()).rejects.toThrow("SAV_INTAKE_BUDGET_UNAUTHORIZED");
  }
  expect(await f.db.select().from(savSyncState)).toHaveLength(0);expect(await f.db.select().from(auditLogs)).toHaveLength(0);
});
it("stores an encrypted cap, audits every change with the previous value, and resets to configuration", async () => {
  await setIntakeDailyBudget({ maxNanoUsd: 5_000_000_000, reason: "Blocage du 26/10" });
  await setIntakeDailyBudget({ maxNanoUsd: 7_500_000_000, reason: "Pic de volume" });
  expect(await readIntakeBudgetOverride(f.db)).toMatchObject({ maxNanoUsd: 7_500_000_000, setBy: "ugo@limova.ai", reason: "Pic de volume" });
  const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, "sav-intake-daily-budget-override.v1"));
  expect(row.cursor).not.toContain("7500000000");
  await setIntakeDailyBudget({ maxNanoUsd: null, reason: "Retour configuration" });
  expect((await readIntakeBudgetOverride(f.db))?.maxNanoUsd).toBeNull();
  const audit = await f.db.select().from(auditLogs);
  expect(audit.map(a => [a.actorEmail, a.action, a.technicalMetadata.previousNanoUsd, a.technicalMetadata.nextNanoUsd]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([
    ["ugo@limova.ai", "sav_intake_daily_budget_set", 5_000_000_000, 7_500_000_000],
    ["ugo@limova.ai", "sav_intake_daily_budget_set", 7_500_000_000, null],
    ["ugo@limova.ai", "sav_intake_daily_budget_set", null, 5_000_000_000]]);
});
it("refuses caps above the20 USD ceiling, non-integer or empty values, and a missing reason, without writing", async () => {
  for (const input of [{ maxNanoUsd: 20_000_000_001, reason: "trop" }, { maxNanoUsd: 0, reason: "zéro" }, { maxNanoUsd: 1.5, reason: "fraction" }, { maxNanoUsd: 5_000_000_000, reason: " " }, { maxNanoUsd: 5_000_000_000, reason: "ok", extra: 1 }])
    await expect(setIntakeDailyBudget(input)).rejects.toThrow();
  await setIntakeDailyBudget({ maxNanoUsd: 20_000_000_000, reason: "plafond max" });
  expect(await f.db.select().from(auditLogs)).toHaveLength(1);
});
it("replaces an unreadable stored cap and records that fact", async () => {
  await f.db.insert(savSyncState).values({ key: "sav-intake-daily-budget-override.v1", cursor: "corrupt", status: "active" });
  await setIntakeDailyBudget({ maxNanoUsd: 5_000_000_000, reason: "réparation" });
  expect((await readIntakeBudgetOverride(f.db))?.maxNanoUsd).toBe(5_000_000_000);
  expect((await f.db.select().from(auditLogs))[0].technicalMetadata.previousNanoUsd).toBe("invalid");
});
it("panel reads without a runtime configuration and lists the audit history", async () => {
  vi.stubEnv("SAV_INTAKE_RUNTIME_MODE", "off");
  await setIntakeDailyBudget({ maxNanoUsd: 5_000_000_000, reason: "test panneau" });
  const panel = await readIntakeBudgetPanel();
  expect(panel).toMatchObject({ configuredNanoUsd: null, usage: null, override: { maxNanoUsd: 5_000_000_000 }, overrideInvalid: false, ceilingNanoUsd: 20_000_000_000 });
  expect(panel.history).toEqual([expect.objectContaining({ actor: "ugo@limova.ai", previousNanoUsd: null, nextNanoUsd: 5_000_000_000, reason: "test panneau" })]);
});
it("parses dollar amounts through cents only", () => {
  expect(parseUsdToNano("5")).toBe(5_000_000_000);expect(parseUsdToNano("7,5")).toBe(7_500_000_000);expect(parseUsdToNano("0.01")).toBe(10_000_000);expect(parseUsdToNano(" 12.34 ")).toBe(12_340_000_000);
  for (const bad of ["", "-1", "1.234", "1e3", "abc", "1 000", "5$"]) expect(() => parseUsdToNano(bad)).toThrow("SAV_INTAKE_BUDGET_AMOUNT_INVALID");
});
