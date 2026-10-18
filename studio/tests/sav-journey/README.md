# SAV-49/65 — parcours local avec fournisseurs fictifs

Depuis studio, sans fichier `.env*`, utiliser le Node privé existant et :

`env -i PATH="<répertoire du Node privé>:/usr/bin:/bin" HOME="$HOME" TMPDIR=/tmp CI=1 NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/playwright test --config playwright.sav-journey.config.ts`

La configuration rejette les variables opérationnelles héritées, crée seulement
`.e2e-journey-db` (PGlite) et une simulation CRM privée en JSON ignorée par Git.
Le preload du serveur renvoie exclusivement les réponses synthétiques énumérées ;
chaque autre fetch est refusé et journalisé. Le navigateur bloque tout hôte externe.
Les clés/tokens sont fictifs. Aucun fournisseur ni modèle réel n’est utilisé.
Le serveur écoute seulement sur 127.0.0.1:3118 et s’arrête après les tests.

La recette couvre le clic humain distinct, aperçu sans mutation, création,
rattachement Nouveau, réactivation, retour fermé récent et successeur >15jours,
403 corrigé sans reload complet et résultat incertain non rejoué. Six parcours
continuent vers correction/enregistrement/reload/acceptation/envoi Gmail simulé,
puis retour à la même vue filtrée. Les compteurs vérifient les effets simulés.
Les mesures sont des clics scriptés et durées murales synthétiques, jamais du temps
humain économisé ou un score de qualité réelle du modèle. Pour les catégories
sensibles, multi-demandes, nouveau mail et refus, compléter par les suites de
combinaison et la recette sémantique existantes ; leurs couvertures sont séparées.
