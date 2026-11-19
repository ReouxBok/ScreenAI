import { defineEntrySkillBlock } from "../../../skills/entry-block";
import { SAV_INTEGRATIONS_CORPUS, SAV_INTEGRATIONS_CORPUS_MINIMUMS, SAV_INTEGRATIONS_CORPUS_REQUEST_WORDS } from "./integrations-corpus.fixture";
import { SAV_INTEGRATIONS_ENTRY_LABEL, SAV_INTEGRATIONS_ENTRY_SKILL, SAV_INTEGRATIONS_ROUTER_LINE } from "./integrations-entry-skill";
import { SAV_INTEGRATIONS_MANIFEST } from "./integrations-manifest";
import { SAV_INTEGRATIONS_BLOCK_ID } from "./integrations-scope";

/*
 * Block « Intégrations »: its REGISTRATION at the entry of the SAV agent (INTERFACE.md v1.2 of the infra-entry lot). Data only. Listed in
 * `cases/blocks/registry.ts` since the assembly (19/11), family `integration` (root decision). Arrives `off`; the mode is set only by `SAV_V2_ENTRY_BLOCKS_JSON`.
 */
export const INTEGRATIONS_ENTRY_BLOCK = defineEntrySkillBlock({
  blockId: SAV_INTEGRATIONS_BLOCK_ID,
  family: "integration",
  label: SAV_INTEGRATIONS_ENTRY_LABEL,
  manifest: SAV_INTEGRATIONS_MANIFEST,
  router: SAV_INTEGRATIONS_ROUTER_LINE,
  skill: SAV_INTEGRATIONS_ENTRY_SKILL,
  /** sha256 of `renderEntryConfirmPrompt(INTEGRATIONS_ENTRY_BLOCK)` (shared frame + this skill). Change it only with the revision. */
  promptSha256: "17d7e34753f5c3bbeab6fd30aac4ebff9ef6cc6a2a7fbed03ccad0b563efcd98",
  corpus: SAV_INTEGRATIONS_CORPUS,
  corpusMinimums: SAV_INTEGRATIONS_CORPUS_MINIMUMS,
  corpusRequestWords: SAV_INTEGRATIONS_CORPUS_REQUEST_WORDS,
  initialMode: "off",
});
