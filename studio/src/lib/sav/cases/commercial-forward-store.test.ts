import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savSyncState } from "@/db/schema";
import { commercialForwardKey, type CommercialForwardDeps } from "./commercial-forward";
import { commercialForwardAuditStore, enqueueCommercialForward, readCommercialForwardFacts, reconcileCommercialForwards } from "./commercial-forward-store";
import { commercialForwardSweepOn } from "./smart/smart-switch";

const fixture = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => fixture.db }));

/*
 * Review L7 (26/11): the durable side of the commercial forward on a REAL Postgres engine (PGlite, like the other store tests): receipts written once,
 * the lease held by one pass, the recovery sweep. FICTIONAL data only (public repository); no Gmail (the sweep's ports are stubs).
 */
const ENTITY = "sav_v2_commercial_forward";
let database: Awaited<ReturnType<typeof createSavTestDb>>;
let n = 0;
const key = () => commercialForwardKey(`case-fictif-${++n}`, `in:e${n}`);

beforeAll(async () => { database = await createSavTestDb(); fixture.db = database.db; });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "commercial-forward-fixture-key-32-chars!");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await database.db.delete(auditLogs).where(eq(auditLogs.entityType, ENTITY));
  await database.db.delete(savSyncState).where(like(savSyncState.key, "sav-commercial-forward:%"));
});
afterAll(async () => { await database.client.close(); });

describe("reçus, bail et reprise de la transmission commerciale (vraie base)", () => {
  it("la mise en file est écrite une fois (date et questions chiffrées), un rejeu retrouve la même clé ; un déclencheur non entrant est refusé", async () => {
    const first = await enqueueCommercialForward({ caseId: "case-fictif-a", inputKey: "in:a", triggerEventId: "inbound:18c0ffee", asks: [" quelle offre ? ", ""] });
    expect(first).toEqual({ ok: true, key: "case-fictif-a:in:a", created: true });
    expect(await enqueueCommercialForward({ caseId: "case-fictif-a", inputKey: "in:a", triggerEventId: "inbound:18c0ffee", asks: ["quelle offre ?"] }))
      .toEqual({ ok: true, key: "case-fictif-a:in:a", created: false });
    const queued = await commercialForwardAuditStore.receipt("case-fictif-a:in:a", "queued");
    expect(queued).toMatchObject({ gmailMessageId: "18c0ffee", caseId: "case-fictif-a", queuedAt: expect.any(String) });
    expect(JSON.stringify(queued)).not.toContain("quelle offre");
    expect(await enqueueCommercialForward({ caseId: "case-fictif-a", inputKey: "in:b", triggerEventId: "timer:x", asks: ["x"] })).toEqual({ ok: false, code: "trigger_not_inbound" });
    expect(await enqueueCommercialForward({ caseId: "case-fictif-a", inputKey: "in:b", triggerEventId: "inbound:18c0ffee", asks: [" "] })).toEqual({ ok: false, code: "no_ask" });
    // The stored mail is not in contact@: no facts, so the reply passage refuses (review L3).
    expect(await readCommercialForwardFacts("case-fictif-a:in:a")).toBeNull();
  });

  it("chaque étape n'est enregistrée qu'une fois, même en concurrence ; les tentatives se comptent", async () => {
    const k = key();
    const writes = await Promise.all([1, 2, 3].map(() => commercialForwardAuditStore.record(k, "dispatched", { revision: "r" })));
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(await commercialForwardAuditStore.steps(k)).toEqual(["dispatched"]);
    expect(await commercialForwardAuditStore.attempt(k, { reason: "A" })).toBe(1);
    expect(await commercialForwardAuditStore.attempt(k, { reason: "B" })).toBe(2);
    expect(await commercialForwardAuditStore.steps(k)).toEqual(["dispatched"]);
  });

  it("le bail : une seule passe le tient ; libéré, il se reprend ; une autre clé est indépendante", async () => {
    const k = key();
    const release = await commercialForwardAuditStore.lease(k);
    expect(release).toBeTypeOf("function");
    expect(await commercialForwardAuditStore.lease(k)).toBeNull();
    const other = await commercialForwardAuditStore.lease(key());
    expect(other).toBeTypeOf("function");
    await release!();
    const again = await commercialForwardAuditStore.lease(k);
    expect(again).toBeTypeOf("function");
    await again!(); await other!();
  });

  it("la reprise ne prend que les transmissions en file sans reçu final, bornée", async () => {
    const open = key(), done = key();
    for (const k of [open, done]) await commercialForwardAuditStore.record(k, "queued", { revision: "r", queuedAt: new Date().toISOString() });
    await commercialForwardAuditStore.record(done, "confirmed", { revision: "r" });
    const seen: string[] = [];
    const deps: CommercialForwardDeps = {
      authority: async () => { throw Error("SAV_COMMERCIAL_FORWARD_EXECUTION_OFF"); },
      readFacts: async k => { seen.push(k); return null; },
      store: commercialForwardAuditStore,
      gmail: { readOriginal: async () => Buffer.alloc(0), send: async () => { throw Error("NO_SEND"); }, sentMessageId: async () => null, findSent: async () => null },
    };
    const result = await reconcileCommercialForwards(5, Date.now() + 20_000, deps);
    expect(result).toEqual({ candidates: 1, results: [{ result: { skipped: "authority", detail: "SAV_COMMERCIAL_FORWARD_EXECUTION_OFF" } }] });
    expect(seen).toEqual([]);
    expect(await commercialForwardAuditStore.steps(open)).toEqual(["queued"]);
  });
});

describe("étape de reprise dans la passe de réconciliation", () => {
  it("aucune étape (aucune requête) quand les deux interrupteurs sont éteints ; elle tourne si l'un des deux est allumé (revue M2)", () => {
    expect(commercialForwardSweepOn({})).toBe(false);
    expect(commercialForwardSweepOn({ SAV_V2_SMART_COMMERCIAL_SPLIT: "off", SAV_V2_SMART_COMMERCIAL_FORWARD: "true" })).toBe(false);
    expect(commercialForwardSweepOn({ SAV_V2_SMART_COMMERCIAL_SPLIT: "on" })).toBe(true);
    expect(commercialForwardSweepOn({ SAV_V2_SMART_COMMERCIAL_FORWARD: "on" })).toBe(true);
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../reconcile-pass.ts"), "utf8");
    expect(source).toMatch(/const commercialForwards = commercialForwardSweepOn\(process\.env\)\s*\? await runStep<[^]*?>\("v2_commercial_forward"/);
    expect(source).toMatch(/\.\.\.\(commercialForwards \? \{ commercialForwards \} : \{\}\)/);
  });
});
