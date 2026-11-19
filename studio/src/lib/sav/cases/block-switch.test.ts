import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, staff: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("../intake/execution-policy", () => ({ executionAdministrator: async () => { if (!state.staff) throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"); return state.staff; } }));
import { readSavBlockSwitch, savBlockEffectiveMode, savBlockReplyGate, SAV_BLOCK_SWITCH_DEFAULT } from "./block-switch";
import { readSavBlockSwitchPanel, savBlockSwitchBlockIds, setSavBlockSwitch } from "./block-switch-admin";
import { SAV_ENTRY_SKILL_BLOCKS } from "./blocks/registry";

/*
 * Per-block switch (12/11): mode off | draft | auto and a pause per treatment block, stored like the agent pause (sav-agent-pause.v1):
 * encrypted row in sav.sync_state, actor, reason, timestamp, audited history. No row = off, except the frozen legacy Access fallback (auto, not paused).
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

it("Access without a row keeps the legacy auto fallback and the global admission restriction", async () => {
  const access = await readSavBlockSwitch(f.db, "access");
  expect(access).toEqual({ blockId: "access", mode: "auto", paused: false, setting: null, invalid: false });
  expect(savBlockReplyGate(access)).toEqual({ send: "rule" });
  expect(savBlockEffectiveMode(access, { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" })).toBe("auto");
  expect(savBlockEffectiveMode(access, {})).toBe("draft");
});

it.each(["integrations", "collaborators", "future-block"])("new block %s without a row is off", async blockId => {
  expect(SAV_BLOCK_SWITCH_DEFAULT).toEqual({ mode: "off", paused: false });
  const read = await readSavBlockSwitch(f.db, blockId);
  expect(read).toEqual({ blockId, mode: "off", paused: false, setting: null, invalid: false });
  expect(savBlockReplyGate(read)).toEqual({ send: "never", code: "block_off" });
  expect(savBlockEffectiveMode(read, { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" })).toBe("off");
});

it.each(["off", "auto"] as const)("an explicit Access %s setting overrides the legacy fallback", async mode => {
  await setSavBlockSwitch({ blockId: "access", mode, paused: false, reason: "Réglage synthétique explicite" });
  expect(await readSavBlockSwitch(f.db, "access")).toMatchObject({ mode, invalid: false, setting: { mode } });
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
  expect(panel.blocks[0]).toEqual(expect.objectContaining({ blockId: "access", mode: "auto", paused: false, effective: "auto",
    history: expect.arrayContaining([expect.objectContaining({ actor: admin.email, previous: "draft+paused", next: "auto", reason: "Retour normal" })]) }));
  expect(panel.blocks.map(block => block.blockId)).toEqual(["access", "collaborators", "charly_max", "integrations"]);
  expect(JSON.stringify(panel)).not.toMatch(/USD|budget|cap/i);
});

it("an unreadable row fails closed (never sends) and is replaced by the next change, recorded as invalid", async () => {
  await f.db.insert(savSyncState).values({ key: "sav-block-switch.v1:access", cursor: "corrupt", status: "active" });
  const read = await readSavBlockSwitch(f.db, "access");
  expect(read).toMatchObject({ mode: "off", invalid: true });
  expect(savBlockReplyGate(read)).toEqual({ send: "never", code: "block_setting_invalid" });
  await setSavBlockSwitch({ blockId: "access", mode: "auto", paused: false, reason: "Réparation du réglage" });
  expect((await audit())[0]!.technicalMetadata.previous).toBe("invalid");
  expect(savBlockReplyGate(await readSavBlockSwitch(f.db, "access"))).toEqual({ send: "rule" });
});

/*
 * Revue Astra P2 (19/11): the Studio switch (panel + save action) knows the blocks of the ENTRY registry (`cases/blocks/registry.ts`) besides Access,
 * whose behaviour is unchanged. Each one is saved and read back; without a row it is off (never the legacy Access fallback).
 */
const ON = { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000042" };
it("the switch knows Access and every entry block, in that order, and nothing else", () => {
  expect(savBlockSwitchBlockIds()).toEqual(["access", ...SAV_ENTRY_SKILL_BLOCKS.map(block => block.blockId)]);
  expect(savBlockSwitchBlockIds()).toEqual(["access", "collaborators", "charly_max", "integrations"]);
});
it.each(["collaborators", "charly_max", "integrations"])("entry block %s: off by default in the panel, saved, read back, audited; Access untouched", async blockId => {
  const before = (await readSavBlockSwitchPanel(ON)).blocks.find(block => block.blockId === blockId);
  expect(before).toMatchObject({ blockId, mode: "off", paused: false, setting: null, invalid: false, effective: "off", history: [] });
  await setSavBlockSwitch({ blockId, mode: "draft", paused: false, reason: "Essai en brouillon" });
  expect(await readSavBlockSwitch(f.db, blockId)).toMatchObject({ blockId, mode: "draft", paused: false, invalid: false, setting: { blockId, setBy: admin.email, reason: "Essai en brouillon" } });
  await setSavBlockSwitch({ blockId, mode: "auto", paused: true, reason: "Pause du bloc" });
  const after = (await readSavBlockSwitchPanel(ON)).blocks.find(block => block.blockId === blockId);
  expect(after).toMatchObject({ blockId, mode: "auto", paused: true, effective: "paused" });
  expect(after!.history.map(entry => [entry.previous, entry.next, entry.reason])).toEqual(expect.arrayContaining([["off", "draft", "Essai en brouillon"], ["draft", "auto+paused", "Pause du bloc"]]));
  await setSavBlockSwitch({ blockId, mode: "auto", paused: false, reason: "Auto mais non listé" });
  // `auto` on the switch is never enough: not in SAV_V2_AUTO_REPLY, the block stays a person's.
  expect((await readSavBlockSwitchPanel(ON)).blocks.find(block => block.blockId === blockId)).toMatchObject({ mode: "auto", effective: "draft" });
  expect((await readSavBlockSwitchPanel({ ...ON, SAV_V2_AUTO_REPLY: `access,${blockId}` })).blocks.find(block => block.blockId === blockId)).toMatchObject({ effective: "auto" });
  // Access keeps its legacy fallback and its effective mode, row-less, whatever was saved for the entry block.
  expect(await readSavBlockSwitch(f.db, "access")).toEqual({ blockId: "access", mode: "auto", paused: false, setting: null, invalid: false });
  expect((await readSavBlockSwitchPanel(ON)).blocks[0]).toMatchObject({ blockId: "access", mode: "auto", effective: "auto", history: [] });
  expect((await audit()).every(row => row.entityId === blockId)).toBe(true);
});
