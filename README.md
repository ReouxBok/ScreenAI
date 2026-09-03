<p align="center">
  <img src="assets/icons/icon.png" width="128" alt="Limova AI Logo">
  <h1 align="center">Limova AI — Charly</h1>
</p>

<p align="center">
  Assistant IA d'onboarding pour la plateforme Limova.
  <br />
  Guidance visuelle pas-à-pas, analyse DOM sécurisée et conversation vocale en temps réel.
  <br />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-blue.svg">
</p>

---

Charly est une extension Chrome (Manifest V3) qui guide les nouveaux utilisateurs à travers la plateforme [Limova](https://new.limova.ai). Elle analyse une carte DOM expurgée, peut utiliser une capture masquée et strictement éphémère pour récupérer après un blocage, propose des instructions contextuelles et peut guider l'utilisateur à la voix.

## Fonctionnalités

- **Guidance contextuelle** — détection de la page courante et instructions adaptées en temps réel.
- **Analyse de page** — carte DOM locale et métadonnées d'interface, sans valeur de formulaire ; capture masquée uniquement à la demande ou pour une récupération silencieuse.
- **Orchestration Google ADK** — sessions texte explicites, outils typés et compacting à 32 000 tokens, avec Gemini exclusivement.
- **Highlighting** — overlay visuel sur les éléments de la page pour guider l'utilisateur.
- **Actions contrôlées** — navigation interne sur demande et confirmation obligatoire pour les actions sensibles.
- **Voix temps réel** — conversation Gemini Live explicitement démarrée, avec interruption naturelle.
- **Base de connaissances** — recherche locale TF-IDF dans 106 articles Limova (refresh via `npm run kb:refresh`).
- **Plan d'onboarding** — 6 étapes structurées pour les nouveaux utilisateurs.
- **Multilingue** — FR / EN / ES, détection auto + override persisté.
- **Confidentialité minimale** — aucun cookie ni analytics produit ; accord IA demandé seulement à la première action.

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│ Extension Chrome    │────▶│  Proxy Heroku    │────▶│ Gemini Text / Live │
│ (aucune clé API)    │     │  (clés sécurisées)│    │ API                │
└─────────────────────┘     └──────────────────┘     └────────────────────┘
```

L'extension ne contient **aucune clé API**. Le texte passe par le proxy Express (`proxy/index.js`). Pour réduire la latence vocale, le proxy délivre un jeton Gemini Live à usage unique et la sidebar ouvre ensuite une connexion directe, limitée et éphémère.

Voir [`ARCHITECTURE.md`](./ARCHITECTURE.md) pour le détail des flux de messages entre service worker, content script, sidebar, proxy.

### Composants

| Dossier / Fichier | Rôle |
|-------------------|------|
| `src/background.js` | Service worker MV3 — orchestration, JWT, appels proxy, session, actions |
| `src/content/` | Extraction DOM, détection de modales, highlight et clic contrôlé |
| `src/sidebar/` | Side panel, consentement IA, chat, voix, i18n et liens rapides |
| `src/prompts/` | Prompt système Gemini + plan d'onboarding 6 étapes |
| `src/knowledge-base/` | Articles + moteur de recherche TF-IDF |
| `src/utils/` | Journal technique local et filtré |
| `proxy/` | Serveur Express (Heroku) — proxy Gemini + ingestion events |
| `tests/` | Suite de tests (Vitest + Playwright) |

## Développement

### Prérequis

- Node.js ≥ 20
- Chrome ≥ 120 (pour MV3 + side panel)

### Setup

```bash
npm install
npx playwright install chromium   # pour les tests e2e
```

### Lancer l'extension en local

1. `chrome://extensions/`
2. Activer **Mode développeur**
3. Exécuter `npm run build`, puis **Charger l'extension non empaquetée** → pointer sur le dossier `build/`
4. Aller sur [new.limova.ai](https://new.limova.ai) — l'icône Charly apparaît dans la sidepanel

### Lancer le proxy en local

```bash
cd proxy
npm install
GEMINI_API_KEY=... \
ALLOWED_EXTENSION_ID=<votre-extension-id> \
KNOWLEDGE_API_URL=https://studio.limova.ai \
KNOWLEDGE_SERVICE_TOKEN=<token-service-aleatoire> \
LIMOVA_JWT_ISSUER=https://api.new.limova.ai \
LIMOVA_JWT_AUDIENCE=limova-extension \
LIMOVA_JWKS_URL=https://api.new.limova.ai/.well-known/jwks.json \
node index.js
```

Pour le déploiement Heroku, voir [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Tests

La suite couvre le journal local, le consentement IA à la demande, l’i18n, les liens rapides, les prompts, la base de connaissances, les actions DOM, le proxy Express, le service worker et le chargement de l’extension.

```bash
npm test              # unit + proxy (Vitest), < 1s
npm run test:unit     # unit seulement
npm run test:proxy    # proxy Express (supertest)
npm run test:e2e      # e2e (Playwright + Chromium, ~15s)
npm run test:all      # tout
npm run coverage      # rapport de couverture v8
npm run test:watch    # mode watch
```

La CI recommandée exécute `npm run test:all` à chaque PR.

## Build

```bash
npm run build   # valide les ressources et produit le ZIP versionné + son SHA-256
```

Le validateur bloque notamment le build si `src/sidebar/sidebar.html` n’existe pas dans le paquet. Voir [`docs/RELEASE.md`](./docs/RELEASE.md) pour le contrat de déploiement, [`docs/PRODUCTION_HANDOFF.md`](./docs/PRODUCTION_HANDOFF.md) pour l’ordre de bascule vérifié, et [`docs/PRIVACY.md`](./docs/PRIVACY.md) pour les flux de données.

Le Studio Next.js est versionné dans `studio/`, avec ses migrations, scripts de récupération et tests. Le proxy Google ADK est versionné dans `proxy/`. Le runbook de correction et de rollback se trouve dans [`docs/STUDIO_RECOVERY_RUNBOOK.md`](./docs/STUDIO_RECOVERY_RUNBOOK.md).

## Knowledge base

La base embarquée historique a été retirée. L’extension conserve seulement un fallback vide dans `src/knowledge-base/kb-data.js`; les connaissances actives viennent des contenus relus, validés et publiés dans le Studio. Un brouillon n’est jamais indexé automatiquement.

Le scraper `npm run kb:refresh` reste disponible comme outil d’import contrôlé depuis le centre d’aide, mais ses résultats doivent être relus puis importés dans le workflow éditorial du Studio avant publication. Voir [`docs/KNOWLEDGE_BASE.md`](./docs/KNOWLEDGE_BASE.md).

## License

MIT — voir [LICENSE](./LICENSE).
