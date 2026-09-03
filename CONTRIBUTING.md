# Contributing

## Setup

```bash
git clone <repo>
cd LimovaAI
npm install
npx playwright install chromium
```

Dans `proxy/` :

```bash
cd proxy && npm install
```

## Workflow de contribution

1. **Branche dédiée** : `feat/xxx`, `fix/xxx`, `docs/xxx`.
2. **Tests verts** avant de push :
   ```bash
   npm run test:all
   ```
3. **Charger l'extension en local** (`chrome://extensions/` → *Load unpacked*) et tester manuellement la feature.
4. **PR** avec description claire + capture si changement d'UI.

## Écrire des tests

### Unit tests (Vitest)

Ajoute un fichier dans `tests/unit/<domaine>/<nom>.test.js`. Les helpers disponibles :

- `installChromeMock()` / `uninstallChromeMock()` — mock léger `chrome.runtime`, `chrome.i18n`, `chrome.storage.local`
- `installFullChromeMock()` — mock complet (pour background.js)
- `loadSidebarScript(path)` — charge un script sidebar/content dans la scope jsdom du test

Exemple :

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { installChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('myFeature', () => {
  beforeEach(() => {
    installChromeMock();
    loadSidebarScript('src/sidebar/my-feature.js');
  });
  // ...
});
```

### Tests proxy (supertest)

Dans `tests/proxy/`. Set les env vars dans `beforeAll` **avant** le `require('./index.js')` :

```js
process.env.GEMINI_API_KEY = 'test';
process.env.ELEVENLABS_API_KEY = 'test';
process.env.ALLOWED_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
```

Le proxy refuse tout Origin absent → utilise le helper `req()` qui injecte l'Origin autorisée.

### Tests e2e (Playwright)

Dans `tests/e2e/*.spec.js`. Les fixtures `context`, `serviceWorker`, `extensionId` sont définies dans `fixtures.js`.

```js
import { test, expect } from './fixtures.js';

test('ma feature', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidebar/sidebar.html`);
  // ...
});
```

**Tip** : les tests e2e ne chargent pas `new.limova.ai` — on navigue sur les pages d'extension (`chrome-extension://...`). Pour tester du content-script, utilise Vitest + jsdom.

## Ajouter une traduction

Dans `sidebar/i18n.js`, ajouter la nouvelle langue dans :
- `SUPPORTED_LANGS`
- `LANG_LABELS`
- l'objet `translations`

Un test vérifie que **toutes les locales partagent les mêmes clés** (`tests/unit/sidebar/i18n.test.js` → *translation coverage*). Si tu oublies une clé, le test te le dira.

## Modifier le prompt système

`src/prompts/system-prompt.js` — le template est couvert par un snapshot dans `tests/unit/prompts/system-prompt.test.js`. Une modification intentionnelle se valide avec :

```bash
npx vitest run --update
```

## Déployer le proxy (Heroku)

```bash
cd proxy
heroku create <app-name>
heroku config:set \
  GEMINI_API_KEY=sk-... \
  ALLOWED_EXTENSION_ID=<id> \
  --app <app-name>
git subtree push --prefix proxy heroku main
```

Penser à **mettre à jour `host_permissions`** dans `manifest.json` + la constante `PROXY_URL` dans `background.js` et `utils/analytics.js` si l'URL change.

## Release de l'extension

```bash
npm run build   # produit build.zip
```

Upload dans le [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole/).

## Conventions

- **Style** : pas de sémicolons finaux manquants ; préférer `async/await` aux chaînes `.then()`.
- **Imports** : ES modules dans `background.js`, `prompts/`, `utils/`, `knowledge-base/`. CommonJS dans `proxy/` (Heroku → Node standard).
- **Messages `chrome.runtime`** : toujours un champ `type` ; toujours un `try { ... } catch {}` ou `.catch(() => {})` côté appelant.
- **Pas de clé API dans le code** — revue PR bloquée si on détecte un secret.

## Matrice de compatibilité

| Composant | Runtime |
|-----------|---------|
| Extension | Chrome ≥ 120, Edge ≥ 120 (MV3 + sidePanel) |
| Proxy | Node ≥ 18 (utilise `Readable.fromWeb`) |
| Tests | Node ≥ 20 |

## Signaler un bug

Inclure :
- Version de l'extension (`chrome://extensions`)
- Version de Chrome
- Logs téléchargés via le bouton *Download logs* de la sidebar
- Étapes pour reproduire
