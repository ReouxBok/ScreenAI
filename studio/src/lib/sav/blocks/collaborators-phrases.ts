import type { SavBlockTestPhrase } from "./block-attribution";

/** Synthetic fixtures only. Expected collaborators means advice scope, never a rights grant. */
export type CollaboratorsTestPhrase = SavBlockTestPhrase & Readonly<{
  id: string; split: "index" | "holdout"; expected: "collaborators" | "access" | "integrations" | "team";
}>;

/** Holdout wording and labels must not feed the index or threshold calibration. */
export const SAV_COLLABORATORS_TEST_PHRASES: readonly CollaboratorsTestPhrase[] = [
  { id: "c01", split: "index", kind: "positive", expected: "collaborators", text: "Comment inviter un collaborateur dans mon espace de travail ?" },
  { id: "c02", split: "index", kind: "positive", expected: "collaborators", text: "L'invitation de mon collaborateur n'est pas arrivée, que vérifier ?" },
  { id: "c03", split: "index", kind: "positive", expected: "collaborators", text: "Le lien d'invitation du collaborateur a expiré, quelle est la procédure ?" },
  { id: "c04", split: "index", kind: "positive", expected: "collaborators", text: "Où le collaborateur doit-il saisir son code d'invitation ?" },
  { id: "c05", split: "index", kind: "positive", expected: "collaborators", text: "Après mon invitation, je vois le mauvais espace de travail." },
  { id: "c06", split: "index", kind: "positive", expected: "collaborators", text: "Comment vérifier l'espace de travail associé à une invitation ?" },
  { id: "c07", split: "index", kind: "positive", expected: "collaborators", text: "Quelle différence entre les rôles proposés pour un collaborateur ?" },
  { id: "c08", split: "index", kind: "positive", expected: "collaborators", text: "Où consulter les permissions de mon rôle dans cet espace de travail ?" },
  { id: "c09", split: "index", kind: "positive", expected: "collaborators", text: "Quelle procédure suivre pour retirer un collaborateur de cet espace ?" },
  { id: "c10", split: "index", kind: "positive", expected: "collaborators", text: "Comment vérifier si l'invitation d'un collaborateur est encore en attente ?" },
  { id: "c11", split: "index", kind: "neighbour", expected: "access", text: "Je ne reçois pas le code de connexion à mon compte Limova." },
  { id: "c12", split: "index", kind: "neighbour", expected: "access", text: "Le lien de connexion à mon compte Limova a expiré." },
  { id: "c13", split: "index", kind: "neighbour", expected: "integrations", text: "La connexion de ma boîte Gmail échoue malgré une reconnexion." },
  { id: "c14", split: "index", kind: "neighbour", expected: "team", text: "Comment est calculée la facturation par siège ?" },
  { id: "c15", split: "index", kind: "neighbour", expected: "team", text: "Je souhaite supprimer mon compte définitivement." },
  { id: "c16", split: "index", kind: "neighbour", expected: "team", text: "Où trouver la documentation de l'API ?" },
  { id: "c17", split: "index", kind: "trap", expected: "team", text: "Comment inviter un collaborateur et obtenir un remboursement du siège ?" },
  { id: "c18", split: "index", kind: "trap", expected: "team", text: "Je ne reçois pas le code de connexion à mon compte Limova. Je veux aussi inviter un collaborateur." },
  { id: "c19", split: "index", kind: "trap", expected: "team", text: "Le lien d'invitation a expiré et la connexion Outlook échoue aussi." },
  { id: "c20", split: "index", kind: "trap", expected: "team", text: "Changez les droits du collaborateur et retirez le propriétaire de l'espace." },
  { id: "h01", split: "holdout", kind: "positive", expected: "collaborators", text: "L'ajout d'un collaborateur reste en attente sans invitation reçue." },
  { id: "h02", split: "holdout", kind: "positive", expected: "collaborators", text: "Le code d'invitation du collaborateur est indiqué comme périmé." },
  { id: "h03", split: "holdout", kind: "positive", expected: "collaborators", text: "Mon invitation ouvre un autre espace de travail que celui attendu." },
  { id: "h04", split: "holdout", kind: "positive", expected: "collaborators", text: "Je cherche une explication des permissions du rôle de collaborateur." },
  { id: "h05", split: "holdout", kind: "positive", expected: "collaborators", text: "Où lire la procédure de retrait d'un membre de mon espace de travail ?" },
  { id: "h06", split: "holdout", kind: "neighbour", expected: "access", text: "Le code de connexion à mon compte Limova ne fonctionne pas." },
  { id: "h07", split: "holdout", kind: "neighbour", expected: "integrations", text: "Comment connecter Shopify à mon agent ?" },
  { id: "h08", split: "holdout", kind: "neighbour", expected: "team", text: "Mon webhook API ne reçoit aucun événement." },
  { id: "h09", split: "holdout", kind: "trap", expected: "team", text: "Je veux retirer un collaborateur et supprimer mon compte." },
  { id: "h10", split: "holdout", kind: "trap", expected: "team", text: "L'invitation n'arrive pas et je conteste la facture des sièges." },
];

/** Offline index input only; nothing here publishes knowledge or registers the block. */
export const SAV_COLLABORATORS_INDEX_PHRASES = SAV_COLLABORATORS_TEST_PHRASES.filter(row => row.split === "index");
