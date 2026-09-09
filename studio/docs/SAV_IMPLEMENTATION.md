# SAV — suivi du plan de fiabilisation

Objectif : réaliser le plan complet convenu dans Studio Limova, sans activer
l’autonomie en production sur la seule base de tests locaux.

Branche : `feat/sav-reliability-harness`.

## Exigences et preuves attendues

| Lot | Exigences | Preuve attendue | État |
|---|---|---|---|
| A1 | Référence : modes, moteurs, corpus anonymisé, tests et mesures initiales | Tests exécutés, référence versionnée, mesures réelles distinguées des simulations | Implémenté localement |
| A2 | Contrôle central des écritures, invalidation, suspension, destinataire, doublons et arrêt | Tests de workers et scénarios concurrents | Implémenté localement |
| A3 | Matrice des modes, drapeau IA global, interface et documentation cohérentes | Tests exhaustifs des permissions et inspection UI | Implémenté localement |
| B1 | Historique borné, auteurs, pièces jointes, citations, résumés et isolation client | Scénarios de conversation | Implémenté localement |
| B2 | Rattachement explicite, ambiguïtés, nouveaux sujets et tickets fermés | Scénarios CRM simulés | Implémenté localement |
| B3 | Étapes contrôlées, recherche répétable bornée, cache par arguments, sorties cohérentes | Tests harness et replis | Implémenté localement |
| B4 | Fiches structurées, validité, preuves précises, contradiction et clarification | Tests de recherche et de justification | Implémenté localement |
| B5 | Éligibilité par catégorie, confiance calibrée, promotion bloquante | Gate lié aux évaluations de la version exacte | Gate implémenté ; calibration réelle attendue |
| C1 | Pilote détaillé, dimensions de verdict, corrections sans ticket et origine des moteurs | Tests service et interface | Implémenté localement |
| C2 | Replay versionné, corpus de contrôle séparé, régressions et événements successifs | Rapport reproductible et CI bloquante | Règles en CI ; runner ADK prêt, campagne réelle attendue |
| D1 | Apprentissage du dossier, provenance, anonymisation, déduplication et validation | Tests candidats et publication | Implémenté localement |
| D2 | Reprise ingestion, retry borné, alertes, priorités, coût et conservation | Tests incidents et métriques opérables | Implémenté localement |
| E | Autonomie graduelle, qualité observée et retour arrière | Données pilotes réelles et recette avant activation | Code fermé par défaut ; données réelles attendues |

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

## Deuxième implémentation — 9 septembre 2026

- Les solutions utilisent des citations exactes. L’identifiant, l’affirmation et
  l’extrait sont contrôlés contre une fiche structurée, récente et suffisamment
  pertinente. Les conflits déclarés entre fiches imposent une revue humaine.
- Les fiches SAV expirées ou sans structure de résolution sont exclues de la
  recherche autonome. Les types de réponse distinguent solution, clarification,
  accusé de réception, transfert et absence de réponse.
- Le routage HubSpot privilégie le ticket déjà lié au fil Gmail, puis une référence
  explicite, un sujet exact et enfin une similarité avec seuil et marge. Une
  ambiguïté suspend l’écriture ; un ticket fermé n’est pas rouvert.
- Les identifiants HubSpot créés sont persistés avant les associations suivantes,
  afin qu’une reprise n’engendre pas un second objet après un échec partiel connu.
- Chaque élément pilote référence directement l’exécution qui l’a produit. Les
  scores de promotion ne peuvent plus être hérités par une autre version du prompt.
- Le formulaire pilote mesure classification, routage, ancrage, ton et escalade.
  Une correction sans ticket HubSpot crée aussi un candidat d’apprentissage.
- Les résolutions apprises enregistrent auteur humain ou IA, confirmation client,
  message source et référence du dossier. Les aperçus et contenus d’apprentissage
  masquent emails, téléphones, cartes et secrets probables.
- Les analyses interrompues et actions externes ont une reprise bornée, un délai
  exponentiel et un état terminal. Les actions urgentes passent avant la file
  normale. Le cron renvoie désormais une erreur exploitable si une étape échoue.
- Les exécutions ADK enregistrent latence et jetons. Le tableau de bord expose les
  incidents, reprises, dimensions de qualité, version exacte et coût en jetons.
- La conservation est volontairement inactive par défaut et ne supprime que les
  dossiers clos au-delà du délai configuré, plus les reçus techniques anciens.
- L’autonomie exige 30 revues de la version exacte, 100 revues globales, 90 % de
  score pondéré, au plus 15 % d’écart de calibration, aucun verdict critique,
  aucun repli et aucune action en échec.
  Elle reste ensuite limitée aux catégories autorisées, à un seuil de confiance,
  à un pourcentage stable de dossiers et à un plafond quotidien. Le pourcentage
  vaut 0 par défaut.
- Le replay synthétique versionné sépare développement et contrôle et bloque la CI.
  Résultat local : 12/12. La suite Studio compte 149 tests réussis.
- Un second replay exécute le vrai harness ADK avec des fiches et tickets synthétiques
  injectés, sans accès aux systèmes externes. Son exécution exige une clé Gemini et
  reste distincte du replay déterministe bloquant de la CI.
- Validation supplémentaire : typage, lint, build Next.js, migration Drizzle réelle
  sur PostgreSQL local isolé et test navigateur du registre SAV réussis.
- Audit Vercel en lecture seule : le projet `studio` est en mode `shadow`, le harness
  ADK est en mode `pilot`, l’analyse IA est active et les webhooks non signés sont
  refusés. Les nouveaux réglages d’autonomie sont absents et prennent donc leurs
  valeurs fermées par défaut.

## Limites externes restantes

- Un timeout sur la requête de création elle-même peut rester ambigu si HubSpot a
  créé l’objet sans renvoyer son identifiant. Les reprises couvrent les échecs après
  réception de l’identifiant ; une garantie absolue demanderait une clé
  d’idempotence acceptée par l’API distante.
- Les pièces jointes sont déclarées non analysées et déclenchent une clarification
  si elles sont nécessaires. Leur extraction sûre n’est pas incluse dans ce lot.
- Le replay CI couvre les règles déterministes et les invariants du harness. Une
  campagne récurrente du modèle ADK sur un corpus pilote anonymisé exige une clé,
  une base de fiches représentative et un budget modèle ; elle ne doit pas être
  simulée dans les chiffres de production.
- Aucun déploiement, migration distante ou changement de variable Vercel n’a été
  effectué dans ce lot. Les métriques de promotion restent donc à zéro tant que les
  revues pilotes réelles n’ont pas été menées sur la version déployée.

## Audit de clôture

Ne déclarer terminé que lorsque chaque exigence a une preuve adaptée à son
périmètre. Documenter les limites externes et les résultats manquants ; ne pas
remplacer les mesures réelles par des assertions statiques ou des fixtures.
