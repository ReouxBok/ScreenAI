# Recette SAV-56

Deux scénarios synthétiques : process revalidé à contenu identique puis brouillon
réenregistré/accepté ; corrections et étapes persistées après rechargement.
La sauvegarde et l’acceptation restent séparées ; envoi interdit dans la fixture.

Depuis studio/, sans fichiers .env, Node 24 et Chromium installé :

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" CI=1 NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/playwright test --config playwright.sav56.config.ts
```

Port local 3196, DB PGlite dédiée .e2e-sav56-db ; préparation recréant uniquement
cette DB de recette. Variables opérationnelles héritées refusées, credentials
fournisseurs vides, écritures externes et IA désactivées, réseau navigateur limité
à son origine locale. Aucun appel fournisseur réel. Les attentes des actions
incluent la fin du POST pour les redirections répétées vers la même URL.
