# Tests

## Résumé

```
tests/
├── unit/
│   ├── utils/              Logger local et filtrage des secrets
│   ├── sidebar/            i18n + annonces + protocole Gemini Live (jsdom)
│   ├── content/            content.js DOM helpers (jsdom)
│   ├── prompts/            system-prompt + onboarding-plan + snapshots
│   ├── knowledge-base/     kb-search (TF-IDF)
│   └── background/         routeur, confidentialité et actions contrôlées
├── proxy/                  endpoints Express + authentification JWT/JWKS réelle
├── e2e/                    Playwright + Chromium + extension chargée
├── helpers/                Mocks chrome + loader de script
└── fixtures/
```

**Total : 199 tests** (163 unitaires/intégration, proxy inclus, + 36 E2E Chrome).

Les E2E chargent le dossier `build/` comme une vraie extension Manifest V3 dans Chromium. Ils utilisent une vraie page HTTPS Limova de test et les vrais content scripts/service worker. Seules les frontières externes (API d’authentification, proxy et WebSocket Gemini) sont simulées de façon déterministe.

## Commandes

| Cible | Commande | Durée |
|-------|----------|-------|
| Tout | `npm run test:all` | ~30s |
| Unit + proxy | `npm test` | < 1s |
| Unit seulement | `npm run test:unit` | < 500ms |
| Proxy seulement | `npm run test:proxy` | ~200ms |
| E2E seulement | `npm run test:e2e` | ~30s |
| Watch | `npm run test:watch` | interactif |
| Couverture | `npm run coverage` | ~1s |

## Helpers

### `helpers/chrome-mock.js`

Mock léger couvrant `chrome.runtime`, `chrome.i18n`, `chrome.storage.local`.
Usage : Logger et i18n.

### `helpers/chrome-mock-full.js`

Mock complet : ajoute `tabs`, `scripting`, `webNavigation`, `sidePanel`, `action`.
Expose `_listeners` pour invoquer directement les handlers enregistrés par background.js.

### `helpers/load-script.js`

Exécute un script classique (non-module) dans le scope global de jsdom en exposant ses top-level `const/let/function` comme un objet exporté.

Utilisé pour tester `sidebar/i18n.js`, `sidebar/announcements.js` et `content.js` qui sont chargés via `<script>` et n'ont pas d'`export`.

## Modifier un snapshot

Un snapshot capture la forme du prompt système pour un contexte canonique. Quand tu le modifies intentionnellement :

```bash
npx vitest run tests/unit/prompts --update
```

## Exécuter un seul fichier

```bash
npx vitest run tests/unit/utils/logger.test.js
npx playwright test tests/e2e/sidebar.spec.js
```

## Débogguer un test Playwright

```bash
npx playwright test tests/e2e --headed --debug
```

Les traces échouées sont dans `test-results/`, le rapport HTML dans `playwright-report/`.
