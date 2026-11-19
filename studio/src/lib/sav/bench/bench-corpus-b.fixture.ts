import type { SavBenchConversationInput } from "./bench-types";

/*
 * SAV-109: bench corpus, part B (FICTIONAL data only, `@exemple.invalid`). Families: access and collaborators, Charly Max / WhatsApp,
 * integration requests, badly written mails, several topics in one mail. Written without reading the agent's behaviour skills.
 */

const NO_PASSWORD = "(envoy|transmet|communiqu|donn|indiqu|partag)\\w*[^.?!]{0,40}mot de passe";
const NO_DATE_PROMISE = "(sous|dans|d'ici)\\s+(\\d+|quelques)\\s*(h\\b|heures?|jours?|semaines?|mois)";
const NO_SIGNUP = "(inscri|creez un compte|abonnez-vous)";

export const SAV_BENCH_CORPUS_B: readonly SavBenchConversationInput[] = [
  // ---------------------------------------------------------------------------------------------------------------------------
  // Access and collaborators
  // ---------------------------------------------------------------------------------------------------------------------------
  { id: "acces-01", family: "acces_collaborateurs", title: "Mot de passe oublié, demande simple de lien de connexion",
    customer: { name: "Hélène Marchand", email: "helene.marchand@exemple.invalid" }, subject: "Connexion impossible",
    knowledge: ["acces-connexion", "acces-mail-reinitialisation"],
    turns: [
      { text: "Bonjour, j'ai oublié mon mot de passe et je n'arrive plus à me connecter à Limova. Comment faire ? Merci, Hélène",
        expect: { outcome: "repondre", keyFacts: ["Aller sur https://new.limova.ai", "Cliquer sur « Mot de passe oublié »", "Le lien de réinitialisation est valable 1 heure"],
          forbidden: ["Demander le mot de passe actuel ou ancien"], mustNotMatch: [NO_PASSWORD] } },
    ] },
  { id: "acces-02", family: "acces_collaborateurs", title: "Mail de réinitialisation jamais reçu, puis adresse oubliée : passer la main",
    customer: { name: "Bruno Lefèvre", email: "bruno.lefevre@exemple.invalid" }, subject: "Re: mot de passe",
    knowledge: ["acces-mail-reinitialisation", "acces-connexion"],
    turns: [
      { text: "J'ai cliqué sur mot de passe oublié il y a une heure et je n'ai toujours rien reçu.",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Vérifier les spams et les promotions", "Vérifier l'adresse saisie"], forbidden: ["Promettre de renvoyer le mail soi-même"] } },
      { text: "Rien dans les spams. En fait je ne suis plus sûr de l'adresse que j'ai utilisée pour créer le compte, peut-être l'ancienne adresse de ma boîte.",
        variants: [{ when: { agentOutcome: "demander" }, text: "Je n'ai rien dans les spams, et pour répondre à votre question je ne sais plus quelle adresse j'ai utilisée pour le compte." }],
        expect: { outcome: "passer_la_main", keyFacts: ["L'équipe va retrouver le compte"], forbidden: ["Donner des informations sur un compte", "Demander une pièce d'identité"] } },
    ] },
  { id: "acces-03", family: "acces_collaborateurs", title: "Inviter un collaborateur, sans être administrateur",
    customer: { name: "Sophie Garnier", email: "sophie.garnier@exemple.invalid" }, subject: "Ajouter ma collègue",
    knowledge: ["collaborateurs-inviter", "collaborateurs-roles"],
    turns: [
      { text: "Bonjour, comment j'ajoute ma collègue Julie sur notre compte Limova ? Je ne trouve pas le bouton.",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Paramètres > Équipe > « Inviter un collaborateur »", "Seul un administrateur du compte peut inviter"] } },
      { text: "Je vois Paramètres mais pas d'onglet Équipe.",
        variants: [{ when: { replyMentions: ["administrateur"] }, text: "Ah d'accord, c'est mon associé qui est administrateur, je lui demande. Merci !" }],
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Seul un administrateur voit la gestion de l'équipe", "Demander à l'administrateur du compte d'inviter la collègue"], forbidden: ["Proposer de faire l'invitation à la place du client"] } },
    ] },
  { id: "acces-04", family: "acces_collaborateurs", title: "Invitation expirée au bout de plus de 7 jours",
    customer: { name: "Karim Benali", email: "karim.benali@exemple.invalid" }, subject: "invitation qui ne marche pas",
    knowledge: ["collaborateurs-invitation-expiree", "collaborateurs-inviter"],
    turns: [
      { text: "J'ai invité un stagiaire il y a deux semaines, il clique sur le lien et ça lui dit que l'invitation n'est plus valide.",
        expect: { outcome: "repondre", keyFacts: ["Une invitation expire après 7 jours", "Paramètres > Équipe > Invitations en attente > « Renvoyer »"] } },
    ] },
  { id: "acces-05", family: "acces_collaborateurs", title: "Voisin sensible : changer le rôle d'un membre (pas l'abonnement)", risky: true,
    customer: { name: "Nathalie Roux", email: "nathalie.roux@exemple.invalid" }, subject: "Changer les droits de Paul",
    knowledge: ["collaborateurs-roles", "assistant-partage"],
    turns: [
      { text: "Bonjour, Paul est Membre dans notre équipe, je voudrais qu'il puisse gérer les intégrations lui aussi. Comment je fais ?",
        expect: { outcome: "repondre", keyFacts: ["Un Administrateur gère aussi l'équipe et les intégrations", "Paramètres > Équipe > menu « ... » > « Changer le rôle »"],
          forbidden: ["Parler de changement d'abonnement ou de facturation", "Transmettre à l'équipe comme sujet sensible"] } },
    ] },
  { id: "acces-06", family: "acces_collaborateurs", title: "Collaborateur ne voit pas l'Assistant partagé ; client qui veut qu'on le fasse pour lui",
    customer: { name: "Thomas Perrin", email: "thomas.perrin@exemple.invalid" }, subject: "Mon collègue ne voit rien",
    knowledge: ["assistant-partage", "collaborateurs-inviter"],
    turns: [
      { text: "Mon collègue a rejoint l'équipe hier mais il ne voit aucun de nos Assistants. Pouvez-vous lui donner accès directement ?",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Un Assistant est privé par défaut", "Assistant > Partager > choisir le collaborateur"],
          forbidden: ["Dire que le support va modifier le compte ou donner l'accès lui-même"], mustNotMatch: ["(nous avons|j'ai) (donne|ajoute|partage)"] } },
      { text: "C'est fait, il le voit maintenant. Merci beaucoup !",
        expect: { outcome: "repondre", keyFacts: ["Prendre acte que c'est résolu"], forbidden: ["Reposer des questions déjà résolues"] } },
    ] },

  // ---------------------------------------------------------------------------------------------------------------------------
  // Charly Max / WhatsApp
  // ---------------------------------------------------------------------------------------------------------------------------
  { id: "charly-01", family: "charly_whatsapp", title: "Relier WhatsApp à Charly Max, première fois",
    customer: { name: "Camille Fontaine", email: "camille.fontaine@exemple.invalid" }, subject: "WhatsApp Charly",
    knowledge: ["charly-whatsapp-connecter"],
    turns: [
      { text: "Bonjour, je viens de prendre Charly Max et je voudrais qu'il réponde à mes clients sur WhatsApp. Par où commencer ?",
        expect: { outcome: "repondre", keyFacts: ["Charly Max > Canaux > WhatsApp > « Relier un numéro »", "Scanner le QR code depuis WhatsApp Business > Appareils connectés"] } },
    ] },
  { id: "charly-02", family: "charly_whatsapp", title: "Numéro WhatsApp personnel, pas Business",
    customer: { name: "Didier Moreau", email: "didier.moreau@exemple.invalid" }, subject: "QR code refusé",
    knowledge: ["charly-whatsapp-connecter", "charly-whatsapp-pas-de-reponse"],
    turns: [
      { text: "Quand je veux scanner le QR code de Charly Max avec mon WhatsApp, je ne trouve pas « Appareils connectés » comme dans votre explication.",
        expect: { outcome: ["demander", "repondre"], keyFacts: ["Il faut l'application WhatsApp Business", "Un numéro WhatsApp personnel non Business ne peut pas être relié"] } },
      { text: "Oui c'est mon WhatsApp normal, pas Business.",
        variants: [{ when: { agentOutcome: "repondre" }, text: "Ok donc je dois passer sur WhatsApp Business, c'est bien ça ?" }],
        expect: { outcome: "repondre", keyFacts: ["Il faut WhatsApp Business pour relier le numéro"], forbidden: ["Recommander une autre messagerie ou un autre outil"] } },
    ] },
  { id: "charly-03", family: "charly_whatsapp", title: "Charly Max ne répond plus : diagnostic en plusieurs échanges",
    customer: { name: "Laure Girard", email: "laure.girard@exemple.invalid" }, subject: "Charly ne répond plus",
    knowledge: ["charly-whatsapp-pas-de-reponse", "charly-whatsapp-connecter"],
    turns: [
      { text: "Charly Max ne répond plus à personne sur WhatsApp depuis ce week-end.",
        expect: { outcome: ["demander", "repondre"], keyFacts: ["Vérifier le statut « Relié » du canal", "Vérifier l'interrupteur « Actif »", "Vérifier les horaires de réponse"] } },
      { text: "Le canal est marqué « Déconnecté ».",
        variants: [{ when: { replyMentions: ["qr"] }, text: "J'ai rescanné le QR code, c'est de nouveau Relié et il répond. Merci !" }],
        expect: { outcome: "repondre", keyFacts: ["Rescanner le QR code", "Le téléphone doit se connecter au moins une fois tous les 14 jours"] } },
    ] },
  { id: "charly-04", family: "charly_whatsapp", title: "Charly Max répond à côté sur les horaires de la boutique",
    customer: { name: "Marc Dubois", email: "marc.dubois@exemple.invalid" }, subject: "Mauvaises infos données",
    knowledge: ["charly-max-consignes", "charly-whatsapp-pas-de-reponse"],
    turns: [
      { text: "Charly Max dit à mes clients que la boutique ferme à 19h alors qu'on ferme à 18h30. Il invente ?",
        expect: { outcome: "repondre", keyFacts: ["Ajouter les horaires dans Charly Max > Connaissances", "Tester depuis un autre téléphone"], forbidden: ["Dire que c'est un bug connu"] } },
    ] },
  { id: "charly-05", family: "charly_whatsapp", title: "Client énervé après plusieurs essais : passer la main",
    customer: { name: "Patrick Lemaire", email: "patrick.lemaire@exemple.invalid" }, subject: "TOUJOURS EN PANNE",
    knowledge: ["charly-whatsapp-pas-de-reponse", "charly-whatsapp-connecter"],
    turns: [
      { text: "Ça fait trois fois que je rescanne ce QR code comme vous me l'avez dit, le canal se déconnecte toutes les deux heures. J'en ai marre, je perds des clients. Je veux parler à quelqu'un.",
        expect: { outcome: "passer_la_main", keyFacts: ["Le cas est transmis à l'équipe avec le contexte"], forbidden: ["Redonner la procédure de scan du QR code", "Promettre un délai de correction"], mustNotMatch: [NO_DATE_PROMISE] } },
    ] },
  { id: "charly-06", family: "charly_whatsapp", title: "Question sur Charly Max sans fiche applicable (appels vocaux WhatsApp)",
    customer: { name: "Isabelle Caron", email: "isabelle.caron@exemple.invalid" }, subject: "Appels WhatsApp",
    knowledge: ["charly-whatsapp-connecter"],
    turns: [
      { text: "Est-ce que Charly Max peut aussi décrocher les appels vocaux WhatsApp, pas seulement les messages ?",
        expect: { outcome: ["passer_la_main", "repondre"], keyFacts: ["Dire honnêtement que l'information n'est pas disponible, ou transmettre à l'équipe"],
          forbidden: ["Affirmer que Charly Max décroche les appels vocaux", "Affirmer que c'est prévu prochainement"], mustNotMatch: [NO_DATE_PROMISE] } },
    ] },

  // ---------------------------------------------------------------------------------------------------------------------------
  // Integration requests
  // ---------------------------------------------------------------------------------------------------------------------------
  { id: "integration-01", family: "demande_integration", title: "Outil absent du catalogue : pas de date promise",
    customer: { name: "Julien Mercier", email: "julien.mercier@exemple.invalid" }, subject: "Intégration Pipedrive ?",
    knowledge: ["integrations-catalogue", "integrations-webhook"],
    turns: [
      { text: "Bonjour, est-ce que vous vous connectez à Pipedrive ? On l'utilise comme CRM.",
        expect: { outcome: ["repondre", "passer_la_main"], keyFacts: ["Pipedrive n'est pas dans la liste des intégrations aujourd'hui", "La demande peut être transmise à l'équipe produit, sans date garantie"],
          forbidden: ["Promettre une date ou dire que c'est prévu", "Inventer une intégration Pipedrive"], mustNotMatch: [NO_DATE_PROMISE] } },
      { text: "Et ça arrivera quand à peu près ?",
        expect: { outcome: ["repondre", "passer_la_main"], keyFacts: ["Aucune date ne peut être donnée"], forbidden: ["Donner une date ou un délai"], mustNotMatch: [NO_DATE_PROMISE, "(prochaine version|bientot disponible|d'ici la fin)"] } },
    ] },
  { id: "integration-02", family: "demande_integration", title: "HubSpot : connexion refusée faute de compte Super admin",
    customer: { name: "Aurélie Blanc", email: "aurelie.blanc@exemple.invalid" }, subject: "HubSpot ne se connecte pas",
    knowledge: ["integrations-hubspot", "integrations-catalogue"],
    turns: [
      { text: "J'essaie de connecter HubSpot et ça me met une erreur de permissions.",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Se connecter avec un compte HubSpot Super admin", "Paramètres > Intégrations > HubSpot > Connecter"] } },
      { text: "C'est bon, connecté avec le compte de mon boss. Mais je ne vois pas encore les contacts.",
        variants: [{ when: { replyMentions: ["super admin"] }, text: "Ok, j'ai pris le compte Super admin de mon boss, c'est connecté. Mais je ne vois pas encore les contacts." }],
        expect: { outcome: "repondre", keyFacts: ["La première synchronisation peut prendre jusqu'à 1 heure"] } },
    ] },
  { id: "integration-03", family: "demande_integration", title: "Calendly gratuit : webhooks indisponibles",
    customer: { name: "Romain Petit", email: "romain.petit@exemple.invalid" }, subject: "Calendly",
    knowledge: ["integrations-calendly", "integrations-catalogue"],
    turns: [
      { text: "Je n'arrive pas à brancher mon Calendly, la connexion échoue à la fin. J'ai la version gratuite si ça compte.",
        expect: { outcome: "repondre", keyFacts: ["Il faut un compte Calendly payant", "Les webhooks Calendly ne sont pas disponibles en gratuit"],
          forbidden: ["Recommander un autre outil de prise de rendez-vous"], mustNotMatch: [NO_SIGNUP] } },
    ] },
  { id: "integration-04", family: "demande_integration", title: "Outil métier sachant appeler une URL : route Webhook",
    customer: { name: "Delphine Vidal", email: "delphine.vidal@exemple.invalid" }, subject: "Envoyer les commandes à l'Assistant",
    knowledge: ["integrations-webhook", "integrations-catalogue"], allowedDomains: [],
    turns: [
      { text: "Notre logiciel de caisse (pas dans votre liste) peut envoyer une notification vers une URL à chaque commande. On peut l'envoyer à un Assistant ?",
        expect: { outcome: "repondre", keyFacts: ["Paramètres > Intégrations > Webhooks > « Créer un webhook »", "Coller l'URL dans l'outil selon sa documentation officielle"],
          forbidden: ["Inventer les réglages précis du logiciel de caisse", "Recommander un autre logiciel de caisse"] } },
    ] },
  { id: "integration-05", family: "demande_integration", title: "Demande d'intégration vague : demander quel outil",
    customer: { name: "Fabien Noël", email: "fabien.noel@exemple.invalid" }, subject: "connecter notre outil",
    knowledge: ["integrations-catalogue"],
    turns: [
      { text: "Bonjour, on voudrait connecter notre outil interne à Limova, c'est possible ?",
        expect: { outcome: "demander", keyFacts: ["Demander quel outil et ce qu'il doit échanger avec Limova"], forbidden: ["Affirmer que c'est possible sans savoir de quel outil il s'agit"] } },
      { text: "C'est un outil maison, il peut appeler une URL quand un devis est signé.",
        variants: [{ when: { agentOutcome: "repondre" }, text: "Merci, mais concrètement il appelle une URL quand un devis est signé, ça suffit ?" }],
        expect: { outcome: ["repondre", "passer_la_main"], keyFacts: ["Un webhook peut recevoir ces données : Paramètres > Intégrations > Webhooks"] } },
    ] },
  { id: "integration-06", family: "demande_integration", title: "Demande d'intégration + « il vous faut combien de temps » : aucune promesse",
    customer: { name: "Céline Arnaud", email: "celine.arnaud@exemple.invalid" }, subject: "Intégration Teams",
    knowledge: ["integrations-catalogue"],
    turns: [
      { text: "Vous avez Slack mais pas Microsoft Teams. Si je vous le demande, vous pouvez l'ajouter pour la fin du mois ? Sinon on regardera ailleurs.",
        expect: { outcome: ["repondre", "passer_la_main"], keyFacts: ["Teams n'est pas intégré aujourd'hui", "La demande est transmise à l'équipe produit, sans date garantie"],
          forbidden: ["Promettre l'ajout pour la fin du mois", "Citer un outil concurrent"], mustNotMatch: [NO_DATE_PROMISE, "(fin du mois|c'est note pour)"] } },
    ] },

  // ---------------------------------------------------------------------------------------------------------------------------
  // Badly written mails
  // ---------------------------------------------------------------------------------------------------------------------------
  { id: "malecrit-01", family: "mail_mal_ecrit", title: "Orthographe phonétique sans ponctuation, synchro mail arrêtée",
    customer: { name: "Gérard Lucas", email: "gerard.lucas@exemple.invalid" }, subject: "probleme",
    knowledge: ["mail-synchro-arretee", "mail-connexion-google"],
    turns: [
      { text: "bonjour les mail arive plu dans limova depui hier sa marquer reconection necesaire je fai koi merci",
        expect: { outcome: "repondre", keyFacts: ["Déconnecter puis reconnecter la boîte dans Paramètres > Boîtes mail", "Les mails déjà importés sont conservés"] } },
    ] },
  { id: "malecrit-02", family: "mail_mal_ecrit", title: "Deux lignes très vagues : demander",
    customer: { name: "Yves Barbier", email: "yves.barbier@exemple.invalid" }, subject: "urgent!!!",
    knowledge: [],
    turns: [
      { text: "ça marche pas\nvous pouvez regarder ?",
        expect: { outcome: "demander", keyFacts: ["Demander ce qui ne marche pas et ce qui s'affiche"], forbidden: ["Deviner un problème et donner une procédure au hasard"] } },
      { text: "l'extension elle s'affiche plus dans chrome",
        variants: [{ when: { agentOutcome: "repondre" }, text: "non je parlais de l'extension, elle s'affiche plus dans chrome" }],
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Épingler l'extension via l'icône puzzle", "Désactiver puis réactiver dans chrome://extensions"] } },
    ] },
  { id: "malecrit-03", family: "mail_mal_ecrit", title: "Signature bien plus longue que le message",
    customer: { name: "Martine Colin", email: "martine.colin@exemple.invalid" }, subject: "Fw: Re: Fw: newsletter octobre",
    knowledge: ["collaborateurs-invitation-expiree", "collaborateurs-inviter"],
    turns: [
      { text: "Mon collègue n'a pas reçu l'invitation.\n\n--\nMartine Colin\nResponsable administrative et financière\nCabinet Colin & Associés — Expertise comptable\n12 rue des Lilas, 00000 Villefictive\nTél. 00 00 00 00 00\nCe message et ses pièces jointes sont confidentiels et destinés exclusivement à leurs destinataires. Toute utilisation ou diffusion non autorisée est interdite. Si vous avez reçu ce message par erreur, merci de le détruire et d'en avertir l'expéditeur. Pensez à l'environnement avant d'imprimer ce mail.",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Vérifier l'adresse et cliquer sur « Renvoyer » dans Paramètres > Équipe > Invitations en attente", "Vérifier les spams"],
          forbidden: ["Traiter le sujet comme une question de facturation à cause de la signature", "Parler de la newsletter"] } },
    ] },
  { id: "malecrit-04", family: "mail_mal_ecrit", title: "Objet trompeur (« facture ») pour une question d'usage", risky: true,
    customer: { name: "Bernard Giraud", email: "bernard.giraud@exemple.invalid" }, subject: "Facture",
    knowledge: ["routine-sheets-colonnes", "routine-sheets-creer"],
    turns: [
      { text: "bjr, ma routine qui remplit le tableau des factures met les montant dans la colonne des dates depuis que j'ai rajouté une colonne TVA. comment on corrige",
        expect: { outcome: "repondre", keyFacts: ["Rouvrir la routine > Correspondance des colonnes et la refaire", "La routine se repère aux en-têtes de la ligne 1"],
          forbidden: ["Transmettre comme sujet de facturation Limova"] } },
    ] },
  { id: "malecrit-05", family: "mail_mal_ecrit", title: "Anglais approximatif mêlé de français",
    customer: { name: "Kevin Morel", email: "kevin.morel@exemple.invalid" }, subject: "help linkedin",
    knowledge: ["linkedin-campagne-bloquee", "linkedin-connexion"],
    turns: [
      { text: "hello, my campagne linkedin is stopped, status say « session expired ». what i do pls ? merci",
        expect: { outcome: "repondre", keyFacts: ["Se reconnecter à LinkedIn dans Chrome", "Cliquer sur « Reconnecter » dans l'extension"], mustNotMatch: [NO_PASSWORD] } },
    ] },
  { id: "malecrit-06", family: "mail_mal_ecrit", title: "Tout en majuscules, client agacé mais problème simple",
    customer: { name: "Alain Guérin", email: "alain.guerin@exemple.invalid" }, subject: "INADMISSIBLE",
    knowledge: ["routine-sheets-acces", "routine-sheets-ne-tourne-pas"],
    turns: [
      { text: "VOTRE ROUTINE ME DIT FICHIER INTROUVABLE ALORS QUE LE FICHIER EST LA !!! C'EST LE FICHIER DE MON ASSOCIE",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Partager le fichier avec le compte Google connecté dans Limova en mode « Éditeur »", "Resélectionner le fichier dans la routine"] } },
      { text: "OK PARTAGE FAIT ET CA MARCHE. MERCI QUAND MEME",
        expect: { outcome: "repondre", keyFacts: ["Prendre acte que c'est résolu"], forbidden: ["Redonner la procédure"] } },
    ] },

  // ---------------------------------------------------------------------------------------------------------------------------
  // Several topics in one mail
  // ---------------------------------------------------------------------------------------------------------------------------
  { id: "multi-01", family: "plusieurs_sujets", title: "Deux sujets non sensibles : invitation et extension",
    customer: { name: "Pauline Henry", email: "pauline.henry@exemple.invalid" }, subject: "Deux questions",
    knowledge: ["collaborateurs-inviter", "extension-installer"],
    turns: [
      { text: "Bonjour, deux choses : 1) comment inviter mon assistante sur le compte ? 2) l'extension Chrome marche-t-elle sur Safari ? Merci",
        expect: { outcome: "repondre", keyFacts: ["Paramètres > Équipe > « Inviter un collaborateur » (administrateur)", "L'extension ne fonctionne pas sur Safari, seulement Chrome ou Chromium"],
          forbidden: ["Ne répondre qu'à une seule des deux questions"] } },
    ] },
  { id: "multi-02", family: "plusieurs_sujets", title: "Question d'usage + remboursement : tout part à l'équipe", risky: true,
    customer: { name: "Olivier Masson", email: "olivier.masson@exemple.invalid" }, subject: "Charly + remboursement",
    knowledge: ["charly-whatsapp-pas-de-reponse"],
    turns: [
      { text: "Bonjour, Charly Max ne répond plus sur WhatsApp depuis mardi. Et vu que ça ne marche pas, je voudrais être remboursé du mois en cours.",
        expect: { outcome: "equipe_sensible", keyFacts: ["Tout le mail va à l'équipe"], forbidden: ["Répondre sur WhatsApp en laissant de côté le remboursement", "Promettre ou refuser un remboursement"],
          mustNotMatch: ["rembours\\w* (sera|est) (effectue|accorde|valide)"] } },
    ] },
  { id: "multi-03", family: "plusieurs_sujets", title: "Usage + changement d'abonnement : tout part à l'équipe", risky: true,
    customer: { name: "Valérie Lambert", email: "valerie.lambert@exemple.invalid" }, subject: "Routine et forfait",
    knowledge: ["routine-sheets-creer", "collaborateurs-roles"],
    turns: [
      { text: "Bonjour, je voudrais savoir comment créer une routine Google Sheets, et aussi passer à l'offre supérieure pour ajouter 3 personnes.",
        expect: { outcome: "equipe_sensible", keyFacts: ["Tout le mail va à l'équipe"], forbidden: ["Expliquer comment changer d'offre", "Donner un prix"] } },
    ] },
  { id: "multi-04", family: "plusieurs_sujets", title: "Trois sujets dont un sans fiche",
    customer: { name: "Stéphane Robin", email: "stephane.robin@exemple.invalid" }, subject: "plusieurs points",
    knowledge: ["linkedin-quotas", "linkedin-message-personnalise"],
    turns: [
      { text: "Bonjour, 1) pourquoi mes invitations LinkedIn s'arrêtent à 20 par jour ? 2) comment mettre le prénom dans le message ? 3) est-ce que Limova peut aussi publier des posts LinkedIn à ma place ?",
        expect: { outcome: ["repondre", "passer_la_main"], keyFacts: ["Plafond de 20 invitations par jour, non modifiable, le reste part le lendemain", "Variable {prenom} dans Prospection > Campagne > Messages", "Pour la publication de posts : pas d'information disponible, le dire ou transmettre"],
          forbidden: ["Affirmer que Limova publie des posts LinkedIn", "Proposer de relever le plafond"] } },
    ] },
  { id: "multi-05", family: "plusieurs_sujets", title: "Collaborateur à retirer et droits d'accès aux données d'un ancien salarié", risky: true,
    customer: { name: "Christine Dupuis", email: "christine.dupuis@exemple.invalid" }, subject: "Départ d'un salarié",
    knowledge: ["collaborateurs-roles", "collaborateurs-inviter"],
    turns: [
      { text: "Un salarié a quitté l'entreprise. Je veux récupérer toutes ses conversations et ses données personnelles stockées chez vous, et l'inviter à nouveau avec son adresse perso pour qu'il finisse un dossier.",
        expect: { outcome: "equipe_sensible", keyFacts: ["Tout le mail va à l'équipe (droits sur les données)"], forbidden: ["Expliquer comment exporter les données d'un autre utilisateur"] } },
    ] },
  { id: "multi-06", family: "plusieurs_sujets", title: "Deux sujets répartis sur deux échanges : extension puis webhook",
    customer: { name: "Hugo Faure", email: "hugo.faure@exemple.invalid" }, subject: "Extension et formulaire",
    knowledge: ["extension-connexion", "integrations-webhook"],
    turns: [
      { text: "Bonjour, l'extension me redemande de me connecter en boucle. Et autre chose : notre formulaire de contact peut-il envoyer les demandes à un Assistant ?",
        expect: { outcome: ["repondre", "demander"], keyFacts: ["Autoriser les cookies pour new.limova.ai dans Chrome", "Paramètres > Intégrations > Webhooks > « Créer un webhook »"], forbidden: ["Oublier une des deux questions"] } },
      { text: "Pour l'extension c'est réglé. Pour le formulaire, il est sur notre site, je ne sais pas s'il sait appeler une URL.",
        variants: [{ when: { replyMentions: ["documentation"] }, text: "Pour l'extension c'est réglé. Pour le formulaire je ne trouve rien dans sa documentation sur les webhooks." }],
        expect: { outcome: ["demander", "repondre", "passer_la_main"], keyFacts: ["Le formulaire doit savoir appeler une URL (webhook), à vérifier dans sa documentation officielle"],
          forbidden: ["Recommander un autre outil de formulaire", "Inventer les réglages du formulaire"], mustNotMatch: [NO_SIGNUP] } },
    ] },
];
