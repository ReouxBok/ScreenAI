# Base de connaissances de Charly

## Principe

Charly ne doit pas être « entraînée » à chaque mise à jour. Elle utilise une base de connaissances (RAG) en complément du contexte temps réel :

- le DOM et les métadonnées réseau décrivent l'état actuel de l'application ;
- les articles décrivent le fonctionnement de Limova et les procédures ;
- l'historique décrit l'intention et les choix de l'utilisateur.

## Workflow actuel

Le Studio est la source de vérité éditoriale. Les membres créent ou modifient des brouillons, les admins/owner les valident puis les publient. Seule la version publiée d’un contenu marqué « destiné à l’agent AI » produit des `content_chunks` recherchables par Charly.

Le snapshot historiquement embarqué dans l’extension a été retiré afin qu’une procédure obsolète ne réapparaisse pas lorsque le service distant est indisponible. `src/knowledge-base/kb-data.js` reste volontairement vide. Une base sans contenu publié retourne immédiatement `kb_empty`, sans appel Gemini.

Le centre d’aide `https://limova.fr/aide` peut toujours servir de source d’import :

1. exécuter `npm run kb:refresh` ;
2. relire les Markdown générés ;
3. importer les articles retenus dans le Studio comme brouillons ;
4. faire valider et publier explicitement chaque contenu ;
5. exécuter les tests de recherche avant déploiement.

## Structure éditoriale recommandée

Chaque article doit traiter une intention utilisateur et contenir :

- un titre formulé comme une tâche ou une question ;
- un résumé court ;
- les pages Limova concernées ;
- les prérequis ;
- une procédure numérotée ;
- le résultat attendu ;
- les erreurs fréquentes et leur résolution ;
- la date de vérification et le propriétaire métier.

Exemple de métadonnées Markdown :

```yaml
---
title: "Connecter Gmail à Limova"
summary: "Ajouter ou rétablir une connexion Gmail."
related_urls: ["/integrations", "/integrations/catalog"]
intents: ["connecter gmail", "reconnecter gmail"]
locale: "fr-FR"
owner: "Équipe Customer Success"
verified_at: "2026-08-04"
---
```

Ne jamais inclure de secret, jeton, donnée client réelle ou information personnelle dans un article.

## Architecture cible recommandée

Pour permettre aux collaborateurs de publier sans attendre une validation Chrome Web Store :

1. conserver le centre d'aide comme source unique ;
2. déclencher automatiquement l'export Markdown à chaque publication ;
3. indexer les articles côté serveur par chemin, mots-clés et recherche sémantique ;
4. exposer au proxy une recherche retournant seulement les passages pertinents ;
5. versionner l'index et permettre un retour arrière ;
6. journaliser uniquement les métadonnées de recherche, jamais la question ou le contenu utilisateur.

Gemini File Search peut gérer l'import, le découpage et l'indexation pour les échanges texte. Il n'est pas disponible dans la Live API : la voix doit donc continuer à utiliser l'outil personnalisé `search_knowledge_base`, relié au même index serveur.

## Critères de publication

Un article est publiable si :

- la procédure correspond à l'interface actuelle ;
- les noms de boutons sont exacts ;
- les chemins de pages sont renseignés ;
- le résultat attendu est vérifiable ;
- une question de test retrouve l'article dans les trois premiers résultats ;
- un responsable métier a validé le contenu.
