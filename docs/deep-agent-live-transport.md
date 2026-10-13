# Transport vocal Limova — couche préparatoire

Le transport `createLimovaLiveTransport` ouvre le namespace Socket.IO existant `/conversation/live` depuis le document exact de l’app Limova, via un port interne dans le monde isolé de l’extension. Il réutilise les cookies du navigateur sans les lire ni les copier. Le worker ou le panneau prépare l’onglet avec le même helper que le chat HTTP. La dépendance Socket.IO est embarquée dans le paquet, sans script distant.

Cette couche n’est pas encore branchée au bouton micro. Le backend doit d’abord implémenter le contrat extension et sa reprise navigateur ; la capture PCM et la lecture audio restent à raccorder. Le moteur cible reste le Charly Deep Agent existant.

## Contrat requis côté backend

Le handshake transporte `auth.workspaceId`. Le démarrage envoie `session.start` avec `conversationId`, `languageCode`, `userTimezone`, `clientSurface: chrome_extension` et `expectedUserId`. Le serveur doit vérifier cette dernière valeur contre l’identité issue du cookie, les droits du workspace, le main Charly/general et le flag unique avant de démarrer le provider. Les champs fournis par le client ne confèrent aucun droit.

`session.ready` doit confirmer `clientSurface`, `userId`, `workspaceId`, `conversationId`, `sessionId`, `inputSampleRate`, `outputSampleRate` et `maxAudioFrameBytes`. La passerelle refuse l’ancien contrat sans identité/surface ainsi qu’un compte ou workspace différent : elle ne peut pas activer accidentellement le parcours live web. Ces champs supplémentaires ne sont pas encore fournis par le backend actuel.

Le flux accepte uniquement les événements live connus. `audio.append` contient des octets PCM binaires et une séquence croissante ; `response.cancel` transmet le temps audio déjà joué, et la fermeture du port arrête la session. Les fréquences sont celles annoncées par le serveur, pas une hypothèse du micro. Le transport ne transcrit pas et n’envoie aucun message texte supplémentaire.

## Coupures et limites

- Aucune reconnexion, répétition du démarrage ni mise en file d’audio hors connexion. Une session interrompue nécessite un nouveau démarrage explicite.
- Trames PCM paires, limitées par le serveur (au plus 8 KiB) et à 64 Ko/s ; arrêt si le buffer Socket.IO est congestionné.
- Événements serveur livrés un à un avec acquittement du consommateur ; délai de 5 secondes, taille et nombre de trames en attente bornés. Une fermeture/navigation de l’app coupe le transport.
- Pas de refresh automatique au milieu du WebSocket : le futur contrôleur doit vérifier/renouveler la session HTTP avant le démarrage puis vérifier l’identité confirmée par le serveur.
- La coordination du flag en cours de session, du changement de workspace, des actions navigateur suspendues et de la lecture/interruption audio reste à implémenter. L’acquittement transport ne prouve ni lecture sonore ni exécution d’une action.

## Vérification

Les tests unitaires couvrent le contrat d’identité, les commandes interdites, les séquences, les limites, les consommateurs bloqués et les coupures. Le test Chromium `tests/e2e/limova-live-session.spec.js` utilise un serveur HTTPS/Socket.IO local et un vrai cookie HttpOnly/Secure/Partitioned. Il vérifie l’origine app, le cookie reçu, les octets PCM, l’annulation et la fermeture sans répétition. Il simule les champs futurs de `session.ready` : il ne qualifie pas un déploiement Limova ou un provider audio réel.

Les builds production et staging embarquent chacun leurs origines fixes. Le validateur vérifie les deux passerelles compilées et refuse un endpoint production dans le paquet staging.
