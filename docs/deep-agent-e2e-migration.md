# Migration de la recette E2E vers Deep Agent

**État courant : 1 scénario legacy reste dans `feature-flows.spec.js`.** Les sections suivantes retracent les couches de migration ; leurs anciens décomptes décrivent ces étapes, pas le total actuel. La suite globale et la qualification distante restent ouvertes.

## Audit du 14 octobre 2026

`npx playwright test --max-failures=8` a terminé avec 42 réussites, 8 échecs et 64 tests non exécutés. L’arrêt à huit échecs sert à borner le diagnostic ; la commande complète et ses seuils CI ne sont pas modifiés. La suite globale n’est pas déclarée verte.

Les échecs observés concernent une attente de manifeste interdisant l’API Limova, puis les anciennes fixtures chat/ADK, évaluation, observation vocale et formation. Ces fixtures ne créent qu’une session OTP du proxy : elles ne connectent pas le compte Limova et peuvent donc être arrêtées par le panneau d’authentification. Chaque parcours restant doit être migré avant de conclure à une régression ou à sa résolution.

## Couverture transférée

| Ancien scénario dans feature-flows | Scénario natif de remplacement |
|---|---|
| Chat via proxy, DOM et confidentialité | `limova-native-chat.spec.js` : panneau → vrai worker → passerelle app → HTTPS/SSE → driver DOM → résultat natif ; valeurs privées et query exclus |
| Markdown assistant | Même fichier : HTML échappé, pas de script ni lien javascript, Markdown sûr conservé |
| Token proxy expiré | Session Limova révoquée : refresh existant refusé, aucun message ni création de chat, feedback et connexion dans l’app après rechargement |
| Session Charly non connectée | Même scénario : panneau de connexion Limova visible, absence du formulaire OTP et de fallback legacy |

Les quatre tests transférés sont remplacés par les scénarios ci-dessus, pas désactivés par des skips. Un cas supplémentaire vérifie la désactivation du flag entre l’ouverture du panneau et l’envoi. Les autres tests legacy restent présents, y compris ceux qui échouent.

Le test de manifeste vérifie désormais la liste exacte des hôtes par environnement, les permissions facultatives non accordées, les identités Chrome distinctes et les matches content-script. Il ne retire pas le contrôle de portée réseau.

## Portée de la fixture native

`native-chat-fixture.js` démarre un serveur HTTPS temporaire, utilise de vrais cookies HttpOnly/Secure/Partitioned, et charge le paquet dans un profil Chromium isolé. Les domaines app/API sont résolus vers localhost ; les autres domaines ne sont pas résolus. Les requêtes legacy sont surveillées et refusées par les assertions. Les méthodes d’envoi du panneau ne sont pas remplacées.

Le contrat API est simulé : ce test prouve l’intégration client/Chrome, pas l’exécution réelle de NestJS, du modèle, de la mémoire, du MCP Studio ou de LangSmith. La continuité testée est le rechargement du panneau sur la même conversation persistée dans la fixture ; une reprise dans l’app Limova réelle reste à qualifier.

## Actions navigateur sur le transport natif

`limova-browser-actions.spec.js` remplace trois scénarios legacy : remplissage exact et silencieux, récupération après mauvaise cible et clic ordinaire sans verbe explicite. La fixture émet plusieurs commandes canoniques dans le même tour ; le worker, le journal et le driver réels exécutent les commandes et renvoient les résultats. Chaque nouveau message reçoit un identifiant de tour distinct.

La récupération change de responsabilité : une saisie visant un bouton est refusée sans effet ; le serveur relit ensuite la page et désigne le champ correct. Le test simule cette décision serveur et ne démontre pas le raisonnement d’un modèle réel. Il vérifie une seule saisie effective, aucun clic accidentel, les identifiants du même tour et l’absence des anciennes valeurs privées dans les résultats.

Le clic ordinaire utilise désormais le consentement navigateur explicite du tour de chat. Le mode analyse refuse les mutations, même si le serveur demande de supprimer un brouillon. Un scénario supplémentaire vérifie la navigation et la lecture du nouveau document avec une version de contexte augmentée, dans la même conversation.

Les anciens scénarios de guidage visuel, curseur et analyse destructive restent présents tant que leur couverture visuelle n’est pas transférée. Les tests de navigation sémantique restent également présents : naviguer vers une URL ne démontre pas la sélection d’un contrôle mal étiqueté. Aucun seuil CI ni skip supplémentaire n’est ajouté.

Validation de cette couche : 12 tests ciblés réussis avec le paquet production, puis 12 avec le paquet staging (`limova-browser-actions.spec.js` et `limova-native-chat.spec.js`). La fixture sélectionne maintenant `build-staging` par défaut lorsque `LIMOVA_E2E_ENV=staging`, tout en respectant `EXTENSION_PATH`. Une première invocation staging avait chargé le paquet production ; elle a été interrompue et corrigée. Il reste 21 scénarios legacy dans `feature-flows.spec.js` ; la suite globale n’est pas déclarée verte.

## Guidage visuel pendant l’analyse

Le mode observation autorise désormais `highlight` en plus de la lecture et de la capture. Le driver applique son animation au contrôle exact enregistré dans son registre privé ; il ne recherche pas un autre contrôle à partir d’un identifiant inventé. Un test du parcours complet vérifie le champ animé, le refus d’une référence inconnue, l’absence de saisie/clic et le maintien du mode observation. Les tests du journal couvrent la persistance de cette permission après réouverture et le refus des quatre opérations mutantes ; ceux du document vérifient le rejet d’un contrôle remplacé.

Le scénario legacy de guidage reste présent : son exigence de capture automatique et les anciens overlays ne sont pas assimilés à la preuve du surlignage natif. Le [curseur natif](deep-agent-action-pointer.md) indique maintenant les clics et saisies ; sa trajectoire et le défilement automatique legacy restent à évaluer.

## Entraînement et transcription native

`limova-training-transcription.spec.js` utilise maintenant le panneau réel pour ouvrir l’entraînement, entrer le code Studio, démarrer, activer le microphone puis finaliser. Le flux PCM, la passerelle first-party, Socket.IO et le worker sont réels ; le serveur Limova/Studio est contrôlé et la sélection d’écran est remplacée par un canvas ; le recorder et le SDK Blob embarqués sont réels, avec réponses HTTP de stockage simulées. Cette recette ne qualifie donc pas une vidéo réellement stockée.

Le test vérifie qu’une seule note finale est enregistrée, sans chat, requête POST de conversation ni clic, y compris si le canal de transcription émet une commande étrangère. Il conserve la vérification de l’arrêt du PCM après retrait du consentement et ajoute la finalisation Studio via le bouton. Il remplace le scénario legacy de microphone passif.

Le passage par le vrai démarrage a révélé une fuite d’alias : le texte initial d’un textarea voisin pouvait devenir un alias de bouton dans le contexte envoyé au Studio. L’extraction sémantique retire désormais les champs, zones éditables et régions marquées privées avant de construire les libellés et alias. Les régressions vérifient le contenu initial des textarea, les descendants éditables et privés, tout en conservant les noms utiles des intégrations.

`limova-training-permissions.spec.js` remplace le scénario legacy de récupération d’autorisation micro, avec une session Limova réelle dans la fixture. Les frontières OS de refus et de récupération sont simulées ; le panneau doit abandonner le recorder et inviter à réessayer sans contacter Studio ni commencer un tour. Ce cas fonctionne aussi avec le paquet staging, sans accès au Studio production.

Il reste 19 scénarios legacy dans feature-flows. Le scénario complet d’enregistrement avec popups OAuth et le stockage réel de vidéo restent à qualifier ; les deux tests transférés ne valent pas validation de tout le Studio.

## Coupures et autorisation de la voix native

Le panneau vocal est testé sur quatre sorties : retrait du consentement, déconnexion serveur, absence de `session.ready` et fermeture de l’onglet d’autorisation micro. Les tests utilisent la session first-party, le transport Socket.IO et le micro/worklet Chromium ; le serveur et l’audio assistant sont contrôlés.

Après déconnexion, l’extension coupe le PCM, affiche l’erreur, libère la sélection de conversation et ne se reconnecte pas automatiquement. Un nouveau clic utilisateur ouvre une nouvelle session vocale dans le même fil. Cela remplace explicitement l’ancienne récupération automatique Gemini, conformément au choix de ne pas rejouer un tour à la reconnexion. Aucune nouvelle requête HTTP de message ni appel au proxy/Gemini n’est envoyé par ces parcours.

Un serveur qui ne confirme pas le démarrage provoque la fermeture après le délai réel du transport, sans commencer le PCM. Fermer l’onglet de permission rend la main sans ouvrir de socket. Les deux anciens tests correspondants (reconnexion Gemini et première autorisation) sont remplacés ; le délai de démarrage est une couverture supplémentaire.

Le scénario legacy « Gemini reste silencieux après une transcription » reste présent : un timeout de démarrage ne démontre pas le traitement d’une réponse manquante après l’acceptation d’un tour. Il reste 17 scénarios legacy à traiter ; cette couche ne déclare pas la suite globale verte.

## Réponse vocale manquante après le début du tour

La recette ajoute maintenant l’échec explicite `turn.deep_agent_stream.failed` et un tour accepté qui cesse de progresser. Le panneau arrête la session avec un message FR/EN/ES invitant à vérifier l’historique avant de relancer une action ; il ne réutilise pas les anciennes relances techniques Gemini.

Le délai de 90 secondes commence sur la transcription finale utilisateur ou le début du flux Deep Agent. Il est renouvelé par les deltas du flux ou du texte assistant, ainsi que par la fin du flux canonique qui précède la restitution vocale. Il est supprimé lors de l’audio, du texte final assistant ou de l’interruption. La fin du calcul Deep Agent ne prouve pas à elle seule que le provider vocal a répondu. Il n’expire pas une session simplement en écoute. Il n’annule pas rétroactivement un effet externe déjà exécuté.

Tests unitaires avec horloge contrôlée : écoute sans demande, progression, expiration, réponses terminales, échec, arrêt audio/transport, événements tardifs et absence de détails serveur. Tests Chromium avec vrai transport : le serveur publie la question dans le flux canonique puis reste silencieux ; l’horloge du panneau avance pour vérifier le délai sans attendre 90 secondes réelles. Le backend et le provider ne sont pas qualifiés par cette simulation.

Le test legacy de silence après transcription est désormais remplacé par ces cas natifs. Il reste 16 scénarios legacy. Le délai choisi doit être observé pendant le pilote, notamment pour les outils longs sans événements de progression ; aucun mécanisme de rejeu automatique n’est ajouté.

## Nouvelle conversation et remise à zéro du panneau

La fixture native gère plusieurs UUID de conversation, des historiques indépendants et la route existante `/message/:id/cancel`, appelée avant un changement de fil. Les deux entrées UI (`limovaNew` et `resetBtn`) créent un second fil, décochent le consentement navigateur et conservent l’historique du premier. Le test envoie ensuite un message dans le second fil sans contexte navigateur, puis reprend le premier et retrouve exactement ses messages. Aucun DELETE ni logout n’est envoyé.

Cette couche ne modifie pas le code produit. Le helper de listener retire l’événement de clic avant la création ; le consentement n’est donc conservé que lors de la création implicite nécessaire à un envoi déjà autorisé. La fixture doit accepter cancel pour représenter le parcours existant.

Le scénario legacy combinant langue/onboarding/diagnostics/export de logs/reset reste présent, car les assertions liées au prompt d’onboarding et aux logs doivent encore être transférées. La vérification du reset ne remplace pas ce scénario entier.

## Plan du main agent dans le panneau natif

Le panneau projette les tâches structurées `write_todos` des checkpoints racine et restaure `reasoning[].todos` de l’historique, sur leur `anchorMessageId`. Il affiche les statuts backend pending/in_progress/completed avec des libellés FR/EN/ES. Pendant un tour sans réponse textuelle, le plan se rattache au message utilisateur ; il rejoint la réponse lorsqu’elle arrive. Un nouveau tour sans plan n’hérite pas du plan précédent. Les sous-agents, messages masqués, textes de raisonnement et sorties brutes des outils ne sont pas rendus.

Aucun moteur de progression ni achèvement automatique n’est ajouté : une tâche reste en cours si le backend la conserve ainsi, même après la fin du flux. Le plan est celui du tour Deep Agent, pas une preuve d’achèvement du parcours métier d’onboarding. Les mises à jour arrivent avec les checkpoints `values`, pas avec les fragments JSON incomplets des appels d’outil.

Les tests unitaires couvrent les mises à jour, l’ancrage, le retrait, les messages masqués et la pagination. Chromium couvre l’affichage, la restauration après reload, le tour suivant sans nouveau plan et l’injection HTML rendue comme texte. L’API reste simulée. Le scénario legacy combiné onboarding/langue/logs reste à transférer intégralement ; aucun des 16 scénarios restants n’est retiré dans cette couche.

## Téléchargement du diagnostic natif

Le téléchargement réel du fichier TXT est vérifié après un échange Deep Agent, avec une connexion valide, une session expirée et un flag désactivé. Le paquet conserve l’incident et les codes des contrôles Limova, mais exclut les messages, les valeurs de formulaire, le cookie et les UUID de conversation/workspace utilisés dans le scénario. Il reste téléchargeable quand la connexion est dégradée.

Le diagnostic ne crée ni conversation ni tour IA et n’ouvre aucun onglet. Une session expirée déclenche la tentative normale `POST /auth/refresh-token` ; les autres sondes sont des GET. L’absence de POST absolue serait une assertion incorrecte du contrat d’authentification. Le test confirme l’absence d’appels legacy et ne qualifie pas une rotation réelle de refresh token.

Cette couche est limitée aux tests et à la documentation : le téléchargement existant appelle déjà le diagnostic natif. Le scénario legacy combiné reste présent tant que ses exigences d’accompagnement ne sont pas entièrement transférées.

## Contrôles personnalisés et navigation nommée

Le pilote natif expose aussi les contrôles personnalisés munis d’un rôle interactif, d’un tabindex explicite, d’un onclick ou de la classe cursor-pointer. Les références restent privées, issues de la dernière lecture et liées au document. Le libellé est lu parmi les textes visibles, sans contenu des champs imbriqués ni zones privées (y compris data-limova-private). Il n’invente pas une intention métier à partir d’un libellé : le backend reçoit le texte de page et choisit une référence réelle.

Le clic consenti émet pointerdown/mousedown puis pointerup/mouseup et un seul click. Les événements de souris compatibles sont omis si pointerdown est annulé. Après chaque étape, la disponibilité et la couverture de la cible sont revérifiées. Si le premier événement détache, masque ou rend privée la cible, les suivants s’arrêtent ; le reçu indique explicitement que le clic final n’a pas eu lieu et demande une relecture. Il reste completed pour l’action déjà partiellement envoyée, sans rejeu automatique. Le mode observation refuse toujours le clic avant l’exécution.

Chromium vérifie un contrôle Gmail personnalisé, la confidentialité des libellés/champs imbriqués, le pointeur pendant l’action, un unique click, les trois changements de cible et la navigation réelle par lien. Profil et catalogue d’intégrations sont relus dans le même tour après navigation, sans confirmation supplémentaire après le consentement du tour. La décision du backend reste simulée ; ce n’est pas une mesure de compréhension du modèle ni une vraie connexion OAuth Gmail.

Trois scénarios legacy sont remplacés : navigation intermédiaire vers Intégrations, contrôle Gmail mal étiqueté et navigation interne explicitement demandée. Le parcours legacy du contrôle Gmail cliquait depuis l’analyse de page ; cette attente devient un refus explicite dans le mode observation et une action dans le mode consenti. Les anciens marqueurs ACTION et messages locaux de succès sont remplacés par les commandes/reçus natifs et la relecture de page. Il reste 13 scénarios legacy, dont la trajectoire/présentation du curseur et les parcours OAuth/Studio complets.

## Erreurs HTTP du chat natif

Le scénario de code support du proxy est remplacé par deux scénarios natifs : HTTP 503 et 429. Le client conserve des codes stables `LIMOVA_HTTP_5XX` et `LIMOVA_RATE_LIMITED`, transmis au panneau et aux diagnostics. Le panneau traduit le message en français, anglais ou espagnol et invite à vérifier l’historique et les actions avant un nouvel envoi. Aucun corps d’erreur serveur n’est affiché.

La fixture sauvegarde le message puis renvoie une erreur HTTP : le rechargement retrouve ce message, sans second POST automatique. Le téléchargement réel des diagnostics contient le code, sans la question privée ni le détail serveur. Les routes API sont simulées ; ces tests ne prouvent pas une exécution distante ni le traitement de toutes les erreurs de streaming. Il reste 12 scénarios legacy à migrer.

## Diagnostic des résultats navigateur natifs

Le diagnostic consulte maintenant le journal IndexedDB durable partagé par les parcours texte et voix, seulement après vérification de l’accès à la conversation sélectionnée. La lecture est sans mutation et ne restitue que des compteurs : résultats terminés, refus, échecs et actions non confirmées. Aucun argument, observation, identifiant ou contenu de page n’est ajouté aux logs.

La fenêtre est de 15 minutes ; les anciennes actions démarrées sans date restent signalées comme non confirmées. Deux refus, un échec ou une action non confirmée rendent le diagnostic dégradé. Le texte précise qu’un refus peut être une protection attendue et qu’une action non confirmée peut encore être en cours. Ce signal ne prouve pas une panne du backend et ne relance aucune action. Un journal inaccessible est explicitement signalé.

Les tests Chromium vérifient persistance, absence de double comptage, exclusion des autres comptes/workspaces/conversations et des dates futures/expirées ; le parcours réel du panneau vérifie le signal dégradé après deux refus, son export sans valeurs privées et son absence dans une nouvelle conversation. Les réponses API restent simulées. Le scénario diagnostic legacy est remplacé ; 11 scénarios legacy restent à migrer.

## Guidage visuel natif avec capture authentifiée

`limova-visual-guidance.spec.js` remplace les scénarios legacy de surlignage exact et de refus du clic destructif pendant l’analyse. Le panneau déclenche un tour d’observation ; le serveur de test demande lecture, capture, surlignage du champ, surlignage d’une référence inventée et clic sur « Supprimer le brouillon ». Les deux dernières commandes sont refusées, sans effet ni popup de confirmation.

La capture utilise le vrai `captureVisibleTab`, le vrai masquage et l’upload multipart via la passerelle first-party et son cookie partitionné. Le test ouvre l’action de l’extension dans Chromium isolé pour accorder activeTab, sans remplacer les API Chrome. Les pixels du fichier effectivement reçu par le serveur sont contrôlés : zone publique bleue préservée ; mot de passe, textarea et région privée grisées. Un seul upload temporaire, dans le workspace attendu, puis son fileId dans le reçu du même tour. Aucun base64 ni contenu privé dans les messages. Le surlignage réel cible uniquement le champ ; aucune bulle de capture ou overlay de capture résiduel.

Le choix de capturer est désormais une commande du Deep Agent, pas un envoi JPEG systématique à Gemini. Cette différence de contrat est intentionnelle. La décision du modèle, le stockage distant et la lecture de l’image par un vrai provider ne sont pas qualifiés par cette fixture. Il reste 9 scénarios legacy à migrer.

## Invalidation après navigation SPA

Un changement d’URL dans le même document pouvait conserver une référence d’élément et autoriser un clic issu de l’ancienne page. Trois régressions ont été reproduites avant correction : pushState, replaceState et fragment. Le registre privé garde maintenant l’URL complète uniquement en mémoire locale ; une différence invalide les commandes précédentes. Le rebinding impose une version supérieure et efface les références : il faut relire la page avant d’utiliser ses contrôles. L’URL privée n’est pas ajoutée au protocole ni aux observations.

Les tests vérifient aussi une navigation déclenchée pendant pointerdown (aucun click final) et un tour complet : ancienne commande refusée, nouvelle page relue, nouvelle commande exécutée une seule fois dans le même tour, sans query sensible transmise. Les 9 scénarios legacy restent : cette correction ne remplace pas le parcours d’analyse automatique après navigation/modal. Elle ne prétend pas détecter tous les changements sémantiques d’un SPA à URL identique.

Les fixtures `browser-document` sélectionnent désormais les origines de l’environnement : leur première invocation avec le paquet staging échouait sur les URL production non autorisées. Les permissions des paquets restent inchangées.

## Contexte vocal après interaction manuelle

Le scénario legacy qui inspectait seulement le log `USER_PAGE_INTERACTION_OBSERVED` est remplacé par deux parcours du panneau vocal natif. Micro Chromium de test, PCM, Socket.IO, cookies first-party, contrôleur navigateur, registre de documents et journal sont réels ; serveur API et réponse du modèle restent simulés.

Après un clic manuel, la page navigue via pushState et ouvre une modale. Le prochain tour demande le contexte, obtient une version supérieure pour le même onglet, puis lit le nouveau texte. Valeurs du mot de passe/textarea et query privée sont absentes des résultats et logs ; la réponse canonique apparaît dans le chat, sans POST texte en doublon ni appel legacy. Une seule session et un seul résultat navigateur sont observés.

Si l’utilisateur a changé d’onglet avant cette demande, la session vocale s’arrête avec une erreur visible, sans transmettre le contexte de l’autre onglet ni résultat d’action et sans reconnexion automatique. Ce test ne fournit pas encore le bouton de retour à l’onglet du parcours historique.

La relecture est déclenchée au tour natif suivant ; ce n’est pas une analyse automatique supplémentaire à chaque clic. Le scénario général d’analyse automatique et celui d’avertissement/retour d’onglet restent à migrer. Huit scénarios legacy restent au total. Une première exécution de la nouvelle fixture a échoué sur l’encodage de son HTML ; le serveur de test indique maintenant UTF-8.

`limova-tab-return.spec.js` vérifie l’avertissement natif après changement d’onglet, le retour explicite vers l’onglet existant, sa fermeture, une nouvelle conversation et la désactivation manuelle du navigateur. La cible vient exclusivement du driver après autorisation. L’UI ne lit pas le contenu de l’autre onglet ; le retour ne relance ni message ni action. Le scénario vocal `manual-other-tab` vérifie aussi que revenir à l’onglet ne redémarre pas la session arrêtée.

Ce repère reste local au panneau ouvert et ne remplace aucune vérification d’autorité du driver. Le prochain tour explicitement demandé peut sélectionner une nouvelle page. La reprise après rechargement du panneau/worker et la qualification des fenêtres OAuth successives restent distinctes. Aucune exemption OAuth automatique n’est introduite par ce bouton.

`limova-training-transcription.spec.js` couvre désormais deux fenêtres OAuth successives (pause de 800 ms entre sélecteur et consentement), puis deux fenêtres qui se chevauchent. Les vraies fenêtres Chromium sont classées par le worker : une seule ouverture/fermeture Studio, `popupCount: 2`, aucun avertissement d’onglet, aucune lecture du contenu externe ni arrêt anticipé du recorder. Les notes PCM natives demeurent enregistrées, puis la démonstration est finalisée une fois. Le scénario legacy limité aux fenêtres Gmail successives est remplacé ; 6 scénarios legacy restent.

Les pages OAuth et services Studio/API/provider sont des fixtures ; aucun compte Google n’est connecté. La recette utilise désormais le vrai recorder et le SDK Blob, avec écran canvas et microphone Chromium de test. Le scénario legacy complet de contrôles/modales/navigation/vidéo est remplacé par cette chaîne ; `training-real-media.spec.js` conserve la vérification ciblée de reprise. Le paquet staging ne dispose pas des permissions Studio production et conserve l’exclusion explicite de cette recette.

## Démonstration Studio complète dans le panneau natif

La même session combine champ « Instructions », clic sur un cercle SVG appartenant au bouton HubSpot, résumé réseau après clic, modale, fenêtres OAuth successives ou simultanées et navigation réelle vers le profil. Les notes vocales natives et les événements rejoignent le transport Studio ; les valeurs tapées, mots de passe et marqueurs OAuth n’apparaissent pas dans les événements. Cela ne constitue pas un masquage des pixels vidéo : l’écran de cette fixture est un canvas.

La finalisation utilise MediaRecorder et le SDK Blob empaquetés. Les octets envoyés sont décodables en WebM 320 × 180, les pistes audio/vidéo sont arrêtées, et le chemin ainsi que la confirmation sont liés à la session de démonstration. La confirmation précède `/complete`. Une réponse 503 dans le parcours successif affiche le bouton de reprise : avant le second clic, aucune complétion Studio ; après, confirmation identique, un seul transfert/finalisation Blob et une seule complétion Studio.

Les deux parcours réussissent avec serveur et stockage simulés. La sélection OS, le microphone physique, un compte OAuth réel et la persistance Studio/Blob distante restent à qualifier. Le raccordement initial Studio utilise son token dans le corps de `/connect` ; les autres POST utilisent le Bearer correspondant. Aucun changement produit requis pour cette couche.

## Évaluation vocale native d’un brouillon

`limova-evaluation.spec.js` couvre désormais aussi le vrai panneau vocal, le microphone/worklet Chromium et la passerelle Socket.IO : même Charly, conversation d’évaluation isolée, code Studio dans `session.start`, cookie first-party et workspace vérifiés. Lecture, clic et relecture passent par le driver et les preuves natives, puis la réponse canonique déclenche la preuve de réponse. Le succès affiche le résultat Studio et restaure la conversation personnelle ; le clic reste unique et aucun POST de message texte n’est utilisé pour le tour vocal.

Si Studio refuse la preuve de vérification, le verdict ne provoque aucune complétion et la conversation d’évaluation reste sélectionnée. Dans les deux cas, la voix est arrêtée et ne redémarre pas ; le code n’est pas persisté dans le stockage local. Les appels proxy/Gemini sont surveillés comme interdits.

L’ancien scénario contributeur utilisant ADK et un token Gemini est remplacé par ces parcours et les quatre scénarios natifs texte/intervention déjà présents. Le contrat vocal est désormais la session Deep Agent, sans demande de token vocal legacy. Les serveurs API/Studio/provider et le calcul du score restent simulés : le test ne prouve pas une évaluation modèle ni une publication/review Studio réelle. L’exclusion staging liée aux permissions Studio production reste explicite.

## Navigation vers une cible hors écran et curseur

Le parcours ajouté à `limova-browser-actions.spec.js` part d’un lien absent des références visibles. Les commandes de défilement renvoient un mouvement réel ; chaque recherche relit la page, puis le lien devient référencé, reçoit un seul clic avec curseur centré et ouvre réellement le profil. Une seule demande utilisateur, un même tour, des reçus distincts et une lecture de la destination sont vérifiés. Aucune carte de confirmation supplémentaire ni appel legacy.

Le scénario legacy curseur/navigation est remplacé. L’analyse conserve son contrat d’observation ; la navigation exige le consentement navigateur du tour. Le curseur est immédiat et le scroll explicite, sans reprise de la trajectoire animée legacy. Voir `deep-agent-action-pointer.md` pour cette différence de présentation. Les choix du serveur restent simulés ; les actions Chrome/DOM et la navigation sont réels.

## Audio natif, interruption et historique relu

Le parcours `playback-interruption` de `limova-native-voice-panel.spec.js` observe les vrais AudioContext/AudioBufferSourceNode de Chromium sans remplacer leurs méthodes d’exécution. Deux morceaux PCM sont décodés à 24 kHz (échantillons négatif/positif vérifiés), programmés puis arrêtés lors d’une interruption. Un nouveau tour reprend la restitution avec la séquence audio suivante. La capture micro reste sur le worklet ; aucun avertissement ScriptProcessor n’est observé.

L’arrêt ferme les deux contextes audio et cesse l’envoi PCM. Après rechargement du panneau, les messages canoniques sont relus via l’API de la conversation, sans nouveau tour POST ni nouvelle session vocale. La fixture API conserve ces messages en mémoire : ce n’est pas une preuve de persistance NestJS/PostgreSQL ni une écoute sur haut-parleur physique.

Le scénario vocal legacy complet reste présent : la recette intégrée vocale de capture/scroll/saisie/navigation et les anciennes relances/suggestions nécessitent encore une correspondance explicite. Cette couche n’en retire aucune exigence par assimilation avec le seul test audio.

## Voix, navigateur et navigation complète

La recette `limova-voice-browser-workflow.spec.js` ajoute dix résultats dans une seule session : lecture, capture, scroll, lecture, saisie, lecture, clic invalide refusé, lecture, clic de navigation, lecture de destination. Les pixels publics sont conservés tandis que mot de passe/textarea sont masqués dans l’image effectivement transférée ; les observations ne contiennent pas les valeurs des champs. Les actions ne passent pas par un POST de chat parallèle.

Cette recette a révélé une coupure du socket au neuvième outil quand la page pilotée hébergeait aussi la passerelle vocale. La connexion navigateur utilise maintenant un onglet app inactif dédié et libéré à l’arrêt, avec protection des onglets repris par l’utilisateur. Voir `deep-agent-live-transport.md`. Le faux serveur choisit les actions et conserve l’historique ; ni intelligence modèle ni stockage distant ne sont revendiqués.

Les trois scénarios legacy restent à ce stade : la correspondance finale de la recherche de connaissances, des relances et des suggestions vocales doit encore être explicitée, ainsi que les deux autres parcours restants. Aucun scénario n’est supprimé par cette correction.

## Micro formateur après navigation

La recette de formation garde maintenant le micro actif pendant les contrôles, les fenêtres OAuth et la navigation complète. Elle reproduisait un arrêt au changement de document avant correction. L’onglet app dédié à la transcription conserve la connexion : une note avant et une note après navigation rejoignent la même session Studio, sans seconde connexion. Le retrait du consentement arrête ensuite le PCM et retire uniquement l’onglet technique ; la vidéo est finalisée séparément par l’utilisateur. Deux variantes OAuth passent avec services simulés. Les trois scénarios legacy restent inchangés.

## Progression des plans du main agent

Chaque plan natif affiche le nombre d’étapes `completed` parmi les éléments `write_todos` reçus du backend, avec une barre accessible traduite en français, anglais et espagnol. Le test du chat vérifie 1/3 puis 3/3, la conservation des anciens plans, le rechargement, le changement de langue et l’absence de plan dans une nouvelle conversation. Aucun état métier d’onboarding supplémentaire n’est stocké dans l’extension.

Cette progression décrit le plan émis par Charly ; elle ne certifie pas l’exécution des actions et ne mesure pas l’onboarding global du compte. Les statuts sont simulés dans cette recette Chromium. La consultation réelle de la trame Studio et la qualification du parcours complet restent des validations distinctes ; les trois scénarios legacy sont conservés.

## Publication de la trame et lecture MCP

La recette PostgreSQL `studio/test/mcp-postgres.spec.ts` utilise désormais les services réels d’enregistrement et de publication d’une trame. Le même client MCP HTTPS continue de recevoir la version publiée précédente après création du brouillon, puis reçoit la nouvelle révision, les consignes, l’étape optionnelle et ses critères de réussite après publication. La recherche expose la nouvelle révision de connaissances et les deux opérations produisent leurs audits en base. Les brouillons des contenus et les contenus privés restent absents de la réponse.

Quatre scénarios passent sur une base locale temporaire avec les migrations du Studio. Cette preuve concerne le cycle de publication et le transport MCP réel ; elle ne comprend pas le modèle Charly, l’API NestJS, les traces LangSmith distantes ou l’interface d’édition Studio. Le scénario legacy d’onboarding reste conservé jusqu’à qualification de la chaîne complète.

## Contrat réel entre le service API et Studio

La même recette accepte `STUDIO_MCP_API_CHECKOUT`, chemin du checkout API contenant `studio-mcp-real-service.integration.spec.ts` et ses dépendances installées. Après publication, elle lance ce fichier avec Vitest depuis le dépôt API. Le service `StudioMcpService` et ses outils LangChain utilisent alors le vrai endpoint HTTPS local du Studio, sa base migrée, un certificat temporaire approuvé et un token éphémère. Aucun remplacement de `fetch`, du serveur MCP ou du service de contenu n’intervient dans ce chemin.

Trois tests API sont exigés par le rapport JSON du sous-processus, sans échec ni test ignoré : lecture de la trame et recherche publiées ; révocation du flag après construction des outils ; retour indisponible pour un mauvais token. Le fournisseur de flag reste simulé. Les traces distantes sont désactivées dans ce processus de qualification.

Depuis `studio`, fournir les variables `STUDIO_MCP_API_CHECKOUT` et `STUDIO_MCP_TEST_DATABASE_URL` puis exécuter `npm run test:mcp:postgres`. La base doit être locale, isolée et nommée `extension_mcp_test`. Sans checkout API, les quatre scénarios Studio habituels restent exécutés seuls. La recette combinée prouve le contrat du service API vers Studio ; elle ne démarre pas le serveur NestJS complet, le modèle, l’authentification utilisateur ni LangSmith. Ces validations restent ouvertes.

## Surface active des modales natives

Le driver détecte les dialogues visibles (`dialog[open]`, rôles dialog/alertdialog et `aria-modal`). Il privilégie les dialogues au premier plan au point central visible et, pour les dialogues imbriqués, le dernier candidat de cette surface. La lecture expose `surface: modal` et limite texte/références à ce dialogue. Les contrôles privés restent filtrés. Une référence de page ne peut plus agir après ouverture d’un dialogue ; une référence de dialogue est refusée après fermeture ou changement de surface, avant tout événement pointeur.

Le scroll utilise le premier conteneur vertical défilable visible du dialogue, ou indique qu’aucun déplacement n’est possible. Il ne fait pas défiler l’arrière-plan. Les tests Chromium couvrent un bouton d’arrière-plan encore découvert, la lecture/clic dans la modale, des dialogues imbriqués, leur fermeture et le défilement isolé.

Les deux premières recettes échouaient avant correction. Cette couche rend les observations et actions explicites sensibles aux modales ; le suivi automatique est ajouté dans la couche suivante. Les overlays dépourvus de sémantique de dialogue ne sont pas tous identifiés par cette détection ; le contrôle de recouvrement continue à protéger les clics.

## Suivi explicite des changements de contexte

Le panneau propose une option séparée pour analyser automatiquement les changements de page et de modale dans un onglet, sans agir. Son activation commence par un tour d’observation sur l’onglet HTTPS actif et autorisé, puis fixe l’identifiant exact de cet onglet. Toutes les 1,5 seconde, une sonde isolée compare l’URL complète et les dialogues visibles par identité DOM. Une navigation SPA, une navigation complète ou un changement de dialogues déclenche un nouveau tour Charly en mode `observe`. Une action proposée par le serveur reste refusée par le runner d’observation.

Le suivi est local au panneau et n’est pas restauré après rechargement. Il s’arrête quand l’utilisateur le décoche, change d’onglet ou de fenêtre, démarre une nouvelle conversation, change de compte/workspace, perd la session ou le flag, retire le consentement IA, démarre la voix/formation, ferme l’onglet ou perd la permission du site. Un tour automatique en cours est annulé lors de l’arrêt. Le backend reçoit aussi l’identifiant d’onglet attendu : une course de focus avant la lecture provoque un refus au lieu de lire un autre onglet.

Les changements qui surviennent pendant un tour sont regroupés et analysés une fois le tour terminé. Une modale ouverte puis refermée entièrement pendant cette période peut ne pas être observée. La sonde n’extrait ni texte ni attributs métier ; le contenu est lu ensuite par le driver privé et filtré. Les tests Chromium couvrent navigation SPA, navigation complète, modale, tentative de clic refusée, retrait manuel, autre onglet, nouvelle conversation, confidentialité, flag, session et rechargement du panneau. Les tests unitaires couvrent la première référence, le regroupement, les réponses tardives, la perte de focus, le retrait de permission et l’onglet fixé.

Cette recette remplace le scénario legacy d’analyse automatique par un consentement de suivi explicite et limité à l’onglet. Deux scénarios legacy restent : le parcours vocal intégré et le parcours combiné onboarding/diagnostic/reset.

## Parcours natif combiné d’accompagnement

Un même scénario du panneau natif vérifie maintenant le changement EN puis FR et sa persistance après rechargement, un plan `write_todos` à 1/3, la demande de prochaine étape dans le même `conversationId`, le diagnostic sain, le téléchargement de logs sans contenu du chat ni identifiants, puis la création d’une nouvelle conversation via la commande de réinitialisation. La langue reste en français tandis que messages et plan ne sont pas transportés dans le nouveau fil.

La provenance de la trame n’est pas simulée comme prompt local dans ce scénario. Les recettes PostgreSQL/MCP des sections précédentes prouvent séparément que le Studio conserve le brouillon privé, publie la nouvelle révision et expose ses étapes au vrai service API. Les tests de factory API prouvent que ces outils appartiennent au main agent Charly et que mémoire/skills restent dans son runtime ordinaire. Aucun de ces tests n’appelle un modèle distant ; la qualité de la réponse réelle demeure un gate de qualification.

Ce parcours remplace le scénario legacy combiné, qui dépendait du prompt local et de Gemini. Il reste un seul scénario legacy : le parcours vocal intégré, dont les attentes de connaissances, clarification et suggestions doivent encore être rapprochées du comportement Deep Agent.
