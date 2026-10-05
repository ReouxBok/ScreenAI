# Reprendre le SAV sur un autre ordinateur

## Démarrage

- Pour cette reprise, Ugo a choisi une **archive privée, aucun push**. Décompresser le dossier `ScreenAI` fourni puis l’ouvrir dans Codex. L’archive contient le code complet, le lockfile et un checkpoint Git local ; elle ne transfère pas la session Codex ni la base de l’ancien Mac. Ce lancement ne modifie pas `main`, ne pousse rien et ne déploie rien.
- Node **24 conseillé**. Node 22.13+ est aussi accepté ; les dépendances sont réinstallées sur la nouvelle machine, pas copiées depuis l’ancien `node_modules`.
- Se placer dans `studio/`, dans un checkout local dédié **sans** `.env`, `.env.local`, `.env.development` ni `.env.development.local`. Le lanceur refuse ces fichiers par leur nom, sans lire leurs valeurs ni les supprimer. Ne pas importer les variables Vercel/production.

```sh
cd ScreenAI/studio
npm ci
npm run sav:preview
```

Ouvrir [l’inbox SAV locale](http://127.0.0.1:3010/studio/sav). L’application utilise le compte fictif local `ugo@limova.ai` ; aucune connexion Clerk n’est nécessaire. `Ctrl+C` arrête le serveur et conserve la base locale.

Les mêmes commandes fonctionnent dans un terminal macOS, Linux ou Windows : le lanceur appelle directement Node et les exécutables déjà installés, sans assignations d’environnement propres à un shell. La compatibilité macOS est la cible de cette reprise ; un test de démarrage réel reste nécessaire sur chaque autre système.

## Ce que le lanceur prépare

1. Vérification de Node, des dépendances installées, des fichiers d’environnement et du port.
2. Création de `studio/.sav-preview/sav-preview-db`, base PostgreSQL embarquée PGlite séparée de toute base distante.
3. Migrations existantes, puis connaissances fictives, puis inbox fictive, séquentiellement. Chaque script termine avant le suivant.
4. Serveur **de développement** limité à `127.0.0.1`, port `3010` par défaut. Ne pas utiliser `npm start` pour cette démo : le mode production bloque volontairement PGlite et le bypass d’authentification.

Le répertoire local de prévisualisation n’est pas une source à transférer ou à committer. Les emails, identifiants CRM, parcours et propositions sont des **fixtures fictives**, pas des preuves d’une intégration fonctionnelle en production ni des réponses IA générées en direct. Le seed des connaissances inclut une résolution approuvée simulée pour illustrer le candidat « tutoriel à enregistrer » ; ce n’est pas une validation humaine réelle.

Sur le nouvel ordinateur, une nouvelle base est créée à partir des fixtures. Les corrections, revues et connaissances ajoutées dans la base locale de l’ancien ordinateur **ne sont pas transférées automatiquement**. Le code, lui, peut être modifié normalement. Le lanceur ne supprime ni ne remet à zéro une base existante ; la fixture d’inbox complète seulement ses cas connus et leurs en-têtes de démonstration.

## Garde-fous

- L’environnement enfant est reconstruit à partir d’une liste limitée de variables système. Aucun `DATABASE_URL` distant, credential Gmail/HubSpot/Gemini/Blob/Clerk/mémoire, secret cron, `NODE_OPTIONS` ni override dotenv hérité n’est transmis.
- Valeurs imposées : SAV **V0**, `shadow`, écritures externes désactivées, ADK désactivé, analyse IA désactivée, backfill/retention désactivés.
- La clé de chiffrement est une valeur **publique de fixtures**, fixe pour conserver la lisibilité de la base locale. Ne jamais l’utiliser pour des données réelles ou en production.
- Les boutons de revue modifient uniquement cette base locale. Un clic de création HubSpot ne crée pas réellement de ticket dans cette configuration ; les brouillons ne sont pas envoyés.
- Aucun install, provisionnement de compte, push Git, publication Vercel ou appel CRM/email/IA n’est lancé par le script.
- La télémétrie Next est désactivée. Ce mode n’est toutefois **pas un pare-feu réseau** : `npm ci` télécharge les dépendances et `next/font/google` peut télécharger les polices à la première compilation. Ne pas ajouter de fichiers `.env*` de production pendant qu’il tourne.

## Options et incidents

```sh
# Initialiser les migrations et fixtures, sans lancer de serveur
npm run sav:preview -- --init-only

# Choisir un autre port si 3010 est déjà occupé
npm run sav:preview -- --port 3011
```

- **Port occupé** : arrêter l’autre instance, ou choisir un autre port si elle ne partage pas cette base. Il n’y a aucun changement automatique de port.
- **Verrou `preview.lock`** : le lanceur empêche deux processus de migrer/servir la même PGlite, même sur deux ports différents. Le verrou créé par le lanceur est retiré à l’arrêt normal ; les fichiers de base restent intacts. Après un arrêt brutal, vérifier qu’aucun processus n’utilise cette base, puis retirer **uniquement** `studio/.sav-preview/preview.lock` avant de relancer. Ne pas supprimer le dossier de base.
- **Dépendances absentes** : exécuter `npm ci` dans `studio/`, sans `--omit=dev` ; PGlite et le loader TypeScript sont des dépendances de développement.
- **Migration/seed en erreur** : le lancement s’arrête et conserve la base. Ne pas le relancer contre une base réelle. Une ancienne fixture de connaissances peut produire un conflit de version/source après un changement du schéma de conversion ; demander une vérification plutôt que contourner les garde-fous ou effacer les données.
- **Liens de conversation** : ils reposent sur les en-têtes RFC disponibles du même email client et de la même boîte. L’absence de lien ne prouve pas l’absence d’une conversation réelle.

La recette sur de vrais emails/HubSpot, l’usage de credentials de développement, puis le déploiement nécessitent chacun une validation distincte d’Ugo. Ce lanceur est uniquement le chemin local fictif.

## Ajouts locaux du 5 octobre — SAV-16/17/18

- Dossier email : conserver des versions du brouillon, valider en interne après le process, abandonner ; une nouvelle revue, un nouvel email ou une autre connaissance rendent l’ancien contexte obsolète.
- [Dashboard d’évaluation](http://127.0.0.1:3010/studio/sav/evaluation) : les données réelles sont affichées par défaut. La démo n’en contient pas ; cliquer « Voir les simulations et tests séparément » pour examiner les fixtures.
- Depuis une revue approuvée fictive : préparer un scénario fictif anonymisé puis lancer le replay des règles. Ce replay ne sollicite aucun modèle IA et ne prouve pas la qualité des réponses réelles.
- Les décisions enregistrées ne changent jamais l’autonomie, ne publient aucune connaissance et n’autorisent aucun déploiement. Les seuils existants d’autonomie ne sont pas un prérequis au premier pilote shadow V0, qui nécessite une validation distincte.
- La recette agent peut avoir ajouté des revues/brouillons/scénarios fictifs dans cette base locale. Ils ne constituent pas une validation produit Ugo ni un consentement de production.
