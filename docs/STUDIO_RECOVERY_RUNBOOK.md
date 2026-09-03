# Runbook de fiabilité du Studio

## Garde-fous permanents

- `SAV_AUTOMATION_MODE=shadow` pendant le pilote : ingestion, analyse et propositions uniquement.
- Les actions d’un lot pilote ont un `pilot_batch_id` et ne sont jamais exécutées dans Gmail ou HubSpot.
- Un membre ne voit et ne gère que ses tutoriels. Un admin ou owner peut tous les gérer.
- Une vidéo complète peut être récupérée ; un essai incomplet est archivé avec une trace d’audit.
- Une publication construit ses chunks dans la même transaction que l’activation de la version.

## Vérification locale

```bash
npm ci
npm ci --prefix proxy
npm ci --prefix studio
npm test
npm test --prefix proxy
npm run typecheck --prefix studio
npm run lint --prefix studio
npm test --prefix studio
npm run build --prefix studio
npm run test:e2e --prefix studio
npm run test:e2e
```

## Récupérations avec aperçu obligatoire

Depuis `studio/` :

```bash
npm run training:reconcile
npm run gmail:replay
```

Ces commandes sont des dry-runs. Les variantes `training:reconcile:apply` et `gmail:replay:apply` modifient les données et ne doivent être lancées qu’après migration, déploiement validé et confirmation du mode shadow.

## Déploiement et rollback

1. Déployer la branche en préproduction Vercel.
2. Vérifier `/connexion`, les redirections privées et un flux membre de création de tutoriel.
3. Promouvoir ce déploiement précis en production ; ne pas reconstruire entre les deux.
4. Contrôler `/studio/sante`, puis appliquer les récupérations.
5. En cas d’échec, utiliser l’Instant Rollback Vercel vers le déploiement précédent et réinstaller le ZIP de l’extension précédent. Les migrations de ce lot sont additives et ne détruisent aucune donnée.

Les événements récupérés ou archivés sont conservés dans `audit_logs`. Les quarantaines Gmail restent visibles jusqu’à leur résolution explicite.
