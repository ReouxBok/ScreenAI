# Exporter une conversation Limova

Le menu propose « Exporter cette conversation (CSV) » pour le chat sélectionné. Le téléchargement utilise `GET /conversation/:id/download`, déjà présent dans l’API, avec le workspace courant et la session first-party. Aucun endpoint ni permission Chrome de téléchargement supplémentaire n’est créé.

Le client valide d’abord la conversation Deep Agent et son périmètre, reçoit le CSV via la passerelle app, puis revalide le compte et le workspace. Le worker et le panneau refusent un résultat devenu obsolète après changement de sélection/session. Le bouton est indisponible sans conversation, pendant un tour, une évaluation ou un autre export. Une expiration d’accès utilise le refresh existant.

Le MIME attendu est `text/csv`. Le téléchargement est limité à 10 Mio et 30 secondes ; dépassement, réponse HTML/JSON, coupure ou perte d’autorisation ne produisent pas de fichier partiel. Le nom est construit à partir de l’UUID de conversation ; aucun nom ou URL fourni par le serveur n’est exécuté. Le contenu reste celui de l’export API.

## Périmètre des données

Le service API `ConversationExportService.exportToCsv` contrôle l’accès par `ConversationService.getById`, sélectionne les messages chronologiquement et exclut les messages cachés, outils et contenus vides. Le CSV contient horodatage, auteur et contenu. Il ne constitue pas un export complet de mémoire, skills, intégrations, pièces jointes ou données du compte.

L’ancien export JSON est conservé lorsqu’il est disponible, sous le libellé explicite « Exporter les données de l’ancienne extension ». Il contient les données du service historique ; il ne devient pas artificiellement un export de la mémoire Limova. L’inventaire/import des données historiques et la parité d’effacement restent à terminer avant retrait de ce service.

## Validation

Tests client : route/workspace, CSV UTF-8, MIME incorrect, plafond, changement de compte après lecture et refresh. Tests worker/panneau : sélection exacte, résultat obsolète et double export. Chromium : vrai téléchargement depuis le menu à travers worker et passerelle, cookie partitionné et route HTTPS locale, nom et octets du fichier vérifiés. Le serveur API de ces scénarios est une fixture : pas de preuve d’export sur le déploiement réel.
