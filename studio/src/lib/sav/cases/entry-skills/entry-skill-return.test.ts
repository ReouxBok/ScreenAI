import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { confirmSays, counterSaysNo, counterSaysYes, entrySkillModelDouble, type EntryDoubleCall, type EntryDoubleAnswer } from "../../../../../test/sav-entry-skill-double";
import { FAKE_BLOCK, FAKE_BLOCK_ID } from "../../../../../test/sav-entry-fake-block";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "../access-skill/access-skill-guidelines";
import { accessSkillReturnRule } from "../access-skill/access-skill-return";
import { entrySkillRuleId } from "../../skills/entry-block";

/* Chantier « 3 blocs »: a customer's return on a case of another block, requalified by that block's skill. Real stores (PGlite), model doubled. Fictional data. */

let f: Awaited<ReturnType<typeof createSavTestDb>>;
const AT = "2026-11-19T09:00:00.000Z", NOW = new Date();
const SKILL = { ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, v1Kind: "support", family: "access", at: AT };
const DEMO = { ruleId: entrySkillRuleId(FAKE_BLOCK_ID), revision: FAKE_BLOCK.skill.revision, v1Kind: "support", family: "usage", at: AT, blockId: FAKE_BLOCK_ID };
const env = (blocks: Record<string, string> | null) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_ACCESS_SKILL: "on", SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([SKILL, DEMO]),
  ...(blocks ? { SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify(blocks) } : {}) }) as Record<string, string>;
const TEXT = "Merci, j'ai trouvé le bouton pour imprimer le planning mais la page reste blanche.", QUOTE = "la page reste blanche";
const port = (families: Array<"usage" | "access"> = ["usage"]) => ({ caseId: randomUUID(), messageId: randomUUID(), text: TEXT, requests: families.map((family, index) => ({ requestId: `r${index + 1}`, family })) });
const rule = (e: Record<string, string>, network: ReturnType<typeof entrySkillModelDouble>["network"], caseBlock: string | null = FAKE_BLOCK_ID) =>
  accessSkillReturnRule({ env: () => e, now: () => NOW, deps: { network, skillBlocks: [FAKE_BLOCK], caseBlock: async () => caseBlock } });
const says = (verdict: string, counter = counterSaysNo()) => (call: EntryDoubleCall): EntryDoubleAnswer =>
  call.kind === "counter" ? { output: counter } : { output: confirmSays((call.payload.requests ?? []).map(row => ({ requestId: row.requestId, verdict, quote: QUOTE }))) };

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-return-fixture-key-32chars!!"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "entry-skill-return-fixture-key-32chars!!"); vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); })); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("retour client sur un dossier d'un autre bloc", () => {
  it("le skill du bloc confirme : la demande reste au bloc (sa règle, sa révision, son blockId), sans routeur", async () => {
    const model = entrySkillModelDouble(says("block"));
    const rows = await rule(env({ [FAKE_BLOCK_ID]: "on" }), model.network)(port());
    expect(rows).toEqual([{ requestId: "r1", family: "usage", provenance: { kind: "qualified_rule", ruleId: DEMO.ruleId, revision: DEMO.revision, at: NOW.toISOString(), blockId: FAKE_BLOCK_ID } }]);
    expect(model.calls.map(call => call.kind)).toEqual(["judge", "counter"]);
    expect(model.calls[0]!.payload.purpose).toBe("return");
  });
  it("une demande sensible au retour : la famille sensible retire le dossier vers l'équipe ; incertain : aucune règle", async () => {
    expect(await rule(env({ [FAKE_BLOCK_ID]: "on" }), entrySkillModelDouble(says("block", counterSaysYes())).network)(port())).toEqual([expect.objectContaining({ requestId: "r1", family: "finance" })]);
    expect(await rule(env({ [FAKE_BLOCK_ID]: "on" }), entrySkillModelDouble(says("unsure")).network)(port())).toEqual([]);
  });
  it("bloc off, dossier sans bloc unique, ou dossier Accès : le chemin d'Accès inchangé (le juge d'Accès)", async () => {
    for (const [e, caseBlock, families] of [[env(null), FAKE_BLOCK_ID, ["usage"]], [env({ [FAKE_BLOCK_ID]: "on" }), null, ["usage"]], [env({ [FAKE_BLOCK_ID]: "on" }), FAKE_BLOCK_ID, ["access"]]] as const) {
      const model = entrySkillModelDouble(says("other"));
      await rule(e, model.network, caseBlock)(port([...families]));
      expect(model.calls.map(call => call.kind)).toEqual(["access_judge"]);
    }
  });
});
