# Transport des évaluations Studio vers Limova

Le client Deep Agent accepte un code d’évaluation optionnel à la création, à l’envoi de message et aux continuations navigateur (résultat/reprise). Il est transmis exclusivement dans `x-limova-evaluation-code` sur la mutation concernée. Les requêtes de session, de sélection d’agent et de lecture ne le reçoivent pas. Le corps des messages ne contient pas le code.

La passerelle first-party autorise cet en-tête uniquement sur `POST /conversation` et `POST /message/:id`. Elle le refuse sur les lectures, refresh, logout, uploads et annulations. Seuls les ports internes de l’extension restent admis. Le format est borné à 24–100 caractères URL-safe.

Le transport vocal valide le code avant de préparer l’onglet Limova. La passerelle valide à nouveau avant d’ouvrir le socket et l’ajoute exclusivement à `session.start`, pas à l’URL ni à l’authentification du socket. L’API le résout en runtime autorisé du même Charly.

Cette couche ne sélectionne pas encore le parcours d’évaluation dans le panneau. Le gestionnaire d’évaluation, la durée de vie du code en mémoire, l’arrêt/changement de compte et les événements Studio doivent encore être raccordés. Aucun code n’est ajouté au stockage par ces transports. La qualification complète exige une session Limova et un Studio autorisant le brouillon, puis une exécution texte et voix réelles.

Vérification locale : 238 tests du client et des composants Limova passent, dont l’en-tête sur les quatre mutations, son absence des lectures/corps, le refus des routes non concernées et la transmission vocale. Builds staging/production générés ; aucun déploiement.

## Gestionnaire de conversation d’évaluation

`LIMOVA_START_EVALUATION` revérifie la session, crée une conversation avec le grant et conserve celui-ci uniquement dans la mémoire du worker. Le stockage du contexte garde la conversation personnelle précédente. L’état public expose seulement `evaluationActive`, l’identité du contexte et la conversation active ; les notifications et le journal navigateur ne reçoivent pas le code.

Les tours texte, résultats navigateur et reprises utilisent le grant associé au test. Les changements de workspace/conversation et un second démarrage sont refusés pendant le test. `LIMOVA_END_EVALUATION` annule le tour puis efface le grant et restaure la sélection personnelle, même si l’annulation distante échoue. La perte de session, de workspace ou le changement de compte effacent également cette sélection temporaire.

Ces messages sont prêts côté gestionnaire Deep Agent. Le bouton historique `START_EVALUATION` et le mode vocal historique restent à basculer : cette couche ne rend donc pas encore le parcours utilisateur opérationnel. Le stockage historique `charly_evaluation_active` devra être retiré du parcours migré. Il reste aussi à raccorder les événements/résultats Studio et à vérifier la fermeture audio associée au test.
