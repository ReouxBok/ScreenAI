import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, staff: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("./execution-policy", () => ({ executionAdministrator: async () => { if (!state.staff) throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"); return state.staff; } }));
import { readSavAgentPauseBanner, readSavAgentPausePanel, setSavAgentPause } from "./agent-pause-admin";
import { readSavAgentPause } from "./agent-pause";

let f: Awaited<ReturnType<typeof createSavTestDb>>;
const KEY = "sav-agent-pause.v1:intake", admin = { id: "a", email: "reouven@limova.ai", role: "admin", active: true };
const rows = () => f.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_agent_pause_set"));
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; });
afterAll(async () => { await f?.client.close(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-pause-encryption-key-32-characters"); state.staff = admin;
  await f.db.delete(savSyncState).where(eq(savSyncState.key, KEY)); await f.db.delete(auditLogs);
});

it("refuses a non-administrator (the executionAdministrator check) without writing", async () => {
  state.staff = null;
  await expect(setSavAgentPause({ agent: "intake", level: "fully_paused", reason: "Incident CRM" })).rejects.toThrow("SAV_AGENT_PAUSE_UNAUTHORIZED");
  await expect(readSavAgentPausePanel()).rejects.toThrow("SAV_AGENT_PAUSE_UNAUTHORIZED");
  expect(await f.db.select().from(savSyncState).where(eq(savSyncState.key, KEY))).toHaveLength(0);
  expect(await rows()).toHaveLength(0);
});
it("requires a reason and a known level and agent; v2 is reserved, not settable yet", async () => {
  for (const input of [{ agent: "intake", level: "fully_paused", reason: " " }, { agent: "intake", level: "fully_paused", reason: "ok" }, { agent: "intake", level: "stopped", reason: "motif valable" },
    { agent: "v2", level: "fully_paused", reason: "motif valable" }, { agent: "intake", level: "running", reason: "motif valable", extra: 1 }, { level: "fully_paused", reason: "motif valable" }])
    await expect(setSavAgentPause(input)).rejects.toThrow();
  expect(await rows()).toHaveLength(0);
});
it("stores the level encrypted, audits actor, previous and next levels and reason, and resumes", async () => {
  await setSavAgentPause({ agent: "intake", level: "fully_paused", reason: "Incident CRM du 27/10" });
  expect(await readSavAgentPause(f.db)).toMatchObject({ level: "fully_paused", invalid: false, setting: { setBy: admin.email, reason: "Incident CRM du 27/10" } });
  const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, KEY));
  expect(row.cursor).not.toContain("Incident");
  await setSavAgentPause({ agent: "intake", level: "actions_paused", reason: "Analyse seule" });
  await setSavAgentPause({ agent: "intake", level: "running", reason: "Incident clos" });
  expect((await readSavAgentPause(f.db)).level).toBe("running");
  const audit = (await rows()).map(a => [a.actorEmail, a.entityType, a.entityId, a.technicalMetadata.previousLevel, a.technicalMetadata.nextLevel, a.technicalMetadata.reason]);
  expect(audit).toEqual(expect.arrayContaining([
    [admin.email, "sav_agent_pause", "intake", "running", "fully_paused", "Incident CRM du 27/10"],
    [admin.email, "sav_agent_pause", "intake", "fully_paused", "actions_paused", "Analyse seule"],
    [admin.email, "sav_agent_pause", "intake", "actions_paused", "running", "Incident clos"]]));
  expect(audit).toHaveLength(3);
});
it("replaces an unreadable setting and records that the previous one was invalid", async () => {
  await f.db.insert(savSyncState).values({ key: KEY, cursor: "corrupt", status: "active" });
  expect(await readSavAgentPauseBanner()).toMatchObject({ level: "fully_paused", invalid: true });
  await setSavAgentPause({ agent: "intake", level: "running", reason: "Réparation du réglage" });
  expect((await rows())[0].technicalMetadata.previousLevel).toBe("invalid");
  expect(await readSavAgentPauseBanner()).toBeNull();
});
it("panel lists the history; the console banner needs no administrator and says who, when and which level", async () => {
  await setSavAgentPause({ agent: "intake", level: "actions_paused", reason: "Vérification des tickets" });
  const panel = await readSavAgentPausePanel();
  expect(panel).toMatchObject({ state: { level: "actions_paused" }, history: [expect.objectContaining({ actor: admin.email, previousLevel: "running", nextLevel: "actions_paused", reason: "Vérification des tickets" })] });
  state.staff = null;
  expect(await readSavAgentPauseBanner()).toMatchObject({ level: "actions_paused", setBy: admin.email, setAt: expect.any(String), invalid: false });
});
