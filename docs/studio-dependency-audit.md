# Audit des dépendances Studio — 14 octobre 2026

## Correction esbuild

Le chargeur TypeScript de Drizzle (`@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils`) résolvait esbuild 0.18.20, concerné par [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99). Un override ciblé sur core-utils impose 0.25.12, déjà dans la plage utilisée par Drizzle lui-même.

Le graphe préexistant résolvait aussi esbuild 0.25.12 pour le peer optionnel de Vite 8.2.2, qui attend `^0.27.0 || ^0.28.0`. Déclarer esbuild 0.28.2 en dépendance de développement corrige ce conflit ; le chargeur Drizzle conserve sa version 0.25.12 isolée.

Le verrou régénéré déplace/déduplique les distributions esbuild et retire 0.18.20. La comparaison des ensembles nom/version confirme qu’aucun autre paquet ne change de version. Le volume du diff du verrou provient surtout de ces déplacements et des binaires par plateforme.

Validation locale : installation `npm ci --ignore-scripts` réussie, `npm ls esbuild` sans dépendance invalide, transformations TypeScript synchrones/asynchrones du vrai core-utils réussies ; `drizzle-kit export --config drizzle.config.ts` produit le schéma sans accès DB. Les 218 tests Studio passent, deux tests PostgreSQL conditionnels sont ignorés dans cette exécution. Typecheck et build passent. Aucune migration appliquée ni base modifiée.

## Résultat et limites

`npm audit` passe de 13 alertes (8 moderate, 5 high) à 9 (4 moderate, 5 high). Il s’agit de comptes de paquets affectés, pas de neuf causes distinctes. La CI `npm audit --audit-level=high` reste donc bloquée.

- Chaîne Next ESLint → fast-glob → micromatch → braces : [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Braces 3.0.3 est encore la dernière version consultée, sans version corrigée annoncée ; `@next/eslint-plugin-next` 16.4.0 conserve fast-glob 3.3.1. Une montée de Next seule ne règle pas cette chaîne.
- Chaîne gray-matter → js-yaml → argparse → sprintf-js : [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). Les deux usages directs de gray-matter sont les scripts d’import/export Markdown ; leur remplacement exige une vérification de compatibilité des métadonnées et des exports.

Aucune règle ESLint désactivée, aucun seuil d’audit abaissé et aucun downgrade Next/Drizzle appliqué pour faire disparaître le résultat. Ce correctif est une réduction vérifiée, pas un audit global vert ni une qualification du déploiement.
