import type { SavBlockTestPhrase } from "./block-attribution";

/** SYN only. Holdout phrases must never feed the search index or threshold calibration. */
export type IntegrationsTestPhrase = SavBlockTestPhrase & Readonly<{ id: string; split: "index" | "holdout"; expected: "integrations" | "access" | "team" }>;
export const SAV_INTEGRATIONS_TEST_PHRASES: readonly IntegrationsTestPhrase[] = [
  { id: "i01", split: "index", kind: "positive", expected: "integrations", text: "La connexion de ma boîte Gmail échoue malgré une reconnexion." },
  { id: "i02", split: "index", kind: "positive", expected: "integrations", text: "Outlook est connecté mais la lecture des messages reste bloquée." },
  { id: "i03", split: "index", kind: "positive", expected: "integrations", text: "Comment connecter WhatsApp à mon agent ?" },
  { id: "i04", split: "index", kind: "positive", expected: "integrations", text: "La connexion de la messagerie OVH ne fonctionne pas." },
  { id: "i05", split: "index", kind: "positive", expected: "integrations", text: "La boîte IONOS reste déconnectée après mon nouvel essai." },
  { id: "i06", split: "index", kind: "positive", expected: "integrations", text: "Comment relier ma messagerie Orange à l'outil ?" },
  { id: "i07", split: "index", kind: "positive", expected: "integrations", text: "Je rencontre une erreur 403 lors de la connexion Shopify." },
  { id: "i08", split: "index", kind: "positive", expected: "integrations", text: "La liaison WordPress apparaît active mais rien ne remonte." },
  { id: "i09", split: "index", kind: "positive", expected: "integrations", text: "Comment connecter Pennylane à mon agent ?" },
  { id: "i10", split: "index", kind: "positive", expected: "integrations", text: "La connexion Dougs échoue au retour de l'autorisation." },
  { id: "i11", split: "index", kind: "positive", expected: "integrations", text: "Odoo est connecté mais l'agent ne peut rien lire." },
  { id: "i12", split: "index", kind: "positive", expected: "integrations", text: "Comment établir la connexion LinkedIn ?" },
  { id: "i13", split: "index", kind: "positive", expected: "integrations", text: "Je veux vérifier la connexion de ma boîte Gmail sans modifier les droits." },
  { id: "i14", split: "index", kind: "neighbour", expected: "access", text: "Je ne reçois pas le code de connexion à mon compte Limova." },
  { id: "i15", split: "index", kind: "neighbour", expected: "access", text: "Le lien de connexion à mon compte Limova a expiré." },
  { id: "i16", split: "index", kind: "neighbour", expected: "team", text: "Le montage de ma vidéo reste bloqué." },
  { id: "i17", split: "index", kind: "trap", expected: "team", text: "Gmail ne se connecte plus et je demande un remboursement." },
  { id: "i18", split: "index", kind: "trap", expected: "team", text: "Je souhaite résilier après cet échec de connexion Outlook." },
  { id: "h01", split: "holdout", kind: "positive", expected: "integrations", text: "Mes messages Outlook sont inaccessibles alors que la liaison est verte." },
  { id: "h02", split: "holdout", kind: "positive", expected: "integrations", text: "Le branchement Shopify me renvoie 403, que dois-je vérifier ?" },
  { id: "h03", split: "holdout", kind: "positive", expected: "integrations", text: "La reconnexion Gmail finit encore en échec, je n'ai pas de capture." },
  { id: "h04", split: "holdout", kind: "positive", expected: "integrations", text: "Impossible de relier Odoo, je joins une capture de l'erreur." },
  { id: "h05", split: "holdout", kind: "positive", expected: "integrations", text: "La liaison WhatsApp a disparu sans message explicatif." },
  { id: "h06", split: "holdout", kind: "neighbour", expected: "access", text: "Le code de connexion à mon compte Limova ne fonctionne pas." },
  { id: "h07", split: "holdout", kind: "trap", expected: "team", text: "La connexion Pennylane échoue et ma facture est incorrecte." },
  { id: "h08", split: "holdout", kind: "trap", expected: "team", text: "La liaison Gmail échoue : le support a confirmé un bug plateforme." },
  { id: "h09", split: "holdout", kind: "trap", expected: "team", text: "Pour réparer Outlook je propose de vous transmettre un jeton secret et des données sensibles." },
];
