import { defineEntrySkillBlock } from "../../../skills/entry-block";
import { CHARLY_MAX_CORPUS, CHARLY_MAX_CORPUS_MINIMUMS } from "./charly-max-corpus.fixture";
import { CHARLY_MAX_MANIFEST } from "./charly-max-manifest";
import { CHARLY_MAX_BLOCK_ID, CHARLY_MAX_ENTRY_SKILL, CHARLY_MAX_LABEL } from "./charly-max-skill-entry";

/*
 * Charly Max block: its REGISTRATION at the entry (interface of the lot infra-entry, `/private/tmp/sav-blocks-20261119/INTERFACE.md` v1.2).
 * Data only. Listed in `cases/blocks/registry.ts` since the assembly (19/11). Arrives `off`; admits nobody until the switch names it
 * and Ugo approves the rule `charly_max-entry-skill` at this revision.
 */
export const CHARLY_MAX_ENTRY_BLOCK = defineEntrySkillBlock({
  blockId: CHARLY_MAX_BLOCK_ID,
  family: "usage",
  label: CHARLY_MAX_LABEL,
  manifest: CHARLY_MAX_MANIFEST,
  router: {
    covers: "parler à Charly depuis son WhatsApp : première connexion, numéro de Charly, profil ou sablier dans la rubrique Charly Max, Charly qui ne répond plus",
    notThis: "connexion au compte Limova, inviter dans l'organisation, WhatsApp Business ou API, prix ou activation de l'offre, réclamation aggravée",
  },
  skill: CHARLY_MAX_ENTRY_SKILL,
  /** sha256 of `renderEntryConfirmPrompt(CHARLY_MAX_ENTRY_BLOCK)`. Pinned by `charly_max-entry.test.ts`; change it only with the revision. */
  promptSha256: "388d1caf51eda26149b2685a84564f9cbaa84dd61b57ab02697329f91a591f47",
  corpus: CHARLY_MAX_CORPUS,
  corpusMinimums: CHARLY_MAX_CORPUS_MINIMUMS,
  initialMode: "off",
});
