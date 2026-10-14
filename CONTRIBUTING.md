# Contribuer

## Installation

```bash
npm install
npx playwright install chromium
```

## Vérification

```bash
npm run test:unit
npm run build
npm run build:staging
npm run test:e2e
```

Les tests unitaires couvrent les contrats API, le routeur MV3, le pilote navigateur, la voix native et Studio. Les tests Playwright chargent les paquets production et staging comme de vraies extensions MV3.

## Règles d’architecture

- utiliser exclusivement l’agent principal `charly`, `type=general` et `engine=deep_agents` ;
- ne pas ajouter de prompt d’agent, de mémoire ou d’authentification parallèle dans l’extension ;
- passer par les bridges first-party pour les appels authentifiés ;
- conserver les contrôles d’origine, de document, de consentement et de masquage des données privées ;
- maintenir le mode formateur en observation seule ;
- ne jamais ajouter une clé ou un token au code, aux fixtures ou aux logs.

Les changements de la migration sont publiés sous forme de PR empilées. Chaque PR indique sa base, ses validations et les qualifications distantes encore ouvertes. Une PR ouverte ne vaut ni merge, ni déploiement, ni activation du feature flag.

Le build final se trouve dans `dist/` avec son SHA-256. La publication Chrome Web Store se fait depuis la console développeur après qualification staging.
