import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, staff: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("../intake/execution-policy", () => ({ executionAdministrator: async () => { if (!state.staff) throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"); return state.staff; } }));
import { readSavBlockSwitch, savBlockEffectiveMode, savBlockReplyGate, SAV_BLOCK_SWITCH_DEFAULT } from "./block-switch";
import { readSavBlockSwitchPanel, setSavBlockSwitch } from "./block-switch-admin";

/*
 * Per-block switch (12/11): mode off | draft | auto and a pause per treatment block, stored like the agent pause (sav-agent-pause.v1):
 * encrypted row in sav.sync_state, actor, reason, timestamp, audited history. No row = today's behaviour (auto, not paused).
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const admin = { id: "a", email: "admin@example.invalid", role: "admin", active: true };
const audit = () => f.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_block_switch_set"));
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f?.client.close(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-block-switch-key-32-characters!"); state.staff = admin;
  await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-block-switch.v1:%")); await f.db.delete(auditLogs);
});

it("default without any row reproduces today: auto, not paused, for Access and any block; the effective mode follows the global switch", async () => {
  expect(SAV_BLOCK_SWITCH_DEFAULT).toEqual({ mode: "auto", paused: false });
  for (const blockId of ["access", "collaborators"]) {
    const read = await readSavBlockSwitch(f.db, blockId);
    expect(read).toEqual({ blockId, mode: "auto", paused: false, setting: null, invalid: false });
    expect(savBlockReplyGate(read)).toEqual({ send: "rule" });
  }
  const access = await readSavBlockSwitch(f.db, "access");
  // Global switch on (SAV_V2_AUTO_REPLY=access + approver): Access is auto, exactly as today; off: a person validates, as today.
  expect(savBlockEffectiveMode(access, { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" })).toBe("auto");
  expect(savBlockEffectiveMode(access, {})).toBe("draft");
  // Another block never answers alone today (the automatic rule is Access-only): draft at most, whatever its mode.
  expect(savBlockEffectiveMode(await readSavBlockSwitch(f.db, "collaborators"), { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" })).toBe("draft");
});

it("off, paused and draft never let the rule send; the stricter of the global switch and the block wins", () => {
  const base = { blockId: "access", setting: null, invalid: false } as const;
  const on = { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" };
  expect(savBlockReplyGate({ ...base, mode: "off", paused: false })).toEqual({ send: "never", code: "block_off" });
  expect(savBlockReplyGate({ ...base, mode: "auto", paused: true })).toEqual({ send: "never", code: "block_paused" });
  expect(savBlockReplyGate({ ...base, mode: "draft", paused: true })).toEqual({ send: "never", code: "block_paused" });
  expect(savBlockReplyGate({ ...base, mode: "draft", paused: false })).toEqual({ send: "person", code: "block_draft" });
  expect(savBlockReplyGate({ ...base, mode: "auto", paused: false, invalid: true })).toEqual({ send: "never", code: "block_setting_invalid" });
  expect(savBlockEffectiveMode({ ...base, mode: "off", paused: false }, on)).toBe("off");
  expect(savBlockEffectiveMode({ ...base, mode: "auto", paused: true }, on)).toBe("paused");
  expect(savBlockEffectiveMode({ ...base, mode: "draft", paused: false }, on)).toBe("draft");
  expect(savBlockEffectiveMode({ ...base, mode: "auto", paused: false }, {})).toBe("draft");
});

it("refuses a non-administrator without writing, for the change and for the panel", async () => {
  state.staff = null;
  await expect(setSavBlockSwitch({ blockId: "access", mode: "off", paused: false, reason: "Incident connexion" })).rejects.toThrow("SAV_BLOCK_SWITCH_UNAUTHORIZED");
  await expect(readSavBlockSwitchPanel()).rejects.toThrow("SAV_BLOCK_SWITCH_UNAUTHORIZED");
  expect(await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-block-switch.v1:%"))).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it("requires a reason, a known mode and a registered block; no extra field", async () => {
  for (const input of [{ blockId: "access", mode: "off", paused: false, reason: " " }, { blockId: "access", mode: "off", paused: false, reason: "ok" },
    { blockId: "access", mode: "on", paused: false, reason: "motif valable" }, { blockId: "unknown-block", mode: "off", paused: false, reason: "motif valable" },
    { blockId: "access", mode: "off", reason: "motif valable" }, { blockId: "access", mode: "off", paused: false, reason: "motif valable", extra: 1 }])
    await expect(setSavBlockSwitch(input)).rejects.toThrow();
  expect(await audit()).toHaveLength(0);
});

it("stores the switch encrypted, audits actor, previous and next state and reason, and lists the history in the panel", async () => {
  await setSavBlockSwitch({ blockId: "access", mode: "draft", paused: false, reason: "Qualification en brouillon" });
  expect(await readSavBlockSwitch(f.db, "access")).toMatchObject({ mode: "draft", paused: false, invalid: false, setting: { setBy: admin.email, reason: "Qualification en brouillon" } });
  const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, "sav-block-switch.v1:access"));
  expect(row!.cursor).not.toContain("Qualification");
  await setSavBlockSwitch({ blockId: "access", mode: "draft", paused: true, reason: "Pause incident" });
  await setSavBlockSwitch({ blockId: "access", mode: "auto", paused: false, reason: "Retour normal" });
  const rows = (await audit()).map(a => [a.actorEmail, a.entityId, a.technicalMetadata.previous, a.technicalMetadata.next, a.technicalMetadata.reason]);
  expect(rows).toEqual(expect.arrayContaining([
    [admin.email, "access", "auto", "draft", "Qualification en brouillon"],
    [admin.email, "access", "draft", "draft+paused", "Pause incident"],
    [admin.email, "access", "draft+paused", "auto", "Retour normal"]]));
  expect(rows).toHaveLength(3);
  const panel = await readSavBlockSwitchPanel({ SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" });
  expect(panel.globalAutoReply).toBe(true);
  expect(panel.blocks).toEqual([expect.objectContaining({ blockId: "access", mode: "auto", paused: false, effective: "auto",
    history: expect.arrayContaining([expect.objectContaining({ actor: admin.email, previous: "draft+paused", next: "auto", reason: "Retour normal" })]) })]);
  expect(JSON.stringify(panel)).not.toMatch(/USD|budget|cap/i);
});

it("an unreadable row fails closed (never sends) and is replaced by the next change, recorded as invalid", async () => {
  await f.db.insert(savSyncState).values({ key: "sav-block-switch.v1:access", cursor: "corrupt", status: "active" });
  const read = await readSavBlockSwitch(f.db, "access");
  expect(read).toMatchObject({ invalid: true });
  expect(savBlockReplyGate(read)).toEqual({ send: "never", code: "block_setting_invalid" });
  await setSavBlockSwitch({ blockId: "access", mode: "auto", paused: false, reason: "Réparation du réglage" });
  expect((await audit())[0]!.technicalMetadata.previous).toBe("invalid");
  expect(savBlockReplyGate(await readSavBlockSwitch(f.db, "access"))).toEqual({ send: "rule" });
});
