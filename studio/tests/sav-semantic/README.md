# Recette navigateur SAV sémantique

Scénario synthétique local : compréhension initiale, motifs de revue, refus du
brouillon, validation indépendante du dossier et persistance après rechargement.
Il est volontairement hors de `tests/e2e` : utiliser sa configuration dédiée.

Depuis `studio/`, dans un checkout sans fichiers `.env*` :

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" CI=1 NEXT_TELEMETRY_DISABLED=1 \
  node_modules/.bin/playwright test --config playwright.sav-semantic.config.ts
```

Le navigateur Playwright doit déjà être installé. Pour utiliser un exécutable
Chromium local existant, passer `STUDIO_E2E_CHROMIUM_PATH=/chemin/absolu/chromium`
dans la commande `env` ; aucun téléchargement n'est effectué par la recette.
`HOME` sert à trouver le cache navigateur et peut être remplacé par un répertoire
temporaire si le chemin du navigateur est fourni explicitement.

La configuration refuse les variables opérationnelles héritées, impose la clé
publique de fixture et une base PGlite locale `.e2e-db`, écoute uniquement sur
`127.0.0.1:3117` et désactive les écritures Gmail/HubSpot et les appels IA. La base
de recette est recréée au démarrage ; aucune base distante n'est utilisée.

Le test bloque les requêtes externes du navigateur et n'actionne que les deux
boutons de revue interne. Il ne mesure ni la qualité réelle d'un fournisseur IA,
ni le comportement d'un environnement de production. La capture est conservée
dans `test-results` ; les données et captures ne sont pas destinées à Git.
