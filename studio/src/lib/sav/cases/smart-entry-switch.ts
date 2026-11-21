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
 * la main sur le sensible. Un ticket sans aucun contact va à l'équipe (`crm_missing_primary`).
 * N8 (SAV-123) : un cas admis est décidé par le cerveau smart (`smart/smart-case-provider.ts`), sans périmètre pilote (`smart-support-scope.ts`) ; un ticket
 * sans fil de mail va à l'équipe (`smart_no_thread`).
 *
 * `SAV_V2_ENTRY_SMART=on` is the ONLY value that switches it on (like `smart-switch.ts`). Absent, empty or any other value (`ON`, `true`, `shadow`...): off,
 * and the entry is exactly the block entry it was. Nothing else reads this switch: the admission decision recognises a smart admission by its provenance.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_ENTRY_SMART_ENV = "SAV_V2_ENTRY_SMART";
export const savV2EntrySmartOn = (env: Env) => env[SAV_V2_ENTRY_SMART_ENV] === "on";
/** SAV-123 (N8): the smart block may be approved by the rule only with `SAV_V2_SMART_SUPPORT_MODE=auto` (exactly); read by the block switch and at the send fence. */
export const SAV_V2_SMART_SUPPORT_MODE_ENV = "SAV_V2_SMART_SUPPORT_MODE";
export const savV2SmartSupportAuto = (env: Env) => env[SAV_V2_SMART_SUPPORT_MODE_ENV] === "auto";

// The label, policy revision and provenance of a smart admission live with the case types (the pure admission rule imports nothing else).
export {
  isSmartSupportProvenance, SAV_SMART_ENTRY_ADMISSION, SAV_SMART_NO_THREAD_WAIT, SAV_SMART_ENTRY_BLOCK_ID, SAV_SMART_ENTRY_FAMILY, SAV_SMART_ENTRY_POLICY_REVISION, SAV_SMART_ENTRY_RULE_ID,
  smartSupportProvenance,
} from "./case-types";

/** SAV-118 (N5): the wait reason of a HubSpot ticket handed to the agent with no contact at all (no primary record), switch on only. Nothing is invented: the
 * ticket goes back to the team with this reason, through the existing hand-over (stage « Nouveau », no owner, one short note). */
export const SAV_SMART_ENTRY_MISSING_PRIMARY = "crm_missing_primary";
