# SAV-19 — livraison contrôlée

## Accord et limites — 5 octobre 2026

Ugo valide la stratégie de publication sur la branche publique `codex/sav-v0`, PR puis production verrouillée, qualification shadow et activation humaine séparée. Cela remplace le choix historique de transfert privé sans push. Aucun merge direct sur main.

Le projet Vercel `studio` utilise le root `studio`, Node 24 et la branche production `main`. La configuration Git bloque uniquement le déploiement automatique de `codex/sav-v0` : les variables PostgreSQL existantes ciblent aussi la preview, donc cette branche ne doit pas exposer la base de production dans une preview. Ne pas promouvoir une preview connectée à cette base.

Version de retour arrière vérifiée au début de la préparation : commit `9b29635632ef80681b8078a4780a0d410eed02da`, déploiement `dpl_AYBavxCCi119uhPRGenSJf7gnNLA`. Vérifier à nouveau le déploiement effectivement actif avant toute promotion.

## Gates obligatoires

1. Relire le diff, vérifier absence de secrets/données clients (`node scripts/verify-sav-release.mjs` depuis Studio, complément non exhaustif à la revue), CI complète et non-régression Studio/extension. Rien de la démo n'est une connaissance produit publiée.
2. PR en brouillon jusqu'à réussite de la CI et revue ; conserver les usages historiques des admins hors connaissances SAV/nouvelles projections canoniques. Aucun rôle global modifié.
3. Vérifier les droits réels Gmail/HubSpot, le label existant et l'identité de la boîte OAuth, la disponibilité du modèle IA et les mappings CRM. La présence des variables ne prouve pas les permissions. Ne pas tester un envoi réel sans cas désigné et accord.
4. Vérifier une sauvegarde/restauration de la base cible ; appliquer uniquement les migrations additives 0025 à 0028 approuvées, dans l'ordre, après contrôle de l'historique de migrations. Ne pas connecter une base de prod à la démo.
5. Présenter à Ugo la version exacte et la cible avant mise en production. Déployer verrouillé avec `SAV_RELEASE_STAGE=v0`, `SAV_AUTOMATION_MODE=shadow`, `SAV_WRITES_DISABLED=true`, `SAV_PILOT_MODE=false`, `SAV_HUBSPOT_BACKFILL_ENABLED=false`, `SAV_RETENTION_ENABLED=false`, sans `DEV_AUTH_BYPASS`. Préserver la clé chiffrante existante. Ne pas réinitialiser watch/curseurs.
6. Une fois la version réellement READY, activer une seule frontière immutable avec son SHA, sa date READY et la boîte OAuth vérifiée, selon `SAV_V0_CUTOVER.md`. Les anciens messages restent contexte en lecture seule, pas de backfill.
7. Qualifier les prochains entrants en shadow : couverture vs Gmail, contexte CRM, résumé, brouillon et références de connaissances approuvées. Vérifier les logs et la non-mutation externe.
8. Accord Ugo distinct avant `assist`/levée du kill switch et recette d'un message précisément désigné. Envoyer, créer un ticket et ouvrir/classer un message sont des actions séparées. Valider le process ne déclenche aucun envoi ni publication de connaissance.

## Sécurité et recette

L'audit initial bloque la CI : dépendances vulnérables préexistantes, notamment Next 16.3.4 (alerte critique next/og). Ugo autorise un lot séparé de correctifs compatibles, sans montée majeure ADK ni modification fonctionnelle de l'extension. Le 5 octobre, il autorise ensuite une exception temporaire ciblée sur GHSA-vfj7-8cjw-p6xm (braces 3.0.3), expirant le 12 octobre à 00:00 UTC, documentée dans `SAV_V0_SECURITY.md`. Toute autre high/critical reste bloquante et la CI fonctionnelle reste inchangée. Aucune montée majeure forcée.

La suite Studio avant ce lot de sécurité : 368/368 tests, lint complet, TypeScript, build et replay 12/12 réussis. Génération Drizzle : aucun écart supplémentaire au schéma des migrations 0025–0028. Ces preuves locales ne remplacent pas la recette Gmail/HubSpot/IA réelle.

## Retour arrière

D'abord bloquer les écritures, puis restaurer le déploiement connu compatible. Conserver migrations additives, reçus, audits et frontière. Une configuration d'environnement modifiée n'affecte pas magiquement les déploiements existants : vérifier/re-déployer le kill switch si nécessaire. Un email envoyé, un ticket créé ou un classement Gmail déjà réalisé n'est pas annulé par un rollback du code. Pas de replay aveugle des résultats incertains.

## Non-régression extension — contre-vérification du 5 octobre

Le feu vert production d'Ugo est conditionné à la préservation de l'extension déjà livrée. Ne publier aucun paquet Chrome et ne déployer aucun proxy dans ce rollout Studio. Les fichiers de l'extension/DOM et les tutoriels publiés ne sont pas modifiés par cette livraison.

Une régression indirecte a été reproduite localement : le nouveau garde de révision de `searchKnowledge` s'appliquait aussi au scope extension. Une publication concurrente déclenchait une erreur API et pouvait forcer la base embarquée de secours du client Chrome. Le garde est désormais strictement SAV ; la recherche extension garde son comportement historique. Deux tests de course simulent le changement de révision pendant l'embedding : extension sans erreur, SAV refusant toujours une proposition à révisions mélangées.

Preuves locales : 303/303 tests racine extension/proxy et 370/370 tests Studio. Elles ne constituent pas une preuve E2E ou une qualification de qualité sur des requêtes réelles. Le correctif local n'est pas encore publié. L'accord conditionnel ne supprime ni la gate sécurité restante ni les vérifications de sauvegarde/migrations ; aucun merge, déploiement, cutover ou appel externe mutatif n'a été réalisé à cette étape.

## Préflight serveur sans export des secrets

Les valeurs sensibles Gmail/HubSpot/IA existantes ne sont pas exportables par Vercel. Ne pas les remplacer ou tenter de les copier. Le contrôle `GET /api/internal/sav/preflight` utilise le token de service existant, n'est pas accessible sans authentification et renvoie `Cache-Control: no-store`.

Il ne fonctionne que sous les six verrous d'observation ci-dessus. Il vérifie l'identité OAuth, le filtre contact@limova.ai, l'unicité du label Gmail existant, la lecture des contacts/tickets HubSpot et les étapes du pipeline, puis la disponibilité du modèle configuré. Aucune lecture de corps d'email, donnée CRM renvoyée, écriture Gmail/HubSpot ou inférence. Les permissions d'envoi et la qualité d'une proposition réelle restent à qualifier séparément.

Le premier déploiement est préparé en production **sans affectation du domaine** (`--prod --skip-domain`) et avec les verrous explicites. Le préflight doit réussir avant promotion vers studio.limova.ai. Aucun branchement d'une preview/démo à la base de production.
