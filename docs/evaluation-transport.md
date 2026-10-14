# Transport des évaluations Studio vers Limova

Le client Deep Agent accepte un code d’évaluation optionnel à la création, à l’envoi de message et aux continuations navigateur (résultat/reprise). Il est transmis exclusivement dans `x-limova-evaluation-code` sur la mutation concernée. Les requêtes de session, de sélection d’agent et de lecture ne le reçoivent pas. Le corps des messages ne contient pas le code.

La passerelle first-party autorise cet en-tête uniquement sur `POST /conversation` et `POST /message/:id`. Elle le refuse sur les lectures, refresh, logout, uploads et annulations. Seuls les ports internes de l’extension restent admis. Le format est borné à 24–100 caractères URL-safe.

Le transport vocal valide le code avant de préparer l’onglet Limova. La passerelle valide à nouveau avant d’ouvrir le socket et l’ajoute exclusivement à `session.start`, pas à l’URL ni à l’authentification du socket. L’API le résout en runtime autorisé du même Charly.

Cette couche ne sélectionne pas encore le parcours d’évaluation dans le panneau. Le gestionnaire d’évaluation, la durée de vie du code en mémoire, l’arrêt/changement de compte et les événements Studio doivent encore être raccordés. Aucun code n’est ajouté au stockage par ces transports. La qualification complète exige une session Limova et un Studio autorisant le brouillon, puis une exécution texte et voix réelles.

Vérification locale : 238 tests du client et des composants Limova passent, dont l’en-tête sur les quatre mutations, son absence des lectures/corps, le refus des routes non concernées et la transmission vocale. Builds staging/production générés ; aucun déploiement.
