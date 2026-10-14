# Migration de la recette E2E vers Deep Agent

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

`limova-training-transcription.spec.js` utilise maintenant le panneau réel pour ouvrir l’entraînement, entrer le code Studio, démarrer, activer le microphone puis finaliser. Le flux PCM, la passerelle first-party, Socket.IO et le worker sont réels ; le serveur Limova/Studio est contrôlé et la sélection d’écran/l’upload vidéo sont simulés. Cette recette ne qualifie donc pas une vidéo réellement stockée.

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
