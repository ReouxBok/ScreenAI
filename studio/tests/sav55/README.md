# Recette SAV-55 isolée

La configuration refuse les fichiers `.env` et variables opérationnelles héritées.
Elle prépare uniquement une PGlite locale `.e2e-db-sav55`, sur `127.0.0.1:3125`.
La fixture SAV-53 est conservée et huit dossiers synthétiques SAV55 ajoutés, deux
par état (recherche `SAV55`). Aucune connaissance réelle, credential ou donnée client.

Dans le checkout combiné, après disponibilité du créneau mémoire :

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" CI=1 NEXT_TELEMETRY_DISABLED=1 \
  node_modules/.bin/playwright test --config playwright.sav55.config.ts
```

Fournisseurs sans clé, écritures externes désactivées, mode test actif ; navigateur
limité à l’origine locale. Les seules mutations éventuelles concernent des données
fictives dans cette base. Ne pas ajouter `reuseExistingServer` ni utiliser un serveur
ayant un fichier d’environnement. Recette séquentielle : un seul serveur/browser.

Périmètre de livraison confirmé par Ugo : ordinateur. Le mobile est exclu de cette recette.
Les routes connaissances sont précompilées par GET local avant le chronomètre du
scénario navigateur ; cela ne modifie aucune donnée. Les assertions métier restent inchangées.
