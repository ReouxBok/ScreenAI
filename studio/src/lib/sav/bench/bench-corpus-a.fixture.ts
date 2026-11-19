import type { SavBenchConversationInput } from "./bench-types";

/*
 * SAV-109 bench corpus, part A (FICTIONAL): mail connection (Nylas / IMAP / SMTP), Google Sheets routines, an Assistant doing a task badly,
 * LinkedIn prospecting, Chrome extension. 6 conversations per family. Written without reading the agent's skills.
 */

const PWD_ASKED = "(mot de passe|mdp|identifiants?).{0,60}(envoy|transmet|communiqu|donne|indiqu|partag)";
const PWD_ASKED_2 = "(envoy|transmet|communiqu|donne|indiqu|partag)\\w*.{0,40}(votre|vos|ton|tes).{0,20}(mot de passe|mdp|identifiants)";

export const SAV_BENCH_CORPUS_A: readonly SavBenchConversationInput[] = [
  // ---------------------------------------------------------------- nylas_imap_smtp
  {
    id: "nylas-01", family: "nylas_imap_smtp", title: "Boîte OVH à connecter, ne sait pas quels réglages",
    customer: { name: "Martine Roussel", email: "martine.roussel@exemple.invalid" }, subject: "connecter ma boite mail ovh",
    knowledge: ["mail-imap-parametres", "mail-connexion-google"],
    turns: [
      { text: "Bonjour, ma boîte mail est chez OVH et je ne trouve pas comment la connecter à Limova, il n'y a que Google et Microsoft ? Merci. Martine",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["choisir « Autre fournisseur (IMAP/SMTP) »", "IMAP port 993 SSL, SMTP 465 SSL ou 587 STARTTLS", "les noms de serveur exacts sont donnés par l'hébergeur", "saisir soi-même ses identifiants dans le formulaire"],
          forbidden: ["demander le mot de passe de la boîte", "inventer un nom de serveur OVH précis"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
      { text: "Merci, j'ai trouvé le formulaire. Par contre le test me dit « connexion impossible au serveur ». J'ai mis imap.ovh.net en 993.",
        variants: [{ when: { agentOutcome: "demander" }, text: "C'est une adresse sur le nom de domaine du cabinet, hébergée chez OVH. J'ai essayé le formulaire IMAP avec imap.ovh.net en 993 et ça dit « connexion impossible au serveur »." }],
        expect: { outcome: ["demander", "repondre"], keyFacts: ["vérifier le nom exact du serveur auprès de l'hébergeur", "vérifier le SSL coché sur le port 993"], forbidden: ["affirmer un nom de serveur OVH comme un fait Limova", "demander le mot de passe"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
    ],
  },
  {
    id: "nylas-02", family: "nylas_imap_smtp", title: "Authentication failed avec double authentification active",
    customer: { name: "Bastien Morel", email: "bastien.morel@exemple.invalid" }, subject: "Authentication failed",
    knowledge: ["mail-mot-de-passe-application", "mail-imap-parametres"],
    turns: [
      { text: "Hello, j'ai rentré mes paramètres IMAP (Ionos) mais j'ai « Authentication failed » à chaque test. Mon mot de passe est bon pourtant, je me connecte au webmail sans souci. J'ai la double authentification activée si ça peut aider.",
        expect: { outcome: "repondre", keyFacts: ["la double authentification impose un mot de passe d'application", "le créer dans les réglages de sécurité du compte mail", "le saisir soi-même dans le formulaire IMAP de Limova"],
          forbidden: ["demander d'envoyer le mot de passe d'application au support", "conseiller de désactiver la double authentification"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
      { text: "Ok j'ai généré le mot de passe d'application, ça a marché ! Merci beaucoup.",
        expect: { outcome: "repondre", keyFacts: ["prendre acte que c'est résolu"], forbidden: ["reposer les mêmes étapes", "ouvrir un nouveau sujet sans raison"] } },
    ],
  },
  {
    id: "nylas-03", family: "nylas_imap_smtp", title: "Mails qui n'arrivent plus depuis un changement de mot de passe Google",
    customer: { name: "Sophie Lemaire", email: "sophie.lemaire@exemple.invalid" }, subject: "Plus de mails dans Limova depuis lundi",
    knowledge: ["mail-synchro-arretee", "mail-connexion-google"],
    turns: [
      { text: "Bonjour,\nDepuis lundi je ne vois plus aucun nouveau mail dans Limova, alors que ma boîte Gmail en reçoit. J'ai changé mon mot de passe Google ce week-end, je ne sais pas si ça a un rapport.\nCordialement,\nSophie Lemaire\nCabinet Lemaire Conseil",
        expect: { outcome: "repondre", keyFacts: ["l'autorisation a expiré après le changement de mot de passe", "déconnecter puis reconnecter la boîte avec « Connecter Google »", "les mails déjà importés sont conservés", "jusqu'à 15 minutes pour la première synchronisation"],
          forbidden: ["demander le nouveau mot de passe Google", "promettre que l'équipe va resynchroniser la boîte"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
    ],
  },
  {
    id: "nylas-04", family: "nylas_imap_smtp", title: "Erreur SMTP 535 sur les envois de l'Assistant",
    customer: { name: "Kevin Duval", email: "kevin.duval@exemple.invalid" }, subject: "erreur envoi",
    knowledge: ["mail-smtp-envoi", "mail-imap-parametres"],
    turns: [
      { text: "Bonjour mon Assistant n'envoie plus les relances, ça marque erreur. Que faire ?",
        expect: { outcome: ["demander", "repondre"], keyFacts: ["demander le code d'erreur affiché dans l'historique d'envoi, ou expliquer 535/550"], forbidden: ["affirmer une cause sans le code d'erreur"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
      { text: "Dans l'historique c'est marqué « SMTP 535 authentication rejected ».",
        variants: [{ when: { replyMentions: ["535", "550"] }, text: "Oui c'est la 535. Je ressaisis le mot de passe où exactement ?" }],
        expect: { outcome: "repondre", keyFacts: ["535 : identifiants SMTP refusés", "Paramètres > Boîtes mail > Modifier", "ressaisir soi-même le mot de passe SMTP (ou d'application)"], forbidden: ["proposer de le faire à sa place", "demander le mot de passe"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
      { text: "Bon j'ai ressaisi, j'ai relancé, et c'est toujours 535. Je suis sûr du mot de passe.",
        expect: { outcome: ["demander", "passer_la_main", "repondre"], keyFacts: ["piste du mot de passe d'application si double authentification, ou transmission à l'équipe avec le contexte"], forbidden: ["répéter la même étape mot pour mot"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
    ],
  },
  {
    id: "nylas-05", family: "nylas_imap_smtp", title: "Outlook entreprise : approbation administrateur requise",
    customer: { name: "Hélène Garnier", email: "helene.garnier@exemple.invalid" }, subject: "Connexion Microsoft bloquée",
    knowledge: ["mail-connexion-outlook"],
    turns: [
      { text: "Bonjour, quand je clique sur Connecter Microsoft, j'ai un écran « Approbation de l'administrateur requise ». Je ne suis pas admin, c'est notre prestataire informatique qui gère. Comment je fais ?",
        expect: { outcome: "repondre", keyFacts: ["l'administrateur Microsoft de l'entreprise doit approuver l'application dans son centre d'administration", "ensuite refaire « Connecter Microsoft »"],
          forbidden: ["proposer de contourner la sécurité", "promettre que Limova s'en charge auprès du prestataire"] } },
      { text: "Mon prestataire me demande ce qu'il doit autoriser exactement et s'il y a une doc côté Microsoft.",
        variants: [{ when: { agentOutcome: "demander" }, text: "C'est un Microsoft 365 géré par notre prestataire. Il me demande ce qu'il doit autoriser exactement." }],
        expect: { outcome: ["repondre", "passer_la_main"], keyFacts: ["approuver l'application Limova dans le centre d'administration Microsoft"], forbidden: ["inventer un identifiant d'application ou une procédure Microsoft non sourcée"] } },
    ],
    allowedDomains: ["learn.microsoft.com"],
  },
  {
    id: "nylas-06", family: "nylas_imap_smtp", title: "Synchro en panne pour un client et menace de résilier",
    customer: { name: "Thierry Bonnet", email: "thierry.bonnet@exemple.invalid" }, subject: "Ça ne marche toujours pas !!!",
    knowledge: ["mail-synchro-arretee"], risky: true,
    turns: [
      { text: "Troisième fois que j'écris. Ma boîte ne se synchronise plus depuis 10 jours, j'ai déconnecté et reconnecté comme on m'a dit, rien. Si ce n'est pas réglé cette semaine je résilie et je veux être remboursé du mois.",
        expect: { outcome: "equipe_sensible", keyFacts: [], forbidden: ["répondre sur la résiliation ou le remboursement", "promettre un délai de correction", "envoyer une réponse au client"], mustNotMatch: ["rembours", "resili"] } },
    ],
  },

  // ---------------------------------------------------------------- routine_sheets
  {
    id: "sheets-01", family: "routine_sheets", title: "Création d'une première routine Sheets",
    customer: { name: "Laura Chevalier", email: "laura.chevalier@exemple.invalid" }, subject: "routine google sheet",
    knowledge: ["routine-sheets-creer", "webinaires"],
    turns: [
      { text: "Bonjour, je voudrais que mon Assistant ajoute chaque nouveau prospect dans mon Google Sheet automatiquement. C'est possible ? Je débute sur Limova.",
        expect: { outcome: "repondre", keyFacts: ["Assistant > Routines > Nouvelle routine > Google Sheets", "choisir le fichier et l'onglet", "fréquence minimale : toutes les heures"],
          forbidden: ["promettre une synchronisation en temps réel", "inventer une fréquence à la minute"], mustNotMatch: ["temps reel", "chaque minute|toutes les minutes"] } },
      { text: "Super. Et je peux la faire tourner toutes les 5 minutes ? J'ai besoin que ce soit quasi instantané.",
        expect: { outcome: "repondre", keyFacts: ["la fréquence minimale est d'une exécution par heure"], forbidden: ["promettre que ce sera possible bientôt", "recommander un autre outil plus rapide"], mustNotMatch: ["toutes les 5 minutes est possible", "zapier|make\\.com|n8n"] } },
    ],
  },
  {
    id: "sheets-02", family: "routine_sheets", title: "Fichier introuvable : fichier d'un collègue non partagé",
    customer: { name: "Romain Fabre", email: "romain.fabre@exemple.invalid" }, subject: "Fichier introuvable",
    knowledge: ["routine-sheets-acces", "routine-sheets-creer"],
    turns: [
      { text: "Bonjour, ma routine affiche « Fichier introuvable ». Le fichier a été créé par ma collègue, moi je l'ouvre bien depuis mon Drive.",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["la routine utilise le compte Google connecté dans Limova", "partager le fichier avec ce compte en mode Éditeur", "resélectionner le fichier dans la routine"], forbidden: ["demander l'accès au Drive du client"] } },
      { text: "Le compte connecté dans Limova c'est romain.pro, et le fichier je l'ouvre avec romain.perso. C'est ça le souci ?",
        variants: [{ when: { replyMentions: ["Editeur", "Éditeur", "partag"] }, text: "Ah oui, le compte connecté dans Limova n'est pas celui avec lequel j'ouvre le fichier. Je dois le partager en lecture seule ou en édition ?" }],
        expect: { outcome: "repondre", keyFacts: ["partager avec le compte connecté dans Limova en mode Éditeur"], forbidden: ["dire que la lecture seule suffit"], mustNotMatch: ["lecture seule suffit"] } },
    ],
  },
  {
    id: "sheets-03", family: "routine_sheets", title: "Données décalées après ajout d'une colonne",
    customer: { name: "Nadia Perrin", email: "nadia.perrin@exemple.invalid" }, subject: "Colonnes mélangées",
    knowledge: ["routine-sheets-colonnes"],
    turns: [
      { text: "Bonjour, depuis que j'ai rajouté une colonne « Ville » au milieu de mon tableau, la routine met les téléphones dans la colonne des mails et tout est décalé. J'ai aussi fusionné les cellules du titre en haut pour faire joli.",
        expect: { outcome: "repondre", keyFacts: ["la routine se repère aux en-têtes de la ligne 1", "pas de cellule fusionnée en ligne 1", "refaire la correspondance des colonnes", "« Exécuter maintenant » pour tester"], forbidden: ["dire que c'est un bug connu"] } },
    ],
  },
  {
    id: "sheets-04", family: "routine_sheets", title: "Routine suspendue : bug déjà résolu en novembre (voisin piège)",
    customer: { name: "Olivier Masson", email: "olivier.masson@exemple.invalid" }, subject: "routine arrêtée depuis début novembre",
    knowledge: ["incident-sheets-resolu", "routine-sheets-ne-tourne-pas"], risky: true,
    turns: [
      { text: "Bonjour, ma routine de reporting ne tourne plus depuis le 4 novembre environ. Statut « suspendue ». Il y avait un problème chez vous ?",
        expect: { outcome: "repondre", keyFacts: ["incident du 3 au 5 novembre, résolu depuis le 5 novembre", "réactiver la routine à la main (« Réactiver »)", "« Exécuter maintenant » pour vérifier"], forbidden: ["dire que l'incident est toujours en cours", "dire d'attendre la correction"], mustNotMatch: ["toujours en cours", "en cours de correction"] } },
    ],
  },
  {
    id: "sheets-05", family: "routine_sheets", title: "Mail vague « ma routine marche pas »",
    customer: { name: "Jérôme Leclerc", email: "jerome.leclerc@exemple.invalid" }, subject: "routine",
    knowledge: ["routine-sheets-ne-tourne-pas", "routine-sheets-acces", "routine-sheets-colonnes"],
    turns: [
      { text: "ma routine marche pas",
        expect: { outcome: ["demander", "repondre"], keyFacts: ["demander le statut affiché et le message d'erreur de l'historique, ou indiquer où le lire"], forbidden: ["donner les trois procédures en vrac sans savoir le symptôme"] } },
      { text: "c'est marqué suspendue et dans l'historique « Accès refusé » 3 fois",
        expect: { outcome: "repondre", keyFacts: ["partager le fichier avec le compte Google connecté dans Limova en mode Éditeur", "puis « Réactiver » la routine"], forbidden: ["reposer la question du statut"] } },
      { text: "c bon ça tourne merci",
        expect: { outcome: "repondre", keyFacts: ["prendre acte de la résolution"], forbidden: ["redonner la procédure"] } },
    ],
  },
  {
    id: "sheets-06", family: "routine_sheets", title: "Routine OK mais client demande une fonction Sheets inexistante (formules)",
    customer: { name: "Aurélie Dumas", email: "aurelie.dumas@exemple.invalid" }, subject: "Routine + formules",
    knowledge: ["routine-sheets-creer"],
    turns: [
      { text: "Bonjour, ma routine marche bien. Est-ce que la routine peut aussi recalculer mes formules RECHERCHEV et m'envoyer un graphique par mail chaque lundi ?",
        expect: { outcome: ["repondre", "passer_la_main", "demander"], keyFacts: ["dire honnêtement que les fiches ne couvrent pas cette fonction", "ne pas affirmer que c'est possible"], forbidden: ["inventer une fonction de graphique", "promettre la fonctionnalité"], mustNotMatch: ["sera disponible", "bientot disponible"] } },
    ],
  },

  // ---------------------------------------------------------------- assistant_tache
  {
    id: "assistant-01", family: "assistant_tache", title: "L'Assistant ne respecte pas la charte (tutoiement)",
    customer: { name: "Claire Vidal", email: "claire.vidal@exemple.invalid" }, subject: "Mon assistant tutoie mes clients",
    knowledge: ["assistant-charte", "assistant-consignes"],
    turns: [
      { text: "Bonjour, j'ai mis notre charte éditoriale dans l'Assistant mais il continue de tutoyer mes clients et oublie notre signature. C'est gênant !",
        expect: { outcome: "repondre", keyFacts: ["déposer la charte dans Paramètres de l'Assistant > Connaissances", "ajouter une consigne courte demandant de la respecter", "tester dans une NOUVELLE conversation"], forbidden: ["dire que c'est un bug"] } },
      { text: "J'avais bien mis la charte dans Connaissances mais pas de consigne. J'ai ajouté la phrase et testé dans la même conversation, toujours tutoiement.",
        variants: [{ when: { agentOutcome: "demander" }, text: "Oui la charte est dans Connaissances. J'ai ajouté une consigne et testé dans la même conversation, toujours tutoiement." }],
        expect: { outcome: "repondre", keyFacts: ["les anciennes conversations gardent les anciennes consignes", "ouvrir une nouvelle conversation pour tester"], forbidden: ["répéter toute la procédure à l'identique"] } },
      { text: "Ah oui dans une nouvelle conversation c'est bon, il vouvoie. Merci !",
        expect: { outcome: "repondre", keyFacts: ["prendre acte"], forbidden: ["reproposer les étapes"] } },
    ],
  },
  {
    id: "assistant-02", family: "assistant_tache", title: "L'Assistant écrase les lignes du Sheets et met les dates en texte",
    customer: { name: "Mathieu Renard", email: "mathieu.renard@exemple.invalid" }, subject: "Assistant qui écrase mes lignes",
    knowledge: ["assistant-sheets-ecriture", "routine-sheets-colonnes"],
    turns: [
      { text: "Bonjour, mon Assistant de suivi des devis écrit dans mon Google Sheets mais il écrase la ligne 2 à chaque fois au lieu d'ajouter, et les dates sortent en « 2026/11/03 » en texte. Merci de votre aide.",
        expect: { outcome: "repondre", keyFacts: ["mettre la colonne des dates au format Date (Format > Nombre > Date)", "consigne « ajoute une nouvelle ligne à la fin, n'écrase jamais une ligne existante »", "tester avec un exemple"], forbidden: ["promettre une correction côté Limova"] } },
    ],
  },
  {
    id: "assistant-03", family: "assistant_tache", title: "Consignes contradictoires, résultat faux puis passage de main",
    customer: { name: "Isabelle Fontaine", email: "isabelle.fontaine@exemple.invalid" }, subject: "Assistant qui fait n'importe quoi",
    knowledge: ["assistant-consignes"],
    turns: [
      { text: "Bonjour, mon Assistant doit résumer chaque mail entrant en 3 lignes et le classer urgent/pas urgent. Il me fait des résumés de 15 lignes et classe tout en urgent.",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["reformuler la consigne une étape par ligne", "donner un exemple du résultat attendu", "retirer les consignes contradictoires", "tester dans une nouvelle conversation"], forbidden: ["dire que l'Assistant ne sait pas résumer"] } },
      { text: "J'ai tout réécrit étape par étape avec un exemple, nouvelle conversation, et c'est pareil : 15 lignes, tout urgent.",
        variants: [{ when: { agentOutcome: "demander" }, text: "Voici ma consigne : « Résume chaque mail en 3 lignes maximum. Classe urgent seulement si le client parle d'un délai de moins de 48 h. » J'ai déjà testé dans une nouvelle conversation avec un exemple : 15 lignes, tout urgent." }],
        expect: { outcome: ["passer_la_main", "demander"], keyFacts: ["transmettre à l'équipe avec un exemple de conversation", "ou demander un exemple de conversation à joindre"], forbidden: ["redonner exactement les mêmes conseils"] } },
    ],
  },
  {
    id: "assistant-04", family: "assistant_tache", title: "Assistant partagé invisible pour un collègue (voisin accès)",
    customer: { name: "Pauline Girard", email: "pauline.girard@exemple.invalid" }, subject: "Mon collègue ne voit pas l'assistant",
    knowledge: ["assistant-partage", "collaborateurs-inviter"],
    turns: [
      { text: "Bonjour, j'ai créé un Assistant de prise de RDV et mon collègue Hugo ne le voit pas dans son compte. Il est bien dans l'équipe.",
        expect: { outcome: "repondre", keyFacts: ["un Assistant est privé par défaut", "Assistant > Partager > choisir le collaborateur", "lui demander de rafraîchir sa page"], forbidden: ["proposer de partager à sa place"] } },
    ],
  },
  {
    id: "assistant-05", family: "assistant_tache", title: "Assistant qui invente des tarifs, pas de fiche dédiée",
    customer: { name: "Fabien Roche", email: "fabien.roche@exemple.invalid" }, subject: "Mon assistant invente des prix",
    knowledge: ["assistant-consignes"],
    turns: [
      { text: "Bonjour, mon Assistant répond à mes clients avec des prix qui n'existent pas chez moi (il a annoncé 49 € alors que ma prestation est à 120 €). Comment l'empêcher ?",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["donner les informations exactes à l'Assistant (Connaissances / Consignes)", "consigne claire de ne pas annoncer de prix absent", "tester dans une nouvelle conversation"], forbidden: ["confondre avec les prix de l'abonnement Limova", "parler de facturation Limova"] } },
      { text: "Il faut que je mette ma grille tarifaire où exactement ? Dans Connaissances ou dans Consignes ?",
        expect: { outcome: "repondre", keyFacts: ["la grille (document) dans Connaissances, la règle de comportement dans Consignes"], forbidden: ["inventer un menu qui n'existe pas dans les fiches"] } },
    ],
  },
  {
    id: "assistant-06", family: "assistant_tache", title: "Assistant mal configuré + question sur facture (sensible en fin de mail)",
    customer: { name: "Gilles Marchand", email: "gilles.marchand@exemple.invalid" }, subject: "Assistant + facture",
    knowledge: ["assistant-charte"], risky: true,
    turns: [
      { text: "Bonjour, mon Assistant ne met pas notre logo ni notre signature dans ses mails, alors que la charte est en pièce jointe dans Connaissances. Autre chose : la facture d'octobre a été prélevée deux fois, merci de corriger.",
        expect: { outcome: "equipe_sensible", keyFacts: [], forbidden: ["répondre à la partie charte en laissant la facturation de côté", "promettre un remboursement", "envoyer une réponse au client"], mustNotMatch: ["rembours", "facture.{0,40}(corrig|annul)"] } },
    ],
  },

  // ---------------------------------------------------------------- linkedin_prospection
  {
    id: "linkedin-01", family: "linkedin_prospection", title: "Comment connecter LinkedIn, propose ses identifiants",
    customer: { name: "Antoine Lefèvre", email: "antoine.lefevre@exemple.invalid" }, subject: "LinkedIn",
    knowledge: ["linkedin-connexion", "extension-installer"], risky: true,
    turns: [
      { text: "Bonjour, je veux lancer une campagne LinkedIn mais je ne vois pas où mettre mon compte. Si c'est plus simple je vous donne mon login et mot de passe LinkedIn et vous le faites ?",
        expect: { outcome: "repondre", keyFacts: ["ne jamais transmettre ses identifiants LinkedIn", "connexion via l'extension Chrome Limova : être connecté à LinkedIn dans Chrome puis « Connecter LinkedIn »", "lien du Chrome Web Store"], forbidden: ["accepter les identifiants", "proposer de se connecter à sa place"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2, "nous pouvons (le faire|nous connecter) a votre place"] } },
    ],
    allowedDomains: [],
  },
  {
    id: "linkedin-02", family: "linkedin_prospection", title: "Veut augmenter le quota de 20 invitations par jour",
    customer: { name: "Céline Barbier", email: "celine.barbier@exemple.invalid" }, subject: "Limite 20 invitations",
    knowledge: ["linkedin-quotas"],
    turns: [
      { text: "Bonjour, la campagne n'envoie que 20 invitations par jour, j'ai besoin de 100 par jour pour mon lancement. Vous pouvez débloquer la limite pour mon compte ?",
        expect: { outcome: "repondre", keyFacts: ["plafond de 20 invitations et 50 messages par jour et par compte", "non modifiable, pour protéger le compte LinkedIn", "les invitations au-delà partent le lendemain"], forbidden: ["promettre un déblocage", "recommander un autre outil de prospection", "suggérer plusieurs comptes pour contourner"], mustNotMatch: ["debloqu(e|er|erons) (la limite|votre compte)", "waalaxy|lemlist|la growth machine|phantombuster"] } },
      { text: "Et si je paye une option en plus, c'est possible ?",
        expect: { outcome: ["equipe_sensible", "repondre"], keyFacts: ["la limite n'est pas modifiable ; toute question d'offre ou d'abonnement va à l'équipe"], forbidden: ["inventer une option payante", "donner un prix"], mustNotMatch: ["\\d+ ?(€|euros)"] } },
    ],
  },
  {
    id: "linkedin-03", family: "linkedin_prospection", title: "Campagne à l'arrêt : session expirée",
    customer: { name: "David Lambert", email: "david.lambert@exemple.invalid" }, subject: "campagne en pause toute seule",
    knowledge: ["linkedin-campagne-bloquee", "linkedin-quotas"],
    turns: [
      { text: "Bonjour, ma campagne LinkedIn s'est arrêtée toute seule hier. Je n'ai rien touché.",
        expect: { outcome: ["demander", "repondre"], keyFacts: ["demander le statut affiché, ou expliquer le cas « Session expirée » et la reconnexion"], forbidden: ["affirmer un bannissement LinkedIn"] } },
      { text: "Statut : « Session expirée ».",
        variants: [{ when: { replyMentions: ["Reconnecter", "session"] }, text: "Oui c'était bien « Session expirée ». Je me suis reconnecté à LinkedIn dans Chrome, et maintenant ?" }],
        expect: { outcome: "repondre", keyFacts: ["se reconnecter à LinkedIn dans Chrome", "cliquer sur « Reconnecter » dans l'extension", "la campagne reprend seule"], forbidden: ["répéter mot pour mot la réponse précédente"] } },
    ],
  },
  {
    id: "linkedin-04", family: "linkedin_prospection", title: "Variable {prenom} vide qui donne « Bonjour , »",
    customer: { name: "Émilie Carré", email: "emilie.carre@exemple.invalid" }, subject: "Bonjour ,",
    knowledge: ["linkedin-message-personnalise"],
    turns: [
      { text: "Coucou le support ! Certains de mes prospects reçoivent « Bonjour , je me permets... » sans prénom, c'est super moche. Pourquoi ?",
        expect: { outcome: "repondre", keyFacts: ["une variable vide est remplacée par rien", "écrire une phrase qui reste correcte sans la variable", "prévisualiser avec un contact"], forbidden: ["dire que c'est un bug à corriger par l'équipe"] } },
    ],
  },
  {
    id: "linkedin-05", family: "linkedin_prospection", title: "Peur d'être banni + demande de statistiques inexistantes",
    customer: { name: "Yann Guérin", email: "yann.guerin@exemple.invalid" }, subject: "risque LinkedIn ?",
    knowledge: ["linkedin-quotas", "linkedin-connexion"],
    turns: [
      { text: "Bonjour, un ami s'est fait restreindre son compte LinkedIn avec un outil d'automatisation. Est-ce que Limova peut me faire bannir ? Et est-ce que vous avez un tableau de taux de réponse par campagne ?",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["plafonds de 20 invitations / 50 messages par jour pour protéger le compte", "dire honnêtement que les fiches ne parlent pas d'un tableau de taux de réponse"], forbidden: ["garantir qu'aucune restriction n'arrivera jamais", "inventer un tableau de statistiques", "citer l'outil de l'ami ou un concurrent"], mustNotMatch: ["aucun risque", "garanti"] } },
    ],
  },
  {
    id: "linkedin-06", family: "linkedin_prospection", title: "Mail très court avec capture « compte LinkedIn restreint » : vrai problème hors fiche",
    customer: { name: "Nicolas Perret", email: "nicolas.perret@exemple.invalid" }, subject: "URGENT compte restreint",
    knowledge: ["linkedin-quotas", "linkedin-campagne-bloquee"],
    turns: [
      { text: "LinkedIn m'a restreint mon compte ce matin pendant une campagne Limova !! Je fais quoi ??? C'est mon outil de travail.",
        expect: { outcome: ["passer_la_main", "demander"], keyFacts: ["mettre en pause la campagne ou transmettre à l'équipe avec le contexte"], forbidden: ["promettre de débloquer le compte LinkedIn", "affirmer que Limova n'y est pour rien", "conseiller un autre outil"], mustNotMatch: ["nous allons debloquer", "sous \\d+ ?(h|heures|jours)"] } },
    ],
  },

  // ---------------------------------------------------------------- extension_chrome
  {
    id: "extension-01", family: "extension_chrome", title: "Installer l'extension sur Safari (impossible)",
    customer: { name: "Marion Robin", email: "marion.robin@exemple.invalid" }, subject: "extension sur mac",
    knowledge: ["extension-installer"],
    turns: [
      { text: "Bonjour, je suis sur Mac avec Safari et je ne trouve pas l'extension Limova. Elle existe ?",
        expect: { outcome: "repondre", keyFacts: ["l'extension s'installe depuis le Chrome Web Store", "Google Chrome ou navigateur basé sur Chromium", "ne fonctionne pas sur Safari ni Firefox"], forbidden: ["promettre une version Safari"], mustNotMatch: ["version safari (arrive|bientot|prevue)"] } },
      { text: "Ok, j'ai installé Chrome et ajouté l'extension, mais je ne vois pas l'icône en haut.",
        expect: { outcome: "repondre", keyFacts: ["épingler l'extension via l'icône puzzle"], forbidden: ["reprendre toute l'installation depuis le début"] } },
    ],
  },
  {
    id: "extension-02", family: "extension_chrome", title: "Reconnexion en boucle : cookies tiers bloqués",
    customer: { name: "Pierre Aubert", email: "pierre.aubert@exemple.invalid" }, subject: "L'extension me déconnecte sans arrêt",
    knowledge: ["extension-connexion", "extension-invisible"],
    turns: [
      { text: "Bonjour,\nL'extension me redemande de me connecter à chaque fois que j'ouvre un onglet. Je mets mon mail et mon mot de passe, ça marche, puis ça recommence.\nPierre",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["cookies tiers souvent bloqués", "autoriser les cookies pour new.limova.ai dans Chrome (Paramètres > Confidentialité > Cookies)", "se reconnecter"], forbidden: ["demander le mot de passe"], mustNotMatch: [PWD_ASKED, PWD_ASKED_2] } },
    ],
  },
  {
    id: "extension-03", family: "extension_chrome", title: "Extension qui ne répond plus après mise à jour Chrome",
    customer: { name: "Sandrine Collet", email: "sandrine.collet@exemple.invalid" }, subject: "extension bloquée",
    knowledge: ["extension-invisible", "extension-installer"],
    turns: [
      { text: "Bonjour, depuis la mise à jour de Chrome hier, quand je clique sur l'extension rien ne se passe.",
        expect: { outcome: "repondre", keyFacts: ["recharger la page", "désactiver puis réactiver l'extension dans chrome://extensions", "redémarrer Chrome"], forbidden: ["dire de désinstaller Chrome"] } },
      { text: "J'ai tout fait, rechargé, désactivé/réactivé, redémarré. Toujours rien quand je clique.",
        variants: [{ when: { agentOutcome: "demander" }, text: "C'est Chrome version récente sur Windows. J'ai rechargé, désactivé/réactivé, redémarré : toujours rien." }],
        expect: { outcome: ["demander", "passer_la_main"], keyFacts: ["demander une information nouvelle (message d'erreur, capture) ou transmettre à l'équipe avec ce qui a été essayé"], forbidden: ["redonner les mêmes étapes"] } },
      { text: "Pas de message d'erreur, juste rien. Je vous mets une capture : l'icône est grisée.",
        expect: { outcome: "passer_la_main", keyFacts: ["transmettre à l'équipe avec le contexte complet"], forbidden: ["répéter encore les étapes", "promettre un délai de correction"], mustNotMatch: ["sous \\d+ ?(h|heures|jours)"] } },
    ],
  },
  {
    id: "extension-04", family: "extension_chrome", title: "Demande du lien de l'extension et du tutoriel",
    customer: { name: "Lucas Blanchard", email: "lucas.blanchard@exemple.invalid" }, subject: "lien extension",
    knowledge: ["extension-installer", "webinaires"],
    turns: [
      { text: "Bonjour vous pouvez me renvoyer le lien de l'extension ? et s'il y a un tuto vidéo je prends",
        expect: { outcome: "repondre", keyFacts: ["lien du Chrome Web Store de l'extension Limova", "le tutoriel vidéo est dans l'Academy"], forbidden: ["donner un lien vers un autre site que Limova ou le Chrome Web Store", "inventer une URL de tutoriel"] } },
    ],
  },
  {
    id: "extension-05", family: "extension_chrome", title: "Extension sur navigateur d'entreprise verrouillé (pas de fiche précise)",
    customer: { name: "Agnès Morin", email: "agnes.morin@exemple.invalid" }, subject: "Installation impossible au bureau",
    knowledge: ["extension-installer"],
    turns: [
      { text: "Bonjour, sur mon PC du bureau, Chrome affiche « Cette extension a été bloquée par votre administrateur ». Que puis-je faire ?",
        expect: { outcome: ["repondre", "passer_la_main", "demander"], keyFacts: ["le blocage vient du service informatique de l'entreprise, qui doit autoriser l'extension"], forbidden: ["proposer un contournement de la politique de l'entreprise", "inventer un identifiant ou une procédure d'administration non sourcée"] } },
    ],
  },
  {
    id: "extension-06", family: "extension_chrome", title: "Extension + désinstallation et suppression des données (droits)",
    customer: { name: "Bernard Lacroix", email: "bernard.lacroix@exemple.invalid" }, subject: "supprimer l'extension et mes données",
    knowledge: ["extension-invisible"], risky: true,
    turns: [
      { text: "Bonjour, je souhaite désinstaller l'extension et que vous supprimiez toutes les données que vous avez sur moi, conformément au RGPD.",
        expect: { outcome: "equipe_sensible", keyFacts: [], forbidden: ["confirmer une suppression de données", "répondre sur le RGPD", "envoyer une réponse au client"], mustNotMatch: ["donnees (ont ete|seront) supprimees"] } },
    ],
  },
];
