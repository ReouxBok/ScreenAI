# Historique partagé dans le panneau Deep Agent

Le panneau réutilise les contrats de pagination de Limova : `GET /conversation?engine=deep_agents&type=general&page=N&limit=20` et `GET /conversation/:id/messages?before=<nextCursor>`. Aucun endpoint ni agent supplémentaire.

« Plus de conversations » ajoute les pages du catalogue, dédupliquées par ID. La sélection courante est conservée même si le chat n’est pas dans la première page. « Messages précédents » ajoute les pages chronologiques en tête, garde la version récente d’un message déjà affiché et affiche le début de l’historique chargé. Les fichiers associés continuent de passer par le filtre de liens HTTPS existant.

Les boutons suivent `pagination.hasNext` et `pagination.hasMore/nextCursor`. Une requête échouée garde son curseur pour une nouvelle tentative. Les doubles clics ne créent pas de lectures concurrentes ; le changement de compte, workspace ou conversation invalide les résultats tardifs. Une actualisation invalide aussi les requêtes anciennes sans laisser les boutons verrouillés. Une nouvelle réponse conserve la frontière historique déjà parcourue.

Tests : catalogue multipage/sélection/déduplication, ordre et chevauchement des messages, rejet après changement de conversation, reprise après erreur réseau, conservation du curseur après une réponse et actualisation concurrente. Le test Chromium exerce les boutons du panneau réel avec des réponses du worker simulées. Les validations ne prouvent pas une session déployée réelle ni la parité complète des artefacts ou des traductions.
