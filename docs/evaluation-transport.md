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

## Preuves d’exécution navigateur

Les reçus locaux du journal sont projetés vers les événements Studio après exécution, sur les chemins texte et voix. La projection conserve uniquement le nom d’opération compatible Studio, son statut et la version du contexte. Elle exclut texte saisi, contenu de page, captures, URL et grant. `completed` signifie ici que l’opération a été exécutée : aucune lecture de page, capture ou action n’est convertie en `verify_expected_result`.

Le worker lie la preuve à la conversation d’évaluation active et capture son grant pour l’envoi. Les reçus identiques sont dédupliqués par action ; un reçu contradictoire est refusé. Une erreur d’enregistrement arrête la continuation et reste visible au flush, sans retry aveugle d’un POST non idempotent. Le verdict attend les tours texte en cours et les enregistrements connus. Les lectures/écritures du journal navigateur ne contiennent pas le grant.

Restent à réaliser : preuve de réponse canonique, vérification explicite du résultat attendu et qualification des interruptions vocales en cours d’action. Les scores ne sont donc pas encore qualifiés pour ce nouveau parcours. Tests : 264 cas composants Limova passent ; 27 tests du gestionnaire repassés après l’ajout de l’attente des tours texte.

## Preuve de réponse texte canonique

Avant un tour d’évaluation texte (y compris navigateur), le worker charge l’historique de la conversation. Il en conserve les identifiants comme référence, puis observe uniquement les snapshots `values` du graphe racine. À la fin réussie du flux, il exige une nouvelle réponse assistant visible, non vide, sans appel outil, après le dernier message humain, et aucune action navigateur encore en attente. Un événement d’erreur invalide la preuve. Les tokens partiels et les événements de sous-agent ne suffisent pas.

La preuve envoyée est seulement `{kind: 'response', status: 'ok'}`. Le texte reste dans Limova ; l’identifiant sert à la déduplication locale. Un refus d’enregistrement demeure bloquant au flush du verdict. Ce raccordement couvre le texte ; la preuve de réponse vocale et la vérification explicite du résultat attendu restent à ajouter.

Vérification locale : 278 tests des composants Limova passent et le build production réussit. Aucun parcours réel ni scoring complet n’est revendiqué.

## Preuve de réponse native pendant la voix

La session charge l’historique avant l’ouverture du fournisseur vocal. Chaque tour observe ensuite les snapshots du graphe racine avec le même filtre que le texte. Seul `turn.deep_agent_stream.completed`, après consommation du flux et sans interruption, permet d’enregistrer la réponse. Les identifiants déjà vus sont conservés pendant la session pour ignorer les relectures d’historique.

Le panneau envoie au worker seulement l’identifiant du message final et la conversation. Le worker exige le test actif, déduplique cet identifiant et transmet au Studio le statut de réponse sans son texte. L’arrêt audio conserve la possibilité d’attendre les enregistrements déjà engagés ; leur échec bloque le verdict. Cela prouve la réception de la réponse canonique dans l’extension, pas que tout l’audio a été entendu.

La vérification explicite de l’objectif métier reste à raccorder ; aucune capture, lecture de page ou affirmation du modèle n’est implicitement transformée en réussite de ce contrôle. La qualification réelle du parcours demeure nécessaire.

## Conditions obligatoires du scoring

Le calcul Studio exige désormais les preuves minimales indépendamment du seuil numérique : réponse livrée pour tous les scénarios ; action exécutée et résultat vérifié en plus pour un scénario `live_action`. Un seuil invalide est refusé. Les points restent affichés pour le diagnostic, mais un seuil bas ne contourne plus une preuve manquante. Les erreurs d’outil et interventions manuelles restent éliminatoires.

La relecture de l’ancien `verify_expected_result` a confirmé qu’il renvoyait `ok` après une simple relecture de page, avec l’attendu dans un message. Ce comportement ne constitue pas une comparaison avec les critères métier. Le parcours natif ne reprend pas cette équivalence : la vérification explicite reste à implémenter avant de qualifier les tests d’action.

Validation de cette correction : 19 tests Studio ciblés passent, ainsi que TypeScript et ESLint. Pas de migration de données ni de déploiement.

## Vérificateur des critères côté Studio

La route existante `POST /api/evaluations/runs/events` accepte maintenant `kind: native_verification` avec une observation bornée (texte, origine HTTPS, chemin sans query/hash, version de contexte et date). Le service charge les critères du scénario depuis le grant ; le client ne choisit pas les critères à valider. Seuls les tests `live_action` en cours hors SAV sont admis. Le grant, le scénario et la version sont relus après l’appel modèle.

Un appel Gemini sans outils compare tous les critères au texte observé. Il utilise la configuration de clé du scope extension déjà disponible dans Studio, jamais la clé SAV. Le modèle reprend la référence `gemini-3.6-flash` présente dans le proxy existant ; sa disponibilité et sa qualité sur le déploiement cible restent à qualifier. Aucune identité d’agent n’est créée. Les observations ont moins de 60 secondes, les pages attendues sont contrôlées lorsqu’elles sont définies, et chaque critère positif doit citer un extrait exact non vide du texte observé. Une sortie tronquée, une erreur fournisseur ou une preuve invalide ne produit pas de vérification positive.

Le résultat reste un jugement de modèle, pas une preuve formelle de l’état du backend. Les extraits exacts réduisent les affirmations sans source mais ne garantissent pas une interprétation correcte. Il faut tester notamment les pages contradictoires, les erreurs métier et les instructions hostiles dans la page avant activation. Le service n’enregistre que le statut et la version de contexte, sans texte de page ni citations.

Le raccordement de l’observation depuis l’extension reste à faire. Les 39 tests ciblés utilisent un fournisseur simulé ; TypeScript et ESLint passent. Aucun appel réel au fournisseur ni déploiement effectué.
