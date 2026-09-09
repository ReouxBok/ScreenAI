# SAV — suivi du plan de fiabilisation

Objectif : réaliser le plan complet convenu dans Studio Limova, sans activer
l’autonomie en production sur la seule base de tests locaux.

Branche : `feat/sav-reliability-harness`.

## Exigences et preuves attendues

| Lot | Exigences | Preuve attendue | État |
|---|---|---|---|
| A1 | Référence : modes, moteurs, corpus anonymisé, tests et mesures initiales | Tests exécutés, référence versionnée, mesures réelles distinguées des simulations | En cours |
| A2 | Contrôle central des écritures, invalidation, suspension, destinataire, doublons et arrêt | Tests de workers et scénarios concurrents | En cours |
| A3 | Matrice des modes, drapeau IA global, interface et documentation cohérentes | Tests exhaustifs des permissions et inspection UI | En cours |
| B1 | Historique borné, auteurs, pièces jointes, citations, résumés et isolation client | Scénarios de conversation | En cours |
| B2 | Rattachement explicite, ambiguïtés, nouveaux sujets et tickets fermés | Scénarios CRM simulés | À faire |
| B3 | Étapes contrôlées, recherche répétable bornée, cache par arguments, sorties cohérentes | Tests harness et replis | En cours |
| B4 | Fiches structurées, validité, preuves précises, contradiction et clarification | Tests de recherche et de justification | À faire |
| B5 | Éligibilité par catégorie, confiance calibrée, promotion bloquante | Gate lié aux évaluations de la version exacte | À faire |
| C1 | Pilote détaillé, dimensions de verdict, corrections sans ticket et origine des moteurs | Tests service et interface | À faire |
| C2 | Replay versionné, corpus de contrôle séparé, régressions et événements successifs | Rapport reproductible et CI bloquante | À faire |
| D1 | Apprentissage du dossier, provenance, anonymisation, déduplication et validation | Tests candidats et publication | À faire |
| D2 | Reprise ingestion, retry borné, alertes, priorités, coût et conservation | Tests incidents et métriques opérables | À faire |
| E | Autonomie graduelle, qualité observée et retour arrière | Données pilotes réelles et recette avant activation | À faire |

## État initial

- Dépôt propre au démarrage ; branche créée depuis `main`.
- Dépendances Studio installées depuis le lockfile, sans scripts d’installation.
- Aucun changement de configuration externe ni écriture Gmail/HubSpot.
- La configuration de production et les résultats pilotes réels restent à vérifier.
- Les performances sur corpus synthétique ne prouvent pas la qualité en production.

## Première implémentation — 9 septembre 2026

- Référence initiale : 31 tests SAV réussis avant modification.
- Contrôle commun appelé avant les mutations Gmail et HubSpot : mode, arrêt global,
  lot pilote, statut d’action, suspension du fil, fraîcheur du message et destinataire.
- Matrice partagée par les deux workers. Les opérations inconnues sont refusées.
- Invalidation transactionnelle des brouillons, réponses en attente et relances lors
  d’un nouveau mail, d’une reprise humaine ou d’une correction de décision.
- Vérification de fraîcheur à l’approbation ; statut « attente client » également protégé.
- Le propriétaire du fil n’est plus remplacé silencieusement par un nouvel expéditeur.
- Historique des 12 derniers échanges, budget de 18 000 caractères, auteurs et dates,
  citations évidentes retirées ; historique futur et autres fils exclus.
- Pièces jointes explicitement déclarées non analysées. Historique tronqué signalé.
- Deux recherches différentes autorisées ; cache par arguments, budget par outil,
  contrôle des trois étapes obligatoires et rejet des identifiants de sources inconnus.
- Désactivation IA commune ; repli ADK soumis à revue humaine ; versions de prompt renouvelées.
- Documentation du pilote corrigée ; arrêts IA/écritures affichés dans le registre.
- Tests sur base PostgreSQL isolée avec toutes les migrations : invalidation, contexte,
  reprise humaine pendant une lecture Gmail et absence de second envoi après succès.
- Dernière suite globale : 115 tests réussis, TypeScript et ESLint réussis.

## Limites restantes à ne pas confondre avec une livraison complète

- La fenêtre entre le dernier contrôle local et l’acceptation d’une requête externe
  n’est pas éliminée par ces contrôles. Les scénarios de concurrence et de réponse
  réseau incertaine demandent un protocole de reprise supplémentaire.
- Les créations HubSpot après un timeout et les associations partiellement réussies
  nécessitent une réconciliation persistante avant nouvelle tentative.
- L’historique est borné, pas encore résumé avec références. Le contenu détaillé du
  ticket HubSpot, les ambiguïtés de routage et les pièces jointes restent à traiter.
- Vérifier une source connue ne prouve pas que chaque affirmation est étayée.
  La justification par passages, la vérification des réponses et les fiches structurées restent à faire.
- Corpus de replay, critères de promotion, corrections sans ticket, apprentissage,
  observabilité et reprise des analyses interrompues restent à implémenter.
- Aucun résultat pilote réel collecté, aucune configuration de production auditée,
  aucune autonomie activée. L’interface modifiée n’a pas encore été inspectée visuellement.

## Audit de clôture

Ne déclarer terminé que lorsque chaque exigence a une preuve adaptée à son
périmètre. Documenter les limites externes et les résultats manquants ; ne pas
remplacer les mesures réelles par des assertions statiques ou des fixtures.
