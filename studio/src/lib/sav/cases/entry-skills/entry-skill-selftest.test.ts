import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { confirmSays, counterSaysNo, counterSaysYes, entrySkillModelDouble, routerSays, type EntryDoubleCall, type EntryDoubleAnswer } from "../../../../../test/sav-entry-skill-double";
import { FAKE_BLOCK, FAKE_BLOCK_ID } from "../../../../../test/sav-entry-fake-block";
import { savCases, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { SAV_ACCESS_SKILL_CORPUS } from "../access-skill/access-skill-corpus.fixture";
import { readAccessSkillSelfTestConfig } from "../access-skill/access-skill-selftest";
import type { CorpusCase } from "../../skills/corpus-contract";
import { readEntrySkillSelfTestAggregate, readEntrySkillSelfTestConfig, runEntrySkillSelfTestPass, SAV_ENTRY_SKILL_SELFTEST_MAX_CAP_MICRO_USD, type EntrySkillSelfTestAggregate } from "./entry-skill-selftest";

/*
 * Chantier « 3 blocs », the generic production self-test on the real store (PGlite), the model doubled at the network boundary from the corpus labels.
 * Fictional corpora only; nothing but the model endpoint may be reached; no case is ever created.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, runSeq = 0;
const at = new Date("2026-11-19T03:00:00.000Z");
const env = (target: string, extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_ENTRY_SKILL_SELFTEST: "run", SAV_V2_ENTRY_SKILL_SELFTEST_TARGET: target,
  SAV_V2_ENTRY_SKILL_SELFTEST_ID: `entry-run-${++runSeq}`, SAV_V2_ENTRY_SKILL_SELFTEST_BATCH: "50", ...extra });

/** The labelled double for the fake block's corpus: routes and confirms each case by its label; `lie` makes the router and the skill say « block » on everything. */
function labelled(lie: false | "router_and_skill" | "everything" = false) {
  const byText = new Map(FAKE_BLOCK.corpus.map(row => [row.text, row]));
  const label = (row: CorpusCase, requestId: string) => row.requests.find(request => request.requestId === requestId)!.expected;
  return entrySkillModelDouble((call: EntryDoubleCall): EntryDoubleAnswer => {
    const row = byText.get(call.payload.text)!, ids = (call.payload.requests ?? []).map(request => request.requestId);
    const sensitive = row.group === "sensitive" || row.requests.some(request => request.expected.kind === "sensitive");
    if (call.kind === "counter") return { output: sensitive && lie !== "everything" ? counterSaysYes() : counterSaysNo() };
    if (call.kind === "router") return { output: routerSays(ids.map(id => { const l = label(row, id); return [id, lie ? FAKE_BLOCK_ID : l.kind === "block" ? l.blockId : l.kind === "sensitive" ? "sensitive" : "other"]; }), lie || !sensitive ? "no" : "yes") };
    const own = call.kind === "access_judge" ? "access" : FAKE_BLOCK_ID;
    return { output: confirmSays(ids.map(id => { const l = label(row, id); const mine = lie || (l.kind === "block" && l.blockId === own);
      return { requestId: id, verdict: mine ? (own === "access" ? "access" : "block") : l.kind === "sensitive" ? "sensitive" : "other",
        quote: call.payload.requests?.find(request => request.requestId === id)?.words ?? row.text }; })) };
  });
}
const run = (e: Record<string, string>, network: ReturnType<typeof entrySkillModelDouble>["network"], extra: Record<string, unknown> = {}) =>
  runEntrySkillSelfTestPass({ env: () => e, now: () => at, network, registry: [FAKE_BLOCK], log: (event, fields) => logs.push([event, fields]), ...extra });
let logs: Array<[string, unknown]> = [];

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-selftest-fixture-key-32chars"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-selftest-fixture-key-32chars"); vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); })); logs = []; });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("auto-test générique : configuration", () => {
  it("off par défaut ; cible inconnue ou invalide refusée ; plafond ≤ 10 USD ; le mode Accès existant reste lu à part", () => {
    expect(readEntrySkillSelfTestConfig({}, [FAKE_BLOCK])).toEqual({ mode: "off" });
    expect(readEntrySkillSelfTestConfig(env("ghost"), [FAKE_BLOCK])).toEqual({ mode: "refused", reason: "target_unknown" });
    expect(readEntrySkillSelfTestConfig(env(FAKE_BLOCK_ID), [{ ...FAKE_BLOCK, promptSha256: "0".repeat(64) }])).toEqual({ mode: "refused", reason: "target_invalid" });
    expect(readEntrySkillSelfTestConfig(env(FAKE_BLOCK_ID, { SAV_V2_ENTRY_SKILL_SELFTEST_MAX_MICRO_USD: String(SAV_ENTRY_SKILL_SELFTEST_MAX_CAP_MICRO_USD + 1) }), [FAKE_BLOCK])).toEqual({ mode: "refused", reason: "cap_invalid" });
    expect(readEntrySkillSelfTestConfig(env(FAKE_BLOCK_ID), [FAKE_BLOCK])).toMatchObject({ mode: "run", target: FAKE_BLOCK_ID, capMicroUsd: 10_000_000, passes: 3 });
    expect(readEntrySkillSelfTestConfig(env("access"), [FAKE_BLOCK])).toMatchObject({ mode: "run", target: "access" });
    // SAV-97's switch is untouched and independent.
    expect(readAccessSkillSelfTestConfig({ SAV_V2_ACCESS_SKILL_SELFTEST: "run", SAV_V2_ACCESS_SKILL_SELFTEST_ID: "a1" })).toMatchObject({ mode: "run", runId: "a1" });
    expect(readAccessSkillSelfTestConfig(env(FAKE_BLOCK_ID))).toEqual({ mode: "off" });
  });
  it("le pas de rapprochement existant ne charge rien quand off (aucune nouvelle route) ; le pas Accès est intact", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url)), source = readFileSync(path.join(dir, "../../reconcile-pass.ts"), "utf8");
    expect(source).toContain('process.env.SAV_V2_ENTRY_SKILL_SELFTEST === "run" ? await runStep("v2_entry_skill_selftest"');
    expect(source).toContain("...(entrySkillSelfTest ? { entrySkillSelfTest } : {})");
    expect(source).toContain('process.env.SAV_V2_ACCESS_SKILL_SELFTEST === "run" ? await runStep("v2_access_skill_selftest"');
  });
});

describe("auto-test générique sur le corpus d'un bloc enregistré", () => {
  it("modèle honnête : 3 passes complètes, verdict N3 PASS, une seule ligne de journal, aucun dossier créé", async () => {
    const model = labelled(), e = env(FAKE_BLOCK_ID);
    let pass = await run(e, model.network);
    for (let guard = 0; "status" in pass && pass.status === "running" && guard < 5; guard++) pass = await run(e, model.network);
    expect(pass).toMatchObject({ status: "done" });
    const aggregate = await readEntrySkillSelfTestAggregate(e.SAV_V2_ENTRY_SKILL_SELFTEST_ID) as EntrySkillSelfTestAggregate;
    expect(aggregate).toMatchObject({ target: FAKE_BLOCK_ID, catalog: ["access", FAKE_BLOCK_ID], status: "done", casesPerPass: FAKE_BLOCK.corpus.length, casesDone: 3 * FAKE_BLOCK.corpus.length, verdict: "PASS" });
    expect(aggregate.perPass.map(row => [row.verdict.status, row.verdict.sensitive.admitted])).toEqual([["pass", 0], ["pass", 0], ["pass", 0]]);
    expect(aggregate.costMicroUsd).toBeLessThanOrEqual(aggregate.capMicroUsd);
    expect(logs.filter(([event]) => event === "sav_entry_skill_selftest")).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toMatch(/planning|résilier/);
    expect(await f.db.select().from(savCases)).toEqual([]);
    expect(await run(e, model.network)).toMatchObject({ skipped: "finished" });
  });
  it("un routeur et un skill qui mentent sont arrêtés par la contre-lecture et le noyau : 0 sensible admis, verdict FAIL (voisins mal routés)", async () => {
    const model = labelled("router_and_skill"), e = env(FAKE_BLOCK_ID, { SAV_V2_ENTRY_SKILL_SELFTEST_PASSES: "1" });
    expect(await run(e, model.network)).toMatchObject({ status: "done" });
    const aggregate = (await readEntrySkillSelfTestAggregate(e.SAV_V2_ENTRY_SKILL_SELFTEST_ID))!;
    expect(aggregate.perPass[0]!.verdict.sensitive.admitted).toBe(0);
    expect(aggregate.verdict).toBe("FAIL");
  });
  it("tout ment (contre-lecture comprise) : arrêt au premier sensible admis", async () => {
    const model = labelled("everything"), e = env(FAKE_BLOCK_ID, { SAV_V2_ENTRY_SKILL_SELFTEST_PASSES: "1" });
    expect(await run(e, model.network)).toMatchObject({ status: "stopped" });
    expect(await readEntrySkillSelfTestAggregate(e.SAV_V2_ENTRY_SKILL_SELFTEST_ID)).toMatchObject({ stopReason: "sensitive_admitted", stopCaseId: "s02", verdict: "FAIL" });
  });
  it("plafond : un cas qui pourrait le dépasser n'est pas commencé", async () => {
    const model = labelled(), e = env(FAKE_BLOCK_ID, { SAV_V2_ENTRY_SKILL_SELFTEST_MAX_MICRO_USD: "9" });
    expect(await run(e, model.network)).toMatchObject({ status: "stopped" });
    const aggregate = (await readEntrySkillSelfTestAggregate(e.SAV_V2_ENTRY_SKILL_SELFTEST_ID))!;
    expect(aggregate).toMatchObject({ stopReason: "cap_reached", verdict: "FAIL" });
    expect(aggregate.costMicroUsd).toBeLessThanOrEqual(9);
    // Nothing was paid through V2's daily budget.
    expect(await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-spend.v1:%"))).toEqual([]);
  });
});

describe("rejeu du corpus Accès à travers le routeur", () => {
  it("le juge et la contre-lecture d'Accès confirment après le routeur ; verdict N3 sur le corpus Accès", async () => {
    const sample = [SAV_ACCESS_SKILL_CORPUS.find(row => row.group === "access" && !row.capcarTwin && !row.secondRequest)!, SAV_ACCESS_SKILL_CORPUS.find(row => row.capcarTwin)!,
      SAV_ACCESS_SKILL_CORPUS.find(row => row.group === "sensitive" && !/r[ée]sili|rembours|supprim|ferm/i.test(row.text))!, SAV_ACCESS_SKILL_CORPUS.find(row => row.group === "other")!];
    const byText = new Map(sample.map(row => [row.text, row]));
    const model = entrySkillModelDouble(call => {
      const row = byText.get(call.payload.text)!, ids = (call.payload.requests ?? []).map(request => request.requestId);
      if (call.kind === "counter") return { output: row.group === "sensitive" ? counterSaysYes() : counterSaysNo() };
      if (call.kind === "router") return { output: routerSays(ids.map(id => [id, row.group === "access" ? "access" : row.group === "sensitive" ? "sensitive" : "other"])) };
      return { output: confirmSays(ids.map(id => ({ requestId: id, verdict: row.group === "access" ? "access" : "other", quote: row.quote ?? row.text }))) };
    });
    const e = env("access", { SAV_V2_ENTRY_SKILL_SELFTEST_PASSES: "1" });
    expect(await run(e, model.network, { accessCorpus: sample })).toMatchObject({ status: "done" });
    const aggregate = (await readEntrySkillSelfTestAggregate(e.SAV_V2_ENTRY_SKILL_SELFTEST_ID))!;
    expect(aggregate.perPass[0]!.verdict).toMatchObject({ status: "pass", sensitive: { admitted: 0, total: 1 }, blockRecall: { hits: 2, total: 2 }, traps: { hits: 1, total: 1 }, neighbourRouting: { hits: 1, total: 1 } });
    expect(model.calls.filter(call => call.kind === "access_judge")).toHaveLength(2);
  });
});
