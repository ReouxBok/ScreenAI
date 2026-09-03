# Studio de connaissances Charly

Application interne Next.js qui administre la base RAG de Charly et le centre d’aide. Elle ne modifie pas le prompt système et n’enregistre jamais les questions ou conversations des utilisateurs.

## Architecture

- Comptes Clerk nominatifs avec connexion email/mot de passe, liste blanche et rôles `owner`, `admin` et `member`.
- Neon Postgres avec `pgvector` pour les contenus, versions, validations, chunks, tests et audits.
- Vercel Blob privé pour les vidéos plein écran des démonstrations. La vidéo est obligatoire pour tout nouveau flow, reste inaccessible publiquement et n'est servie qu'à une session Studio authentifiée.
- Gemini `gemini-embedding-001`, embeddings de 768 dimensions.
- Recherche hybride : vecteurs, texte français, intention déclarée et page Limova.
- Client PostgreSQL transactionnel sur l’URL poolée Neon. La publication prépare embeddings et tests, puis change la version active dans une transaction.
- PGlite + pgvector uniquement pour les E2E locaux ; son activation est bloquée en production.

## Configuration locale

```bash
cp .env.example .env.local
npm install
npm run db:migrate
npm run kb:import
npm run dev
```

Pour un développement local sans connexion Clerk, définir `DEV_AUTH_BYPASS=true`. Cette option est ignorée en production. Utiliser une base Neon de développement pour le travail quotidien ; les E2E créent automatiquement leur base isolée.

## Accès interne

1. Installer Clerk depuis le Marketplace Vercel et connecter la ressource au projet Studio.
2. Vérifier la présence de `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` et `CLERK_SECRET_KEY` dans Development, Preview et Production.
3. Provisionner silencieusement les adresses présentes dans `src/lib/access.ts` avec `npm run staff:provision` ; toute autre adresse est refusée par l’application.
4. Aucun email d’invitation n’est envoyé. Chaque membre utilise « Mot de passe oublié » lors de sa première connexion pour choisir son mot de passe personnel.

Chaque page privée et chaque Server Action vérifie la session côté serveur. Les audits et versions sont attribués à l’adresse email du compte connecté.

## Migration des 106 Markdown

```bash
npm run kb:import
npm run kb:export -- --out /chemin/explicite
```

L’import est idempotent, conserve le slug et le frontmatter dans `sourceMetadata`, classe les articles, les place `à valider` et crée 40 questions de référence. L’export reconstruit les fichiers Markdown et leurs métadonnées.

## Workflow

- `member` : crée, modifie et supprime un contenu tant qu’aucune version n’est en production, puis le soumet.
- `admin` : valide, publie, corrige les contenus en production et crée les parcours de formation.
- `owner` : possède tous les droits administrateur et reste le niveau d’accès le plus élevé.

Le toggle `Agent IA` de la bibliothèque décide si un contenu publié peut être recherché par Charly. Les contenus existants sont conservés comme actifs lors de la migration ; les nouveaux contenus nécessitent une activation explicite.

Un échec avant ou pendant la transaction laisse `publishedVersionId` inchangé. Charly et `/aide` lisent ce même pointeur publié.

## API privée

`POST /api/internal/knowledge/search` exige `Authorization: Bearer $STUDIO_SERVICE_TOKEN`. Le token doit contenir au moins 32 caractères. Les logs contiennent uniquement la révision, les identifiants de contenus, la latence et les codes d’erreur techniques.

Le proxy Limova doit recevoir :

```dotenv
KNOWLEDGE_API_URL=https://studio.limova.ai
KNOWLEDGE_SERVICE_TOKEN=<même valeur que STUDIO_SERVICE_TOKEN>
```

## Mémoire privée de Charly

La mémoire personnelle utilise le schéma PostgreSQL séparé `charly_memory` et le rôle limité `charly_memory_service`. Elle ne partage ni tables ni identifiants bruts avec la base Limova. Les profils, messages, résumés, objectifs et souvenirs sont chiffrés en AES-256-GCM ; l’identité persistante est une empreinte HMAC de l’adresse normalisée.

Variables de production nécessaires :

```dotenv
MEMORY_DATABASE_URL=postgresql://charly_memory_service:...@.../...
MEMORY_SERVICE_TOKEN=<jeton interne partagé avec le proxy>
MEMORY_IDENTITY_SECRET_V1=<secret HMAC partagé avec le proxy>
MEMORY_ENCRYPTION_KEY_V1=<clé de chiffrement dédiée>
MEMORY_AI_EXTRACTION=true
MEMORY_EXTRACTION_MODEL=gemini-3.6-flash
CRON_SECRET=<secret Vercel dédié>
```

`npm run memory:migrate` applique exclusivement les migrations du schéma mémoire. La tâche Vercel `/api/cron/memory-retention` supprime chaque jour les messages et résumés de plus de 12 mois, les objectifs et souvenirs inutilisés, ainsi que les runs expirés. Elle exige le jeton `CRON_SECRET` et n’est pas accessible publiquement.

Le Studio ne propose aucune page de consultation des conversations et son rôle applicatif courant n’est jamais transmis à l’extension. Le proxy doit utiliser uniquement les routes internes avec `MEMORY_SERVICE_TOKEN`.

## Déploiement Vercel

1. Créer un projet Vercel avec `studio/` comme Root Directory.
2. Ajouter Neon depuis le Marketplace Vercel et utiliser son URL **poolée** dans `DATABASE_URL`.
3. Ajouter toutes les variables de `.env.example` pour Production et Preview ; les clés Clerk sont injectées par l’intégration Marketplace.
4. Déployer, exécuter `npm run db:migrate`, puis `npm run kb:import` avec la base de production.
5. Associer `studio.limova.ai`; publier ensuite les deux variables du proxy.
6. Tester l’API privée et le centre d’aide avant de publier l’unique version Chrome qui active la base distante.

## Vérification

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Les E2E couvrent création, soumission, refus, publication, recherche hybride, centre d’aide, nouvelle version, rollback et archivage sur un vrai moteur PostgreSQL + pgvector embarqué. `npm audit --omit=dev` doit rester à zéro ; les éventuels avis de `drizzle-kit` concernent uniquement l’outil local de génération des migrations.

## SAV IA

La section `/studio/sav`, réservée aux rôles `admin` et `owner`, centralise tous les emails de la boîte SAV. Chaque message possède une décision justifiée, un journal d’actions et, le cas échéant, un ticket HubSpot. Les réponses de Charly annoncent systématiquement l’IA et proposent un transfert humain sous trois jours.

Le mode `shadow` est la valeur par défaut : Gmail et HubSpot sont analysés sans aucune mutation externe. Le passage à `assist`, `semi` puis `on` doit suivre la recette décrite dans [`docs/SAV_AI.md`](docs/SAV_AI.md).
