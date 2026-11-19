import { SAV_ACCESS_SKILL_PROMPT_SHA256, SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID, accessSkillCounterReadPrompt } from "../cases/access-skill/access-skill-guidelines";
import { createHash } from "node:crypto";
import type { EntryCatalog } from "./entry-decision";
import { entrySkillRuleId } from "./entry-block";
import { entryRouterAccessLine, entryRouterLineOf, entryRouterPromptSha256, SAV_ENTRY_ROUTER_ID, SAV_ENTRY_ROUTER_REVISION } from "./entry-router";
import { packageFingerprint, type BlockManifest, type PackageManifest } from "./skill-contract";

/*
 * The « paquet » of one entry (METHODE_BLOCS_V3 §1): the whole composition that decides a mail, versioned by ONE sha256 (N3 `packageFingerprint`):
 * the catalog (each block's manifest), every prompt at its revision (router with its rendered catalog, each block's confirmation, Access's judge and
 * counter-read pin, the shared counter-read) and the model. Every stored reading of the entry is bound to it: another composition is another reading.
 */

const ACCESS_MANIFEST: BlockManifest = { blockId: "access", family: "access", productVersion: "all", skills: [{ id: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION }], excludedNeighbours: [], sources: [] };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function entryPackageManifest(catalog: EntryCatalog, model: string): PackageManifest {
  const lines = [...(catalog.access ? [entryRouterAccessLine()] : []), ...catalog.blocks.map(entryRouterLineOf)];
  return {
    activeBlocks: [...(catalog.access ? [ACCESS_MANIFEST] : []), ...catalog.blocks.map(block => block.manifest)],
    skills: [
      ...(lines.length >= 2 ? [{ id: SAV_ENTRY_ROUTER_ID, revision: SAV_ENTRY_ROUTER_REVISION, promptFingerprint: entryRouterPromptSha256(lines) }] : []),
      ...(catalog.access ? [{ id: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION, promptFingerprint: SAV_ACCESS_SKILL_PROMPT_SHA256 }] : []),
      ...catalog.blocks.map(block => ({ id: entrySkillRuleId(block.blockId), revision: block.skill.revision, promptFingerprint: block.promptSha256 })),
      ...(catalog.blocks.length ? [{ id: "entry-counter-read", revision: SAV_ACCESS_SKILL_REVISION, promptFingerprint: sha256(accessSkillCounterReadPrompt()) }] : []),
    ],
    model,
    scopes: [],
  };
}
export const entryPackageSha256 = (catalog: EntryCatalog, model: string) => packageFingerprint(entryPackageManifest(catalog, model));
