# Historique partagé dans le panneau Deep Agent

Le panneau réutilise les contrats de pagination de Limova : `GET /conversation?engine=deep_agents&type=general&page=N&limit=20` et `GET /conversation/:id/messages?before=<nextCursor>`. Aucun endpoint ni agent supplémentaire.

« Plus de conversations » ajoute les pages du catalogue, dédupliquées par ID. La sélection courante est conservée même si le chat n’est pas dans la première page. « Messages précédents » ajoute les pages chronologiques en tête, garde la version récente d’un message déjà affiché et affiche le début de l’historique chargé. Les fichiers associés continuent de passer par le filtre de liens HTTPS existant.

Les boutons suivent `pagination.hasNext` et `pagination.hasMore/nextCursor`. Une requête échouée garde son curseur pour une nouvelle tentative. Les doubles clics ne créent pas de lectures concurrentes ; le changement de compte, workspace ou conversation invalide les résultats tardifs. Une actualisation invalide aussi les requêtes anciennes sans laisser les boutons verrouillés. Une nouvelle réponse conserve la frontière historique déjà parcourue.

Tests : catalogue multipage/sélection/déduplication, ordre et chevauchement des messages, rejet après changement de conversation, reprise après erreur réseau, conservation du curseur après une réponse et actualisation concurrente. Le test Chromium exerce les boutons du panneau réel avec des réponses du worker simulées. Les validations ne prouvent pas une session déployée réelle ni la parité complète des artefacts ou des traductions.


## Contenus générés attachés aux réponses

La projection lit désormais `generatedFiles`, `generatedImages`, `generatedVideos`, `generatedCaption` et les `slides` de `generatedCarousel` des messages visibles, selon les DTO existants de l’API. Les fichiers sont associés au message qui les porte ; les diapositives suivent l’ordre du carrousel. Une réponse contenant uniquement des pièces jointes ou une légende reste affichable. Un événement ultérieur de fichier peut renouveler son URL sans perdre son association au message.

Le panneau affiche les liens HTTPS sous la réponse, les légendes en texte brut et les fichiers sans message connu en fin de fil. Les liens s’ouvrent séparément avec `noopener noreferrer` et sans référent. Il ne monte pas de HTML distant, iframe, lecteur média ou script provenant d’un contenu généré ; la CSP reste inchangée.

Validation : tests de projection des vidéos/carrousels/légendes seules, ordre, déduplication, réconciliation des URLs, exclusions des outils/messages cachés/URLs non HTTPS ; Chromium vérifie leur place dans le panneau et l’inertie d’une légende contenant une balise script.

Cette couche donne accès aux médias par leurs liens signés ; elle ne réalise pas encore l’aperçu embarqué, l’édition/versionnage des artefacts, ni le renouvellement à la demande d’un lien expiré sur une ancienne page d’historique. Ces points restent ouverts pour la parité complète.
