# SAV-5 — Qualification des nouveaux emails

La borne SAV-4 est obligatoire. Aucune requalification historique n'est réalisée.

## Règles avant le modèle

- Bounce : adresse exacte `mailer-daemon` / `postmaster`, ou MIME `multipart/report; report-type=delivery-status`. Une phrase « non remis » citée dans un email client ne suffit pas.
- Réponse automatique : `Auto-Submitted: auto-replied` / `auto-generated`. Un en-tête inconnu ou un objet seul conduit à une revue humaine.
- Notification interne : adresse technique Limova explicitement connue, pas toute adresse `@limova.ai`.
- Risque sensible, demande humaine ou injection : revue humaine.
- Spam : signaux commerciaux étroits sans contexte support. Le simple mot « casino » ne suffit plus.
- Remerciement seul : aucun nouveau ticket. Un remerciement accompagné d'une question reste analysable.
- Corps vide, salutation seule ou demande indéterminée : revue humaine, jamais création automatique.
- Demande support probable : analyse existante, recherche du dossier avant proposition ; toute écriture externe reste conditionnée à un clic humain en V0.

Chaque décision conserve motif, justification, confiance, acteur et preuves. Les signaux `Auto-Submitted` et `Content-Type` sont conservés dans le payload chiffré et transmis aussi au moteur pilote.

## Idempotence et correction

- Un Gmail message ID ne produit qu'une ingestion par boîte. La création concurrente d'un fil est tolérée.
- Les commits de décision et les corrections sont sérialisés par verrou du message, puis revérifient la décision courante dans la transaction.
- Une correction conserve l'ancienne décision et son lien de supersession ; les actions encore en attente liées à l'ancienne décision sont annulées.
- Une correction antérieure au cutover est refusée. Le formulaire Studio existant reste disponible ; ses libellés et droits SAV seront finalisés dans SAV-13/14.
- Un message sans action ne ferme pas un dossier déjà lié à HubSpot ou pris en charge par un humain.

## Validation

Tests unitaires : cas techniques, ambiguïtés, faux positifs bounce/spam, remerciement vs nouvelle question ; aucun modèle/RAG appelé pour les messages non-support.

Tests PGlite : persistance des en-têtes, retry sans seconde décision, correction auditée et actions annulées, préservation d'un dossier humain.

À vérifier dans la QA intégrée avant production : parcours de correction et permissions locales SAV (SAV-13/14), concurrence multi-workers réelle et proposition arrivée après une nouvelle réponse (SAV-14). Les copies de contenu sous des Gmail IDs différents ne sont pas fusionnées automatiquement : risque de supprimer une vraie demande.
