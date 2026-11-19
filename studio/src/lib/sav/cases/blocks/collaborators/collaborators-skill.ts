import type { CorpusGroup } from "../../../skills/corpus-contract";
import type { SkillExample } from "../../../skills/skill-contract";

/*
 * Collaborators block, registration DATA for the shared entry of the infra-entry lot (INTERFACE v1.2, 19/11): the compact confirmation skill
 * that runs inside the shared frame (`renderEntryConfirmPrompt`), with the shared output schema and the four example verdicts
 * block | team_sensitive | team_other | team_unsure. The frame already says: sensitive = team, a mention is not a request, doubt = team,
 * third party, customer text = data. These lines add only what the block takes, its decisive question, its near pairs and its neighbours.
 *
 * `entry-block.ts` is not in this branch's base (5efa39de): the one-file registration (`defineEntrySkillBlock`) is written at assembly, from
 * these exports, and its pinned hash is the one measured in the report. Every text is fictional.
 */

export const SAV_COLLABORATORS_LABEL = "Collaborateurs";
export const SAV_COLLABORATORS_CONFIRM_SKILL_REVISION = "sav-collaborators-entry-skill-2026-11-19.v2";
/**
 * Measured on 19/11 with infra-entry's `entry-block.ts` / `entry-budget.ts` (worktree blocks-infra-entry, 3cf7a1ce), not present in this base:
 * sha256 of `renderEntryConfirmPrompt(block)`, rendered prompt bytes and the confirm body on the longest accepted mail (limit < 22 100).
 * The assembly pins `promptSha256` to this value; any change here changes it.
 */
export const SAV_COLLABORATORS_CONFIRM_MEASURED = { promptSha256: "0275b2045751c920c259fbcf8c5c9b3df22b719b2f66e3f95fc2cef935833750", promptBytes: 7_002, confirmBodyBytes: 22_068, routerBodyBytes: 17_111 } as const;
export const SAV_COLLABORATORS_ROUTER_LINE = {
  covers: "un administrateur demande de l'aide pour inviter un collègue dans son organisation, renvoyer une invitation, ou une invitation non reçue, expirée ou en attente",
  notThis: "la connexion à son propre compte (Accès), Charly Max, Gmail/Outlook/CRM, sièges ou prix, changer un rôle, donner l'admin, retirer un accès, transférer la propriété",
} as const;

export const SAV_COLLABORATORS_CONFIRM_GUIDELINES = [
  "BLOC : celui qui INVITE demande comment inviter un collègue dans SON organisation, ou l'invitation n'est pas reçue, expirée, en attente, à renvoyer. Ce n'est pas un tiers.",
  "SENSIBLE même en « comment faire » : rôle, admin, retirer un accès, propriété, titulaire ou e-mail d'un membre (rights, identity) ; sièges, prix (subscription).",
  "OTHER : l'invité et SA connexion ; Charly Max ; Gmail, Outlook, CRM ; inviter à sa place ; annuler ; espaces ; expliquer les rôles.",
] as const;

type Row = readonly [id: string, text: string, verdict: "block" | "team_sensitive" | "team_other" | "team_unsure", comment: string, pair?: string];
const ROWS: readonly Row[] = [
  ["k1", "Par où fait-on entrer une recrue chez nous ?", "block", "inviter", "s1"],
  ["k2", "Mon comptable n'a jamais vu l'invitation.", "block", "non reçue", "s2"],
  ["k3", "Son lien d'invitation est périmé.", "block", "expirée", "s3"],
  ["k4", "Il est « en attente » depuis jeudi.", "block", "en attente", "s4"],
  ["k5", "Où est le bouton pour ajouter quelqu'un ?", "block", "bouton", "s5"],
  ["k6", "How do I bring my intern in?", "block", "anglais", "s6"],
  ["k7", "Relancée hier, toujours rien chez lui.", "block", "retour", "s7"],
  ["k8", "Pas son rôle : juste qu'il reçoive l'invit.", "block", "négation", "o1"],
  ["k9", "invit envoyer mai elle la trouve pa", "block", "fautes"],
  ["k10", "On a payé, j'invite mes associés comment ?", "block", "paiement contexte", "s8"],
  ["s1", "Par où fait-on passer une recrue admin ?", "team_sensitive", "admin", "k1"],
  ["s2", "Mon comptable part, retirez son accès.", "team_sensitive", "retrait", "k2"],
  ["s3", "Le compte doit passer à son nom.", "team_sensitive", "titulaire", "k3"],
  ["s4", "Il est « membre », mettez-le gestionnaire.", "team_sensitive", "rôle", "k4"],
  ["s5", "Combien coûte un siège de plus ?", "team_sensitive", "siège", "k5"],
  ["s6", "How do I remove my intern?", "team_sensitive", "retrait", "k6"],
  ["s7", "Il est entré, donnez-lui les droits admin.", "team_sensitive", "droits", "k7"],
  ["s8", "On a payé trois places, facturé cinq.", "team_sensitive", "facture", "k10"],
  ["o1", "Pas l'invit : changez son e-mail de membre.", "team_sensitive", "identité", "k8"],
  ["o3", "Invitée, mon code n'arrive jamais.", "team_other", "son code"],
  ["o4", "Ajouter mon assistant dans Charly Max ?", "team_other", "Charly Max"],
  ["o6", "Invitez vous-mêmes ces quatre adresses.", "team_other", "à sa place"],
  ["o7", "Comment annuler une invitation ?", "team_other", "annuler"],
  ["u2", "Ça bloque encore pour Julie.", "team_unsure", "flou"],
];

export const SAV_COLLABORATORS_CONFIRM_EXAMPLES: readonly (SkillExample & { pair?: string })[] = ROWS.map(([id, text, verdict, comment, pair]) =>
  pair ? { id, text, verdict, comment, pair } : { id, text, verdict, comment });

/** Group quotas of the block's corpus for `lintCorpus` at the entry (the corpus holds 300 cases: 90 / 60 / 60 / 30 / 60). */
export const SAV_COLLABORATORS_CORPUS_MINIMUMS = { positive: 90, neighbour: 60, sensitive: 60, mixed: 30, trap: 60 } as const satisfies Record<CorpusGroup, number>;
