import { savBenchConversationSchema, type SavBenchConversation, type SavBenchConversationInput } from "../../bench/bench-types";

/*
 * Agent SAV intelligent (20/11): 12 multi-turn bench conversations for the new agent's case memory and progress rule, added to the 120 of the
 * bench corpus by the self-test (`SAV_SMART_BENCH_SELFTEST_CORPUS`). They test: never re-ask what the customer already said, never re-propose a
 * trial that failed, use what the customer answered, hand over after two turns without progress or at the 5th exchange with a useful note.
 * FICTIONAL DATA ONLY: `@exemple.invalid` customers, bench cards (`bench-knowledge.fixture.ts`). `mustNotMatch` runs on the reply, lower case, no accents.
 */
export const SAV_SMART_BENCH_MULTITURN_REVISION = "sav-smart-multiturn-2026-11-20.v1";

const STEP: ["repondre", "demander"] = ["repondre", "demander"];
const NO_REPEAT = "redonner une étape que le client dit avoir déjà faite";

const ROWS: readonly SavBenchConversationInput[] = [
  { id: "multi-memoire-01", family: "nylas_imap_smtp", title: "Mémoire : le client a déjà donné son hébergeur et ses ports, ne pas les redemander", risky: true,
    customer: { name: "Hélène Marchal", email: "helene.marchal@exemple.invalid" }, subject: "boite mail pro",
    knowledge: ["mail-imap-parametres", "mail-mot-de-passe-application"],
    turns: [
      { text: "Bonjour, je veux connecter ma boîte pro hébergée chez OVH. J'ai mis IMAP 993 en SSL et SMTP 465 mais ça ne passe pas.",
        expect: { outcome: STEP, keyFacts: ["les noms de serveur sont donnés par l'hébergeur", "erreur d'authentification : mot de passe d'application si double authentification"], forbidden: ["redemander l'hébergeur ou les ports"] } },
      { text: "Le message exact c'est « Authentication failed ». Et oui j'ai la double authentification.",
        expect: { outcome: STEP, keyFacts: ["créer un mot de passe d'application chez l'hébergeur", "le saisir soi-même dans le formulaire IMAP"], forbidden: ["redemander l'hébergeur, les ports ou le message d'erreur", NO_REPEAT],
          mustNotMatch: ["quel (est votre )?hebergeur", "quels? ports?"] } },
    ] },

  { id: "multi-memoire-02", family: "routine_sheets", title: "Mémoire : le partage du fichier est déjà fait, ne pas le reproposer", risky: true,
    customer: { name: "Yann Leclerc", email: "yann.leclerc@exemple.invalid" }, subject: "routine sheets",
    knowledge: ["routine-sheets-acces", "routine-sheets-ne-tourne-pas"],
    turns: [
      { text: "Bonjour, ma routine Google Sheets affiche « Accès refusé ».",
        expect: { outcome: STEP, keyFacts: ["vérifier que le compte Google connecté a accès au fichier"] } },
      { text: "J'ai partagé le fichier avec le compte connecté en éditeur, j'ai relancé, toujours « Accès refusé ».",
        expect: { outcome: ["repondre", "demander", "passer_la_main"], keyFacts: ["proposer une autre piste (reconnecter le compte Google, vérifier le bon compte) ou une question ciblée"], forbidden: ["reproposer de partager le fichier", NO_REPEAT] } },
    ] },

  { id: "multi-memoire-03", family: "extension_chrome", title: "Mémoire : le client a dit être sur Chrome à jour, ne pas redemander le navigateur", risky: true,
    customer: { name: "Sonia Perret", email: "sonia.perret@exemple.invalid" }, subject: "extension qui se déconnecte",
    knowledge: ["extension-connexion", "extension-invisible"],
    turns: [
      { text: "Bonjour, je suis sur Chrome, à jour, et l'extension me demande de me reconnecter toutes les deux minutes.",
        expect: { outcome: STEP, keyFacts: ["piste de l'extension qui se reconnecte en boucle (cookies, session)"], forbidden: ["demander quel navigateur"], mustNotMatch: ["quel navigateur"] } },
      { text: "J'ai fait ce que vous dites, c'est mieux mais ça recommence au bout d'une heure.",
        expect: { outcome: ["repondre", "demander", "passer_la_main"], keyFacts: ["tenir compte de l'amélioration partielle"], forbidden: ["demander quel navigateur", NO_REPEAT], mustNotMatch: ["quel navigateur"] } },
    ] },

  { id: "multi-memoire-04", family: "charly_whatsapp", title: "Mémoire : utiliser la réponse du client à la question posée", risky: false,
    customer: { name: "Karim Belaid", email: "karim.belaid@exemple.invalid" }, subject: "charly",
    knowledge: ["charly-whatsapp-pas-de-reponse", "charly-whatsapp-connecter"],
    turns: [
      { text: "Bonjour, Charly Max ne répond plus sur WhatsApp.",
        expect: { outcome: STEP, keyFacts: ["vérifier statut « Relié », interrupteur « Actif » et horaires"] } },
      { text: "C'est marqué « Déconnecté ».",
        variants: [{ when: { agentOutcome: "repondre" }, text: "Le statut est « Déconnecté », le reste est bon." }],
        expect: { outcome: STEP, keyFacts: ["rescanner le QR code pour relier WhatsApp"], forbidden: ["redemander le statut"] } },
      { text: "J'ai rescanné, c'est Relié et il répond. Merci !",
        expect: { outcome: ["repondre"], keyFacts: ["confirmer que c'est résolu, sans relancer de procédure"], forbidden: ["proposer une nouvelle procédure"] } },
    ] },

  { id: "multi-progres-01", family: "piege_toujours_pareil", title: "Progrès : deux tours sans rien de neuf, passage de main avec note", risky: true,
    customer: { name: "Denis Vasseur", email: "denis.vasseur@exemple.invalid" }, subject: "mails envoyés en erreur",
    knowledge: ["mail-smtp-envoi", "mail-imap-parametres"],
    turns: [
      { text: "Bonjour, les mails envoyés par mon Assistant partent en erreur depuis hier.",
        expect: { outcome: STEP, keyFacts: ["vérifier les réglages SMTP d'envoi"] } },
      { text: "Pareil.",
        expect: { outcome: ["repondre", "demander", "passer_la_main"], forbidden: ["redonner exactement la même procédure"] } },
      { text: "Toujours pareil.",
        expect: { outcome: "passer_la_main", forbidden: ["proposer encore les mêmes étapes"] } },
    ] },

  { id: "multi-progres-02", family: "piege_toujours_pareil", title: "Progrès : chaque réponse du client apporte un fait, l'agent continue d'avancer", risky: false,
    customer: { name: "Laure Fontaine", email: "laure.fontaine@exemple.invalid" }, subject: "linkedin",
    knowledge: ["linkedin-campagne-bloquee", "linkedin-connexion"],
    turns: [
      { text: "Bonjour, ma campagne LinkedIn est à l'arrêt.",
        expect: { outcome: STEP, keyFacts: ["regarder le statut affiché de la campagne"] } },
      { text: "Le statut dit « Session expirée ».",
        expect: { outcome: STEP, keyFacts: ["reconnecter LinkedIn via l'extension Chrome"], forbidden: ["redemander le statut"] } },
      { text: "Je me suis reconnectée dans l'extension, la campagne affiche maintenant « En cours ».",
        expect: { outcome: ["repondre"], keyFacts: ["confirmer que c'est reparti"], forbidden: ["passer la main alors que c'est résolu"] } },
    ] },

  { id: "multi-progres-03", family: "assistant_tache", title: "Plafond : 5e échange sans solution, passage de main", risky: true,
    customer: { name: "Pascal Morin", email: "pascal.morin@exemple.invalid" }, subject: "assistant qui n'obéit pas",
    knowledge: ["assistant-consignes", "assistant-charte"],
    turns: [
      { text: "Bonjour, mon Assistant ne suit pas mes consignes de mise en forme.", expect: { outcome: STEP, keyFacts: ["revoir les consignes de l'Assistant"] } },
      { text: "J'ai réécrit les consignes, il met toujours des titres en gras.", expect: { outcome: ["repondre", "demander", "passer_la_main"], forbidden: [NO_REPEAT] } },
      { text: "J'ai ajouté un exemple comme vous dites, c'est un peu mieux mais il recommence parfois.", expect: { outcome: ["repondre", "demander", "passer_la_main"], forbidden: [NO_REPEAT] } },
      { text: "Je l'ai testé sur cinq demandes, deux sont encore en gras.", expect: { outcome: ["repondre", "demander", "passer_la_main"], forbidden: [NO_REPEAT] } },
      { text: "Toujours deux sur cinq en gras.", expect: { outcome: "passer_la_main", forbidden: ["proposer encore un essai"] } },
    ] },

  { id: "multi-progres-04", family: "piege_toujours_pareil", title: "Progrès : le client s'agace après un essai raté, passage de main sans reproposer", risky: true,
    customer: { name: "Mireille Caron", email: "mireille.caron@exemple.invalid" }, subject: "invitation",
    knowledge: ["collaborateurs-invitation-expiree", "collaborateurs-inviter"],
    turns: [
      { text: "Bonjour, ma collaboratrice n'a jamais reçu l'invitation.", expect: { outcome: STEP, keyFacts: ["vérifier les indésirables", "renvoyer l'invitation"] } },
      { text: "Elle a regardé partout, j'ai renvoyé l'invitation deux fois, rien. C'est pénible.",
        expect: { outcome: ["demander", "passer_la_main"], forbidden: ["reproposer de renvoyer l'invitation ou de regarder les indésirables"], mustNotMatch: ["renvoy(ez|er) l'invitation"] } },
      { text: "Rien de neuf, elle n'a toujours rien.", expect: { outcome: "passer_la_main", forbidden: ["proposer encore les mêmes étapes"] } },
    ] },

  { id: "multi-memoire-05", family: "changement_sujet", title: "Mémoire : nouveau sujet au 2e tour, le premier reste réglé", risky: false,
    customer: { name: "Bruno Lemaire", email: "bruno.lemaire@exemple.invalid" }, subject: "extension puis linkedin",
    knowledge: ["extension-invisible", "linkedin-quotas"],
    turns: [
      { text: "Bonjour, l'extension a disparu de ma barre Chrome.", expect: { outcome: STEP, keyFacts: ["épingler l'extension via l'icône puzzle"] } },
      { text: "C'est bon, elle est revenue. Autre question : pourquoi mes invitations LinkedIn s'arrêtent à 20 par jour ?",
        expect: { outcome: ["repondre"], keyFacts: ["limites d'envoi de la prospection LinkedIn"], forbidden: ["reparler de l'épinglage de l'extension"] } },
    ] },

  { id: "multi-memoire-06", family: "piege_bug_resolu", title: "Mémoire : le client dit que c'est réglé, ne pas relancer d'enquête", risky: false,
    customer: { name: "Agathe Royer", email: "agathe.royer@exemple.invalid" }, subject: "synchro sheets",
    knowledge: ["routine-sheets-ne-tourne-pas", "incident-sheets-resolu"],
    turns: [
      { text: "Bonjour, ma routine Sheets ne s'est pas lancée ce matin.", expect: { outcome: STEP, keyFacts: ["vérifier que la routine est active et son horaire"] } },
      { text: "Elle était désactivée, je l'ai réactivée et elle a tourné. Merci.",
        expect: { outcome: ["repondre"], keyFacts: ["confirmer, sans nouvelle procédure"], forbidden: ["proposer une nouvelle procédure", "passer la main"] } },
    ] },

  { id: "multi-progres-05", family: "sujet_inconnu", title: "Enquête utile : sans fiche, une question qui tranche puis une note concrète", risky: false,
    customer: { name: "Rémi Gauthier", email: "remi.gauthier@exemple.invalid" }, subject: "export",
    knowledge: [],
    turns: [
      { text: "Bonjour, l'export de mes conversations ne contient que la moitié des messages.",
        expect: { outcome: ["demander", "passer_la_main"], keyFacts: ["ne rien affirmer sans source", "une question qui aide (quel export, quelle période) ou un passage à l'équipe"], forbidden: ["inventer une fonctionnalité d'export"] } },
      { text: "C'est l'export de l'Assistant commercial, sur octobre, il manque tout après le 15.",
        expect: { outcome: "passer_la_main", keyFacts: ["transmettre avec ce qui a été compris : Assistant commercial, octobre, après le 15"], forbidden: ["redemander l'Assistant ou la période"] } },
    ] },

  { id: "multi-progres-06", family: "piege_toujours_pareil", title: "Progrès : un essai raté reproposé est refusé ; l'agent change de piste ou passe la main", risky: true,
    customer: { name: "Céline Dupuis", email: "celine.dupuis@exemple.invalid" }, subject: "réinitialisation",
    knowledge: ["acces-mail-reinitialisation", "acces-connexion"],
    turns: [
      { text: "Bonjour, je ne reçois pas le mail de réinitialisation du mot de passe.", expect: { outcome: STEP, keyFacts: ["regarder les indésirables", "vérifier l'adresse utilisée"] } },
      { text: "J'ai regardé les indésirables et c'est bien la bonne adresse, rien.",
        expect: { outcome: ["repondre", "demander", "passer_la_main"], forbidden: ["reproposer de regarder les indésirables ou de vérifier l'adresse"], mustNotMatch: ["indesirables"] } },
      { text: "Toujours rien.", expect: { outcome: "passer_la_main" } },
    ] },
];

export const SAV_SMART_BENCH_MULTITURN: readonly SavBenchConversation[] = ROWS.map(row => savBenchConversationSchema.parse(row));
