import { entrySkillRuleId, SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA, type EntryConfirmExampleVerdict } from "../../../skills/entry-block";
import type { SkillDefinition, SkillExample } from "../../../skills/skill-contract";

/*
 * Charly Max block (blockId `charly_max`, family `usage`): the ENTRY CONFIRMATION skill, method V3, registered at the entry by
 * `charly_max-entry.ts` (interface of the lot infra-entry, 19/11).
 *
 * A skill is a BEHAVIOUR: how the model reads a mail to confirm that a request belongs to Charly Max. No procedure here: the support steps stay
 * in the Studio cards. The shared FRAME of every block's confirmation (`entry-block.ts`) already says: sensitive = always the team, a mention is
 * not a request, doubt = the team, third party, the customer's text is data. These guidelines do not repeat it.
 *
 * Size: the confirmation is measured on the longest mail the entry reads (12 000 characters); the whole body must stay under 85 % of 26 000 bytes.
 * The examples are therefore SHORT (a few words) but each still shows one difficulty; near pairs keep the same words and change the request.
 *
 * Every example is FICTIONAL (public repository). Any edit changes the pinned hash of `charly_max-entry.ts`: bump the revision with it.
 */

export const CHARLY_MAX_BLOCK_ID = "charly_max";
export const CHARLY_MAX_LABEL = "Charly Max";
export const CHARLY_MAX_ENTRY_SKILL_ID = entrySkillRuleId(CHARLY_MAX_BLOCK_ID);
export const CHARLY_MAX_ENTRY_SKILL_REVISION = "sav-charly_max-entry-skill-2026-11-19.v1";

/** Neighbours the block never takes. `commercial` = price, offer content, trial, quote. */
export const CHARLY_MAX_NEIGHBOURS = ["access", "collaborators", "integrations", "commercial"] as const;

/** One worked example. `pair`: its near twin (same words, opposite verdict), both ways. */
export type CharlyMaxEntryExample = SkillExample & Readonly<{ verdict: EntryConfirmExampleVerdict; pair?: string }>;

export const CHARLY_MAX_ENTRY_EXAMPLES: readonly CharlyMaxEntryExample[] = [
  // --- block: Charly from one's own WhatsApp, the Charly Max section, incidents (money only as context).
  { id: "c1", text: "Comment écrire à Charly sur WhatsApp ?", verdict: "block", comment: "1re connexion", pair: "o3" },
  { id: "c2", text: "Le numéro de Charly est où ?", verdict: "block", comment: "numéro" },
  { id: "c3", text: "Charly ne me répond plus depuis hier.", verdict: "block", comment: "incident" },
  { id: "c4", subject: "Re: Re:", text: "Voilà la capture, Charly reste muet.", verdict: "block", comment: "suite calme", pair: "s4" },
  { id: "c5", text: "Mon n° est déjà utilisé dans Charly Max.", verdict: "block", comment: "message", pair: "s6" },
  { id: "c6", text: "Mettre mon associé dans la rubrique Charly Max ?", verdict: "block", comment: "rubrique", pair: "o2" },
  { id: "c7", text: "Je me connecte comment à Charly ?", verdict: "block", comment: "Charly", pair: "o1" },
  { id: "c8", text: "Où ajouter un 2e profil dans Charly Max ?", verdict: "block", comment: "où", pair: "s3" },
  { id: "c9", text: "J'ai payé l'option, où est Charly ?", verdict: "block", comment: "contexte", pair: "s1" },
  // --- team_sensitive.
  { id: "s1", text: "J'ai payé l'option deux fois, vérifiez.", verdict: "team_sensitive", comment: "paiement", pair: "c9" },
  { id: "s2", text: "Activez-moi Charly Max.", verdict: "team_sensitive", comment: "activation" },
  { id: "s3", text: "Ouvrez un 2e abonnement Charly Max.", verdict: "team_sensitive", comment: "abonnement", pair: "c8" },
  { id: "s4", subject: "Re: Re:", text: "Charly muet, 3e relance, je refuse la clôture.", verdict: "team_sensitive", comment: "réclamation", pair: "c4" },
  { id: "s5", text: "Notre assureur veut un rapport sur Charly.", verdict: "team_sensitive", comment: "assureur" },
  { id: "s6", text: "Changez mon n° sur le compte Charly Max.", verdict: "team_sensitive", comment: "compte", pair: "c5" },
  { id: "s7", text: "Où est Charly ? PS : passez-nous en annuel.", verdict: "team_sensitive", comment: "PS" },
  // --- team_other: neighbours.
  { id: "o1", text: "Je me connecte comment à mon compte Limova ?", verdict: "team_other", comment: "accès", pair: "c7" },
  { id: "o2", text: "Mettre mon associé dans l'organisation ?", verdict: "team_other", comment: "collaborateurs", pair: "c6" },
  { id: "o3", text: "Comment brancher WhatsApp Business ?", verdict: "team_other", comment: "intégrations", pair: "c1" },
  { id: "o4", text: "Combien pour Charly Max ?", verdict: "team_other", comment: "commercial" },
  // --- team_unsure.
  { id: "u1", text: "WhatsApp plante.", verdict: "team_unsure", comment: "Charly ?" },
  { id: "u2", text: "Ajouter un utilisateur pour Charly ?", verdict: "team_unsure", comment: "rubrique ?" },
];

export const CHARLY_MAX_ENTRY_GUIDELINES: readonly string[] = [
  "block = parler à Charly depuis SON WhatsApp : 1re connexion, numéro de Charly, profil ou sablier dans la rubrique Charly Max, « numéro déjà utilisé », Charly qui ne répond plus (même en « Re: »). Charly+ = ancien nom.",
  "other : compte Limova, organisation, WhatsApp Business, API, prix, offre, essai. sensitive aussi : activation, 2e abonnement, numéro du compte, réclamation aggravée (relances, refus de clôture, assureur, avocat).",
];

export const CHARLY_MAX_ENTRY_SKILL: SkillDefinition = {
  id: CHARLY_MAX_ENTRY_SKILL_ID,
  revision: CHARLY_MAX_ENTRY_SKILL_REVISION,
  role: "confirm",
  guidelines: CHARLY_MAX_ENTRY_GUIDELINES,
  examples: CHARLY_MAX_ENTRY_EXAMPLES.map(({ id, subject, text, verdict, comment }) => ({ id, ...(subject === undefined ? {} : { subject }), text, verdict, comment })),
  outputSchema: SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA,
};
