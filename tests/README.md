# Tests

- `tests/unit/limova/` couvre le client, les bridges, la conversation, la voix et le pilote navigateur Deep Agent.
- `tests/unit/background/` couvre le routeur MV3 et la reprise Studio.
- `tests/unit/content/` couvre la capture formateur sans valeurs privées.
- `tests/e2e/` charge les builds production et staging dans Chromium et simule uniquement les frontières API, Studio et live nécessaires.

```bash
npm test
npm run test:e2e
npm run test:all
```

Les fixtures surveillent les appels vers l’ancien proxy et les providers directs afin de détecter toute régression. Aucun test proxy séparé n’existe depuis le retrait du backend historique.
