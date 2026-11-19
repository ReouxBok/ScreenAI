import { defineEntrySkillBlock, entrySkillRuleId, SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA } from "../../../skills/entry-block";
import type { SkillDefinition } from "../../../skills/skill-contract";
import { SAV_COLLABORATORS_CORPUS } from "./collaborators-corpus.fixture";
import { SAV_COLLABORATORS_BLOCK_ID } from "./collaborators-entry-skill";
import { SAV_COLLABORATORS_BLOCK_MANIFEST } from "./collaborators-manifest";
import {
  SAV_COLLABORATORS_CONFIRM_EXAMPLES, SAV_COLLABORATORS_CONFIRM_GUIDELINES, SAV_COLLABORATORS_CONFIRM_SKILL_REVISION, SAV_COLLABORATORS_CORPUS_MINIMUMS,
  SAV_COLLABORATORS_LABEL, SAV_COLLABORATORS_ROUTER_LINE,
} from "./collaborators-skill";

/*
 * Collaborators block: its REGISTRATION at the entry (INTERFACE.md of the infra-entry lot), written at the assembly (19/11) from the block's own data
 * (`collaborators-skill.ts`, unchanged). Data only. Arrives `off`: the mode is set only by `SAV_V2_ENTRY_BLOCKS_JSON`, and the block admits nobody until
 * Ugo approves the rule `collaborators-entry-skill` at this revision in the admission policy. Family `usage` (shared with Charly Max).
 * The examples are rendered with id, text, verdict and comment only (`renderSkillPrompt`); their `pair` metadata stays out of the prompt.
 */

export const SAV_COLLABORATORS_CONFIRM_SKILL: SkillDefinition = {
  id: entrySkillRuleId(SAV_COLLABORATORS_BLOCK_ID),
  revision: SAV_COLLABORATORS_CONFIRM_SKILL_REVISION,
  role: "confirm",
  guidelines: SAV_COLLABORATORS_CONFIRM_GUIDELINES,
  examples: SAV_COLLABORATORS_CONFIRM_EXAMPLES,
  outputSchema: SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA,
};

export const COLLABORATORS_ENTRY_BLOCK = defineEntrySkillBlock({
  blockId: SAV_COLLABORATORS_BLOCK_ID,
  family: "usage",
  label: SAV_COLLABORATORS_LABEL,
  manifest: SAV_COLLABORATORS_BLOCK_MANIFEST,
  router: SAV_COLLABORATORS_ROUTER_LINE,
  skill: SAV_COLLABORATORS_CONFIRM_SKILL,
  /** sha256 of `renderEntryConfirmPrompt(COLLABORATORS_ENTRY_BLOCK)`: the value measured by the block's lot (SAV_COLLABORATORS_CONFIRM_MEASURED). */
  promptSha256: "0275b2045751c920c259fbcf8c5c9b3df22b719b2f66e3f95fc2cef935833750",
  corpus: SAV_COLLABORATORS_CORPUS,
  corpusMinimums: SAV_COLLABORATORS_CORPUS_MINIMUMS,
  initialMode: "off",
});
