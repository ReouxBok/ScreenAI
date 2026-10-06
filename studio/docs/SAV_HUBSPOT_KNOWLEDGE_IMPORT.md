# Import privé des connaissances HubSpot dans le SAV

## Périmètre de cette livraison

Complément à la PR #4, depuis `codex/ugo` / `4b62bdeafc1ddb0bfba83a7e3153c6db9e633958`.
Le code accepte un fichier privé préparé à partir des réponses de support. Il ne
contient aucune connaissance importée, aucun mail client et aucun secret.
Notion sert au suivi du travail ; le Studio conserve les connaissances et leurs
sources. Aucune nouvelle dépendance ou migration n’est nécessaire.

Seule l’orientation vers Limova 3 est une consigne générale de l’agent, commune
aux deux chemins de génération et conditionnée au besoin et aux preuves.
Les clarifications métier restent dans les fiches pertinentes, sans bloc de
règles prioritaires ni chargement systématique. Les révisions des prompts sont
incrémentées pour distinguer les évaluations de ce changement.

## Import et validation

Dans **SAV → Connaissances à valider**, choisir **Importer des fiches HubSpot**.
Le fichier JSON suit `hubspotImportSchema` :

- `schemaVersion: 1`, `namespace` stable et `entries` (1 à 100 fiches).
- Chaque fiche : `externalId` stable, `title` égal à l’objectif métier,
  `document` canonique `sav_only`, `provenance.sources` et `validationNotes`.
- Les sources contiennent uniquement références, liens HTTPS HubSpot, dates
  et identifiants de tickets. Aucun corps de mail brut n’est accepté comme champ.
- `supportContext` conserve symptômes, questions de diagnostic et réponse type.
  Les procédures, exceptions et escalades font partie de la révision revue.
- Maximum 800 000 octets par import, 12 000 caractères par fiche rendue.
  Les champs inconnus, identités répétées et procédures hors SAV sont refusés.

Le même namespace et identifiant rattachent les révisions à une famille stable.
Le réimport est idempotent : un candidat déjà préparé, approuvé ou rejeté n’est
pas recréé. Une modification de procédure, diagnostic ou réponse type crée une
révision. Toutes les fiches sont validées avant la première écriture. Les
écritures se font ensuite par fiche : un incident DB peut laisser un lot partiel,
que le renvoi du même fichier permet de reprendre. Aucun contenu publié n’est
remplacé par rapprochement de titre.

Les mentions de l’ancien nom de l’espace conversationnel sont harmonisées dans
les connaissances, en conservant la provenance. Les noms de compétences sont
des titres métier du Studio, pas des outils ou compétences exécutables ajoutés
au prompt. Aucun tutoriel, DOM ou droit global n’est modifié.

### Vérifier les contradictions

La page compare les articles non archivés du Studio (versions publiées **et**
brouillons, y compris ceux des autres agents) et les candidats SAV en attente.
Elle présente le texte et l’identité exacte des versions proches. Les
rapprochements lexicaux détectent des doublons et sujets voisins ; ils ne
constituent pas une preuve d’absence de contradiction et ne décident pas de la
vérité produit. Ugo vérifie les conditions, produits, versions et sources ; il
écarte le doublon ou corrige le candidat avant de l’approuver.

Pour un candidat HubSpot, l’approbation exige une confirmation de cette revue
et un motif. Le serveur recalcule une empreinte des textes et versions comparés ;
si la base a changé depuis l’affichage, recharger et refaire la comparaison.
L’approbation conserve l’empreinte et les références dans le Studio et produit
un brouillon `in_review`, non publié et désactivé pour l’IA à sa création.
L’état d’une projection existante est préservé lorsqu’une nouvelle révision est
proposée : sa version publiée reste en service jusqu’à une décision distincte.

La **publication**, puis l’**activation IA**, restent des décisions séparées
réalisées dans le workflow existant après validation. L’import ne fait ni l’une
ni l’autre. La recherche SAV continue de filtrer les versions publiées et
activées. Pour les fiches importées de taille bornée, elle renvoie le texte
complet de la version publiée : les précautions et réponses types ne sont pas
perdues lorsque le meilleur fragment correspond au seul symptôme. Le classement
par fragments et la recherche de l’extension restent inchangés.

## Recette en environnement isolé

1. Charger un fichier **fictif** conforme ; vérifier les candidats et sources,
   l’absence de publication, puis réimporter sans doublon.
2. Modifier une réponse type ; vérifier la nouvelle révision.
3. Comparer à une fiche publiée et à un brouillon du même sujet ; contrôler les
   désaccords à la main. Ne pas valider un doublon inutile.
4. Tenter l’approbation sans confirmation ou après modification d’une fiche
   comparée : elle doit être refusée. Un autre admin ne peut pas approuver.
5. Approuver comme Ugo : vérifier diagnostic, réponse type, précautions et
   provenance dans le brouillon, sans publication ni activation.
6. Avec autorisation distincte, publier/activer **uniquement en base de test**
   avec embeddings simulés ; vérifier la recherche SAV et les citations de la
   version exacte. Aucun appel Gmail/HubSpot n’est nécessaire.

Test optionnel du fichier de livraison privé, contre PostgreSQL PGlite en
mémoire uniquement, sans variables de connexion ou service externe :

```sh
SAV_PRIVATE_IMPORT_FIXTURE=/chemin/prive/import.json npm test -- src/lib/knowledge/hubspot-import.test.ts
```

Le fichier doit rester hors Git. Ce test prépare les candidats puis réimporte
le lot ; il ne publie pas ses connaissances. Les autres tests de ce fichier
emploient exclusivement des procédures fictives et des embeddings simulés.

## Limites et retour arrière

- La base du Studio en production n’a pas été lue ni modifiée pour cette
  livraison. La comparaison réelle sera exécutée lors de l’import autorisé.
- L’analyse des mails et les clarifications ne sont pas des tests fonctionnels
  du produit. Les autres détails historiques attendent la revue métier.
- L’empreinte contrôle l’état observé au moment de l’approbation, pas les
  modifications futures : la publication ultérieure exige une recette humaine.
- La livraison privée est en français ; le filtrage de langue de la recherche
  SAV existante reste inchangé. Les autres langues nécessitent des fiches
  correspondantes validées.
- Le blocage des déploiements Vercel est conservé. La CI et ses audits de
  dépendances restent obligatoires ; aucun contournement n’est introduit.
- Avant publication : écarter les candidats depuis le Studio. Après une
  publication autorisée : désactiver la fiche ou restaurer la version revue
  précédente avec le workflow existant et les validations habituelles. Ne pas
  supprimer les sources/audits pour annuler un import.
- Le retour arrière du code est le revert du commit de cette livraison sur la
  branche, suivi d’une nouvelle revue ; aucun déploiement automatique autorisé.

## Vérifications exécutées pour cette livraison

En local avec Node 22.22.1, sans configuration de production :

| Contrôle | Résultat |
| --- | --- |
| `npm ci` avec cache temporaire | Réussi, lockfile inchangé ; aucun changement de dépendance |
| `npm run typecheck` | Réussi |
| ESLint sur les 15 fichiers TypeScript/TSX modifiés ou ajoutés | Réussi |
| `npm run lint` global | Échec préexistant : `scripts/audit-sav-20-offline.mjs:46`, `@next/next/no-assign-module-variable` ; inchangé dans le commit de départ |
| Suite Studio, premier lancement | 516 réussis, 1 échec sur `memory/crypto.test.ts`, 1 sauté ; test de ciphertext intermittent déjà signalé dans la revue de branche |
| Suite Studio après ajout des tests de consigne, relance complète | 519 réussis, 1 sauté, 61 fichiers réussis |
| Import privé isolé, test opt-in | 13 tests réussis ; lot importé et réimporté sans doublon, aucun article publié/activé |
| `git diff --check` | Réussi |

Les tests de publication/recherche utilisent une base en mémoire et des
embeddings fictifs : aucune publication réelle, aucun test du modèle externe
ni validation fonctionnelle du produit. Aucun build ou E2E navigateur n’a été
exécuté pour ce lot. Les deux alertes de dépendances bloquant la CI existante
restent hors périmètre, sans changement d’audit, dépendance ou workflow CI.
