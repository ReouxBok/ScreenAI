# SAV V0 — lot 4 local, 5 octobre 2026

## Périmètre livré pour revue Ugo

| Ticket | Implémentation locale | Limite de qualification |
| --- | --- | --- |
| SAV-16 | Brouillons chiffrés append-only, édition, validation interne, abandon, références email/run/revue/connaissance, verrou de contexte/version et audit | Aucun envoi ni brouillon Gmail/HubSpot ; recette fictive uniquement |
| SAV-17 | Métriques post-cutover par origine, modèle, prompt, connaissance, code et catégorie ; verdict initial et cinq dimensions ; scénarios réécrits et approuvés Ugo ; replays des règles | Ne teste pas les réponses du modèle IA ; qualification réelle et replay agent restent nécessaires |
| SAV-18 | Dashboard avec données insuffisantes explicites, incidents, connaissances en attente, calibration, historique et décisions documentaires Ugo | Aucune mutation d’autonomie ni déploiement ; les seuils ne valent pas validation de production |

## Arbitrages pris en compte

- Accès SAV dédié à contact@limova.ai : le compte garde son rôle global membre. Ugo admin et Reouven admin/owner autorisés ; autres comptes SAV refusés. Les autres rubriques utilisent toujours leurs guards globaux existants.
- Correction après erreur critique permise uniquement si le process/réponse a réellement été modifié. Le verdict IA d’origine et ses dimensions sont conservés dans l’évaluation.
- Préflight HubSpot : matching/ambiguïté demandent rattachement/revue ; ticket ouvert non lié au problème exige justification humaine d’au moins 20 caractères avant nouvelle création. Ce blocage est terminal, sans relance automatique. La justification est chiffrée.
- Aucun contact créé, aucun nouvel envoi, aucune publication automatique de connaissance, aucun changement DOM/extension/tutoriel.

## Données et sécurité

- Migrations additives 0027 et 0028 : nouvelles tables uniquement dans le schéma SAV ; provenance ajoutée à sav.agent_runs. Le schéma global evaluation_runs est inchangé.
- Appliquées exclusivement à PGlite locale de démonstration et bases de tests ; jamais en production.
- Code identifié seulement par SHA exact fourni par l’environnement, sinon unknown. Un checkout modifié ne devient pas artificiellement un commit qualifié.
- Les métriques ne mélangent pas simulations/tests/réel. Les fixtures anciennes sont reconnues par runtime local_fixture.
- Scénarios de replay : Ugo réécrit, confirme l’anonymisation et valide. Coordonnées courantes et liens sont masqués ; la vérification humaine reste nécessaire pour noms/adresses/détails identifiants. Le mail original n’est jamais copié automatiquement.
- Un replay porte hash du corpus, version du runner et code. Nouveau scénario ou revue remplacée : un replay ancien ne satisfait plus la gate du corpus courant.
- Les métriques bornées aux 5 000 derniers runs affichent leur troncature et bloquent les demandes de promotion. Les taux manquants ne sont pas des succès.
- Contrôles d’identité côté serveur pour chaque action ; contexte et optimisme vérifiés avant écritures ; lectures indépendantes parallélisées.

## Gates et limites

Le dashboard réutilise les seuils préexistants : 30 revues par version/catégorie, 100 revues réelles globales, score pondéré >= 90 %, zéro critique/dégradation/incident et calibration <= 15 points. Ces seuils sont des aides à la revue d’une future promotion d’autonomie, **pas des prérequis au premier déploiement shadow V0**. Le bouton de demande reste documentaire, même si tous les indicateurs sont satisfaits.

Un replay de règles réussi n’est pas une certification du modèle. Aucun accord de déploiement, publication de connaissance ou passage assist/semi/on n’est déduit du dashboard. SAV-19 exige une qualification terrain et un accord explicite sur les opérations prévues.

## Vérifications du 5 octobre

- Suite complète : 326/326 tests, 49 fichiers.
- Build Next.js et TypeScript : réussis ; lint ciblé réussi.
- Un premier passage avait exposé le blocage de problème distinct relancé automatiquement : corrigé dans retry-policy et testé. Un test crypto mémoire préexistant a également échoué une fois car son altération base64 peut ne pas modifier les octets ; diagnostic consigné, code mémoire inchangé, passage complet final réussi.
- Navigateur local : sauvegarde, invalidation après nouvelle revue, validation interne et abandon du brouillon fictif ; critique initial conservé ; données réelles absentes affichées insuffisantes. Scénario fictif anonymisé approuvé en recette, replay des règles 1/1 et décision fictive de maintien en observation enregistrée sans action externe.
- Derniers ajustements : filtre remounté selon la navigation ; calibration sans confiance affichée non mesurable. Métriques retestées 8/8, TypeScript et lint ciblé repassés après ces ajustements.
- Desktop vérifié sans erreur console. Petit écran 390 px : débordement de la coque Studio/sidebar existante constaté ; la coque globale n’a pas été modifiée hors périmètre. La recette mobile reste à reprendre, aucun résultat responsive positif prétendu.

Serveur : npm run sav:preview, http://127.0.0.1:3010/studio/sav. Aucun secret réel, push, PR, migration production ou déploiement. L’archive privée du 2 octobre reste l’ancien checkpoint.
