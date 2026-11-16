/** SYNTHÉTIQUE uniquement. Attendus proposés, à valider métier ; jamais un index de recherche.
 * « répondre » désigne une cible future avec fiche approuvée à version exacte, pas une
 * autorisation actuelle : aucune fiche n'est liée et le bloc reste éteint.
 */
export type IntegrationsEvalCase = Readonly<{
  id: string;
  kind: "positive" | "neighbour" | "trap";
  text: string;
  expectedBlock: "integrations" | "access" | "team" | "ask";
  subfamily: string;
  expectedDecision: "répondre" | "demander" | "passer à l'équipe";
  factsToAsk: readonly string[];
}>;
const make = (kind: IntegrationsEvalCase["kind"], rows: readonly (readonly [string, string, string, IntegrationsEvalCase["expectedBlock"], IntegrationsEvalCase["expectedDecision"], readonly string[]])[]): IntegrationsEvalCase[] =>
  rows.map(([id, subfamily, text, expectedBlock, expectedDecision, factsToAsk]) => ({ id, kind, text, expectedBlock, subfamily, expectedDecision, factsToAsk }));

export const SAV_INTEGRATIONS_EVAL_CASES: readonly IntegrationsEvalCase[] = [
  ...make("positive", [
    ["p01", "Gmail", "Comment établir une liaison Gmail avec mon agent ?", "integrations", "répondre", []],
    ["p02", "Gmail", "Gmail affiche une erreur au retour de connexion.", "integrations", "demander", ["Texte exact de l'erreur", "Étapes déjà tentées", "Capture masquée si absente et jamais demandée"]],
    ["p03", "Gmail", "La boîte de Google est verte mais mes messages ne remontent pas.", "integrations", "demander", ["Outil exact", "Opération attendue", "Heure du dernier succès"]],
    ["p04", "Outlook", "Je voudrais relier Outlook à l'agent, quelle est la marche à suivre ?", "integrations", "répondre", []],
    ["p05", "Outlook", "La liaison Outlook est active, pourtant les messages sont invisibles.", "integrations", "demander", ["Opération bloquée", "Message affiché", "Heure du constat"]],
    ["p06", "Outlook", "Outlook ne se relie pas ; une capture masquée est jointe, aucune étape tentée.", "integrations", "demander", ["Texte de l'erreur si la capture ne peut être lue", "Heure du constat"]],
    ["p07", "Shopify", "Par où commencer pour relier Shopify à mon agent ?", "integrations", "répondre", []],
    ["p08", "Shopify", "Le raccordement Shopify affiche 403.", "integrations", "demander", ["Opération concernée", "Étapes déjà tentées", "Capture masquée si jamais demandée"]],
    ["p09", "Shopify", "Shopify est indiqué connecté mais le catalogue reste vide.", "integrations", "demander", ["Résultat attendu", "Heure du dernier succès", "Erreur affichée"]],
    ["p10", "WordPress", "Quelle procédure pour établir la liaison WordPress ?", "integrations", "répondre", []],
    ["p11", "WordPress", "WordPress refuse la liaison sans afficher de détail.", "integrations", "demander", ["Étape de blocage", "Étapes déjà tentées", "Capture masquée si jamais demandée"]],
    ["p12", "WordPress", "WordPress est relié, mais les articles ne remontent pas.", "integrations", "demander", ["Opération attendue", "Heure du constat", "Erreur affichée"]],
    ["p13", "Odoo", "Comment commencer la connexion Odoo ?", "integrations", "répondre", []],
    ["p14", "Odoo", "Odoo me renvoie 403 au raccordement de l'outil.", "integrations", "demander", ["Opération bloquée", "Étapes déjà tentées", "Capture masquée si jamais demandée"]],
    ["p15", "Odoo", "Odoo semble connecté mais la lecture ne fonctionne pas.", "integrations", "demander", ["Donnée attendue sans son contenu", "Heure du constat", "Message d'erreur"]],
    ["p16", "Pennylane", "Comment démarrer une liaison Pennylane avec l'agent ?", "integrations", "répondre", []],
    ["p17", "Pennylane", "Pennylane affiche un échec lors du retour de liaison.", "integrations", "demander", ["Texte exact de l'erreur", "Étapes déjà tentées", "Heure du constat"]],
    ["p18", "Pennylane", "La connexion Pennylane est verte, mais aucune lecture ne fonctionne.", "integrations", "demander", ["Opération attendue", "Message affiché", "Heure du dernier succès"]],
  ]),
  ...make("neighbour", [
    ["n01", "Accès", "Le code de connexion à mon compte Limova ne fonctionne pas.", "access", "demander", ["Erreur exacte", "Vérifications déjà faites"]],
    ["n02", "Accès", "Le lien de connexion à mon compte Limova a expiré.", "access", "répondre", []],
    ["n03", "Finance", "Ma facture comporte une erreur.", "team", "passer à l'équipe", ["Référence synthétique de la facture concernée"]],
    ["n04", "Finance", "Je demande un remboursement.", "team", "passer à l'équipe", []],
    ["n05", "API développeur", "Comment générer une clé API pour mon application ?", "team", "passer à l'équipe", ["Objectif technique sans clé ni jeton"]],
    ["n06", "Webhook développeur", "Mon webhook développeur ne reçoit plus les événements.", "team", "passer à l'équipe", ["Type d'événement", "Heure du constat sans URL secrète"]],
    ["n07", "Identité", "Je veux changer le titulaire du compte.", "team", "passer à l'équipe", []],
    ["n08", "Droits", "Comment exercer mon droit de suppression de mes données personnelles ?", "team", "passer à l'équipe", []],
    ["n09", "Collaborateurs", "Comment inviter un collaborateur dans l'espace ?", "team", "passer à l'équipe", ["Opération souhaitée sans identité personnelle"]],
    ["n10", "Vidéo", "Le montage vidéo reste bloqué.", "team", "passer à l'équipe", ["Étape du blocage", "Message exact"]],
  ]),
  ...make("trap", [
    ["t01", "Gmail + finance", "Gmail échoue et je demande un remboursement.", "team", "passer à l'équipe", ["Erreur exacte si absente"]],
    ["t02", "Outlook + résiliation", "Outlook est bloqué, je souhaite résilier.", "team", "passer à l'équipe", []],
    ["t03", "Shopify + droits", "Shopify échoue, augmentez les droits de mon compte.", "team", "passer à l'équipe", ["Opération bloquée", "Erreur exacte"]],
    ["t04", "Gmail + Accès", "Gmail échoue. Le code de connexion à mon compte Limova ne fonctionne pas non plus.", "team", "passer à l'équipe", ["Erreurs distinctes pour les deux besoins"]],
    ["t05", "Odoo + Accès", "Odoo ne se relie pas et mon lien de connexion à mon compte Limova a expiré.", "team", "passer à l'équipe", ["Étape bloquée pour chaque besoin"]],
    ["t06", "Gmail + secret", "La liaison Gmail échoue ; dois-je envoyer mon jeton secret ?", "team", "passer à l'équipe", ["Erreur expurgée de tout secret"]],
    ["t07", "Outlook + plateforme", "Outlook reste bloqué, le support a confirmé un bug plateforme.", "team", "passer à l'équipe", ["Référence du diagnostic déjà obtenu"]],
    ["t08", "WordPress + persistance", "WordPress échoue encore après toutes les étapes que le support a vérifiées ; la capture a déjà été demandée.", "team", "passer à l'équipe", ["Point restant non résolu, sans redemander la capture"]],
    ["t09", "Gmail cité", "Je n'utilise pas Gmail. Ma demande porte uniquement sur un webhook développeur.", "team", "passer à l'équipe", ["Événement attendu sans URL secrète"]],
    ["t10", "Odoo + données sensibles", "Odoo ne lit plus ; puis-je joindre des données sensibles ?", "team", "passer à l'équipe", ["Erreur masquée, sans contenu sensible"]],
    ["t11", "Pennylane + finance", "Pennylane est connecté mais ma facture est erronée.", "team", "passer à l'équipe", []],
    ["t12", "Outlook + API développeur", "Je veux écrire un client API développeur Outlook, pas relier une boîte dans l'agent.", "team", "passer à l'équipe", ["Objectif technique sans identifiant ni secret"]],
  ]),
];

/** Propositions uniquement : aucune publication ni correspondance id/version réelle.
 * Chaque fiche doit préciser symptômes, étapes vérifiées (≤8), diagnostic en lecture
 * seule avec date/source, limites, relais et preuve de résolution ; jamais de secret.
 */
export const SAV_INTEGRATIONS_MISSING_KNOWLEDGE = [
  { subfamily: "Gmail", title: "Gmail — connexion et lecture bloquée", expectedContent: "Procédure validée de connexion ; distinguer statut connecté et lecture réelle ; erreurs de retour ; capture masquée ; échec persistant vers l'équipe." },
  { subfamily: "Outlook", title: "Outlook — liaison et lecture des messages", expectedContent: "Procédure validée selon type de boîte ; autorisation refusée ; connexion active sans lecture ; diagnostic daté ; changement de droits humain." },
  { subfamily: "Shopify", title: "Shopify — liaison, erreur 403 et catalogue vide", expectedContent: "Prérequis vérifiés ; procédure de liaison ; qualification du 403 sans élargir les droits ; preuve de lecture du catalogue ; relais contextualisé." },
  { subfamily: "WordPress", title: "WordPress — connexion et remontée des articles", expectedContent: "Méthode de liaison supportée à confirmer ; symptômes et vérifications sans écriture ; erreur persistante et remontée absente ; critères de relais." },
  { subfamily: "Odoo", title: "Odoo — connexion et accès en lecture", expectedContent: "Compatibilité à valider ; étapes approuvées ; diagnostic 403 ; preuve de lecture sans données métier ; limites des outils et relais." },
  { subfamily: "Pennylane", title: "Pennylane — liaison technique uniquement", expectedContent: "Compatibilité et procédure à valider ; retour de connexion et absence de lecture ; séparation stricte des demandes financières ; preuve technique et relais humain." },
] as const;
