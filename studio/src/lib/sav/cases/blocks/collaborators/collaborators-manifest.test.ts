import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packageFingerprint } from "../../../skills/skill-contract";
import { accessSkillPromptSha256, SAV_ACCESS_SKILL_PROMPT_SHA256, SAV_ACCESS_SKILL_REVISION } from "../../access-skill/access-skill-guidelines";
import { SAV_CASE_BLOCK_REGISTRY } from "../../case-block-registry";
import { measureCollaboratorsPromptBudget, SAV_COLLABORATORS_INPUT_CEILING_BYTES } from "./collaborators-budget";
import { collaboratorsDecisionSkillSha256, SAV_COLLABORATORS_DECISION_SKILL } from "./collaborators-decision-skill";
import { collaboratorsEntryRoutes, collaboratorsEntryTruncations, SAV_COLLABORATORS_CONFIRM_TEXT_MAX } from "./collaborators-entry-rule";
import { SAV_COLLABORATORS_ENTRY_SKILL } from "./collaborators-entry-skill";
import { SAV_COLLABORATORS_CONFIRM_MEASURED, SAV_COLLABORATORS_CONFIRM_SKILL_REVISION } from "./collaborators-skill";
import { collaboratorsManifestBindable, SAV_COLLABORATORS_BLOCK_MANIFEST, SAV_COLLABORATORS_BLOCK_SETTINGS } from "./collaborators-manifest";

describe("collaborators manifest: off, no right, nothing wired", () => {
  it("starts off, without automatic right, J2 or automatic closure", () => {
    expect(SAV_COLLABORATORS_BLOCK_SETTINGS.modes.initial).toBe("off");
    expect(SAV_COLLABORATORS_BLOCK_SETTINGS.autoAllowed).toBe(false);
    expect(SAV_COLLABORATORS_BLOCK_SETTINGS.j2.allowed).toBe(false);
    expect(SAV_COLLABORATORS_BLOCK_SETTINGS.resolutionProof.autoClosure).toBe(false);
    expect("resolutionProof" in SAV_COLLABORATORS_BLOCK_MANIFEST).toBe(false);
  });
  it("keeps the permanent human families exactly", () => {
    expect([...SAV_COLLABORATORS_BLOCK_SETTINGS.alwaysHuman]).toEqual(["cancellation", "subscription", "finance", "rights", "identity"]);
  });
  it("names the real skill revisions, the usage family and the excluded neighbours", () => {
    expect(SAV_COLLABORATORS_BLOCK_MANIFEST).toMatchObject({ blockId: "collaborators", family: "usage" });
    expect(SAV_COLLABORATORS_BLOCK_MANIFEST.skills).toEqual([
      { id: "collaborators-entry-skill", revision: SAV_COLLABORATORS_CONFIRM_SKILL_REVISION },
      { id: SAV_COLLABORATORS_DECISION_SKILL.id, revision: SAV_COLLABORATORS_DECISION_SKILL.revision },
    ]);
    expect(SAV_COLLABORATORS_ENTRY_SKILL.id).toBe("collaborators-entry-skill");
    expect([...SAV_COLLABORATORS_BLOCK_MANIFEST.excludedNeighbours].sort()).toEqual(["access", "charly_max", "integrations"]);
  });
  it("binds nothing while a source version is to confirm; one answer card only", () => {
    expect(collaboratorsManifestBindable()).toBe(false);
    expect(SAV_COLLABORATORS_BLOCK_MANIFEST.sources.filter(source => source.usage === "answer").map(source => source.sourceId)).toEqual(["collaborators.invite-member"]);
    for (const source of SAV_COLLABORATORS_BLOCK_MANIFEST.sources) expect(source.contentVersionId, source.sourceId).toBe("TO_CONFIRM");
  });
  it("never weakens the method thresholds", () => {
    const t = SAV_COLLABORATORS_BLOCK_SETTINGS.thresholds;
    expect([t.sensitiveAdmitted, t.sourcesOutsideSupport, t.doubleSend, t.draftsSensitiveMissed]).toEqual([0, 0, 0, 0]);
    expect(t.neighbourRouted).toBeGreaterThanOrEqual(0.95);
    expect(t.blockRecall).toBeGreaterThanOrEqual(0.9);
    expect(t.draftsMin).toBeGreaterThanOrEqual(10);
    expect(t.draftsGoodRate).toBeGreaterThanOrEqual(0.9);
  });
  it("is pure data: no server-only import, no production identifier, absent from the live registry", () => {
    const dir = new URL("./", import.meta.url);
    for (const name of readdirSync(dir).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(name, dir), "utf8");
      expect(source, name).not.toMatch(/(?:from|import)\s+["']server-only["']/);
      expect(source, name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
    expect(SAV_CASE_BLOCK_REGISTRY.map(row => row.blockId)).toEqual(["access"]);
  });
  it("computes a package fingerprint from the manifest and both skill fingerprints", () => {
    const fingerprint = packageFingerprint({
      activeBlocks: [SAV_COLLABORATORS_BLOCK_MANIFEST],
      skills: [
        { id: SAV_COLLABORATORS_ENTRY_SKILL.id, revision: SAV_COLLABORATORS_CONFIRM_SKILL_REVISION, promptFingerprint: SAV_COLLABORATORS_CONFIRM_MEASURED.promptSha256 },
        { id: SAV_COLLABORATORS_DECISION_SKILL.id, revision: SAV_COLLABORATORS_DECISION_SKILL.revision, promptFingerprint: collaboratorsDecisionSkillSha256() },
      ],
      model: "model-to-confirm",
      scopes: [],
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("prompt budget per stage, measured at the read bounds", () => {
  it("stays strictly under 85 % of the ceiling and matches the manifest", () => {
    const [confirm, decision] = measureCollaboratorsPromptBudget();
    expect(SAV_COLLABORATORS_INPUT_CEILING_BYTES).toBe(SAV_COLLABORATORS_BLOCK_SETTINGS.budget.ceilingBytes);
    expect(confirm).toEqual({ stage: "confirm", bodyBytes: SAV_COLLABORATORS_BLOCK_SETTINGS.budget.confirm.measuredBytes, ceilingBytes: 26_000, status: "pass" });
    expect(decision).toEqual({ stage: "decision", bodyBytes: SAV_COLLABORATORS_BLOCK_SETTINGS.budget.decision.measuredBytes, ceilingBytes: 26_000, status: "pass" });
  });
  it("sends a mail longer than the read bound wholly to the team, before any reading", () => {
    const input = { purpose: "first_mail" as const, subject: "Invitation", text: "a".repeat(SAV_COLLABORATORS_CONFIRM_TEXT_MAX + 1), requests: [{ requestId: "r1", words: null }] };
    expect(collaboratorsEntryTruncations(input)).toEqual(["text"]);
    expect(collaboratorsEntryRoutes(input, null, "no")).toEqual({ routes: [{ requestId: "r1", route: { kind: "team" } }], teamReasons: ["input_truncated", "judgment_malformed"] });
  });
});

describe("Access stays identical", () => {
  it("keeps the Access skill revision and pinned prompt fingerprint", () => {
    expect(SAV_ACCESS_SKILL_REVISION).toBe("sav-access-entry-skill-2026-11-18.v1");
    expect(accessSkillPromptSha256()).toBe(SAV_ACCESS_SKILL_PROMPT_SHA256);
  });
});
