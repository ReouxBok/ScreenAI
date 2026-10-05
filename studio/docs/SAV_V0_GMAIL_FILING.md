# SAV-16 — Classement Gmail au clic (5 octobre 2026)

## Décision produit

Un clic humain sur un email de la file SAV V0 du Studio ajoute le libellé existant **MAIL STUDIO SAV** et retire **INBOX**, afin de laisser une trace des ouvertures et de ne plus laisser ce message dans la boîte de réception. Le message reste consultable dans le Studio et Gmail. Son statut lu/non lu et ses autres libellés restent inchangés. Aucun email supprimé ni dossier créé.

Le changement est encore local. Dernière instruction Ugo : terminer et présenter le script avant de décider du push. Aucun push, déploiement, migration production ou cutover réel effectué.

## Déclenchement

- Formulaire POST par ligne de la file, avec IDs du message et du dossier ; pas de mutation depuis un rendu serveur, un préchargement Next, une visite GET ou un effet de montage.
- Authentification/allowlist SAV côté serveur. L’acteur vient de la session, jamais du formulaire. Aucun rôle global Studio changé.
- Classement du **message cliqué**, pas de tous les messages du thread ni du dernier entrant arbitrairement. Les liens de contexte et le laboratoire restent en lecture/simulation.
- Écriture du clic dans audit_logs (acteur, date, message, dossier) avant toute requête Gmail ; marqueur de dispatch avant modification, résultat/erreur enregistré ensuite. Aucun corps email dans ce journal.

## Gmail

- Recherche du libellé utilisateur existant par son nom, insensible à la casse pour accepter « MAIl STUDIO SAV ». Absence/ambiguïté : erreur visible, aucune création ni archivage.
- Lecture des métadonnées du message exact ; vérification ID et threadId. Message dans la corbeille ou contexte incohérent : blocage.
- Une requête messages.modify avec addLabelIds = [ID du dossier] et removeLabelIds = [INBOX]. Aucun changement UNREAD, étoile, spam ou autre libellé.
- Double clic/réouverture : ajout/retrait idempotents. Si le message est déjà classé, aucune seconde modification ; chaque ouverture autorisée reste auditée.
- Kill switch, shadow, prévisualisation et pilotes : aucun accès Gmail ni mutation. Éligibilité post-cutover et boîte active revérifiées avant le POST.
- Timeout/réponse incohérente après modification : résultat incertain affiché, jamais faux succès. Un nouveau clic humain peut vérifier le résultat existant ; aucun retry autonome.
- Le dossier SAV reste accessible même si le classement échoue. Aucun ticket/contact/envoi, aucun changement de proposition ou connaissance induit.

## Permissions et mise en service

Les noms de credentials Gmail/HubSpot/IA sont présents dans l’environnement Vercel production (inventaire lecture seule du 5 octobre). Leur présence ne prouve ni leur validité ni les scopes effectivement consentis. Aucun secret n’a été affiché ou copié dans la démo.

La modification des libellés requiert notamment gmail.modify (ou un scope Gmail plus large accepté par l’API). À vérifier avec **le token de service du Studio**, pas avec les droits du connecteur Gmail Codex. Lecture du profil/scopes et existence du libellé en recette autorisée, puis test du clic sur un email désigné après activation réelle. Ne pas élargir les permissions silencieusement.

La watch INBOX et le curseur de synchronisation restent inchangés. Le préflight d’envoi lit le thread par ID et ne dépend pas de la présence d’INBOX : l’archivage ne supprime pas le contexte nécessaire pour répondre.

### Diagnostic des droits après activation assist

`GET /api/internal/sav/gmail-permissions`, protégé par `STUDIO_SERVICE_TOKEN` (au moins 32 caractères), inspecte le grant OAuth du runtime et le profil `contact@limova.ai`, sans envoi, classement, lecture de corps email ni écriture DB. Réponse non cachée ; aucun token, credential, corps provider ou donnée client retourné. Ne pas copier le token dans un navigateur ou les logs.

Le rapport distingue `sendScopeGranted` et `modifyScopeGranted`. `gmail.modify` permet les deux ; un droit d’envoi seul ne permet pas le classement. Un champ scope absent reste inconnu et ne doit pas être interprété comme un droit absent ou accordé. Le diagnostic ne prouve pas qu’une mutation réussira : `writesNotTested` reste vrai, même avec les scopes requis. Les politiques Workspace peuvent encore refuser une opération.

Ce diagnostic fonctionne en assist sans retirer les garde-fous du préflight initial, qui reste réservé au rollout shadow verrouillé. Si les droits sont insuffisants, demander une réautorisation humaine du compte de service ; ne pas élargir les scopes ni remplacer le refresh token sans validation.

## Vérification

Tests isolés PGlite/réseau simulé : message exact, préservation des autres libellés et lu/non lu, dossier manquant/ambigu, permissions, acteur non autorisé, identifiants incohérents, corbeille, cutover, boîte inactive, pilotes, kill switch avant POST, clic répété et résultat incertain. Tests POST/auth et rendu sans effet externe. Aucune mutation Gmail réelle dans la recette locale.

Résultat final : **366/366 tests, 53 fichiers**, build Next/TypeScript et lint ciblé réussis, git diff --check sans erreur. Vérification navigateur sur le seul cas factures fictif : nouveau bouton d’ouverture, POST puis dossier avec retour « classement Gmail désactivé », aucune erreur console. Capture hors dépôt : outputs/SAV-classement-gmail-local-2026-10-05.jpg. Serveur local laissé actif sur 127.0.0.1:3010, sans accès Gmail/HubSpot. SAV-16 prêt pour Review Ugo, pas Done/production.

Sources : [messages.modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), [labels.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list).
