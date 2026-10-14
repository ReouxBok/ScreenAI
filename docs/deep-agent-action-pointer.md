# Indication visuelle des actions natives

Le driver affiche un curseur violet au centre du contrôle lors d’un clic ou d’une saisie autorisés. Le curseur utilise un dessin SVG constant construit par les API DOM, sans `innerHTML`, texte utilisateur ou contenu du modèle. Le shadow root isole le dessin ; le conteneur reste hors du flux, sans interception des événements et masqué aux technologies d’assistance.

Le curseur est créé après validation de la référence et du type d’action. Il n’ajoute aucun délai avant l’effet : les vérifications du document, de la cible et des permissions gardent leur ordre. La décision et la référence viennent toujours du Deep Agent. L’extension ne recherche pas un autre contrôle et ne rejoue pas l’action pour rendre le curseur visible.

Une seule indication existe par document. Elle disparaît après 900 ms, au défilement, au redimensionnement ou à la sortie du document. Une navigation complète peut donc la faire disparaître immédiatement. Le mode observation conserve son surlignage sans déclencher clic ou saisie.

La recette Chromium vérifie la présence du curseur pendant les événements réels de clic/saisie, ses coordonnées, la stabilité de la géométrie, l’absence d’interception, une seule exécution et la disparition automatique. Elle vérifie aussi la capture de géométrie avec le curseur présent et sa suppression au défilement. L’API est simulée dans les parcours intégrés.

Le parcours natif vers un lien initialement hors écran est maintenant vérifié : commandes de défilement, relecture des références visibles, puis clic unique avec curseur centré et navigation réelle, dans le même tour. Les reçus prouvent le mouvement et la lecture de la destination. Aucun contrôle hors écran n’est sélectionné à partir d’une référence inventée.

Le scénario legacy correspondant est remplacé par ce parcours et les tests de clic/saisie et navigation nommée. L’ancien test déclenchait un clic depuis le bouton d’analyse ; ce comportement est remplacé par une demande avec consentement navigateur, car l’analyse native reste en observation. Le curseur reste une indication immédiate au point d’action : aucune trajectoire animée ni attente artificielle avant clic n’est ajoutée. Le défilement est une commande explicite du même tour, suivie d’une nouvelle lecture, plutôt qu’un effet implicite du clic. Cette recette ne prétend pas reproduire pixel pour pixel l’animation legacy ni qualifier la planification d’un modèle réel.
