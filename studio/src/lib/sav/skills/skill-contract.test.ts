import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { packageFingerprint, renderSkillPrompt, skillFingerprint, type BlockManifest, type PackageManifest, type SkillDefinition } from "./skill-contract";

const skill = {
  id: "sync-entry", revision: "v1", role: "entry",
  guidelines: ["Read the whole message.", "Choose a route."],
  examples: [
    { id: "ex-1", subject: "Agenda", text: "Le calendrier ne se synchronise plus.\nMerci !", verdict: "block", comment: "Calendar sync stopped." },
    { id: "ex-2", text: "Could you close my account?", verdict: "team", comment: "The team handles closures." },
  ],
  outputSchema: { type: "object", properties: { route: { enum: ["block", "team"] }, reason: { type: "string" } } },
} as const satisfies SkillDefinition;

const block = {
  blockId: "sync", family: "usage", productVersion: "all",
  skills: [{ id: skill.id, revision: skill.revision }, { id: "sync-confirm", revision: "v2" }],
  excludedNeighbours: ["exports", "calendar-setup"],
  sources: [
    { sourceId: "card-sync", contentVersionId: "card-sync-v3", usage: "answer", productVersion: 3 },
    { sourceId: "card-calendar", contentVersionId: "card-calendar-v2", usage: "orient_only", productVersion: 2 },
  ],
  resolutionProof: { id: "calendar-resumed", revision: "v1" },
} as const satisfies BlockManifest;

const manifest = {
  activeBlocks: [block, { ...block, blockId: "calendar-setup", resolutionProof: undefined }],
  skills: [
    { id: skill.id, revision: skill.revision, promptFingerprint: skillFingerprint(skill) },
    { id: "sync-confirm", revision: "v2", promptFingerprint: skillFingerprint({ ...skill, id: "sync-confirm", revision: "v2", role: "confirm" }) },
  ],
  model: "model-v1",
  scopes: [{ id: "support-fr", revision: "v2" }, { id: "support-en", revision: "v1" }],
} as const satisfies PackageManifest;

describe("skill prompt contract", () => {
  it("renders the guidelines, worked examples and full schema, and hashes the exact UTF-8 prompt", () => {
    const prompt = renderSkillPrompt(skill);
    expect(prompt).toContain('Skill "sync-entry" (entry, revision "v1")');
    expect(prompt).toContain("Read the whole message.\nChoose a route.");
    expect(prompt).toContain('"subject":"Agenda","text":"Le calendrier ne se synchronise plus.\\nMerci !","verdict":"block"');
    expect(prompt).toContain('"comment":"Calendar sync stopped."');
    expect(prompt).toContain('Output JSON schema\n{"properties":{"reason":{"type":"string"},"route":{"enum":["block","team"]}},"type":"object"}');
    expect(skillFingerprint(skill)).toBe(createHash("sha256").update(prompt, "utf8").digest("hex"));
  });

  it("canonicalizes schema keys at every depth, including keys within schema arrays", () => {
    const schema = { allOf: [{ type: "object", properties: { one: { const: 1 }, two: { const: 2 } } }] };
    const reordered = { allOf: [{ properties: { two: { const: 2 }, one: { const: 1 } }, type: "object" }] };
    expect(renderSkillPrompt({ ...skill, outputSchema: reordered })).toBe(renderSkillPrompt({ ...skill, outputSchema: schema }));
  });

  it.each<[string, SkillDefinition]>([
    ["guideline order", { ...skill, guidelines: [...skill.guidelines].reverse() }],
    ["example order", { ...skill, examples: [...skill.examples].reverse() }],
    ["example verdict", { ...skill, examples: [{ ...skill.examples[0], verdict: "team" }, skill.examples[1]] }],
    ["example comment", { ...skill, examples: [{ ...skill.examples[0], comment: "The calendar stopped updating." }, skill.examples[1]] }],
    ["schema", { ...skill, outputSchema: false }],
    ["role", { ...skill, role: "confirm" }],
    ["revision", { ...skill, revision: "v2" }],
  ])("changes the fingerprint after a change to %s", (_field, changed) => {
    expect(skillFingerprint(changed)).not.toBe(skillFingerprint(skill));
  });
});

describe("package fingerprint", () => {
  it("ignores list order throughout the manifest and normalizes omitted proof", () => {
    const reordered: PackageManifest = {
      model: manifest.model,
      skills: [...manifest.skills].reverse(),
      scopes: [...manifest.scopes].reverse(),
      activeBlocks: [
        { ...block, blockId: "calendar-setup", resolutionProof: undefined },
        { ...block, skills: [...block.skills].reverse(), excludedNeighbours: [...block.excludedNeighbours].reverse(), sources: [...block.sources].reverse() },
      ],
    };
    const omitted = { ...manifest, activeBlocks: [block, { ...manifest.activeBlocks[1], resolutionProof: undefined }] };
    const { resolutionProof, ...withoutProof } = omitted.activeBlocks[1];
    expect(resolutionProof).toBeUndefined();
    expect(packageFingerprint({ ...omitted, activeBlocks: [block, withoutProof] })).toBe(packageFingerprint(reordered));
    expect(packageFingerprint(reordered)).toBe(packageFingerprint(manifest));
  });

  it.each<[string, Partial<PackageManifest>]>([
    ["active block catalogue", { activeBlocks: [block] }],
    ["model", { model: "model-v2" }],
    ["scope revision", { scopes: [{ ...manifest.scopes[0], revision: "v3" }, manifest.scopes[1]] }],
    ["skill revision", { skills: [{ ...manifest.skills[0], revision: "v2" }, manifest.skills[1]] }],
    ["skill prompt", { skills: [{ ...manifest.skills[0], promptFingerprint: skillFingerprint({ ...skill, guidelines: [] }) }, manifest.skills[1]] }],
  ])("binds the %s", (_field, change) => {
    expect(packageFingerprint({ ...manifest, ...change })).not.toBe(packageFingerprint(manifest));
  });

  it.each<[string, Partial<BlockManifest>]>([
    ["excluded neighbours", { excludedNeighbours: ["exports"] }],
    ["referenced skill revision", { skills: [{ ...block.skills[0], revision: "v2" }, block.skills[1]] }],
    ["exact source version", { sources: [{ ...block.sources[0], contentVersionId: "card-sync-v4" }, block.sources[1]] }],
    ["source usage", { sources: [{ ...block.sources[0], usage: "orient_only" }, block.sources[1]] }],
    ["source product version", { sources: [{ ...block.sources[0], productVersion: "all" }, block.sources[1]] }],
    ["block product version", { productVersion: 2 }],
    ["block family", { family: "access" }],
    ["proof revision", { resolutionProof: { ...block.resolutionProof, revision: "v2" } }],
    ["absent proof", { resolutionProof: undefined }],
  ])("binds the %s", (_field, change) => {
    expect(packageFingerprint({ ...manifest, activeBlocks: [{ ...block, ...change }, manifest.activeBlocks[1]] })).not.toBe(packageFingerprint(manifest));
  });
});
