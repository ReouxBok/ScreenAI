import type { SavBlockTestPhrase } from "./block-attribution";
import type { FollowupsDecision } from "./followups-decision";

/** Synthetic only. Expected actions assume a full review and proven resolution of all known needs.
 * These are evaluation labels, never evidence that a real customer's needs have been resolved.
 */
export type FollowupsTestPhrase = SavBlockTestPhrase & Readonly<{
  id: string; split: "index" | "holdout"; expected: FollowupsDecision["action"]; access: boolean;
}>;
export const SAV_FOLLOWUPS_TEST_PHRASES: readonly FollowupsTestPhrase[] = [
  {"id": "f01", "split": "index", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Merci."},
  {"id": "f02", "split": "index", "kind": "positive", "expected": "close_proposal", "access": false, "text": "C’est bon merci !"},
  {"id": "f03", "split": "index", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Merci beaucoup."},
  {"id": "f04", "split": "index", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Tout fonctionne merci."},
  {"id": "f05", "split": "index", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Bien reçu merci."},
  {"id": "f06", "split": "index", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Accusé de réception."},
  {"id": "f07", "split": "index", "kind": "positive", "expected": "no_action", "access": false, "text": "Je reviens vers vous."},
  {"id": "f08", "split": "index", "kind": "positive", "expected": "no_action", "access": false, "text": "Je vous tiens au courant."},
  {"id": "f09", "split": "index", "kind": "positive", "expected": "no_action", "access": false, "text": "Pas de nouvelles."},
  {"id": "f10", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci mais toujours bloqué."},
  {"id": "f11", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci, et sinon pour la facture…"},
  {"id": "f12", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci, je résilie."},
  {"id": "f13", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Bien reçu, mais rien ne fonctionne."},
  {"id": "f14", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci pour votre aide. Pouvez-vous aussi connecter Shopify ?"},
  {"id": "f15", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci. Cordialement. PS : je demande un remboursement."},
  {"id": "f16", "split": "index", "kind": "neighbour", "expected": "handoff", "access": true, "text": "Je ne reçois pas le code de connexion à mon compte Limova."},
  {"id": "f17", "split": "index", "kind": "neighbour", "expected": "handoff", "access": false, "text": "La connexion Gmail échoue encore."},
  {"id": "f18", "split": "index", "kind": "neighbour", "expected": "handoff", "access": false, "text": "Ajoutez un collaborateur à mon espace."},
  {"id": "f19", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci, transférez mon compte à un autre titulaire."},
  {"id": "f20", "split": "index", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci pour la procédure, je ne l’ai pas encore essayée."},
  {"id": "f21", "split": "holdout", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Merci pour votre retour !"},
  {"id": "f22", "split": "holdout", "kind": "positive", "expected": "close_proposal", "access": false, "text": "Problème résolu merci."},
  {"id": "f23", "split": "holdout", "kind": "positive", "expected": "no_action", "access": false, "text": "Je reviens vers vous plus tard."},
  {"id": "f24", "split": "holdout", "kind": "positive", "expected": "no_action", "access": false, "text": "Je n’ai pas de nouvelles."},
  {"id": "f25", "split": "holdout", "kind": "trap", "expected": "handoff", "access": false, "text": "Un grand merci, cependant le blocage persiste."},
  {"id": "f26", "split": "holdout", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci ! PS : comment exporter mes documents ?"},
  {"id": "f27", "split": "holdout", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci, supprimez mes données personnelles."},
  {"id": "f28", "split": "holdout", "kind": "trap", "expected": "handoff", "access": false, "text": "Merci, le prélèvement est contesté."},
  {"id": "f29", "split": "holdout", "kind": "neighbour", "expected": "handoff", "access": true, "text": "Le lien de connexion à mon compte Limova a expiré."},
  {"id": "f30", "split": "holdout", "kind": "trap", "expected": "handoff", "access": false, "text": "Bien reçu. Je joins une capture avec une autre erreur."},
 ];

/** Only this subset may be used as offline index input; no production index is created. */
export const SAV_FOLLOWUPS_INDEX_PHRASES = SAV_FOLLOWUPS_TEST_PHRASES.filter(row => row.split === "index");
