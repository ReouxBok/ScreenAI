# SAV — branche de revue, sans déploiement

Branche : `codex/ugo`. Base GitHub : `f00f807`.
Ce lot prépare une revue ; il n'autorise aucun merge, déploiement, migration,
retraitement d'emails ou appel d'écriture Gmail/HubSpot.

## Périmètre technique

- SAV-20 : diagnostics de génération à codes autorisés, distinction entre
  analyse et repli, trace obligatoire avant persistance d'une proposition.
- SAV-21 : séparation du dernier message, des citations et de la signature ;
  contexte borné, langue et faits déclaratifs. L'original reste inchangé.
- SAV-23 : conservation des brouillons contextualisés sous revue humaine,
  contrôle des citations et de l'identité ; règle de présentation séparée à
  l'envoi et snapshot chiffré du corps final, hash et révision vérifiés.
- SAV-22 : les fiches de connaissances candidates sont hors de ce dépôt public.
  Aucune fiche publiée ou activée par ce lot. Leur stockage cible est la base
  canonique du Studio ; Notion sert uniquement au suivi des tâches.
- SAV-24 : évaluation isolée et qualité réelle des sorties encore à qualifier.

Complément HubSpot et correctifs de revue : import privé vers des candidats
SAV, provenance versionnée, comparaison sur le document corrigé et le brouillon
cible actuel. La recherche partagée est modifiée uniquement pour restituer une
fiche HubSpot complète dans le scope SAV ; le chemin extension est inchangé.
Voir `SAV_HUBSPOT_KNOWLEDGE_IMPORT.md` pour le détail et les limites de recette.
Aucun changement du runtime extension Chrome, DOM, tutoriels, SDK, dépendances,
schéma ou rôles globaux du Studio.

## Vérification locale

Depuis `studio`, avec Node 24 :

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=2
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/lib/sav 'src/app/studio/sav/[id]/proposal-review.tsx'
```

Depuis la racine :

```sh
git diff --check
node studio/scripts/verify-sav-release.mjs origin/main
node studio/scripts/audit-sav-20-offline.mjs
```

Régression initiale du lot SAV-20/21/23 : 505 tests, 59 fichiers, passants. PostgreSQL PGlite
et fournisseurs simulés uniquement. Le scanner est partiel : relire le diff
pour les données privées, il ne constitue pas un audit PII exhaustif.
Un test mémoire préexistant et intermittent reste inchangé hors du SAV.
Le build complet et les E2E seront vérifiés par la CI de la PR ; leur succès
n'est pas présumé. Aucun vrai modèle, envoi Gmail ou ticket CRM testé ici.

## Passage de relais

1. Partir du SHA exact de la PR, pas d'une ancienne copie locale.
2. Un seul agent écrit sur `codex/ugo` à la fois ; lire les changements existants.
3. Ne pas modifier `studio/vercel.json` pour activer une preview. Les branches
   `codex/ugo` et `codex/ugo/**` sont bloquées par `git.deploymentEnabled`.
4. Dépôt public : aucun secret, mail client, export de base ou connaissance
   privée dans les commits, les fixtures, les logs ou la description de PR.
5. Fournir le diff, les tests, les limites et les choix produit à valider.
6. Pas d'auto-merge, de bypass CI ni de déploiement sans accord Ugo distinct.

## Avant une future production

La source d'un déploiement CLI observé précédemment n'a pas été récupérée
intégralement. Réconcilier les changements légitimes avec cette branche avant
de remplacer le code servi. Vérifier les providers et le parcours réel dans un
environnement isolé, puis obtenir l'approbation explicite du SHA à livrer.
La publication GitHub de cette branche n'effectue aucune de ces opérations.
