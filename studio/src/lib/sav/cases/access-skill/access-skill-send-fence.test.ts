import { describe, expect, it } from "vitest";
import { FAKE_BLOCK, FAKE_BLOCK_ID } from "../../../../../test/sav-entry-fake-block";
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "./access-skill-guidelines";
import { accessSkillSendProblem } from "./access-skill-send-fence";

/* The last look before a reply leaves: Access exactly as before; a case admitted by another block's skill only while that block is still on, same revision. */

const admission = (ruleId: string, revision: string) => ({ qualification: { requests: [{ provenance: { kind: "qualified_rule", ruleId, revision } }] } });
const ACCESS = admission(SAV_ACCESS_SKILL_RULE_ID, SAV_ACCESS_SKILL_REVISION), DEMO = admission(`${FAKE_BLOCK_ID}-entry-skill`, FAKE_BLOCK.skill.revision);
const LEGACY = admission("rule-access", "r1");
const env = (access: string | null, blocks: Record<string, string> | null) => ({ ...(access ? { SAV_V2_ACCESS_SKILL: access } : {}), ...(blocks ? { SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify(blocks) } : {}) });
const fence = (e: Record<string, string>, a: unknown, text = "Voici la marche à suivre.", purpose = "answer") =>
  accessSkillSendProblem({ env: e, admission: a as Parameters<typeof accessSkillSendProblem>[0]["admission"], text, purpose, skillBlocks: [FAKE_BLOCK] });

describe("barrière d'envoi", () => {
  it("Accès : inchangé (on : passe ; changé ou off : annulé ; phrase du noyau dans notre réponse : annulée)", () => {
    expect(fence(env("on", null), ACCESS)).toBeNull();
    expect(fence(env("off", null), ACCESS)).toBe("CANCELLED_ACCESS_SKILL_CHANGED");
    expect(fence(env("on", null), admission(SAV_ACCESS_SKILL_RULE_ID, "older"))).toBe("CANCELLED_ACCESS_SKILL_CHANGED");
    expect(fence(env("on", null), ACCESS, "Pour résilier votre abonnement, cliquez ici.")).toBe("CANCELLED_REPLY_SENSITIVE_WORDING");
    expect(fence(env(null, null), LEGACY)).toBeNull();
    expect(fence(env("on", { [FAKE_BLOCK_ID]: "off" }), ACCESS)).toBeNull();
  });
  it("un autre bloc à skill : seulement s'il est encore on, à la même révision", () => {
    expect(fence(env("on", { [FAKE_BLOCK_ID]: "on" }), DEMO)).toBeNull();
    for (const e of [env("on", null), env("on", { [FAKE_BLOCK_ID]: "shadow" }), env("on", { [FAKE_BLOCK_ID]: "off" }), env("shadow", { [FAKE_BLOCK_ID]: "on" })]) expect(fence(e, DEMO)).toBe("CANCELLED_ACCESS_SKILL_CHANGED");
    expect(fence(env("on", { [FAKE_BLOCK_ID]: "on" }), admission(`${FAKE_BLOCK_ID}-entry-skill`, "older"))).toBe("CANCELLED_ACCESS_SKILL_CHANGED");
    expect(fence(env("on", { [FAKE_BLOCK_ID]: "on" }), admission("ghost-entry-skill", "v1"))).toBe("CANCELLED_ACCESS_SKILL_CHANGED");
    expect(fence(env("on", { [FAKE_BLOCK_ID]: "on" }), DEMO, "Pour résilier votre abonnement, cliquez ici.")).toBe("CANCELLED_REPLY_SENSITIVE_WORDING");
    // A hand-over or closing notice is the team's path already.
    expect(fence(env("on", null), DEMO, "x", "handoff")).toBeNull();
  });
});
