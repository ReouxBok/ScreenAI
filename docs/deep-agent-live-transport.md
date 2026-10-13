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

Le transport seul ne lance pas d’actions. Le contrôleur décrit ci-dessous compose ce transport avec le driver et le journal ; le contexte est relu à la demande du backend avant chaque tour vocal disposant des outils navigateur. Le panneau utilise désormais cette composition pour la voix utilisateur. `onEvent` doit rapidement enregistrer les frames dans sa propre file puis rendre la main : ne pas attendre l’exécution d’une action ou sa réponse vocale dans ce callback, car l’acquittement transport est borné à 5 secondes.

## Contrôleur navigateur vocal

`createBrowserLiveSession` compose le transport, le client HTTP Limova, le driver et le journal existants. Avant le socket : vérification du compte/workspace/conversation par `getConversation`, récupération de la session du journal, puis lecture du contexte de page autorisé. Les uploads éventuels gardent la conversation et le signal d’annulation de l’action.

`createLiveBrowserController` ingère les octets SSE sans attendre les actions dans `onEvent`. Son buffer d’entrée est borné à 256 Ko et le parseur commun conserve ses limites de taille. Seules les frames `extension.action_requested` suivies d’un état `waiting` cohérent déclenchent le journal, après une nouvelle vérification HTTP et l’autorisation du driver. Le reçu obtenu est envoyé via `continueBrowser`, avec un contexte relu après l’action. Maximum 100 continuations par tour ; un reçu incertain provoque un arrêt explicite, jamais un rejeu automatique.

L’annulation interrompt le parseur et le signal du driver ; un résultat tardif n’est pas envoyé. Une erreur ferme la session composée et remonte une seule notification. Le panneau arrête la session lors du changement de contexte stocké ou du retrait du consentement. Une vérification HTTP toutes les cinq secondes contrôle le compte, le workspace et le flag ; elle contrôle aussi les modes entraînement/évaluation. Ces modes conservent temporairement leur transport legacy.

Le test Chromium comprend maintenant une variante avec le vrai client HTTP first-party, le vrai driver DOM et IndexedDB. Le serveur local redemande le même `read_page` : deux reçus identiques sont transmis, pour une seule exécution DOM. Compte, flag, conversation et provider restent simulés par le serveur local ; cela ne prouve pas le fonctionnement d’un déploiement réel.

## Coupures et limites

- Aucune reconnexion, répétition du démarrage ni mise en file d’audio hors connexion. Une session interrompue nécessite un nouveau démarrage explicite.
- Trames PCM paires, limitées par le serveur (au plus 8 KiB) et à 64 Ko/s ; arrêt si le buffer Socket.IO est congestionné.
- Événements serveur livrés un à un avec acquittement du consommateur ; délai de 5 secondes, taille et nombre de trames en attente bornés. Une fermeture/navigation de l’app coupe le transport.
- Pas de refresh automatique au milieu du WebSocket : le client vérifie la session HTTP avant le démarrage et le transport valide l’identité confirmée par le serveur. Le superviseur périodique réutilise la vérification HTTP, y compris son refresh existant.
- Le contrôle périodique du flag peut laisser un délai maximal de cinq secondes côté panneau ; les autorisations backend restent nécessaires avant les effets. La qualification réelle des changements de contexte pendant une action suspendue reste à effectuer. L’acquittement transport ne prouve ni lecture sonore ni exécution d’une action.

## Vérification

Les tests unitaires couvrent le contrat d’identité, les commandes interdites, les séquences, les limites, les consommateurs bloqués et les coupures. Le test Chromium `tests/e2e/limova-live-session.spec.js` utilise un serveur HTTPS/Socket.IO local et un vrai cookie HttpOnly/Secure/Partitioned. Il vérifie l’origine app, le cookie reçu, les octets PCM, le binding navigateur, les identifiants distincts du tour vocal et navigateur, le retour exact d’un résultat, l’annulation et la fermeture sans répétition. Il simule le contrat backend de `session.ready` et de continuation : il ne qualifie pas un déploiement Limova ou un provider audio réel.

Les builds production et staging embarquent chacun leurs origines fixes. Le validateur vérifie les trois passerelles compilées et refuse un endpoint production dans le paquet staging.

## Microphone du panneau

`DeepAgentVoiceSession` relie le bouton micro à la conversation sélectionnée et aux événements natifs du même historique. Les transcriptions ne sont pas renvoyées comme un deuxième message humain. Pendant la connexion et la capture, les contrôles de sélection sont bloqués et la boucle legacy reçoit l’état vocal actif.

`openNativeAudio` utilise un AudioWorklet local, mono PCM16 little-endian, avec trames de 20 ms à la fréquence négociée (16 ou 24 kHz en entrée). Le worklet dispose de 25 crédits et attend les acquittements de capture ; un dépassement arrête la session. La lecture conserve la séquence serveur et limite la file à 30 secondes. L’interruption arrête les sources audio et rapporte le temps joué. L’arrêt ferme les contextes et libère les pistes micro.

Sans consentement navigateur, aucune session de journal ni aucun driver DOM n’est construit pour la voix. Le contrôleur continue à traiter les événements natifs, mais refuse les commandes navigateur. Le consentement AI reste requis.

`limova-native-voice-panel.spec.js` clique sur le vrai bouton, avec le vrai transport first-party et un microphone Chromium simulé. Il vérifie l’identité et la conversation au démarrage, les trames PCM, l’absence d’appel `/api/live-session`, puis l’arrêt après retrait du consentement. Le serveur local simule l’API et le provider. `native-audio.spec.js` qualifie séparément le worklet et la lecture ; il neutralise la fermeture automatique de sa page de permission, sans prétendre qualifier le parcours réel d’autorisation. Un test avec compte/provider réels reste requis avant activation.

## Contexte frais avant chaque tour vocal navigateur

Avant le premier segment natif de chaque tour, le backend émet `turn.browser_context_requested` avec `sessionId`, `turnId` vocal et `requestId` unique. L’extension revalide le compte/workspace/conversation puis appelle le driver pour relire le binding autorisé. Elle répond par `turn.browser_context` avec ces identifiants et `browserContext` (tabId, origin, contextVersion). Le backend attend au plus dix secondes ; une réponse absente, étrangère ou invalide ne déclenche aucun segment natif avec l’ancien contexte.

La passerelle accepte une seule réponse pour la demande courante, ajoute le sessionId confirmé et refuse les champs libres. La lecture est asynchrone et ne bloque pas l’ACK des événements. Cancel, interruption et fermeture annulent la lecture en cours ; un résultat tardif est ignoré. Sans autorisation navigateur, aucun échange de contexte n’est admis. Le driver conserve son onglet lié : un changement vers un autre onglet arrête la session au lieu de transférer implicitement son autorisation. La navigation du document reste soumise à ses contrôles de permissions et de version.

Ce contrat nécessite les deux couches API/extension correspondantes avant activation du flag. Il s’agit d’une évolution du protocole en draft, pas d’une capacité déjà déployée. La lecture avant le tour ne garantit pas qu’une page restera immobile ensuite : l’autorisation et le binding sont à nouveau contrôlés lors de chaque action.

## Isolation de l’observateur legacy

Le panneau signale `engine: deep_agents` avec l’état vocal actif. Le background suspend alors son ancien observateur automatique (navigation, modale, interaction) et n’active pas son écouteur de page via `SESSION_STATE`. Les observations en attente sont abandonnées avant capture ou publication dès que la session native est connue. Les commandes vocales legacy tardives sont refusées, y compris le démarrage de leur transport et l’insertion de transcriptions dans leur historique. Le driver Deep Agent demeure responsable des lectures/actions autorisées. Le bouton de capture legacy demande d’utiliser la conversation ; il ne déclenche pas une seconde capture pendant la voix native.

L’arrêt natif remet à zéro cet état. Le mode évaluation conserve encore son chemin legacy ; sa migration reste requise avant de retirer le proxy.


## Transcription des démonstrations Studio

Le micro d’entraînement utilise le namespace existant `/voice/transcribe` via une troisième passerelle first-party, avec le cookie de l’app et le workspace sélectionné. Il ne crée aucune conversation et aucun agent. La confirmation de session valide compte/workspace/surface, fréquence 16 kHz et taille maximale des trames ; les paquets audio portent le sessionId et une séquence. Aucun audio n’est conservé hors connexion ni rejoué après une coupure.

Les transcriptions partielles remplacent l’aperçu courant. Chaque résultat final est enregistré comme `voice_note` dans la démonstration active ; le texte est découpé en labels de 500 unités UTF-16 sans couper les paires Unicode. L’arrêt explicite sauvegarde la dernière transcription partielle et attend les notes avant de terminer la capture. Une révocation des droits abandonne la transcription partielle. Le background vérifie le consentement et l’identité de démonstration avant chaque fragment ; une écriture échouée arrête le flux sans répétition automatique. Les événements Studio ont un délai réseau maximal de quinze secondes.

Le micro réutilise le worklet PCM natif. Les contrôles d’identité, workspace, flag et consentement sont revérifiés toutes les cinq secondes ; l’arrêt ferme le transport et les pistes. L’observation de la démonstration reste active, alors que l’ancien moteur de décision vocal n’est pas démarré.

Le test `limova-training-transcription.spec.js` utilise le vrai bouton micro, le transport, le worklet et le background avec API/provider/Studio simulés localement. Il vérifie les octets audio, une note finale unique, l’absence de session vocale legacy et l’arrêt après retrait du consentement. Il utilise le paquet production en environnement isolé : le paquet staging n’autorise volontairement pas le Studio de production. Un Studio staging et une qualification avec compte/provider réels restent nécessaires. Ce test ne couvre pas l’enregistrement vidéo complet.
