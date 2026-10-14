# Transport des évaluations Studio vers Limova

Le client Deep Agent accepte un code d’évaluation optionnel à la création, à l’envoi de message et aux continuations navigateur (résultat/reprise). Il est transmis exclusivement dans `x-limova-evaluation-code` sur la mutation concernée. Les requêtes de session, de sélection d’agent et de lecture ne le reçoivent pas. Le corps des messages ne contient pas le code.

La passerelle first-party autorise cet en-tête uniquement sur `POST /conversation` et `POST /message/:id`. Elle le refuse sur les lectures, refresh, logout, uploads et annulations. Seuls les ports internes de l’extension restent admis. Le format est borné à 24–100 caractères URL-safe.

Le transport vocal valide le code avant de préparer l’onglet Limova. La passerelle valide à nouveau avant d’ouvrir le socket et l’ajoute exclusivement à `session.start`, pas à l’URL ni à l’authentification du socket. L’API le résout en runtime autorisé du même Charly.

Le panneau est maintenant raccordé au gestionnaire décrit ci-dessous. Les événements de preuve et le scoring Studio doivent encore être adaptés au flux natif. Aucun code n’est ajouté au stockage par ces transports. La qualification complète exige une session Limova et un Studio autorisant le brouillon, puis une exécution texte et voix réelles.

Vérification locale : 238 tests du client et des composants Limova passent, dont l’en-tête sur les quatre mutations, son absence des lectures/corps, le refus des routes non concernées et la transmission vocale. Builds staging/production générés ; aucun déploiement.

## Gestionnaire de conversation d’évaluation

`LIMOVA_START_EVALUATION` revérifie la session, crée une conversation avec le grant et conserve celui-ci uniquement dans la mémoire du worker. Le stockage du contexte garde la conversation personnelle précédente. L’état public expose seulement `evaluationActive`, l’identité du contexte et la conversation active ; les notifications et le journal navigateur ne reçoivent pas le code.

Les tours texte, résultats navigateur et reprises utilisent le grant associé au test. Les changements de workspace/conversation et un second démarrage sont refusés pendant le test. `LIMOVA_END_EVALUATION` annule le tour puis efface le grant et restaure la sélection personnelle, même si l’annulation distante échoue. La perte de session, de workspace ou le changement de compte effacent également cette sélection temporaire.

Le bouton `START_EVALUATION` crée maintenant la conversation via ce gestionnaire avant de connecter le run Studio. Un refus ou une erreur de connexion restaure la sélection précédente. Le token historique `charly_evaluation_active` n’est plus écrit ni restauré ; il est supprimé au démarrage. Après redémarrage du worker, le test doit être reconnecté explicitement.

La voix utilise le chemin Deep Agent ordinaire avec le grant obtenu par `LIMOVA_PREPARE_VOICE` sur le port interne. Le worker vérifie la conversation sélectionnée ; le panneau vérifie identité, workspace et génération après l’attente. Les sélecteurs restent verrouillés pendant une évaluation. Le grant n’entre ni dans le rendu ni dans le pilote de page.

Le verdict arrête la voix du panneau, annule le tour texte et bloque de nouveaux envois/préparations vocales pendant sa transmission. Une erreur de transmission conserve le test pour réessayer ; un succès ferme le contexte local. Les événements de preuve du moteur natif, le scoring et une qualification complète du parcours restent nécessaires : les tests unitaires ne prouvent pas une évaluation réelle réussie.
