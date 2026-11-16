import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savCases, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, excluded: new Set<string>() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
const scope = vi.hoisted(() => vi.fn(async (_env: unknown, id: string) => ({ allowed: !state.excluded.has(id) })));
vi.mock("./qualification-scope", async importOriginal => ({ ...await importOriginal<typeof import("./qualification-scope")>(), savV2QualificationCaseAllowed: scope }));
import { encryptSavPayload } from "../crypto";
import { sweepCaseContinuations } from "./v2-entry";
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const KEY = "sav-v2-sweep.v1:continuation", env = { SAV_V2_ENTRY: "on", SAV_CASE_RECORDING: "on" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const seed = async (count: number) => {
  const ids = Array.from({ length: count }, (_, n) => id(n + 1));
  await f.db.insert(savCases).values(ids.map((id, n) => ({ id, ticketId: String(900_000 + n), owner: "agent", admissionTarget: "agent", phase: "queued", contractRevision: "synthetic", payloadCiphertext: "not-read", updatedAt: new Date(1_000 + n) })));
  return ids;
};
const cursor = async () => (await f.db.select().from(savSyncState).where(eq(savSyncState.key, KEY)))[0]?.cursor;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { await f.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "v2-entry-sweep-fixture-key-only-32-characters-x");
  await f.db.delete(auditLogs); await f.db.delete(savCases); await f.db.delete(savSyncState);
  state.excluded.clear(); scope.mockClear();
});
it("50 excluded cases cannot starve the 51st allowed case; the persisted cursor resumes on the next call", async () => {
  const ids = await seed(51); ids.slice(0, 50).forEach(id => state.excluded.add(id));
  const continuation = vi.fn(async () => ({ status: "started" }));
  expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 0, failed: {}, outOfScope: 50 });
  expect(scope).toHaveBeenCalledTimes(50); expect(await cursor()).toBe(id(50));
  expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 1, failed: {}, outOfScope: 49 });
  expect(continuation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ caseId: id(51), trigger: "sweep" }));
  expect(await cursor()).toBe(id(49));
});
it("205 cases are all continued in 11 bounded passes despite changed timestamps and repeated failures", async () => {
  const ids = await seed(205), seen: string[] = [];
  const continuation = async ({ caseId }: { caseId: string }) => {
    seen.push(caseId);
    await f.db.update(savCases).set({ updatedAt: new Date() }).where(eq(savCases.id, caseId));
    if (seen.length % 3 === 0) throw Error("SAV_SYN_FAILURE");
    return { status: "started" };
  };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let pass = 0; pass < 11; pass++) {
      scope.mockClear();
      expect(await sweepCaseContinuations({ env, limit: 20, continuation })).toMatchObject({ tried: 20 });
      expect(scope.mock.calls.length).toBeLessThanOrEqual(40); // includes the continuation's scope recheck
    }
    expect(seen).toEqual([...ids, ...ids.slice(0, 15)]); expect(await cursor()).toBe(id(15));
    await sweepCaseContinuations({ env, limit: 1, continuation });
    expect(seen.at(-1)).toBe(ids[15]);
  } finally { errors.mockRestore(); }
});
it("50 held cases advance the scan without taking continuation slots", async () => {
  const ids = await seed(51);
  await f.db.insert(savSyncState).values({ key: "sav-block-switch.v1:access", status: "active", cursor: encryptSavPayload({
    revision: "sav-block-switch.v1", blockId: "access", mode: "off", paused: false,
    setBy: "fixture@example.invalid", setAt: new Date().toISOString(), reason: "synthetic held block",
  }) });
  await f.db.insert(auditLogs).values(ids.slice(0, 50).map(entityId => ({ actorEmail: "system", entityType: "sav_v2_case", entityId, action: "sav_v2_continuation_block_held", technicalMetadata: { blockId: "access", reason: "block_off", since: "2026-11-01", lastAt: "2026-11-01" } })));
  const continuation = vi.fn(async () => ({ status: "started" }));
  expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 0, failed: {} });
  expect(await cursor()).toBe(id(50)); expect(scope).not.toHaveBeenCalled();
  await sweepCaseContinuations({ env, continuation });
  expect(continuation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ caseId: id(51) }));
});
it("OFF preserves the cursor and an empty tail wraps to revisit cases behind it", async () => {
  await seed(2);
  const continuation = vi.fn(async () => ({ status: "started" }));
  await sweepCaseContinuations({ env, limit: 1, continuation });
  const saved = await cursor();
  expect(await sweepCaseContinuations({ env: {}, continuation })).toEqual({ skipped: "off" });
  expect(await cursor()).toBe(saved);
  await f.db.update(savSyncState).set({ cursor: id(99) }).where(eq(savSyncState.key, KEY));
  expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 2, failed: {} });
  expect(await cursor()).toBeNull();
  await sweepCaseContinuations({ env, continuation }); expect(continuation).toHaveBeenCalledTimes(5);
});

it("five pending cases fill four slots on every passage without revisiting a case", async () => {
  await seed(5);
  const continuation = vi.fn(async (_input: { caseId: string }) => ({ status: "started" }));
  for (let pass = 0; pass < 6; pass++) {
    continuation.mockClear();
    expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 4, failed: {} });
    expect(new Set(continuation.mock.calls.map(args => (args[0] as { caseId: string }).caseId)).size).toBe(4);
  }
});
it.each(["absent", "existing", "full-lap"])("a delayed concurrent passage cannot overwrite the winning cursor (%s)", async mode => {
  await seed(5);
  if (mode !== "absent") await f.db.insert(savSyncState).values({ key: KEY, cursor: null });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const slow = sweepCaseContinuations({ env, limit: 1, continuation: async () => {
    entered(); await held; return { status: "started" };
  } });
  await started;
  try {
    expect(await sweepCaseContinuations({ env, limit: mode === "full-lap" ? 20 : 4,
      continuation: async () => ({ status: "started" }) })).toEqual({ tried: mode === "full-lap" ? 5 : 4, failed: {} });
    expect(await cursor()).toBe(mode === "full-lap" ? null : id(4));
  } finally { release(); await slow; }
  expect(await cursor()).toBe(mode === "full-lap" ? null : id(4));
});
it("owner hand-over (#271): grace and team-last hold an existing agent case; no continuation, durable stop untouched; admitted releases it", async () => {
  const [held, graced] = await seed(2);
  const mark = (entityId: string, technicalMetadata: Record<string, string | number>, action = "sav_v2_owner_handover", entityType = "sav_hubspot_ticket") =>
    f.db.insert(auditLogs).values({ actorEmail: "system", action, entityType, entityId, technicalMetadata });
  await mark("900000", { state: "team_replied_last", occurredAt: Date.now() - 7_200_000, teamLastAt: new Date(Date.now() - 7_200_000).toISOString() });
  await mark("900001", { state: "starting", occurredAt: Date.now() });
  await mark(held!, { code: "ticket_owner_human", failures: 1 }, "sav_v2_continuation_failed", "sav_v2_case");
  const continuation = vi.fn(async () => ({ status: "started" }));
  expect(await sweepCaseContinuations({ env, continuation })).toEqual({ tried: 2, failed: {} });
  expect(continuation).not.toHaveBeenCalled();
  const stop = await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, held!));
  expect(stop[0]!.technicalMetadata).toEqual({ code: "ticket_owner_human", failures: 1 });
  await f.db.update(auditLogs).set({ technicalMetadata: { state: "admitted", occurredAt: Date.now() } }).where(eq(auditLogs.entityId, "900001"));
  await sweepCaseContinuations({ env, continuation });
  expect(continuation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ caseId: graced, trigger: "sweep" }));
});
