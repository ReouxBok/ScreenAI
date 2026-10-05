# SAV-6 à SAV-10 — livrable local, non déployé

## Ce qui est implémenté

| Ticket | Livrable |
| --- | --- |
| SAV-6 | Proposition structurée validée côté serveur, routage CRM lu sans mutation, ambiguïtés en revue humaine, citations contrôlées, version de connaissance et proposition chiffrée conservées dans les runs. Une erreur de persistance de trace bloque le traitement. |
| SAV-7 | Familles canoniques, révisions métier, sources versionnées et projections distinctes SAV/onboarding. Identité/provenance plutôt que fusion par titre. Tables additives ; aucun backfill automatique. |
| SAV-8 | Étapes métier avec identifiant, libellé, instruction, localisation utilisateur, prérequis, résultat, exceptions, escalade et variantes de rôle/version. Les bindings Chrome référencent les actions enregistrées ; aucun DOM n'est copié dans la projection SAV. |
| SAV-9 | Conversion des tutoriels en candidats écrits, contrôles nommés et emplacement utilisateur conservés. Gestes sans portée métier non applicables ; état pending, source/session/version et diff visibles. |
| SAV-10 | Conversion depuis la version exacte d'une résolution humainement revue. Parcours UI : needs_recording, aucune action exécutable inventée ; autres résolutions SAV-only. Réessai idempotent de génération après revue, sans réécriture de la version source. |

## Limites intentionnelles et suite

- `/studio/sav/connaissances` est une vue en lecture seule. La matérialisation, revue Ugo, rejet, publication atomique et gestion des modifications concurrentes relèvent de SAV-11.
- Les nouveaux candidats ne sont pas des `content_items` publiés. Une simple conversion n'alimente pas les connaissances actives de l'agent.
- Le garde-fou Ugo-only sur publication/rollback est posé avant le lot SAV-11 ; un candidat nécessitant un tutoriel ne peut pas être publié, même via publication d'urgence.
- Les variantes rôle/version sont représentées et leur résolution pure est fail-closed si le contexte manque. Leur raccordement complet aux projections publiées/retrieval doit rester contrôlé pendant SAV-11 ; ne pas publier une procédure conditionnelle comme une procédure générale.
- Les identifiants générés utilisent la famille et l'ordre source, pas le libellé ou le DOM. Une insertion/réorganisation nécessite une revue humaine du mapping ; aucune correspondance automatique non vérifiable entre familles différentes.
- Aucun rapprochement par titre de connaissances historiques. Les contenus existants ne sont ni fusionnés ni supprimés. SAV conserve les sources de même titre distinctes pour permettre la détection de contradictions.
- Les connaissances proposées à partir d'une démonstration peuvent manquer de prérequis ou de résultats observés : c'est explicitement signalé, pas inventé. Ugo confirme avant publication.
- Aucun changement aux utilisateurs, à l'authentification ou aux permissions globales du Studio. Seule la nouvelle page SAV est limitée aux trois admins confirmés.
- SAV-13/14 afficheront la proposition complète et sa revue dans l'inbox ; SAV-15 ajoutera le clic de création HubSpot distinct. Le flux V0 complet n'est pas encore terminé.

## Migration et retour arrière

- `0025_sav_v0_knowledge.sql` ajoute cinq tables, des contraintes/indices et deux colonnes nullable sur les runs. Snapshot Drizzle généré avec le schéma correspondant.
- Migration vérifiée sur PGlite isolé uniquement. Aucune migration, configuration, activation cutover ou modification de données de production réalisée.
- Retour arrière applicatif : revenir au binaire précédent tout en conservant les nouvelles tables/colonnes et les preuves. Ne pas supprimer les données de révision/audit pour annuler un déploiement.
- Aucun push/déploiement avant validation explicite d'Ugo, revue du diff, QA intégrée et préparation des opérations de production.

## Prévisualisation isolée

- Base : `pglite:` vers un répertoire dédié `sav-preview-db` hors dépôt, sans accès aux données clients.
- Seed : `scripts/seed-sav-preview.ts`, refus de PostgreSQL ou de NODE_ENV=production ; deux cas fictifs, aucune publication.
- Serveur : localhost sur 127.0.0.1:3010, variables externes non héritées, V0 shadow, écritures désactivées, pas de clés Gmail/HubSpot/IA.
- Mode d'authentification de test existant utilisé uniquement en développement. Aucun contournement de l'authentification production ajouté.
- Vérification navigateur intégré : affichage des candidats et du diff factures, absence d'erreur console, navigation vers le Studio existant. Contrôle HTTP : admin autorisé 200, autre identité test redirigée 307, autres contenus Studio toujours 200.

## Vérification

- Tests de conversions sur PGlite : idempotence, DOM-only, renommage d'étape, famille partagée, source/version erronée, contexte non applicable, tutoriel requis, résolution non validée, modifications ultérieures non validées et publication par un autre admin.
- Tests d'analyse/routage/citations et corpus de replay SAV local ; aucun appel à une boîte réelle pendant les tests.
- Le journal Notion décrit les erreurs de fixture, les limites des watchers locaux et les correctifs. Les chiffres de la dernière exécution sont consignés dans les tickets.
