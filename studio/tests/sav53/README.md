# Recette SAV-53

Neuf scénarios synthétiques : conversation repliée/développée, libellés de retour
sur ticket selon son état, synthèse de la file et transfert partenariat supervisé.
La recette ne clique aucun bouton d’action Gmail/HubSpot et ne contacte aucun
fournisseur. Seule la validation interne de quatre dossiers synthétiques est écrite.

Dans un checkout isolé sans fichiers `.env*`, avec Node 24 et Chromium déjà installé :

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" CI=1 NEXT_TELEMETRY_DISABLED=1 \
  node_modules/.bin/playwright test --config playwright.sav53.config.ts
```

Le port est `127.0.0.1:3119`, la base PGlite locale `.e2e-db` est recréée,
les variables opérationnelles héritées sont refusées. `SAV_WRITES_DISABLED=true`,
clés fournisseurs vides, clé de chiffrement publique de fixture. Les requêtes
externes du navigateur sont bloquées. Le scénario partenariat vérifie que la
confirmation d’envoi est désactivée ; il n’envoie aucun message réel.

Les captures ne contiennent que les données synthétiques et restent dans
`test-results`. Le résultat ne qualifie pas les fournisseurs de production.
