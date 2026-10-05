# SAV V0 — lot 3 : SAV-11 à SAV-15

## État et frontière

Branche locale `codex/sav-v0`. Aucun commit, push, déploiement, migration ou changement de configuration en production. Migration additive `0026_sav_supervised_reviews` appliquée uniquement aux bases de test et à `work/sav-preview-db`.

Le code de l’extension Chrome et le workflow d’enregistrement/conversion des tutoriels ne sont pas modifiés. L’import vers le SAV est une action explicite dans la page Connaissances ; il lit une version source sans la modifier. La seule règle commune de publication prévue par SAV-11 est l’autorisation réservée à Ugo. Le répertoire des utilisateurs et leurs rôles globaux restent inchangés.

## Implémentation

| Ticket | Livrable local |
| --- | --- |
| SAV-11 | Revue Ugo des candidats, correction canonique avec diff et provenance, matérialisation atomique d’un brouillon SAV. Publication distincte réservée à Ugo avec vérification de la version et de l’approbation. Rejet et rollback audités. Aucun candidat Chrome sans enregistrement fiable ne peut être publié ou exécuté. |
| SAV-12 | Évaluation rattachée au run, modèle et prompt exacts, snapshots avant/après chiffrés. Un candidat de résolution masqué et non publié est créé seulement après qualification explicite « réutilisable » et justification. Ton ou cas client ne deviennent pas une règle générale. |
| SAV-13 | Inbox V0 post-cutover, filtres, recherche côté serveur et pagination. Exclusions techniques séparées ; pièces jointes affichées comme non analysées. Erreurs visibles, reprise d’analyse contrôlée et accès aux incidents de synchronisation/actions. |
| SAV-14 | Revue champ par champ du processus, qualification, note et brouillon Studio ; quatre verdicts et cinq dimensions. Contrôle anti-page obsolète, actor/date/revision, reprise humaine. La validation ne crée ni ticket ni email. |
| SAV-15 | Création manuelle et rattachement séparés, préflight Gmail/HubSpot, clé stable interne. Double clic dédupliqué, résultat connu réutilisé. Une création incertaine bloque tout nouveau POST et exige une réconciliation humaine vérifiant contenu, pipeline et contact. Aucun contact CRM créé. |

## Identité — décision Ugo

- Email absent de HubSpot : recherches **en lecture seule** sur le nom et le téléphone lorsqu’ils sont disponibles.
- Les correspondances sont des pistes, jamais une identité confirmée ni un rattachement automatique.
- Sans correspondance, le brouillon demande l’email d’inscription Limova.
- Avec une piste, passage en revue humaine ; aucun détail du compte trouvé n’est exposé au demandeur.
- Une adresse d’inscription différente nécessite une confirmation humaine explicite avant son utilisation pour le ticket.
- Les critères nom/téléphone demandent encore une vérification sur des cas réels autorisés ; les tests réseau de ce lot sont simulés.

## Accès à confirmer

Rôles existants : Ugo admin, Reouven owner, contact membre. À ce stade les deux premiers disposent de l’accès SAV ; contact reste bloqué tant qu’Ugo n’a pas confirmé l’autorisation SAV dédiée. Aucun rôle global n’a été changé. Les autres comptes conservent leurs usages Studio.

## Prévisualisation et vérification

Base PGlite isolée, mode shadow, IA désactivée, écritures externes bloquées, aucun identifiant Gmail/HubSpot/modèle transmis au processus local. Fixtures email : factures, identité non reconnue, erreur d’analyse, réponse automatique exclue, ancien email hors cutover. Les parcours et identités affichés sont fictifs, non validés en production.

- Suite complète finale : 261/261 tests, 42/42 fichiers, aucun test ignoré. Contrôle navigateur et incidents consignés dans Notion.
- Build Next/TypeScript réussi ; lint ciblé et `git diff --check` sans erreur.
- Replay hors ligne : 12/12.
- Navigateur : accueil et inbox accessibles, revue fictive corrigée enregistrée, évaluation partielle visible, création par clic distinct enregistrée en attente sans écriture externe ; aucune erreur console.
- Accès local : entraînements pour un membre existant HTTP 200, SAV pour ce membre HTTP 307 (refus), SAV pour Reouven owner HTTP 200. Aucun changement du répertoire global.
- Tests : approbation canonique, refus hors Ugo, source intacte, variante/stale/DOM non fiable bloqués, feedback masqué, absence d’apprentissage implicite, page obsolète, double clic, doublon tardif, contact inconnu, réponse réseau ambiguë, résultat connu, réconciliation correcte/incorrecte, confirmation d’identité, pièces jointes et rétention FK.

## Limites explicites

- Pas de test réel d’envoi, de création CRM ou de déploiement. Tous restent interdits avant validation d’Ugo.
- Le rattachement V0 enregistre le lien au ticket dans le Studio ; il ne crée pas d’activité email, note ou changement de statut HubSpot.
- Par prudence, un ticket ouvert trouvé à la préflight empêche une nouvelle création ; les faux positifs sont à examiner sur les cas réels avant élargissement.
- Une proposition notée critique est refusée pour validation dans cette version ; aucune progression automatique vers un mode autonome.
- Les variantes contextuelles de connaissance ne sont pas aplaties ; leur publication reste bloquée tant que le contexte n’est pas qualifié.
- Aucun candidat SAV → Chrome n’ajoute de DOM ou de clic : il reste « à compléter par un tutoriel ».

## Recette Ugo

1. Dans l’inbox, ouvrir le cas Factures et vérifier l’email, la pièce jointe non analysée et le processus fictif.
2. Corriger la réponse, donner le verdict sur la proposition initiale et enregistrer la revue : aucun ticket n’est créé.
3. Si pertinent, qualifier une procédure générique réutilisable ; la retrouver comme candidat non publié dans Résolutions.
4. Ouvrir le cas Identité : vérifier le signalement et les pistes non confirmées ; aucun nouveau contact.
5. Vérifier les vues Erreurs/Exclusions et l’absence de l’ancien email.
6. Dans Connaissances, vérifier l’approbation distincte, les sources et le statut non exécutable des candidats Chrome.

Les tickets passent en Review Ugo pour recette locale ; le parent reste In Progress. Le prochain lot couvre les tickets suivants après retour sur cette prévisualisation.
