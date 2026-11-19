import type { EntrySkillBlock } from "../../skills/entry-block";

/*
 * The blocks with a skill known to the ENTRY (chantier « 3 blocs », 19/11). Pure data. Adding a block = its folder `blocks/<blockId>/` (skill, corpus,
 * manifest, registration `<blockId>-entry.ts`, tests) and ONE line here. A registered block is `off` until the entry switch
 * (`SAV_V2_ENTRY_BLOCKS_JSON`) names it, and admits nobody until its rule `<blockId>-entry-skill` at its revision is configured and approved.
 * Access is not listed: it is the built-in instance (its own skill `access-skill/`, its own switch `SAV_V2_ACCESS_SKILL`).
 */
export const SAV_ENTRY_SKILL_BLOCKS: readonly EntrySkillBlock[] = [];
