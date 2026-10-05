# SAV V0 — gate sécurité

## Lot compatible autorisé — 5 octobre 2026

Les correctifs sont séparés du commit fonctionnel V0. Aucun upgrade majeur ADK, changement de rôle global ou changement fonctionnel des tutoriels/extension.

- Next et eslint-config-next : 16.3.8.
- Undici : 6.29.0 ; overrides Workflow 7.29.1.
- adm-zip : override 0.6.1 (Studio et proxy).
- devalue : override 5.9.3 compatible avec la série 5 utilisée par Workflow.
- Mise à jour compatible de la résolution transitive et régénération des lockfiles ; installation propre Studio réussie sous Node 24.
- ADK conservé à 1.6.0 dans le lock Studio et 1.5.0 dans celui du proxy.

## Audit après correctifs

| Périmètre | High | Critical | État du seuil CI high |
| --- | ---: | ---: | --- |
| Racine / outils extension | 0 | 0 | Passe ; 4 moderate restantes |
| Proxy | 13 | 0 | Bloqué |
| Studio | 15 | 0 | Bloqué |

Ces comptes incluent les dépendances parentes d'une même alerte transitive : ce ne sont pas 28 failles distinctes. La chaîne high restante remonte à `braces` via micromatch/fast-glob, présent dans les dépendances ADK/MikroORM et, dans le Studio, les outils ESLint Next.

- [Avis braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) : versions jusqu'à 3.0.3 affectées, **aucune version corrigée publiée** au contrôle.
- [Avis Next GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) : concerne ImageResponse Node alimenté par des valeurs attaquant. Le passage à 16.3.8 supprime l'alerte de dépendance ; l'audit initial ne prouvait pas une exploitation dans notre application.

Ne pas exécuter `npm audit fix --force` : les propositions incluent ADK 2 et un downgrade majeur ESLint Next. Une montée majeure ADK seule ne corrige pas la présence de braces dans les outils de lint.

Le seuil reste high/critical. La présence de braces dans une dépendance ne prouve pas qu'un client peut atteindre son parseur ; elle n'est pas non plus une preuve d'absence de risque.

## Exception temporaire explicitement autorisée — 5 octobre 2026

Après la proposition d'une exception documentée limitée à braces, Ugo répond « ok fais la verif vite puis push ». Cette décision remplace l'attente d'une correction upstream pour cette seule alerte ; elle ne supprime aucune autre gate de recette ou de base de données.

- Propriétaire : Ugo Le Bras. Expiration bloquante : **12 octobre 2026 à 00:00 UTC**. Pas de renouvellement automatique.
- Seulement **GHSA-vfj7-8cjw-p6xm**, dépendance `braces`, version installée **3.0.3**, sévérité high et plage `<=3.0.3`. Aucune exception sur une nouvelle alerte, une critical ou un paquet parent entier.
- `scripts/audit-dependencies.mjs` conserve les comptes bruts et affiche un avertissement. Il remonte les chaînes transitives et échoue sur toute autre high/critical, une erreur réseau, un rapport incomplet ou une exception expirée. Aucun `continue-on-error`.
- Cartographie : ESLint Next utilise des motifs de configuration ; MikroORM utilise les chemins d'entités/cache. Aucun flux email → motif braces identifié. Import ADK, construction du runner en mémoire et création de session instrumentés : zéro appel braces. Ce contrôle ne couvre pas un appel réel du modèle et ne prouve pas l'inexploitabilité.
- Risque résiduel accepté : déni de service par motif profondément imbriqué si un chemin exposé est trouvé. Aucune correction de la faille n'est revendiquée.
- Livraison limitée au Studio en shadow, écritures Gmail/HubSpot bloquées, aucun déploiement proxy ni publication Chrome. CI complète, sauvegarde/restauration, migrations et rollback restent obligatoires.
- Retirer l'exception dès qu'une correction compatible ou une remédiation testée est disponible ; avant expiration, revoir l'alerte et les chemins d'exposition. Pas de montée majeure ADK forcée.

## Vérifications locales

- 368/368 tests Studio après correctifs sous Node 24 ; 303/303 tests racine ; 2/2 tests du harness proxy.
- Schéma Drizzle sans écart supplémentaire ; replay déterministe 12/12.
- Lint complet Studio réussi. Les preuves build/E2E finales sont consignées dans le suivi de PR ; des tests unitaires ne remplacent pas les tests navigateur ni les services réels.
