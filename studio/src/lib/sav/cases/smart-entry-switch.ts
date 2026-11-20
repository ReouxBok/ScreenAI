/*
 * SAV-117 (N4, Ugo 20/11): the new entry of the Agent SAV, behind `SAV_V2_ENTRY_SMART`. Pure: reads only the values given.
 *
 * Contrat V1 → V2 (interrupteur allumé), en 5 lignes :
 *   1. V1 garantit : le mail est classé, chaque demande a un type (`support`, `finance`, `cancellation`...), le ticket HubSpot est créé ou rattaché.
 *   2. V2 vérifie encore : ticket rattaché et confirmé par V1, mail stocké, identité confirmée, contexte CRM complet.
 *   3. V2 vérifie encore : toutes les demandes du mail sont `support` (1 à 4), aucune finance ni résiliation ; sinon tout le mail va à l'équipe.
 *   4. V2 ne vérifie plus : le bloc détecté (Accès seul), la liste de mots `sensitive-words.ts`, la politique `SAV_V2_ADMISSION_POLICY_JSON`.
 *   5. La sensibilité et l'énervement du client sont jugés ensuite par le cerveau smart (N8), jamais par une liste de mots à l'entrée.
 *
 * Tickets attribués à l'Agent SAV dans HubSpot (SAV-118, N5) : même porte. Pas de tri V1 sur un ticket ; la lecture du cerveau smart classe la demande et passe
 * la main sur le sensible. Un ticket sans aucun contact va à l'équipe (`crm_missing_primary`). Avant N8, un ticket admis attend : ni dossier, ni restitution.
 *
 * `SAV_V2_ENTRY_SMART=on` is the ONLY value that switches it on (like `smart-switch.ts`). Absent, empty or any other value (`ON`, `true`, `shadow`...): off,
 * and the entry is exactly the block entry it was. Nothing else reads this switch: the admission decision recognises a smart admission by its provenance.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_ENTRY_SMART_ENV = "SAV_V2_ENTRY_SMART";
export const savV2EntrySmartOn = (env: Env) => env[SAV_V2_ENTRY_SMART_ENV] === "on";

// The label, policy revision and provenance of a smart admission live with the case types (the pure admission rule imports nothing else).
export {
  isSmartSupportProvenance, SAV_SMART_ENTRY_ADMISSION, SAV_SMART_ENTRY_BLOCK_ID, SAV_SMART_ENTRY_FAMILY, SAV_SMART_ENTRY_POLICY_REVISION, SAV_SMART_ENTRY_RULE_ID,
  smartSupportProvenance,
} from "./case-types";

/** SAV-118 (N5): the wait reason of a HubSpot ticket handed to the agent with no contact at all (no primary record), switch on only. Nothing is invented: the
 * ticket goes back to the team with this reason, through the existing hand-over (stage « Nouveau », no owner, one short note). */
export const SAV_SMART_ENTRY_MISSING_PRIMARY = "crm_missing_primary";

/**
 * SAV-117 review 1F — THE central hold of external effects before N8 (TO REMOVE IN N8, here only: make it return null, then drop its call sites).
 * While `SAV_V2_ENTRY_SMART=on` and the smart brain is not wired, no external effect of the Agent SAV leaves: no hand-back of a HubSpot-assigned ticket
 * (`owner-handover.ts`), no Gmail send nor HubSpot write of the case effects executor (`runCaseEffectsPass`: thread replies, first mail of a ticket, CRM
 * journal, summary note) nor of the ticket stage executor (`runCaseTicketStagePass`). Each executor stops BEFORE claiming or marking anything, with this
 * reason: nothing is consumed, nothing irreversible is written, the work stays due. It is a guard against an accidental switch-on, not a filter.
 * Off: null, every executor exactly as before.
 */
export const SAV_SMART_ENTRY_EFFECTS_HOLD = "smart_entry_awaiting_n8";
export const smartEntryEffectsHold = (env: Env): typeof SAV_SMART_ENTRY_EFFECTS_HOLD | null => savV2EntrySmartOn(env) ? SAV_SMART_ENTRY_EFFECTS_HOLD : null;
