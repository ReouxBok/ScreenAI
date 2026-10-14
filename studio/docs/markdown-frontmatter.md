# Métadonnées Markdown de la base de connaissances

Les scripts `kb:import` et `kb:export` utilisent `src/lib/markdown-frontmatter.ts` et `js-yaml` 4.3.2. Le remplacement de `gray-matter` retire sa chaîne `js-yaml` 3 → `argparse` 1 → `sprintf-js`, sans modifier les routes ou services Studio.

L’import accepte un en-tête YAML délimité par `---`, éventuellement avec le marqueur `yaml`, ou un Markdown sans en-tête. BOM et CRLF sont pris en charge. Les métadonnées doivent être un mapping ; les en-têtes non fermés, clés dupliquées, autres langages et tags JavaScript sont refusés. Le contenu après l’en-tête reste intact. L’export conserve les métadonnées source, puis remplace titre et slug par les valeurs Studio comme auparavant.

Les 106 sources sont lues, parsées et leurs métadonnées sérialisées avant la première écriture de catégories/articles. Cela évite une importation partielle causée par un en-tête invalide ; cela ne rend pas toutes les écritures DB transactionnelles.

Les tests couvrent les métadonnées imbriquées, listes, booléens, null, dates, chaînes ambiguës citées, Unicode, valeurs multilignes, alias YAML, corps Markdown avec séparateurs et refus des en-têtes invalides/exécutables. Un export puis réimport conserve le contenu et les valeurs testées, pas nécessairement la mise en forme originale du YAML.

Le corpus source de 106 fichiers n’est pas présent dans ce checkout. Avant toute réimportation réelle, comparer les métadonnées obtenues sur ce corpus avec son export historique. Le passage de js-yaml 3 à 4 peut changer l’interprétation de scalaires anciens non cités, notamment nombres octaux ou sexagésimaux ; ils doivent être qualifiés, et non corrigés silencieusement dans les données. Aucun import/export vers une base réelle n’a été exécuté pour cette couche.

L’audit après remplacement contient encore cinq alertes hautes dans la chaîne ESLint/fast-glob/micromatch/braces. Le gate n’est pas abaissé. L’[avis braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) n’annonce pas de version corrigée ; l’[avis sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) concerne la chaîne désormais retirée.
