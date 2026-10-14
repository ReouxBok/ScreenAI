# Historique partagé dans le panneau Deep Agent

Le panneau réutilise les contrats de pagination de Limova : `GET /conversation?engine=deep_agents&type=general&page=N&limit=20` et `GET /conversation/:id/messages?before=<nextCursor>`. Aucun endpoint ni agent supplémentaire.

« Plus de conversations » ajoute les pages du catalogue, dédupliquées par ID. La sélection courante est conservée même si le chat n’est pas dans la première page. « Messages précédents » ajoute les pages chronologiques en tête, garde la version récente d’un message déjà affiché et affiche le début de l’historique chargé. Les fichiers associés continuent de passer par le filtre de liens HTTPS existant.

Les boutons suivent `pagination.hasNext` et `pagination.hasMore/nextCursor`. Une requête échouée garde son curseur pour une nouvelle tentative. Les doubles clics ne créent pas de lectures concurrentes ; le changement de compte, workspace ou conversation invalide les résultats tardifs. Une actualisation invalide aussi les requêtes anciennes sans laisser les boutons verrouillés. Une nouvelle réponse conserve la frontière historique déjà parcourue.

Tests : catalogue multipage/sélection/déduplication, ordre et chevauchement des messages, rejet après changement de conversation, reprise après erreur réseau, conservation du curseur après une réponse et actualisation concurrente. Le test Chromium exerce les boutons du panneau réel avec des réponses du worker simulées. Les validations ne prouvent pas une session déployée réelle ni la parité complète des artefacts ou des traductions.


## Contenus générés attachés aux réponses

La projection lit désormais `generatedFiles`, `generatedImages`, `generatedVideos`, `generatedCaption` et les `slides` de `generatedCarousel` des messages visibles, selon les DTO existants de l’API. Les fichiers sont associés au message qui les porte ; les diapositives suivent l’ordre du carrousel. Une réponse contenant uniquement des pièces jointes ou une légende reste affichable. Un événement ultérieur de fichier peut renouveler son URL sans perdre son association au message.

Le panneau affiche les fichiers sous la réponse, les légendes en texte brut et les fichiers sans message connu en fin de fil. Les boutons de fichier demandent maintenant une URL renouvelée au worker avant ouverture dans un nouvel onglet. Il ne monte pas de HTML distant, iframe, lecteur média ou script provenant d’un contenu généré ; la CSP reste inchangée.

Validation : tests de projection des vidéos/carrousels/légendes seules, ordre, déduplication, réconciliation des URLs, exclusions des outils/messages cachés/URLs non HTTPS ; Chromium vérifie leur place dans le panneau et l’inertie d’une légende contenant une balise script.

L’aperçu embarqué et l’édition/versionnage des artefacts restent ouverts pour la parité complète. Le renouvellement des liens est décrit ci-dessous.


## Ouverture avec URL renouvelée

Le clic ne navigue plus vers l’URL conservée dans le rendu. Le worker résout l’ID du fichier dans l’historique canonique de la conversation sélectionnée, via `GET /conversation/:id/messages` et ses curseurs. Cette route renouvelle déjà les URLs signées et applique les droits de conversation. La route `GET /files/:id` est volontairement évitée : sa portée `uploadedBy=userId` ne couvre pas tous les fichiers accessibles via un chat partagé.

Le client parcourt les pages jusqu’au fichier, avec timeout global de 30 secondes, annulation et détection des curseurs répétés. Il considère uniquement les messages visibles et les fichiers explicitement sans ancrage. L’URL doit être HTTPS sans identifiants intégrés ; l’identité est revérifiée après sa résolution. Le worker refuse une réponse tardive si le contexte sélectionné a changé, puis crée l’onglet. Le panneau transmet uniquement les identifiants de conversation/fichier, jamais une URL à ouvrir. Aucun élargissement des routes autorisées par la passerelle first-party.

Les fichiers supprimés/inaccessibles, la perte du flag ou les changements de compte entraînent une erreur visible, sans repli sur l’ancienne URL. Limite de performance : un ancien fichier peut nécessiter plusieurs pages de lecture ; un très long historique peut atteindre le timeout et rester réessayable. Pas de garantie d’accès hors ligne ni de renouvellement après ouverture de l’onglet externe.

Tests : fichier sur une ancienne page, absence, URL malformée/non HTTPS/avec identifiants, contenu caché, curseur répété, annulation, changement de compte après résolution et changement de sélection avant ouverture. Chromium vérifie que le clic du panneau transmet les IDs au worker ; il ne qualifie pas un téléchargement sur le stockage déployé.
