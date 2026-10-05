# SAV V0 — reprise privée du 2 octobre 2026

## Mise à jour du checkout — 5 octobre 2026

### Accord de publication et préparation du rollout

Ugo a ensuite validé la stratégie branche GitHub publique `codex/sav-v0` + PR, production verrouillée puis qualification shadow et activation humaine séparée. Cet accord remplace le choix historique du paquet privé sans push ci-dessous. Lire [SAV_V0_ROLLOUT.md](SAV_V0_ROLLOUT.md) pour les gates et preuves actuelles. L'audit de sécurité bloque encore le déploiement ; correctifs compatibles autorisés dans un lot séparé, sans montée majeure ADK ni changement fonctionnel extension/tutoriels. Aucune mutation de production présumée par cet accord de préparation.

### Dernière demande : trace Gmail des ouvertures

Lire [SAV_V0_GMAIL_FILING.md](SAV_V0_GMAIL_FILING.md). Le clic sur un email de la file V0 ajoute MAIL STUDIO SAV et retire INBOX ; pas de changement lu/non lu, pas de dossier créé. POST authentifié, message exact, audit et erreurs visibles ; aucun effet lors du rendu/préchargement. Dernière instruction : terminer ce script avant de décider ensemble du push. Aucun push ni activation production. Identifiants Gmail/HubSpot/IA déclarés en production ; scopes réels non confirmés.

### Décision la plus récente : réponse manuelle distincte

Lire [SAV_V0_MANUAL_REPLY.md](SAV_V0_MANUAL_REPLY.md). Ugo autorise un clic humain **Envoyer la réponse** dans le fil Gmail d’origine ; **Valider le process corrigé** n’envoie rien, sans bouton Refuser. Connaissance proposée puis validée séparément par Ugo, jamais publiée automatiquement. Cette décision remplace les mentions historiques d’interdiction totale d’envoi V0 ci-dessous. La démo reste sans envoi externe ; recette réelle et production non autorisées.

Le présent checkout a continué après le paquet du vendredi. **L’archive privée du 2 octobre n’a pas été régénérée et ne contient pas ce nouveau lot.** Aucun push, commit, PR ou déploiement n’a été effectué pour ce lot.

- Lire aussi [SAV_V0_LOT_4.md](SAV_V0_LOT_4.md) : SAV-16/17/18, brouillons versionnés, métriques séparées, replays déterministes anonymisés et décisions documentaires Ugo.
- L’accès SAV dédié à `contact@limova.ai` membre est désormais prévu sans changer son rôle global. Les autres accès Studio restent inchangés.
- Une proposition IA critique peut être corrigée puis approuvée ; son verdict initial reste critique. Une proposition critique non corrigée ne peut pas être approuvée.
- Un autre ticket ouvert sans matching peut permettre une nouvelle création uniquement avec justification humaine explicite du problème distinct. Un matching ou une ambiguïté restent bloquants. Aucun contact créé.
- Suite : [SAV_V0_PILOT_CHECKLIST.md](SAV_V0_PILOT_CHECKLIST.md). Recette locale fictive disponible ; Gmail/HubSpot et IA réels non qualifiés. Pas d’autorisation de production implicite.

## Décisions de transfert

- Choix Ugo : **paquet privé, aucun push**. Le dépôt GitHub ScreenAI est public ; la nouvelle implémentation n’y a pas été publiée.
- Le dossier fourni contient tout le code du dépôt, l’historique Git et un checkpoint local sur `codex/sav-v0`. Le checkpoint est créé dans une copie de livraison, pas dans le checkout de travail d’origine. `main` n’est pas modifiée.
- Le remote de lecture référence le dépôt existant ; son URL de push est volontairement désactivée dans la copie privée, et aucun upstream de push n’est configuré. Ne pas réactiver de push ni créer de PR sans accord Ugo.
- Aucun secret, `.env`, `node_modules`, build, session Codex ou base client n’est transféré. La base de démo est recréée localement à partir de fixtures.

## Premier démarrage sur le Mac

1. Décompresser l’archive et déplacer `ScreenAI` dans un dossier de travail. Ouvrir ce dossier comme projet dans Codex.
2. Utiliser Node 24 (Node 22.13+ accepté) et installer seulement les dépendances du Studio.
3. Lancer la démo isolée :

```sh
cd ScreenAI/studio
npm ci
npm run sav:preview
```

Ouvrir `http://127.0.0.1:3010/studio/sav`. Le terminal doit rester ouvert ; `Ctrl+C` arrête le serveur. Le code et les revues de cette nouvelle base restent sur ce Mac. Les anciens liens contenant un UUID de fixture de l’autre Mac ne sont pas réutilisables : partir de l’inbox.

Instructions, sécurité et dépannage : [SAV_LOCAL_PREVIEW.md](SAV_LOCAL_PREVIEW.md).

## Contexte pour le prochain Codex

Lire ce fichier, puis [SAV_V0_CONTRACT.md](SAV_V0_CONTRACT.md), [SAV_V0_LOT_2.md](SAV_V0_LOT_2.md) et [SAV_V0_LOT_3.md](SAV_V0_LOT_3.md). Ne pas repartir de `main` ni remplacer les changements par une nouvelle génération. Les règles de `studio/AGENTS.md` s’appliquent.

- [Parent Notion — Créer l’agent SAV IA](https://app.notion.com/p/3ec4e1ce0bc98196a524cb3765b1c2de) : In Progress.
- Tickets SAV-1 à SAV-15 : implémentations et analyses locales prêtes pour recette, statut Review Ugo ; pas de validation de production implicite.
- [SAV-13 — Inbox](https://app.notion.com/p/3ed4e1ce0bc98182851dfb7ed6b1719c) et [SAV-14 — Revue humaine](https://app.notion.com/p/3ed4e1ce0bc9816b9097d008b21ed393) intègrent aussi le retour UX de cette session.
- Ne pas charger la bibliothèque de skills Notion : elle est hors scope.

## Frontière produit ferme

- Surveiller `contact@limova.ai`, déjà synchronisée ; HubSpot fait foi pour les tickets de l’équipe. Notion contient les tickets personnels de réalisation d’Ugo, pas ceux des clients.
- V0 : nouveaux emails synchronisés après activation seulement, **aucun rattrapage historique**. Tous les entrants sont qualifiés ; exclusions visibles séparément.
- Le Studio est le poste de pilotage : process et brouillon IA, correction et validation humaines sans CTA Refuser, évaluation rattachée au run exact. **Envoi V0 uniquement par bouton humain distinct, en réponse dans le fil d’origine.**
- Créer/rattacher un ticket demande un clic humain distinct après revue. Préflight live et déduplication sont obligatoires ; une création incertaine demande réconciliation, jamais un second POST aveugle.
- **Ne jamais créer de contact HubSpot.** Si l’email n’est pas reconnu, chercher les indices nom/téléphone en lecture seule. Les pistes ne confirment pas l’identité ; demander l’email d’inscription Limova dans le brouillon si nécessaire.
- Toute nouvelle connaissance doit être relue et validée par Ugo avant publication. Une correction de ton ou un cas propre au client n’est pas une procédure générique.
- SAV/Chrome partagent une famille canonique et des projections séparées : le SAV conserve le parcours sémantique « Paramètres en bas à gauche → Facturation → Factures » ; DOM/clic/enregistrement restent propres à Chrome. Un candidat SAV → Chrome sans tutoriel est non exécutable, non publié, « à compléter par un tutoriel ».
- Ne pas modifier les utilisateurs, rôles globaux du Studio, tutoriels, DOM ou extension existants. Une connexion de développement réelle nécessite un cadrage et des autorisations distincts.

## Refonte UX livrée dans ce paquet

- Adresse client en haut à droite ; dernier email reçu au début de la colonne principale.
- « Voir la conversation entière » si plusieurs messages, historique chronologique, puis proposition IA : process et brouillon avant la qualification/évaluation, CTA de revue en bas.
- Colonne droite : fiche HubSpot reconnue lors de l’analyse, ticket réellement lié distinct d’un matching proposé, conversations liées, puis CTA manuels. Un raccourci donne accès au contexte pour les écrans étroits et la lecture assistée.
- Conversations liées : uniquement références RFC disponibles, même boîte et même email client, recherche bornée à 40 conversations récentes ; aucun matching par objet ni fusion automatique. Un lien historique permet la lecture, pas le retraitement.
- Labels et choix en français, enums backend inchangés. La décision du panneau reflète la correction revue, pas l’ancienne décision IA. CTA de création désactivé pour action en attente/en cours ou résultat incertain.
- CSS limitée au SAV ; aucun changement de styles globaux pour cette refonte.

## Vérification et suite

- Tests unitaires/DB isolée, build Next/TypeScript, lint ciblé et navigateur local ont été vérifiés pendant cette session. Le compte exact final est fourni dans le guide de livraison extérieur et le suivi Notion.
- Le test d’installation neuve a révélé des peers optionnels manquants dans le lockfile existant (esbuild pour Vite, chokidar/readdirp pour Workflow). Le lock a été complété sans changer les dépendances directes ni les versions des paquets déjà verrouillés, puis l’installation propre retestée. Il faut conserver ce `studio/package-lock.json` avec le code.
- La démo est **fictive** : pas d’IA en direct, pas de Gmail/HubSpot réels, écritures externes bloquées. Les parcours fictifs ne sont pas des connaissances produit validées.
- En priorité : recette Ugo sur l’UX, puis cas réels autorisés et préparation contrôlée du déploiement. Aucun déploiement, migration production, cutover, secret ou activation d’autonomie sans validation explicite sur les opérations prévues.

Questions historiques du checkpoint du 2 octobre (résolues dans le checkout du 5 octobre, pas dans l’archive) :

1. Autorisation SAV dédiée à `contact@limova.ai`, actuellement membre global et donc bloqué par le garde SAV admin/owner. Ne pas changer son rôle global pour contourner cela.
2. Un ticket ouvert trouvé à la préflight empêche actuellement la création : vérifier les faux positifs et préciser la règle avant élargissement.
3. Une proposition notée critique ne peut pas être approuvée dans la règle actuelle, même corrigée. Clarifier ce workflow sans améliorer rétroactivement le verdict de l’IA d’origine.

## Prompt court de reprise

> Reprends le projet SAV V0 depuis ce checkpoint privé. Lis `studio/docs/SAV_V0_HANDOFF.md`, le contrat et les deux derniers lots avant modification. Aucun push, PR, déploiement, migration prod, secret réel ou modification des utilisateurs/extensions/tutoriels sans validation explicite d’Ugo. Lance `npm run sav:preview` dans `studio` pour la démo fictive. Respecte le suivi des tickets Notion et pose les questions produit avant de changer une règle. Commence par vérifier l’état local et le retour UX d’Ugo.
