import type { CurriculumJourney } from "./limova-curriculum";

type GroupGuide = {
  entry: string;
  prerequisites: string[];
  checkpoints: string[];
  fallbacks: string[];
};

const GROUP_GUIDES: Record<string, GroupGuide> = {
  "Accès et premiers pas": {
    entry: "Utiliser l’écran d’authentification ou le sélecteur d’organisation affiché avant l’espace de travail.",
    prerequisites: ["Disposer de l’adresse e-mail du membre", "Vérifier si une invitation Limova existe déjà"],
    checkpoints: ["L’organisation active apparaît dans l’URL ou le sélecteur", "Un espace de travail accessible est chargé"],
    fallbacks: ["Renvoyer le code OTP s’il a expiré", "Reprendre l’invitation depuis la page Invitations", "Créer un espace si l’écran indique qu’aucun espace n’est accessible"],
  },
  "Compte, organisation et équipe": {
    entry: "Ouvrir le menu du profil, puis Paramètres du compte, Organisation ou Paramètres de l’espace selon la portée demandée.",
    prerequisites: ["Être connecté", "Identifier l’organisation et l’espace concernés", "Vérifier que le rôle permet la modification"],
    checkpoints: ["La valeur enregistrée est réaffichée après sauvegarde", "Le membre ou l’espace concerné apparaît dans la liste"],
    fallbacks: ["Expliquer la restriction si le rôle ne permet pas l’action", "Actualiser la liste avant de conclure à un échec", "Ne jamais retirer le dernier administrateur sans confirmation"],
  },
  "Abonnement, crédits, API et téléphonie": {
    entry: "Ouvrir les paramètres de l’organisation, puis Facturation, API ou Numéros de téléphone.",
    prerequisites: ["Être administrateur de l’organisation", "Confirmer l’organisation facturée", "Obtenir une confirmation avant tout achat, annulation ou régénération de secret"],
    checkpoints: ["Le nouveau statut ou solde est visible", "La confirmation de paiement, de clé ou de numéro est affichée"],
    fallbacks: ["Ne jamais lire ni recopier une clé complète dans le chat", "En cas de paiement interrompu, revenir par la page de callback", "Si les crédits sont insuffisants, proposer la recharge sans la déclencher sans confirmation"],
  },
  "Assistants et conversations": {
    entry: "Ouvrir Assistants ou Conversations dans l’espace de travail actif.",
    prerequisites: ["Être dans le bon espace de travail", "Identifier l’assistant et la conversation concernés"],
    checkpoints: ["La conversation ou l’assistant apparaît avec son nouveau statut", "Le message, fichier ou résultat est visible dans le fil"],
    fallbacks: ["Réinspecter le fil après une génération longue", "Ne pas renvoyer un message déjà transmis", "Demander quel assistant utiliser si l’intention reste ambiguë"],
  },
  "Documents et contexte": {
    entry: "Ouvrir Documents dans l’espace de travail actif.",
    prerequisites: ["Être dans le bon espace", "Disposer du fichier et vérifier son format", "Confirmer si le document doit être partagé ou seulement attaché à une conversation"],
    checkpoints: ["Le document apparaît dans la bibliothèque", "Son état de traitement n’est plus en attente ou en erreur"],
    fallbacks: ["Attendre la fin du traitement avant de l’utiliser", "Relancer le traitement si l’action est proposée", "Distinguer retrait du contexte et suppression définitive"],
  },
  "Intégrations": {
    entry: "Ouvrir Intégrations, puis Catalogue ou Comptes connectés dans l’espace actif.",
    prerequisites: ["Être dans le bon espace", "Connaître le fournisseur et le compte à connecter", "Autoriser l’ouverture d’une fenêtre externe uniquement après accord"],
    checkpoints: ["Le fournisseur apparaît dans Comptes connectés", "Le compte affiche un état connecté et exploitable"],
    fallbacks: ["Si la fenêtre OAuth est bloquée, demander d’autoriser les pop-ups", "Si elle est fermée ou refusée, relancer Connecter", "Si le compte est révoqué, utiliser Reconnecter sans créer de doublon"],
  },
  "Power-ups et contenus": {
    entry: "Ouvrir Super-pouvoirs dans l’espace actif et sélectionner la carte correspondant au résultat demandé.",
    prerequisites: ["Être dans le bon espace", "Recueillir le brief, le format et la destination", "Vérifier les crédits et l’intégration de publication si nécessaire"],
    checkpoints: ["Le résultat est visible dans l’étape finale", "Le contenu apparaît dans Brouillons ou Contenus finalisés"],
    fallbacks: ["Conserver le brouillon si la génération échoue", "Attendre une génération encore en cours avant de la relancer", "Ne publier ni planifier sans validation explicite"],
  },
  "Blog et SEO": {
    entry: "Ouvrir Super-pouvoirs, puis choisir Audit SEO, Article de blog ou Campagne d’articles.",
    prerequisites: ["Connaître le site ou domaine", "Recueillir le sujet, l’audience, la langue et l’objectif", "Vérifier le CMS avant publication"],
    checkpoints: ["Le rapport ou l’article généré est visible", "La campagne ou la publication affiche son statut final"],
    fallbacks: ["Vérifier le format du domaine si l’audit ne démarre pas", "Conserver l’article en brouillon si aucun CMS n’est connecté", "Ne jamais publier sans confirmation"],
  },
  "Campagnes de prospection": {
    entry: "Ouvrir Campagnes dans l’espace actif, puis Brouillons, Actives ou Archivées selon le statut.",
    prerequisites: ["Identifier le canal", "Confirmer la cible, le message, le calendrier et le compte connecté", "Vérifier les crédits pour les appels"],
    checkpoints: ["La campagne apparaît dans le bon onglet", "Son statut et ses compteurs correspondent à l’action demandée"],
    fallbacks: ["Ne jamais démarrer une campagne sans confirmation finale", "Conserver le brouillon si une source de prospects manque", "Actualiser les données avant d’annoncer un résultat"],
  },
  "Agents autonomes et canaux": {
    entry: "Ouvrir Agents dans l’espace actif, puis Brouillons, Actifs ou Archivés.",
    prerequisites: ["Définir le rôle, le ton, les connaissances et le canal", "Vérifier les intégrations et numéros nécessaires", "Tester avant activation"],
    checkpoints: ["L’agent apparaît dans le bon onglet", "Le canal ou widget affiche un état connecté", "Le test produit une réponse conforme"],
    fallbacks: ["Laisser l’agent en brouillon si le test échoue", "Ne pas exposer le widget sur un domaine non autorisé", "Reconnecter le canal avant de recréer l’agent"],
  },
  "Blocages et garde-fous": {
    entry: "Inspecter la page courante, le rôle, l’offre, le solde et l’état des connexions avant toute nouvelle action.",
    prerequisites: ["Conserver le contexte de la demande", "Ne pas contourner une permission ou une confirmation"],
    checkpoints: ["La cause du blocage est identifiée", "Le membre dispose d’une reprise sûre ou d’un passage au staff"],
    fallbacks: ["Ne jamais cliquer sur une cible ambiguë", "Ne jamais saisir un secret dans le chat", "Transmettre au staff le chemin, l’état visible et la dernière action réussie"],
  },
};

function taskSteps(entry: CurriculumJourney) {
  const title = entry.title.toLocaleLowerCase("fr");
  if (title.includes("créer et configurer son organisation")) return [
    "Depuis le sélecteur d’organisation ou la page d’entrée, choisir l’action de création d’une organisation.",
    "Saisir le nom de l’entreprise et valider la création. Attendre l’URL contenant le nouvel identifiant d’organisation.",
    "Dans l’onboarding de l’organisation, compléter les informations d’entreprise demandées et enregistrer chaque étape.",
    "Choisir l’offre uniquement avec l’accord du membre ; si un paiement est requis, le laisser confirmer lui-même les données de paiement.",
    "Créer le premier espace de travail ou sélectionner l’espace proposé, puis vérifier que son tableau de bord se charge.",
    "Ouvrir les paramètres de l’organisation et contrôler que le nom, l’entreprise et l’espace attendu sont visibles.",
  ];
  if (/connecter|connexion/.test(title)) return [
    "Ouvrir le catalogue des intégrations et rechercher le fournisseur demandé.",
    "Sélectionner la bonne carte et vérifier le compte ou l’usage attendu avant de choisir Connecter.",
    "Après confirmation du membre, ouvrir la fenêtre d’autorisation externe et le laisser s’authentifier si nécessaire.",
    "Revenir dans Limova, ouvrir Comptes connectés et vérifier le nom du compte ainsi que son état.",
    "Si plusieurs comptes existent, confirmer celui qui doit être utilisé et sa visibilité dans l’espace.",
  ];
  if (/créer|générer|réaliser|importer|ajouter|inviter|activer|acheter/.test(title)) return [
    `Ouvrir la section indiquée et choisir l’action correspondant à « ${entry.title} ».`,
    "Recueillir les valeurs obligatoires visibles dans le formulaire ; ne pas inventer les choix métier manquants.",
    "Compléter les étapes du formulaire une par une et corriger toute validation affichée avant de continuer.",
    "Présenter le récapitulatif au membre et demander confirmation si l’action publie, facture, invite, active ou contacte un tiers.",
    "Valider puis attendre la fin du traitement sans répéter l’action.",
    "Ouvrir la liste ou la fiche de résultat et vérifier le nom, le statut et les marqueurs attendus.",
  ];
  if (/modifier|renommer|configurer|gérer|changer|attribuer/.test(title)) return [
    "Ouvrir la liste concernée et sélectionner l’élément exact à modifier.",
    "Ouvrir son menu d’actions ou ses paramètres, puis choisir Modifier ou Configurer.",
    "Comparer la valeur actuelle avec la demande et ne changer que les champs confirmés.",
    "Enregistrer, attendre la confirmation, puis recharger la fiche ou la liste.",
    "Vérifier que la nouvelle valeur est affichée et que les autres réglages sont inchangés.",
  ];
  if (/supprimer|retirer|annuler|désactiver|archiver/.test(title)) return [
    "Ouvrir la fiche de l’élément exact et vérifier son identité, son espace et son statut.",
    "Ouvrir le menu d’actions et sélectionner l’action destructive demandée.",
    "Expliquer l’effet visible et demander une confirmation explicite au membre.",
    "Confirmer une seule fois, attendre la réponse, puis revenir à la liste.",
    "Vérifier que l’élément a disparu ou qu’il porte le statut annulé, désactivé ou archivé attendu.",
  ];
  if (/consulter|retrouver|rechercher|filtrer|se repérer|comprendre|distinguer|expliquer|protéger|réagir|reprendre|passer la main/.test(title)) return [
    "Identifier l’organisation, l’espace et l’objet recherchés à partir de la demande.",
    "Ouvrir la section indiquée et utiliser les onglets, filtres ou la recherche sans modifier les données.",
    "Sélectionner le résultat correspondant exactement au nom, au statut ou à la période demandée.",
    "Lire uniquement les informations utiles et expliquer l’état constaté.",
    "Si aucune correspondance fiable n’existe, conserver les filtres et demander une seule précision.",
  ];
  return [
    `Ouvrir la section correspondant à « ${entry.title} » dans l’organisation et l’espace actifs.`,
    "Inspecter les contrôles visibles et sélectionner l’objet exact concerné.",
    "Suivre les étapes affichées sans inventer de valeur et demander les informations manquantes.",
    "Valider uniquement après les confirmations nécessaires, puis attendre le résultat.",
    "Contrôler la route, le statut et les marqueurs visibles avant d’annoncer la réussite.",
  ];
}

export function buildOperationalJourney(entry: CurriculumJourney) {
  const guide = GROUP_GUIDES[entry.group];
  if (!guide) throw new Error(`Missing operational guide for ${entry.group}`);
  const steps = taskSteps(entry);
  const expectedPages = entry.paths;
  const successCriteria = [
    ...guide.checkpoints,
    `Le résultat de « ${entry.title} » est visible dans Limova après réinspection de la page.`,
  ];
  const qualificationQuestions = [
    "Dans quelle organisation et quel espace de travail faut-il agir ?",
    `Quel résultat précis attendez-vous pour « ${entry.title} » ?`,
    "Les choix, comptes et conséquences éventuelles ont-ils été confirmés ?",
  ];
  const branches = [
    { condition: "L’élément existe déjà", next: "Ouvrir l’existant et proposer de le modifier au lieu de créer un doublon." },
    { condition: "Le rôle, l’offre ou les crédits bloquent l’action", next: "Expliquer le prérequis manquant et ne pas contourner le blocage." },
    { condition: "La cible ou le résultat n’est pas identifiable", next: "Réinspecter la page puis demander une précision unique si l’ambiguïté persiste." },
  ];
  const fallbacks = [...guide.fallbacks, "Après une erreur réseau, vérifier l’état réel avant toute nouvelle tentative."];
  const bodyMarkdown = [
    `# ${entry.title}`,
    "",
    "## Quand utiliser ce parcours",
    "",
    `Utiliser ce parcours lorsqu’un membre demande à ${entry.title.toLocaleLowerCase("fr")}. Il s’applique uniquement à l’organisation et à l’espace confirmés par le membre.`,
    "",
    "## Point d’entrée",
    "",
    guide.entry,
    "",
    "Pages repérées dans le front Limova :",
    ...expectedPages.map((path) => `- \`${path}\``),
    "",
    "## Prérequis",
    "",
    ...guide.prerequisites.map((item) => `- ${item}`),
    "",
    "## Questions à poser si l’information manque",
    "",
    ...qualificationQuestions.map((item) => `- ${item}`),
    "",
    "## Étapes opérationnelles",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Vérification de réussite",
    "",
    ...successCriteria.map((item) => `- ${item}`),
    "",
    "## Variantes et blocages",
    "",
    ...branches.map((item) => `- **${item.condition}** : ${item.next}`),
    "",
    "## Reprise sûre",
    "",
    ...fallbacks.map((item) => `- ${item}`),
  ].join("\n");

  return {
    summary: `Guider et vérifier de bout en bout l’action « ${entry.title} » dans Limova.`,
    bodyMarkdown,
    metadata: {
      objective: entry.title,
      proposalSignals: [entry.title, `Aide-moi à ${entry.title.toLocaleLowerCase("fr")}`, `Comment ${entry.title.toLocaleLowerCase("fr")} ?`],
      qualificationQuestions,
      expectedPages,
      successCriteria,
      branches,
      fallbacks,
      actionSteps: [],
      sourceMetadata: {
        origin: "limova_code_inventory",
        generatedRevision: "operational-v2",
        sourcePaths: ["Limova-2-0/client@main", "Limova-2-0/api@main", ...expectedPages.map((path) => `client/src/app${path}`)],
      },
    },
  };
}
