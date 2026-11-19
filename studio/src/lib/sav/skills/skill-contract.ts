import { createHash } from "node:crypto";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

export type SkillRole = "entry" | "confirm" | "decision" | "writing" | "closure" | "followup";

export type SkillExample = Readonly<{
  id: string;
  subject?: string;
  text: string;
  verdict: string;
  comment: string;
}>;

export type SkillRevision = Readonly<{ id: string; revision: string }>;

export type SkillDefinition = SkillRevision & Readonly<{
  role: SkillRole;
  guidelines: readonly string[];
  examples: readonly SkillExample[];
  outputSchema: JsonObject | boolean;
}>;

export type ProductVersion = 2 | 3 | "all";

export type BlockSource = Readonly<{
  sourceId: string;
  contentVersionId: string;
  usage: "answer" | "orient_only";
  productVersion: ProductVersion;
}>;

export type BlockManifest = Readonly<{
  blockId: string;
  /** `access` is the Access block's alone; `integration` (19/11) is the Integrations block's own family; other blocks share `usage`. */
  family: "usage" | "access" | "integration";
  skills: readonly SkillRevision[];
  excludedNeighbours: readonly string[];
  sources: readonly BlockSource[];
  /** Identifies the versioned proof rule. Omit it to disable automatic closure for this block. */
  resolutionProof?: Readonly<{ id: string; revision: string }>;
  productVersion: ProductVersion;
}>;

export type PackageManifest = Readonly<{
  activeBlocks: readonly BlockManifest[];
  skills: readonly (SkillRevision & Readonly<{ promptFingerprint: string }>)[];
  model: string;
  scopes: readonly Readonly<{ id: string; revision: string }>[];
}>;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Guidelines and examples keep their authored order. JSON schema object keys have a canonical order. */
export function renderSkillPrompt(skill: SkillDefinition): string {
  const examples = skill.examples.map(({ id, subject, text, verdict, comment }) =>
    canonicalJson({ id, ...(subject === undefined ? {} : { subject }), text, verdict, comment }));
  return [
    `Skill ${JSON.stringify(skill.id)} (${skill.role}, revision ${JSON.stringify(skill.revision)})`,
    "Guidelines",
    ...skill.guidelines,
    "Fictional examples",
    ...examples,
    "Output JSON schema",
    canonicalJson(skill.outputSchema),
  ].join("\n");
}

export function skillFingerprint(skill: SkillDefinition): string {
  return sha256(renderSkillPrompt(skill));
}

/** Manifest lists are unordered. Each skill's prompt fingerprint pins its ordered prompt content. */
export function packageFingerprint(manifest: PackageManifest): string {
  const sorted = (entries: readonly JsonValue[]) => entries.map(canonicalJson).sort();
  const revisionOf = ({ id, revision }: SkillRevision) => ({ id, revision });
  const activeBlocks = manifest.activeBlocks.map(block => ({
    blockId: block.blockId,
    family: block.family,
    productVersion: block.productVersion,
    skills: sorted(block.skills.map(revisionOf)),
    sources: sorted(block.sources.map(({ sourceId, contentVersionId, usage, productVersion }) =>
      ({ sourceId, contentVersionId, usage, productVersion }))),
    excludedNeighbours: [...block.excludedNeighbours].sort(),
    resolutionProof: block.resolutionProof ? revisionOf(block.resolutionProof) : null,
  }));
  return sha256(canonicalJson({
    activeBlocks: sorted(activeBlocks),
    skills: sorted(manifest.skills.map(skill => ({ ...revisionOf(skill), promptFingerprint: skill.promptFingerprint }))),
    model: manifest.model,
    scopes: sorted(manifest.scopes.map(revisionOf)),
  }));
}
