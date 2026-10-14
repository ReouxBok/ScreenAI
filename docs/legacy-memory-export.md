# Export complet des enregistrements historiques conservés

`POST /api/internal/memory/export` réutilise l’authentification serveur à serveur existante et la clé utilisateur validée. Le proxy `/api/copilot/export` continue de dériver cette clé de l’utilisateur authentifié, puis de fournir un fichier JSON. Aucune route publique supplémentaire ni association automatique à un UUID Limova n’est créée.

Le service dédié `studio/src/memory/export.ts` utilise une transaction `REPEATABLE READ READ ONLY`, avec un timeout de dix secondes par requête. Il n’appelle plus le chargement de contexte, le modèle, la recherche vectorielle ou les helpers qui créent une session. Il ne met à jour ni les dates d’usage ni la préférence mémoire.

## Format version 2

L’archive expose `schemaVersion: 2`, `scope: retained_legacy_memory_records`, la date, `complete: true`, `identityMapping: unverified` et `replayAllowed: false`.

- `user` : préférences et profil déchiffré, ou null si l’identité n’existe plus.
- `sessions`, `messages`, `summaries` : tous les épisodes et leurs contenus conservés, avec identifiants, relations, statuts et dates.
- `memories`, `goals` : tous les états conservés, y compris oubliés, expirés et abandonnés ; embeddings et fingerprints restent disponibles pour la réconciliation.
- `tombstones`, `runs`, `auditEvents` : marqueurs d’oubli, états historiques déchiffrés et audit de cette identité.

Chaque tableau est filtré sur la même identité et ordonné par date puis identifiant. Les champs chiffrés sont remplacés par leur valeur JSON déchiffrée (`content`, `state`, `adkState`, `profile`, `title`, `nextStep`, `blocker`) ; les objets d’origine sont conservés sans interprétation. Par exemple, le contenu d’un message reste `{ content: "..." }` dans son champ `content`. Une préférence désactivée ne masque pas les données conservées. Une identité absente n’est pas créée ; ses éventuels événements d’audit conservés sont exportés.

Le format remplace l’ancienne projection `recentMessages`/résumé unique. Le proxy télécharge le JSON sans transformation. Les fichiers antérieurs ne deviennent pas exhaustifs rétroactivement.

## Échecs et limites

Une erreur de requête ou de déchiffrement fait échouer toute la réponse avec `memory_unavailable` : pas de données partielles annoncées complètes, ni de ciphertext silencieusement ignoré. La réponse réussie conserve `Cache-Control: private, no-store`. Le périmètre est celui des enregistrements encore stockés ; les données déjà supprimées physiquement ne peuvent pas être reconstituées.

Il s’agit d’un export des données retenues, pas d’un import ou d’une sauvegarde de restauration du système. Aucun run ni message ne doit être rejoué. Les tombstones, expirations et préférences doivent être appliqués avant tout import ; la présence d’une mémoire oubliée dans l’archive ne l’autorise pas à redevenir active. L’identité et l’organisation de destination restent à vérifier séparément.

La base de production n’a pas été interrogée. La volumétrie réelle, les délais et les limites de réponse des déploiements Studio/proxy restent à qualifier avant retrait de l’ancien service. Aucun mécanisme d’export asynchrone de très grosses archives n’est encore fourni ; un échec de transport doit rester un échec, jamais un export réputé complet.

## Validation

Tests sur les migrations réelles dans PGlite/pgvector : deux identités, mémoire désactivée, deux sessions, 30 messages, dix souvenirs, six objectifs, résumés, tombstone, run et audit. Comparaison des neuf tables avant/après, contrôle de la transaction read-only, absence d’accès à l’autre identité, refus sans authentification, identité inconnue, audit orphelin conservé et ciphertext corrompu. Pas d’export de données réelles effectué.
