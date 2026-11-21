import type { SavBenchCard } from "./bench-types";

/*
 * SAV-109: the bench's FICTIONAL knowledge cards. Written for the bench only: they are NOT Limova's published cards and are not read from them.
 * Inside the bench they are the only source of truth about Limova: a reply's fact about Limova must come from one of the cards the conversation
 * provides, and the judge checks it against them. Temporary cards carry `validUntil`; the bench's clock is `SAV_BENCH_NOW` (20/11/2026), so a card
 * whose date is past is expired and must not be used.
 */
export const SAV_BENCH_NOW = "2026-11-20T09:00:00.000Z";
const LOGIN = "https://new.limova.ai";
const STORE = "https://chromewebstore.google.com/detail/limova-ai-assistant-onboa/fpkgfhhomlijmhbgcpbpjnfafdedfccj";
const WEBINARS = "https://bienvenue.limova.ai/webinaires";

export const SAV_BENCH_KNOWLEDGE: readonly SavBenchCard[] = [
  // Mail connection (Nylas / IMAP / SMTP).
  { id: "mail-connexion-google", title: "Connecter une boîte Gmail ou Google Workspace", content: "La connexion d'une boîte Google passe par le bouton « Connecter Google » dans Paramètres > Boîtes mail. Le client se connecte lui-même sur la page Google et accepte les autorisations demandées. Limova ne demande jamais le mot de passe de la boîte.",
    steps: ["Ouvrir Paramètres > Boîtes mail", "Cliquer sur « Connecter Google »", "Choisir le compte et accepter toutes les autorisations demandées", "Vérifier que la boîte apparaît avec le statut « Connectée »"] },
  { id: "mail-connexion-outlook", title: "Connecter une boîte Outlook ou Microsoft 365", content: "Pour Outlook et Microsoft 365, utiliser le bouton « Connecter Microsoft ». Si l'entreprise bloque les applications tierces, l'administrateur Microsoft du client doit autoriser l'application dans son centre d'administration.",
    steps: ["Ouvrir Paramètres > Boîtes mail", "Cliquer sur « Connecter Microsoft »", "Se connecter et accepter les autorisations", "Si un message « Approbation de l'administrateur requise » s'affiche, demander à l'administrateur Microsoft de l'entreprise d'approuver l'application"] },
  { id: "mail-imap-parametres", title: "Connecter une boîte par IMAP / SMTP", content: "Pour les autres fournisseurs (OVH, Ionos, o2switch...), choisir « Autre fournisseur (IMAP/SMTP) ». Réglages habituels : IMAP port 993 en SSL, SMTP port 465 en SSL ou 587 en STARTTLS. Les noms de serveur exacts sont donnés par l'hébergeur de la boîte. Le client saisit lui-même ses identifiants dans le formulaire, jamais par mail au support.",
    steps: ["Ouvrir Paramètres > Boîtes mail > « Autre fournisseur (IMAP/SMTP) »", "Renseigner le serveur IMAP (port 993, SSL) et le serveur SMTP (port 465 SSL ou 587 STARTTLS) donnés par l'hébergeur", "Saisir soi-même l'adresse et le mot de passe de la boîte dans le formulaire", "Cliquer sur « Tester la connexion »"] },
  { id: "mail-mot-de-passe-application", title: "Erreur d'authentification IMAP : mot de passe d'application", content: "Quand la double authentification est active chez le fournisseur, la connexion IMAP refuse le mot de passe habituel (erreur « Authentication failed »). Il faut créer un mot de passe d'application dans le compte du fournisseur, puis le saisir soi-même dans le formulaire IMAP de Limova. Le support ne doit jamais le recevoir.",
    steps: ["Créer un mot de passe d'application dans les réglages de sécurité du compte mail", "Le saisir soi-même dans le formulaire IMAP de Limova à la place du mot de passe habituel", "Cliquer sur « Tester la connexion »"] },
  { id: "mail-synchro-arretee", title: "Boîte connectée mais les mails n'arrivent plus", content: "Si la boîte affiche « Reconnexion nécessaire » ou si les nouveaux mails n'apparaissent plus depuis plus d'une heure, l'autorisation a expiré (changement de mot de passe, révocation). Il faut déconnecter puis reconnecter la boîte. Les mails déjà importés sont conservés.",
    steps: ["Ouvrir Paramètres > Boîtes mail", "Cliquer sur « Déconnecter » à côté de la boîte", "La reconnecter avec le même bouton qu'à l'origine (Google, Microsoft ou IMAP)", "Attendre jusqu'à 15 minutes la première synchronisation"] },
  { id: "mail-smtp-envoi", title: "Les mails envoyés par l'Assistant partent en erreur", content: "Une erreur d'envoi « SMTP 535 » signifie que les identifiants SMTP sont refusés ; « SMTP 550 » que l'adresse du destinataire est refusée par son serveur. Pour la 535, ressaisir le mot de passe (ou le mot de passe d'application) dans Paramètres > Boîtes mail > Modifier. Pour la 550, vérifier l'adresse du destinataire.",
    steps: ["Ouvrir l'historique d'envoi de l'Assistant et lire le code d'erreur", "535 : Paramètres > Boîtes mail > Modifier, ressaisir soi-même le mot de passe SMTP", "550 : vérifier l'orthographe de l'adresse du destinataire"] },

  // Google Sheets routines.
  { id: "routine-sheets-creer", title: "Créer une routine Google Sheets", content: "Une routine lit ou écrit dans un Google Sheets à intervalle régulier. Elle se crée dans l'Assistant > Routines > Nouvelle routine > Google Sheets. La fréquence minimale est d'une exécution par heure.",
    steps: ["Ouvrir l'Assistant concerné > Routines", "Cliquer sur « Nouvelle routine » puis « Google Sheets »", "Choisir le fichier et l'onglet", "Choisir la fréquence (au minimum toutes les heures) et enregistrer"] },
  { id: "routine-sheets-acces", title: "Routine Sheets : « Fichier introuvable » ou « Accès refusé »", content: "La routine utilise le compte Google connecté dans Limova. Si le fichier appartient à un autre compte, il doit être partagé avec ce compte Google en mode « Éditeur ». Un fichier déplacé dans la corbeille ou renommé doit être resélectionné dans la routine.",
    steps: ["Vérifier quel compte Google est connecté dans Paramètres > Intégrations > Google", "Partager le fichier avec ce compte en mode « Éditeur »", "Rouvrir la routine et resélectionner le fichier et l'onglet"] },
  { id: "routine-sheets-colonnes", title: "Routine Sheets : les données vont dans les mauvaises colonnes", content: "La routine se repère aux en-têtes de la ligne 1. Si une colonne est ajoutée, renommée ou déplacée, il faut rouvrir la routine et refaire la correspondance des colonnes. Les cellules fusionnées en ligne 1 empêchent la lecture des en-têtes.",
    steps: ["Vérifier que la ligne 1 contient un en-tête par colonne, sans cellule fusionnée", "Rouvrir la routine > Correspondance des colonnes", "Refaire la correspondance et enregistrer", "Lancer « Exécuter maintenant » pour tester"] },
  { id: "routine-sheets-ne-tourne-pas", title: "Routine Sheets qui ne se lance pas", content: "Une routine en pause ou dont la dernière exécution a échoué trois fois de suite est suspendue. Son statut s'affiche dans Routines. Il faut corriger la cause indiquée dans l'historique, puis cliquer sur « Réactiver ».",
    steps: ["Ouvrir l'Assistant > Routines", "Lire le statut et le dernier message d'erreur dans l'historique", "Corriger la cause indiquée", "Cliquer sur « Réactiver » puis « Exécuter maintenant »"] },
  { id: "incident-sheets-resolu", title: "Incident de synchronisation Google Sheets du 3 au 5 novembre (résolu)", content: "Un incident a empêché certaines routines Google Sheets de s'exécuter du 3 au 5 novembre 2026. Il est résolu depuis le 5 novembre au soir. Les routines suspendues pendant l'incident doivent être réactivées à la main (bouton « Réactiver »).",
    steps: ["Ouvrir l'Assistant > Routines", "Cliquer sur « Réactiver » pour chaque routine suspendue", "Lancer « Exécuter maintenant » pour vérifier"] },
  { id: "incident-sheets-en-cours", title: "TEMPORAIRE : incident en cours sur les routines Google Sheets", content: "Incident en cours : certaines routines Google Sheets ne s'exécutent pas. L'équipe technique corrige ; inutile de modifier la routine. Message temporaire.",
    steps: ["Indiquer au client que l'incident est connu et en cours de correction"], validUntil: "2026-11-06T00:00:00.000Z" },

  // An Assistant doing a task badly.
  { id: "assistant-charte", title: "Faire respecter une charte (ton, mise en forme) à un Assistant", content: "Un Assistant suit la charte qu'on lui donne dans Paramètres de l'Assistant > Connaissances : déposer le document de charte (PDF ou Google Docs) et ajouter dans les Consignes une phrase qui demande de la respecter. Les consignes courtes et précises sont mieux suivies que les longues. Après modification, tester dans une nouvelle conversation.",
    steps: ["Ouvrir l'Assistant > Paramètres > Connaissances et déposer la charte", "Dans Consignes, écrire une consigne courte, par exemple « Respecte toujours la charte jointe (ton, vouvoiement, signature) »", "Ouvrir une NOUVELLE conversation pour tester (les anciennes gardent les anciennes consignes)"] },
  { id: "assistant-consignes", title: "Un Assistant ne fait pas ce qu'on lui demande", content: "Quand un Assistant exécute mal une tâche, la cause la plus fréquente est une consigne ambiguë ou contradictoire. Il faut reformuler la consigne en une étape par ligne, donner un exemple du résultat attendu, et tester dans une nouvelle conversation. Si le résultat reste faux avec une consigne claire, transmettre à l'équipe un exemple de conversation.",
    steps: ["Relire les Consignes de l'Assistant et retirer les consignes contradictoires", "Écrire une étape par ligne et ajouter un exemple du résultat attendu", "Tester dans une nouvelle conversation"] },
  { id: "assistant-sheets-ecriture", title: "L'Assistant écrit mal dans un Google Sheets", content: "Quand un Assistant écrit dans un Google Sheets (dates au mauvais format, lignes écrasées), vérifier le format des colonnes dans le fichier (Format > Nombre > Date) et préciser dans les Consignes « ajoute une nouvelle ligne à la fin, n'écrase jamais une ligne existante ».",
    steps: ["Mettre la colonne des dates au format Date dans Google Sheets", "Ajouter la consigne « ajoute une nouvelle ligne à la fin, n'écrase jamais une ligne existante »", "Tester avec un exemple"] },

  // LinkedIn and prospecting.
  { id: "linkedin-connexion", title: "Connecter LinkedIn à Limova", content: "LinkedIn se connecte via l'extension Chrome Limova : être connecté à LinkedIn dans Chrome, ouvrir l'extension et cliquer sur « Connecter LinkedIn ». Limova ne demande jamais l'identifiant ni le mot de passe LinkedIn.",
    steps: ["Installer l'extension Chrome Limova", "Se connecter à LinkedIn dans le même navigateur Chrome", "Ouvrir l'extension et cliquer sur « Connecter LinkedIn »"], links: [STORE] },
  { id: "linkedin-quotas", title: "Limites d'envoi de la prospection LinkedIn", content: "Pour protéger le compte LinkedIn du client, Limova envoie au plus 20 invitations et 50 messages par jour et par compte. La limite de 20 invitations par jour vient aussi de LinkedIn et de sa politique stricte : l'augmenter risquerait de faire suspendre le compte LinkedIn du client. Limova ne peut donc pas la relever, même avec une option payante. Ces plafonds ne sont pas modifiables. Les invitations au-delà sont reportées au lendemain.",
    steps: ["Vérifier dans Prospection > Campagne le nombre d'invitations envoyées aujourd'hui", "Les invitations au-delà de 20 par jour partent automatiquement le lendemain", "Ne pas chercher à relever la limite, même en payant : LinkedIn pourrait suspendre le compte"] },
  { id: "linkedin-campagne-bloquee", title: "Campagne LinkedIn à l'arrêt", content: "Une campagne LinkedIn s'arrête quand la session LinkedIn a expiré (déconnexion de LinkedIn dans Chrome) : le statut affiche « Session expirée ». Il faut se reconnecter à LinkedIn dans Chrome, puis cliquer sur « Reconnecter » dans l'extension. La campagne reprend seule.",
    steps: ["Se reconnecter à LinkedIn dans Chrome", "Ouvrir l'extension Limova et cliquer sur « Reconnecter »", "Vérifier que la campagne repasse au statut « Active »"] },
  { id: "linkedin-message-personnalise", title: "Personnaliser les messages de prospection", content: "Les messages de campagne acceptent les variables {prenom}, {entreprise} et {poste}. Une variable vide chez un contact est remplacée par rien : prévoir une phrase qui reste correcte sans elle.",
    steps: ["Ouvrir Prospection > Campagne > Messages", "Insérer les variables {prenom}, {entreprise} ou {poste}", "Prévisualiser avec un contact"] },

  // Chrome extension.
  { id: "extension-installer", title: "Installer l'extension Chrome Limova", content: "L'extension « Limova AI - Assistant Onboarding » s'installe depuis le Chrome Web Store, sur Google Chrome ou un navigateur basé sur Chromium. Elle ne fonctionne pas sur Safari ni Firefox. Le tutoriel vidéo est dans l'Academy.",
    steps: ["Ouvrir le lien du Chrome Web Store", "Cliquer sur « Ajouter à Chrome »", "Épingler l'extension avec l'icône puzzle", "Se connecter avec son compte Limova"], links: [STORE] },
  { id: "extension-invisible", title: "L'extension n'apparaît pas ou ne répond plus", content: "Si l'icône n'apparaît pas, l'épingler via l'icône puzzle de Chrome. Si elle ne répond plus, recharger la page, puis désactiver et réactiver l'extension dans chrome://extensions. Une mise à jour de Chrome peut nécessiter de redémarrer le navigateur.",
    steps: ["Épingler l'extension via l'icône puzzle", "Recharger la page", "Dans chrome://extensions, désactiver puis réactiver l'extension", "Redémarrer Chrome si besoin"] },
  { id: "extension-connexion", title: "L'extension demande de se reconnecter en boucle", content: "Si l'extension redemande la connexion en boucle, les cookies tiers sont souvent bloqués. Autoriser les cookies pour new.limova.ai dans Chrome (Paramètres > Confidentialité > Cookies), puis se reconnecter.",
    steps: ["Chrome > Paramètres > Confidentialité et sécurité > Cookies tiers", "Ajouter new.limova.ai aux sites autorisés", "Se reconnecter dans l'extension"] },

  // Access and collaborators.
  { id: "acces-connexion", title: "Se connecter à Limova", content: `La connexion se fait sur ${LOGIN} avec l'adresse mail du compte. En cas d'oubli du mot de passe, cliquer sur « Mot de passe oublié » : un lien de réinitialisation est envoyé par mail, valable 1 heure. Le support ne demande jamais le mot de passe.`,
    steps: [`Aller sur ${LOGIN}`, "Cliquer sur « Mot de passe oublié » et saisir l'adresse du compte", "Ouvrir le mail reçu (vérifier les spams) et choisir un nouveau mot de passe dans l'heure"], links: [LOGIN] },
  { id: "acces-mail-reinitialisation", title: "Le mail de réinitialisation n'arrive pas", content: "Le mail de réinitialisation arrive en moins de 5 minutes. S'il n'arrive pas, vérifier les spams et l'orthographe de l'adresse. Une adresse sans compte ne reçoit rien. Si le client ne sait plus quelle adresse il a utilisée, passer la main à l'équipe.",
    steps: ["Vérifier les spams et les promotions", "Vérifier l'adresse saisie", "Refaire la demande une seule fois"] },
  { id: "collaborateurs-inviter", title: "Inviter un collaborateur", content: "Seul un administrateur du compte peut inviter : Paramètres > Équipe > « Inviter un collaborateur ». L'invité reçoit un mail et crée son mot de passe. L'invitation est valable 7 jours ; au-delà, il faut la renvoyer.",
    steps: ["Paramètres > Équipe", "Cliquer sur « Inviter un collaborateur » et saisir son adresse", "Choisir son rôle (Administrateur ou Membre)", "Prévenir le collaborateur de surveiller ses spams"] },
  { id: "collaborateurs-roles", title: "Rôles des collaborateurs", content: "Un Membre utilise les Assistants partagés avec lui ; un Administrateur gère aussi l'équipe et les intégrations. Le rôle se change dans Paramètres > Équipe > menu « ... » du collaborateur. Le changement d'abonnement ou de facturation n'est jamais lié au rôle et se traite avec l'équipe.",
    steps: ["Paramètres > Équipe", "Menu « ... » du collaborateur > « Changer le rôle »"] },
  { id: "collaborateurs-invitation-expiree", title: "Le collaborateur n'a pas reçu l'invitation ou elle a expiré", content: "Une invitation expire après 7 jours. Dans Paramètres > Équipe, l'invitation en attente a un bouton « Renvoyer ». Vérifier l'orthographe de l'adresse ; une faute oblige à annuler l'invitation et à en créer une nouvelle.",
    steps: ["Paramètres > Équipe > Invitations en attente", "Vérifier l'adresse", "Cliquer sur « Renvoyer » (ou annuler et réinviter si l'adresse est fausse)"] },
  { id: "assistant-partage", title: "Partager un Assistant avec un collaborateur", content: "Un Assistant est privé par défaut. Pour qu'un collaborateur le voie : Assistant > Partager > choisir le collaborateur. Le collaborateur doit d'abord avoir accepté son invitation dans l'équipe.",
    steps: ["Ouvrir l'Assistant > Partager", "Choisir le collaborateur dans la liste de l'équipe", "Lui demander de rafraîchir sa page"] },

  // Charly Max / WhatsApp.
  { id: "charly-whatsapp-connecter", title: "Connecter WhatsApp à Charly Max", content: "Charly Max répond sur WhatsApp une fois le numéro relié : Charly Max > Canaux > WhatsApp > « Relier un numéro », puis scanner le QR code avec l'application WhatsApp Business du téléphone (Appareils connectés). Un numéro WhatsApp personnel non Business ne peut pas être relié.",
    steps: ["Charly Max > Canaux > WhatsApp > « Relier un numéro »", "Sur le téléphone : WhatsApp Business > Appareils connectés > Connecter un appareil", "Scanner le QR code affiché"] },
  { id: "charly-whatsapp-pas-de-reponse", title: "Charly Max ne répond pas sur WhatsApp", content: "Vérifier trois choses : le canal WhatsApp est au statut « Relié » (sinon rescanner le QR code), Charly Max est « Actif » (interrupteur en haut de page), et les horaires de réponse couvrent le moment du message. Le téléphone doit être allumé et connecté au moins une fois tous les 14 jours.",
    steps: ["Charly Max > Canaux : vérifier le statut « Relié »", "Vérifier que l'interrupteur « Actif » est allumé", "Vérifier les horaires de réponse", "Si « Déconnecté » : rescanner le QR code"] },
  { id: "charly-max-consignes", title: "Charly Max répond à côté", content: "Charly Max répond à partir de ses Connaissances et de ses Consignes. Ajouter les informations manquantes (tarifs, horaires, adresse de l'entreprise du client) dans Charly Max > Connaissances, puis tester depuis un autre téléphone.",
    steps: ["Charly Max > Connaissances : ajouter l'information manquante", "Charly Max > Consignes : préciser le ton et ce qu'il ne doit pas dire", "Tester depuis un autre téléphone"] },
  { id: "maintenance-whatsapp-temporaire", title: "TEMPORAIRE : maintenance WhatsApp du 10 novembre", content: "Le 10 novembre de 22 h à minuit, les canaux WhatsApp seront indisponibles pour maintenance. Message temporaire.",
    steps: ["Prévenir que WhatsApp est indisponible le 10 novembre de 22 h à minuit"], validUntil: "2026-11-11T00:00:00.000Z" },

  // Integrations.
  { id: "integrations-catalogue", title: "Intégrations disponibles", content: "La liste des intégrations disponibles est dans Paramètres > Intégrations (Google, Microsoft, HubSpot, Slack, Notion, Calendly, Webhooks). Un outil absent de la liste n'est pas intégré aujourd'hui ; la demande peut être transmise à l'équipe produit, sans promesse de date.",
    steps: ["Ouvrir Paramètres > Intégrations", "Chercher l'outil dans la liste", "S'il est absent, la demande est transmise à l'équipe produit (aucune date garantie)"] },
  { id: "integrations-webhook", title: "Brancher un outil absent du catalogue avec un Webhook", content: "Un outil qui sait appeler une URL (webhook) peut envoyer des données à un Assistant : Paramètres > Intégrations > Webhooks > « Créer un webhook » donne une URL à coller dans l'outil du client. La configuration côté outil se fait selon la documentation officielle de cet outil.",
    steps: ["Paramètres > Intégrations > Webhooks > « Créer un webhook »", "Copier l'URL générée", "La coller dans l'outil du client, à l'endroit prévu par sa documentation officielle"] },
  { id: "integrations-hubspot", title: "Connecter HubSpot", content: "HubSpot se connecte dans Paramètres > Intégrations > HubSpot > Connecter, avec un compte HubSpot administrateur (Super admin). Les contacts sont synchronisés toutes les heures.",
    steps: ["Paramètres > Intégrations > HubSpot > Connecter", "Se connecter avec un compte Super admin HubSpot", "Attendre la première synchronisation (jusqu'à 1 heure)"] },
  { id: "integrations-calendly", title: "Connecter Calendly", content: "Calendly se connecte dans Paramètres > Intégrations > Calendly. Il faut un compte Calendly payant (les webhooks Calendly ne sont pas disponibles en gratuit).",
    steps: ["Paramètres > Intégrations > Calendly > Connecter", "Se connecter avec le compte Calendly (offre payante)"] },

  // Resources.
  { id: "webinaires", title: "Webinaires de prise en main", content: `Des webinaires gratuits de prise en main ont lieu chaque semaine. Inscription : ${WEBINARS}.`, steps: [`S'inscrire sur ${WEBINARS}`], links: [WEBINARS] },
  { id: "webinaire-special-temporaire", title: "TEMPORAIRE : webinaire spécial Charly Max du 8 novembre", content: "Un webinaire spécial Charly Max a lieu le 8 novembre à 11 h. Message temporaire.",
    steps: ["Proposer le webinaire spécial du 8 novembre à 11 h"], validUntil: "2026-11-09T00:00:00.000Z" },
  { id: "telephone-agent-site", title: "Brancher l'Assistant téléphonique sur son site", content: "L'Assistant téléphonique Limova se branche sur un site existant avec le bouton d'appel : Assistant téléphonique > Intégrer > copier le code du bouton et le coller dans l'éditeur du site (bloc « Code HTML » ou équivalent). Cela marche avec tout éditeur de site qui accepte un bloc de code HTML.",
    steps: ["Assistant téléphonique > Intégrer > « Copier le code du bouton »", "Dans l'éditeur du site, ajouter un bloc « Code HTML » (ou équivalent)", "Coller le code et publier le site"] },
];

export const savBenchCard = (id: string) => SAV_BENCH_KNOWLEDGE.find(card => card.id === id);
export const savBenchCardExpired = (card: SavBenchCard, now: string = SAV_BENCH_NOW) => card.validUntil !== undefined && Date.parse(card.validUntil) <= Date.parse(now);
