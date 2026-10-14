# Limova AI — extension Chrome

Cette extension ouvre Charly dans le panneau latéral de Chrome. Elle utilise le compte Limova déjà connecté et le **Deep Agent principal `charly`** pour le texte, la voix, la mémoire et les intégrations. Elle ne possède plus de backend conversationnel, de compte OTP, de prompt Gemini ou de mémoire parallèle.

## Flux principal

```text
Extension Chrome
  └─ bridge first-party dans new.limova.ai
       └─ API Limova authentifiée
            └─ conversation type=general, engine=deep_agents, agent=charly
                 ├─ mémoire Limova en lecture/écriture
                 ├─ intégrations du workspace
                 ├─ outils navigateur consentis
                 └─ contenus publiés du Studio via MCP
```

L’utilisateur se connecte dans l’application Limova. Le bridge first-party utilise la session de l’application et son refresh token sans lire ni copier les cookies dans l’extension. Les conversations créées depuis l’extension apparaissent dans le même historique Limova.

## Composants

| Chemin | Rôle |
|---|---|
| `src/limova/` | Client API, session first-party, conversation Deep Agent, voix native et pilote navigateur |
| `src/sidebar/` | Panneau, workspace, conversation, consentement, chat, voix, training et évaluation |
| `src/background.js` | Routeur natif, orchestration Studio, diagnostic local |
| `src/content/content.js` | Capture des gestes formateur et preuve d’intervention pendant une évaluation |
| `src/content/training-network.js` | Métadonnées réseau généralisées pour les démonstrations Studio |
| `studio/` | Contenus, démonstrations, évaluations et serveur MCP du Studio |

Le pilote navigateur injecte `browser-document.js` à la demande. Il lit une représentation filtrée de la page, masque les zones privées des captures et valide chaque document/action avec une version éphémère.

## Développement

Prérequis : Node.js 20+ et Chrome 114+.

```bash
npm install
npx playwright install chromium
npm test
npm run build
```

Charge ensuite `build/` depuis `chrome://extensions` en mode développeur. La variante staging est produite avec `npm run build:staging` et utilise une identité et des origines distinctes.

```bash
npm run test:unit
npm run test:e2e
npm run test:all
npm run coverage
```

Le build génère un ZIP versionné et son SHA-256 dans `dist/`. Il valide les permissions, la CSP, les bridges first-party et les fichiers inclus.

## Déploiement

La bascule est commandée par le feature flag backend `is_charly_extension_enabled`. Le workspace doit être activé pour que l’extension puisse créer ou reprendre une conversation. Aucun fallback vers l’ancien proxy n’existe dans le paquet.

La publication Chrome Web Store reste une opération séparée du déploiement API/Studio. Voir [ARCHITECTURE.md](./ARCHITECTURE.md), [confidentialité](./docs/PRIVACY.md), [diagnostic](./docs/DIAGNOSTICS.md) et [qualification staging](./docs/staging-qualification.md).

## Licence

MIT — voir [LICENSE](./LICENSE).
