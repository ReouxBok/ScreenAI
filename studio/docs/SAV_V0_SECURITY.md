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

Pas de modification du seuil CI, pas d'exception silencieuse ni de fake override supprimant l'alerte. Production, migrations et cutover restent en attente d'une remédiation ciblée et validée. La présence de braces dans une dépendance ne prouve pas qu'un client peut atteindre son parseur : cartographier les appels réels avant de proposer une suppression/remplacement ou une mitigation.

## Vérifications locales

- 368/368 tests Studio après correctifs sous Node 24 ; 303/303 tests racine ; 2/2 tests du harness proxy.
- Schéma Drizzle sans écart supplémentaire ; replay déterministe 12/12.
- Lint complet Studio réussi. Les preuves build/E2E finales sont consignées dans le suivi de PR ; des tests unitaires ne remplacent pas les tests navigateur ni les services réels.
