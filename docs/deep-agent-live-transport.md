# Transport vocal Limova — couche préparatoire

Le transport `createLimovaLiveTransport` ouvre le namespace Socket.IO existant `/conversation/live` depuis le document exact de l’app Limova, via un port interne dans le monde isolé de l’extension. Il réutilise les cookies du navigateur sans les lire ni les copier. Le worker ou le panneau prépare l’onglet avec le même helper que le chat HTTP. La dépendance Socket.IO est embarquée dans le paquet, sans script distant.

Cette couche n’est pas encore branchée au bouton micro. Les PR API #2212–#2214 préparent le contrat extension et sa reprise navigateur ; leur disponibilité sur le déploiement cible reste à vérifier. La capture PCM, la lecture audio et le raccordement au panneau restent à réaliser. Le moteur cible reste le Charly Deep Agent existant.

## Contrat requis côté backend

Le handshake transporte `auth.workspaceId`. Le démarrage envoie `session.start` avec `conversationId`, `languageCode`, `userTimezone`, `clientSurface: chrome_extension` et `expectedUserId`. Le serveur doit vérifier cette dernière valeur contre l’identité issue du cookie, les droits du workspace, le main Charly/general et le flag unique avant de démarrer le provider. Les champs fournis par le client ne confèrent aucun droit.

`session.ready` doit confirmer `clientSurface`, `userId`, `workspaceId`, `conversationId`, `sessionId`, `inputSampleRate`, `outputSampleRate` et `maxAudioFrameBytes`. La passerelle refuse l’ancien contrat sans identité/surface ainsi qu’un compte ou workspace différent : elle ne peut pas activer accidentellement le parcours live web. Ces champs supplémentaires sont implémentés dans la PR API #2212 ; leur présence en production n’est pas présumée.

Le flux accepte uniquement les événements live connus. `audio.append` contient des octets PCM binaires et une séquence croissante ; `response.cancel` transmet le temps audio déjà joué, et la fermeture du port arrête la session. Les fréquences sont celles annoncées par le serveur, pas une hypothèse du micro. Le transport ne transcrit pas et n’envoie aucun message texte supplémentaire.

## Continuations navigateur

Le démarrage accepte les deux champs optionnels `browserSession` (credential UUID) et `browserContext` (`tabId`, origine HTTPS exacte, `contextVersion`). Ils sont validés ensemble avant ouverture du socket, puis transmis uniquement au backend Limova.

Le handle retourné expose `continueBrowser({ turnId, kind, browserContext, browserResult?, browserTurnId? })`. `turnId` est celui du **tour vocal** reçu dans `turn.deep_agent_stream.started`. Le résultat ou la reprise porte séparément l’identifiant du **tour navigateur**, issu des frames SSE. La passerelle ajoute elle-même le `sessionId` vocal confirmé par le serveur et émet `turn.browser_continue`. Le credential navigateur n’est pas recopié dans les résultats.

Les champs sont limités au contrat existant : résultats completed/rejected/failed, observation de 32 000 caractères maximum, identifiants d’action/outil bornés, référence image UUID éventuelle et contexte de page validé. Aucun contenu utilisateur supplémentaire, agent alternatif ou destination arbitraire. Une continuation ne peut partir que pour le tour vocal actif d’une session ayant déclaré son binding navigateur ; au maximum 100 envois par tour, sans mise en file Socket.IO hors connexion. Annulation et fin de tour invalident cette possibilité.

Le transport seul ne lance pas d’actions. Le contrôleur décrit ci-dessous compose ce transport avec le driver et le journal ; le rafraîchissement proactif du contexte entre tours et le branchement au panneau restent à réaliser. `onEvent` doit rapidement enregistrer les frames dans sa propre file puis rendre la main : ne pas attendre l’exécution d’une action ou sa réponse vocale dans ce callback, car l’acquittement transport est borné à 5 secondes.

## Contrôleur navigateur vocal

`createBrowserLiveSession` compose le transport, le client HTTP Limova, le driver et le journal existants. Avant le socket : vérification du compte/workspace/conversation par `getConversation`, récupération de la session du journal, puis lecture du contexte de page autorisé. Les uploads éventuels gardent la conversation et le signal d’annulation de l’action.

`createLiveBrowserController` ingère les octets SSE sans attendre les actions dans `onEvent`. Son buffer d’entrée est borné à 256 Ko et le parseur commun conserve ses limites de taille. Seules les frames `extension.action_requested` suivies d’un état `waiting` cohérent déclenchent le journal, après une nouvelle vérification HTTP et l’autorisation du driver. Le reçu obtenu est envoyé via `continueBrowser`, avec un contexte relu après l’action. Maximum 100 continuations par tour ; un reçu incertain provoque un arrêt explicite, jamais un rejeu automatique.

L’annulation interrompt le parseur et le signal du driver ; un résultat tardif n’est pas envoyé. Une erreur ferme la session composée et remonte une seule notification. Le changement de compte/workspace et les modes entraînement/évaluation devront annuler cette session depuis le futur raccordement au panneau/background. Le bouton micro existant n’utilise pas encore cette composition.

Le test Chromium comprend maintenant une variante avec le vrai client HTTP first-party, le vrai driver DOM et IndexedDB. Le serveur local redemande le même `read_page` : deux reçus identiques sont transmis, pour une seule exécution DOM. Compte, flag, conversation et provider restent simulés par le serveur local ; cela ne prouve pas le fonctionnement d’un déploiement réel.

## Coupures et limites

- Aucune reconnexion, répétition du démarrage ni mise en file d’audio hors connexion. Une session interrompue nécessite un nouveau démarrage explicite.
- Trames PCM paires, limitées par le serveur (au plus 8 KiB) et à 64 Ko/s ; arrêt si le buffer Socket.IO est congestionné.
- Événements serveur livrés un à un avec acquittement du consommateur ; délai de 5 secondes, taille et nombre de trames en attente bornés. Une fermeture/navigation de l’app coupe le transport.
- Pas de refresh automatique au milieu du WebSocket : le futur contrôleur doit vérifier/renouveler la session HTTP avant le démarrage puis vérifier l’identité confirmée par le serveur.
- La coordination du flag en cours de session, du changement de workspace, des actions navigateur suspendues et de la lecture/interruption audio reste à implémenter. L’acquittement transport ne prouve ni lecture sonore ni exécution d’une action.

## Vérification

Les tests unitaires couvrent le contrat d’identité, les commandes interdites, les séquences, les limites, les consommateurs bloqués et les coupures. Le test Chromium `tests/e2e/limova-live-session.spec.js` utilise un serveur HTTPS/Socket.IO local et un vrai cookie HttpOnly/Secure/Partitioned. Il vérifie l’origine app, le cookie reçu, les octets PCM, le binding navigateur, les identifiants distincts du tour vocal et navigateur, le retour exact d’un résultat, l’annulation et la fermeture sans répétition. Il simule le contrat backend de `session.ready` et de continuation : il ne qualifie pas un déploiement Limova ou un provider audio réel.

Les builds production et staging embarquent chacun leurs origines fixes. Le validateur vérifie les deux passerelles compilées et refuse un endpoint production dans le paquet staging.
