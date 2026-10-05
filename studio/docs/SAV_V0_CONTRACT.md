# SAV-2 — Contrat métier V0

## Invariants

- HubSpot : vérité des tickets équipe ; Studio : propositions/revues/brouillons ; Notion : travail interne Ugo.
- Les comptes, rôles, sessions, droits et autres écrans existants du Studio restent inchangés. SAV conserve le contrôle admin existant.
- V0 (décision Ugo du 5 octobre) : réponse email uniquement par CTA humain distinct, dans le fil Gmail d’origine ; zéro brouillon externe, zéro écriture automatique HubSpot. Une validation du process n’envoie rien et ne crée pas de ticket.
- Cutover persistant : nouveaux emails reçus après la frontière ; aucun traitement de l'ancien stock. Le contexte antérieur du même dossier peut être lu, sans nouveau traitement ni transfert entre clients.
- Knowledge : chaque ajout/modification reste candidat jusqu'à validation Ugo. La validation d'une réponse n'active pas une connaissance.
- Feedback : évaluation rattachée au message, décision, prompt, modèle et sources exacts. Promotion/deploiement manuels.

## Machine de proposition (distincte du statut HubSpot)

| État | Événement | Résultat |
| --- | --- | --- |
| pending_analysis | analysis_ready | proposed : classification/process/routage/preuves/confiance/brouillon visibles |
| pending_analysis | analysis_failed | analysis_failed : diagnostic, retry borné, pas d'effet externe |
| analysis_failed | retry_analysis | pending_analysis : même message, traitement idempotent |
| proposed | validate | validated : verdict tracé, brouillon local seulement |
| proposed | correct | validated : correction versionnée, original conservé, signal d'évaluation |
| proposed | reject | rejected : raison tracée, aucune action externe |
| tout état sauf human_owned | new_inbound | obsolete : ancienne proposition non validable, nouvelle proposition séparée pour le nouveau message |
| tout état | takeover | human_owned : tâches IA non exécutables, aucun accusé envoyé |
| human_owned | new_inbound | human_owned : ne pas reprendre automatiquement la main |

Les autres transitions échouent. `transitionSavProposal` constitue le contrat testable ; la persistance et les actions de revue sont raccordées dans SAV-14. Une nouvelle arrivée pendant l'analyse doit également empêcher la publication d'une proposition courante obsolète.

## Actions

| Action | V0 |
| --- | --- |
| lire Gmail/HubSpot, analyser, proposer | autorisée après cutover, sous garde-fous d'isolation |
| enregistrer/corriger un brouillon | Studio uniquement |
| créer/lier un ticket | clic humain explicite, dossier courant, déduplication et audit |
| écrire une note/statut/log HubSpot | humain uniquement ; aucun side effect d'une simple revue |
| send_reply | humain uniquement, clic Envoyer distinct sur brouillon Studio courant ; ancien élément de queue/agent seuls interdits |
| classer le mail Gmail ouvert | clic humain dans la file V0 : libellé existant MAIL STUDIO SAV + retrait INBOX, sans changement lu/non lu ; jamais au préchargement/rendu, shadow et pilotes bloqués |
| request_human (accusé email) / relance | interdite en V0 |
| produire un candidat knowledge | permis, non actif |
| publier knowledge | validation Ugo dédiée, indépendante du verdict de réponse |

Le verrou V0 s'applique à l'exécution, pas seulement à l'interface. Les niveaux futurs sont conservés dans le modèle de configuration, sans activation ni contournement des kill switches. `shadow` reste sans écritures, `assist` est strictement humain.

Détail de la décision et de l’idempotence Gmail : [SAV_V0_MANUAL_REPLY.md](SAV_V0_MANUAL_REPLY.md). La revue ne publie pas de connaissance ; un candidat requiert une validation Ugo distincte. Le rejet historique reste compatible côté données, mais n’est plus un CTA de l’écran de proposition.

Classement Gmail au clic : [SAV_V0_GMAIL_FILING.md](SAV_V0_GMAIL_FILING.md). Dernière instruction : terminer ce changement et faire le retour avant de décider du push ; aucun cutover réel activé à ce stade.

## Ordre de réalisation

SAV-3 mapping et SAV-4 cutover ; SAV-5/6 qualification ; SAV-7/8 noyau sémantique ; SAV-9/10 candidats croisés ; SAV-11 publication ; SAV-12 évaluation ; SAV-13/14 cockpit/revue ; SAV-15/16 actions/brouillons ; SAV-17/18 mesures ; SAV-19 recette et mise en service approuvée. Les dépendances circulaires de la knowledge sont résolues en définissant d'abord le contrat candidat, puis les adaptateurs, puis la publication.
