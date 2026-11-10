/** Night V1 (A): named causes of `applyExternalCompletion` refusing an administrative completion (pure labels,
 * shared by the console page and the MCP; the reader lives in external-completion.ts). No customer data. */
export const savCompletionBlockerLabels = {
  human_action: "Une action humaine historique (ticket, réponse, transfert ou occupation) est partie sans résultat vérifié.",
  human_command: "Une commande humaine Studio est encore en attente ou en lecture.",
  intake_effect: "Un effet du moteur sur ce fil (peut-être sur un message précédent) reste à rapprocher.",
  active_worker: "Un traitement automatique détient encore ce dossier.",
  // Night V1 cycle 1 (M-5): the blocker read failed; fail closed (not offered), the page stays readable.
  unreadable: "Les blocages de clôture n’ont pas pu être lus : passage en Terminés non proposé, aucune absence de blocage affirmée.",
} as const;
export type SavCompletionBlocker = keyof typeof savCompletionBlockerLabels;
/** Night V1 cycle 1 (I-1): the refusals `applyExternalCompletion` checks BEFORE the blockers, for one message. */
export const savCompletionPrecheckLabels = {
  new_inbound: "Un message plus récent est arrivé sur ce fil : relire le dossier avant de décider.",
  after_boundary: "Le message est daté après l’instant de la demande (horloge) : relire avant de réessayer.",
  not_live_eligible: "Ce message est hors du périmètre actif (avant la bascule, autre boîte, ou message pilote) : la clôture administrative ne s’applique pas.",
  technical_exclusion: "Ce message est classé technique (spam, réponse automatique, rebond, notification interne ou doublon) : il ne passe pas en Terminés comme traité.",
} as const;
export type SavCompletionPrecheck = keyof typeof savCompletionPrecheckLabels;
/** MCP refusal code per server refusal reason (source_changed stays SAV_MCP_DOSSIER_CHANGED: a version guard re-read under lock at action time). */
export const savCompletionPrecheckCodes: Record<SavCompletionPrecheck, string> = {
  new_inbound: "SAV_MCP_NEW_INBOUND", after_boundary: "SAV_MCP_AFTER_BOUNDARY",
  not_live_eligible: "SAV_MCP_NOT_LIVE_ELIGIBLE", technical_exclusion: "SAV_MCP_TECHNICAL_EXCLUSION",
};
