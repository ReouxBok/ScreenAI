<p align="center">
  <img src="icon.png" width="128" alt="Limova AI Logo">
  <h1 align="center">Limova AI — Charly</h1>
</p>

<p align="center">
  Assistant IA d'onboarding pour la plateforme Limova.
  <br />
  Guidance visuelle pas-à-pas, capture automatique d'écran, et conversation vocale.
  <br />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-blue.svg">
</p>

---

Charly est une extension Chrome qui guide les nouveaux utilisateurs à travers la plateforme [Limova](https://new.limova.ai). Elle analyse automatiquement chaque page visitée, propose des instructions contextuelles, et peut même cliquer à la place de l'utilisateur.

## Fonctionnalités

* **Guidance contextuelle** — Charly détecte la page en cours et fournit des instructions adaptées en temps réel.
* **Capture automatique** — Un screenshot est pris à chaque changement d'URL pour une analyse visuelle via Gemini.
* **Conversation vocale** — Mode vocal avec reconnaissance vocale et synthèse TTS (ElevenLabs).
* **Auto-click** — Charly peut cliquer sur les éléments de la page pour guider l'utilisateur pas-à-pas.
* **Base de connaissances** — Recherche locale TF-IDF dans la documentation Limova pour enrichir les réponses.
* **Multilingue** — S'adapte automatiquement à la langue du navigateur (FR/EN).

## Architecture

```
Extension Chrome  →  Proxy Heroku  →  Gemini API / ElevenLabs API
(aucune clé API)     (clés sécurisées)
```

L'extension ne contient **aucune clé API**. Tous les appels passent par un serveur proxy hébergé sur Heroku qui détient les clés dans ses variables d'environnement.

### Composants

| Fichier | Rôle |
|---------|------|
| `background.js` | Service worker central — orchestration, appels proxy, gestion de session |
| `content.js` | Interaction DOM — détection de modales, highlight, auto-click |
| `console-interceptor.js` | Interception des logs console pour le diagnostic |
| `sidebar/` | Interface chat (sidebar Chrome) |
| `prompts/system-prompt.js` | Prompt système dynamique pour Gemini |
| `knowledge-base/` | Base de connaissances locale (articles + recherche TF-IDF) |
| `proxy/` | Serveur Express proxy pour Heroku |

## Installation

### Extension (développement)

1. Cloner ce dépôt
2. Ouvrir `chrome://extensions/`
3. Activer le **Mode développeur**
4. Cliquer **Charger l'extension non empaquetée**
5. Sélectionner le dossier racine du projet

### Proxy Heroku

Le proxy est dans le dossier `proxy/`. Pour le déployer :

```bash
cd proxy
heroku create nom-de-votre-app
heroku config:set GEMINI_API_KEY=votre-clé ELEVENLABS_API_KEY=votre-clé --app nom-de-votre-app
git init && git add . && git commit -m "Deploy proxy"
heroku git:remote --app nom-de-votre-app
git push heroku main
```

Ensuite, mettre à jour `PROXY_URL` dans `background.js` avec l'URL de votre app Heroku.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
