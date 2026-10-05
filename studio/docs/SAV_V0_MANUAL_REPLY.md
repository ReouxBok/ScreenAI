# SAV-14 / SAV-16 — Revue simplifiée et réponse humaine (5 octobre 2026)

## Décision Ugo en vigueur

Cette décision remplace l’ancienne interdiction totale d’envoi V0, sans activer l’autonomie :

- Un humain autorisé peut cliquer sur **Envoyer la réponse**. Le mail répond dans le fil Gmail original.
- **Enregistrer le brouillon** conserve une version chiffrée dans le Studio, sans email ni brouillon Gmail.
- **Valider le process corrigé** conserve la correction et l’évaluation : ni envoi, ni création de ticket, ni publication de connaissance.
- Seul un feedback déclaré réutilisable propose un candidat générique. Toute connaissance doit ensuite être revue et publiée séparément par Ugo.
- Aucun push, PR, déploiement, migration production, secret ou email réel de recette autorisé implicitement.

## Interface

Situation initiale et contexte retrouvé → action/ticket proposé (titre, description, Support, Nouveau, propriétaire vide, Email, qualification) → un seul brouillon éditable avec son CTA d’envoi → noms des connaissances réellement utilisées → correction et évaluation dépliables → validation du process. Aucun bouton Refuser dans ce parcours.

Le résumé reprend la note factuelle de l’analyse ou sa justification, sans inventer un nouveau résumé IA des anciens emails. Les références de contexte affichées proviennent des données réellement disponibles. Une connaissance seulement retrouvée par recherche n’est pas présentée comme utilisée sans citation/étape référencée.

Les catégories/urgences actuelles sont la qualification SAV ; les valeurs techniques ne sont pas directement des options CRM. La taxonomie multi-catégories HubSpot reste un point distinct du mapping de qualification, conformément à SAV_HUBSPOT_MAPPING.md.

## Envoi et sécurité

- Authentification SAV existante et allowlist, uniquement acteur humain ; action distincte du verdict process.
- Brouillon immuable lié à email/décision/run/revue/révision de connaissance. Le contenu exact affiché et sauvegardé est envoyé ; aucun ajout invisible au moment de l’envoi.
- Pas besoin de créer un contact ou de confirmer une identité CRM pour poser la question de l’email d’inscription.
- Cutover, pilotage et kill switch vérifiés côté serveur. L’IA, les anciennes approbations de queue, les pilotes et les relances ne peuvent pas envoyer en V0.
- Contrôle live Gmail du dernier entrant avant envoi ; `threadId`, `In-Reply-To`, `References` et objet du mail source préservés. En-têtes manquants, expéditeur incohérent ou nouveau mail : blocage.
- Clé unique par entrant, claim worker et marqueur durable avant POST. Un timeout/crash/résultat inattendu après dispatch impose une réconciliation, jamais un second POST automatique. Recherche par RFC Message-ID limitée aux messages envoyés et au même thread.
- Un envoi V0 ne programme aucune relance et ne modifie aucun ticket/statut/note HubSpot. Un dossier repris humain conserve son statut et sa pause IA ; les autres passent localement en attente client.
- La pause IA ne bloque pas un nouveau clic explicite d’envoi humain V0. La confirmation dédiée, l’acteur autorisé, le contexte courant, l’idempotence et le kill switch restent requis. Elle bloque toujours les réponses des versions autonomes futures ; l’envoi humain ne reprend jamais l’IA.
- Les workers des versions futures conservent leur comportement existant ; aucune version future activée.

## Recette

Les tests utilisent uniquement PGlite et des réponses Gmail simulées. Les invariants de fil, corps exact, déduplication, kill switch, identité inconnue, changement de connaissance, nouveau mail et résultat incertain sont couverts. La séparation revue/candidat/publication conserve les tests de revue existants.

La prévisualisation reste `shadow`, écritures externes désactivées et sans credentials Gmail/HubSpot. Le bouton Envoyer y est volontairement inactif. La qualité réelle du modèle, la connexion réelle et un email de recette réel restent à qualifier après autorisation spécifique.

L’archive privée du 2 octobre n’est pas régénérée : cette livraison reste dans le checkout local sur `codex/sav-v0`.

### Correctif de recette assist — 5 octobre 2026

- Une proposition `create_ticket` ou `link_ticket` automatique en attente n’est pas une demande humaine V0 : elle reste non exécutable et ne bloque plus le CTA manuel. Une vraie demande humaine en cours ou une création au résultat incertain reste bloquante. Validation du process puis clic distinct toujours obligatoires.
- Le motif d’envoi désactivé distingue le verrou environnement du dossier de simulation, sans annoncer une prévisualisation à tort.
- Qualification locale : 394/394 tests Studio, typage et lint complets réussis. Réponses Gmail simulées seulement ; aucune réussite d’envoi réel présumée.

### Résultats de recette locale

- Suite complète : **344/344 tests**, 50 fichiers ; build Next/TypeScript, lint ciblé et `git diff --check` réussis.
- Navigateur : nouvelle présentation, correction avec verdict initial critique conservé, validation indépendante, sauvegarde de la cinquième version, aucun email/ticket/publication ; console sans erreur.
- Capture : `outputs/SAV-proposition-simplifiee-2026-10-05.png` à la racine de conversation (hors dépôt).
- Les guards Gmail sont testés avec réseau simulé, pas avec l’intégration réelle. La recette réelle reste nécessaire et ne doit pas être confondue avec ces résultats.
