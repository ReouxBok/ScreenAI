import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { confirmSays, counterSaysNo, entrySkillModelDouble, routerSays, type EntryDoubleCall, type EntryDoubleAnswer } from "../../../../../test/sav-entry-skill-double";
import { FAKE_BLOCK, FAKE_BLOCK_ID } from "../../../../../test/sav-entry-fake-block";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "../access-skill/access-skill-guidelines";
import { entrySkillRuleId } from "../../skills/entry-block";
import { qualifyThreadlessTicket, SAV_THREADLESS_SOURCE_REVISION, type ThreadlessTicketSource } from "../threadless-source";

/*
 * Chantier « 3 blocs », the HubSpot ticket without a mail (`threadless-source.ts`): the same two-stage entry, on the real stores, model doubled at the
 * network boundary. The ticket's subject and description only (never a note). Fictional data only.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, ticket = 9_190_000;
const AT = "2026-11-19T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000019";
const SKILL = { ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, v1Kind: "support", family: "access", at: AT };
const DEMO = { ruleId: entrySkillRuleId(FAKE_BLOCK_ID), revision: FAKE_BLOCK.skill.revision, v1Kind: "support", family: "usage", at: AT, blockId: FAKE_BLOCK_ID };
const POLICY = { revision: "policy-ticket-19", admittedFamilies: ["access", "usage"], approvedBy: STAFF, approvedAt: AT,
  qualifiedRules: [{ ruleId: SKILL.ruleId, revision: SKILL.revision, families: ["access"] }, { ruleId: DEMO.ruleId, revision: DEMO.revision, families: ["usage"], blockId: FAKE_BLOCK_ID }] };
const env = (blocks: Record<string, string> | null) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_ACCESS_SKILL: "on", SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([SKILL, DEMO]),
  SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({ policy: POLICY, validFrom: "2025-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" }),
  ...(blocks ? { SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify(blocks) } : {}) }) as Record<string, string>;
const source = (subject: string, description: string): ThreadlessTicketSource => ({ kind: "hubspot_ticket", revision: SAV_THREADLESS_SOURCE_REVISION, ticketId: String(ticket++),
  version: AT, ownerId: "123", stageId: "1", subject, description, categories: "", notes: [], contact: { id: "55", email: "client@exemple.invalid" } });
const LOGIN = "Le client ne reçoit pas le code de connexion.", LOGIN_QUOTE = "ne reçoit pas le code de connexion";
const EXPORT = "Le client demande comment imprimer le planning.", EXPORT_QUOTE = "comment imprimer le planning";
const honest = (call: EntryDoubleCall): EntryDoubleAnswer => {
  const id = call.payload.requests?.[0]?.requestId ?? "r1", exportTopic = call.payload.text.includes("imprimer");
  if (call.kind === "counter") return { output: counterSaysNo() };
  if (call.kind === "router") return { output: routerSays([[id, exportTopic ? FAKE_BLOCK_ID : "access"]]) };
  if (call.kind === "access_judge") return { output: confirmSays([{ requestId: id, verdict: exportTopic ? "other" : "access", quote: exportTopic ? EXPORT_QUOTE : LOGIN_QUOTE }]) };
  return { output: confirmSays([{ requestId: id, verdict: exportTopic ? "block" : "other", quote: exportTopic ? EXPORT_QUOTE : LOGIN_QUOTE }]) };
};
const qualify = (e: Record<string, string>, s: ThreadlessTicketSource, network: ReturnType<typeof entrySkillModelDouble>["network"]) =>
  qualifyThreadlessTicket(s, e, new Date(AT), { accessSkillCompute: true, accessSkillDeps: { network }, skillBlocks: [FAKE_BLOCK] });
let infos: ReturnType<typeof vi.spyOn>;

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-ticket-fixture-key-32chars!!"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-ticket-fixture-key-32chars!!");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); }));
  infos = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ticket HubSpot sans mail : même logique d'entrée", () => {
  it("Accès seul actif : le chemin SAV-97 à l'identique (juge et contre-lecture d'Accès, pas de routeur)", async () => {
    for (const blocks of [null, { [FAKE_BLOCK_ID]: "off" }]) {
      const model = entrySkillModelDouble(honest);
      expect(await qualify(env(blocks), source("Connexion", LOGIN), model.network)).toMatchObject({ status: "admitted" });
      expect(model.calls.map(call => call.kind)).toEqual(["access_judge", "counter"]);
    }
  });
  it("deux blocs actifs : un ticket Accès passe par le routeur puis le juge d'Accès, admis comme avant (même lecture d'Accès réutilisée)", async () => {
    const model = entrySkillModelDouble(honest);
    const result = await qualify(env({ [FAKE_BLOCK_ID]: "on" }), source("Connexion", LOGIN), model.network);
    expect(result).toMatchObject({ status: "admitted", admission: { qualification: { requests: [{ family: "access", provenance: { ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION } }] } } });
    expect(model.calls.map(call => call.kind)).toEqual(["router", "access_judge", "counter"]);
  });
  it("deux blocs actifs : un ticket confirmé pour un autre bloc n'est jamais admis (block_not_threadless) ; sensible au routeur → l'équipe", async () => {
    const model = entrySkillModelDouble(honest);
    expect(await qualify(env({ [FAKE_BLOCK_ID]: "on" }), source("Planning", EXPORT), model.network)).toEqual({ status: "out_of_scope", reason: "block_not_threadless" });
    const sensitive = entrySkillModelDouble(call => call.kind === "router" ? { output: routerSays([[call.payload.requests![0]!.requestId, "sensitive"]]) } : honest(call));
    expect(await qualify(env({ [FAKE_BLOCK_ID]: "on" }), source("Connexion", LOGIN), sensitive.network)).toEqual({ status: "human_wait", reason: "sensitive_request" });
    expect(sensitive.calls.map(call => call.kind)).toEqual(["router"]);
  });
  it("shadow : la décision réelle est celle d'Accès ; la comparaison est journalisée (codes fermés)", async () => {
    const model = entrySkillModelDouble(honest);
    expect(await qualify(env({ [FAKE_BLOCK_ID]: "shadow" }), source("Planning", EXPORT), model.network)).toEqual({ status: "human_wait", reason: "not_access" });
    const shadow = infos.mock.calls.filter((call: unknown[]) => call[0] === "sav_v2_threadless_entry_skill_shadow").map((call: unknown[]) => call[1]);
    expect(shadow).toEqual([expect.objectContaining({ actual: "r1=team", shadow: `r1=${FAKE_BLOCK_ID}`, disagree: true })]);
  });
});
