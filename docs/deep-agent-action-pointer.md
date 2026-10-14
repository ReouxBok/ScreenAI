# Indication visuelle des actions natives

Le driver affiche un curseur violet au centre du contrôle lors d’un clic ou d’une saisie autorisés. Le curseur utilise un dessin SVG constant construit par les API DOM, sans `innerHTML`, texte utilisateur ou contenu du modèle. Le shadow root isole le dessin ; le conteneur reste hors du flux, sans interception des événements et masqué aux technologies d’assistance.

Le curseur est créé après validation de la référence et du type d’action. Il n’ajoute aucun délai avant l’effet : les vérifications du document, de la cible et des permissions gardent leur ordre. La décision et la référence viennent toujours du Deep Agent. L’extension ne recherche pas un autre contrôle et ne rejoue pas l’action pour rendre le curseur visible.

Une seule indication existe par document. Elle disparaît après 900 ms, au défilement, au redimensionnement ou à la sortie du document. Une navigation complète peut donc la faire disparaître immédiatement. Le mode observation conserve son surlignage sans déclencher clic ou saisie.

La recette Chromium vérifie la présence du curseur pendant les événements réels de clic/saisie, ses coordonnées, la stabilité de la géométrie, l’absence d’interception, une seule exécution et la disparition automatique. Elle vérifie aussi la capture de géométrie avec le curseur présent et sa suppression au défilement. L’API est simulée dans les parcours intégrés.

Le curseur ne reproduit pas la trajectoire animée et le défilement automatique legacy. Le test legacy correspondant reste en place tant que le parcours de navigation complet n’est pas réévalué ; cette couche ne déclare pas toute la parité visuelle achevée.
