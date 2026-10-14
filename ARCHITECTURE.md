# Architecture — Charly dans l’extension

## Identité et conversation

L’extension ne crée pas d’identité propre. `app-session-bridge` s’exécute dans un onglet first-party Limova et appelle les routes API avec le refresh token de l’application. Le service worker ne lit ni cookie ni token.

Après le bootstrap, l’utilisateur choisit un workspace activé par `is_charly_extension_enabled`. Une nouvelle conversation utilise le contrat existant :

```json
{
  "botAgentId": "<id de l'agent charly>",
  "type": "general",
  "engine": "deep_agents",
  "disableFirstMessage": true
}
```

Le backend résout l’agent principal par le slug `charly`. Il conserve l’historique canonique, la mémoire en lecture/écriture, les intégrations et les contenus Studio. L’extension n’envoie aucun prompt système d’onboarding et ne crée aucun agent secondaire.

## Texte et voix

`src/limova/background.js` orchestre la conversation et diffuse les événements au panneau. Le texte utilise le stream Deep Agent. La voix ouvre une session live first-party rattachée au même utilisateur, workspace et `conversationId`; les transcriptions visibles proviennent du stream natif et ne sont pas réinjectées comme un second message.

## Navigateur

Le Deep Agent peut demander une lecture ou une action via le contrat browser tool. Le pilote :

- lie chaque commande à un onglet, un document et une version de contexte ;
- exclut les champs sensibles et les zones `data-private` ;
- ne transmet jamais de valeur de formulaire pendant une lecture ;
- refuse une cible disparue, couverte, obsolète ou désactivée ;
- masque les zones privées avant l’envoi d’une capture ;
- journalise les résultats nécessaires aux évaluations Studio.

L’autorisation du site est optionnelle et accordée par origine. Le consentement IA et l’activation du navigateur sont contrôlés avant chaque tour.

## Studio

Le mode formateur reste distinct d’une conversation personnelle. `content.js` observe les gestes réels du formateur sans copier les valeurs saisies. `training-network.js` conserve uniquement méthode, chemin généralisé, statut et durée pour expliquer le résultat d’un clic. La vidéo et la transcription utilisent les routes Studio existantes.

Pendant une évaluation, le backend Deep Agent crée une conversation temporaire et le Studio reçoit les preuves d’action, de réponse et d’intervention manuelle. À la fin, la conversation précédente est restaurée.

Les contenus publiés sont exposés au Deep Agent par le serveur MCP du Studio. Une publication/revue Studio et la disponibilité réelle de ce MCP doivent être qualifiées séparément du build Chrome.

## Frontières de déploiement

- un seul flag produit : `is_charly_extension_enabled` côté backend, reflété par `workspace.enabled` dans le bootstrap extension ;
- aucun fallback proxy/Gemini/OTP dans l’extension ;
- traces de runs et d’outils dans LangSmith côté backend ;
- journaux locaux expurgés dans `chrome.storage.session` côté extension ;
- staging et production possèdent des identités Chrome et des origines API/app distinctes.
