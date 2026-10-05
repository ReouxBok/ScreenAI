# SAV-1 — Audit du déploiement, 2 octobre 2026

Audit en lecture seule, sans modification de production ni relance de reçus.

## Preuves

| Élément | État constaté | Preuve / limite |
| --- | --- | --- |
| Production | READY, branche main, commit `9b29635632ef80681b8078a4780a0d410eed02da` | Vercel `dpl_AYBavxCCi119uhPRGenSJf7gnNLA`, alias studio.limova.ai ; identique au clone |
| Mode SAV | shadow (Observation) | Cockpit et page Santé authentifiés comme Ugo |
| ADK | pilot, clé SAV présente | Cockpit ; aucune valeur de secret consultée |
| Ingestion | 2 818 mails, dont 2 778 sans justification | Cockpit à 12:08 UTC ; compteurs instantanés, pas un objectif de backfill |
| Gmail | watch actif jusqu'au 09/10/2026 04:11:19 (affichage serveur), 2 reçus en échec, 0 en quarantaine | Santé ; pas de relance. L'identité OAuth et les destinataires effectifs ne sont pas exposés par cette vue |
| HubSpot | clé présente, 0 action externe en échec, 20 986 fiches affichées | Cockpit/Santé ; ne prouve pas les scopes ni le pipeline configuré |
| Évaluations | 0 revues ; ADK actuel 9 exécutions, 6 dégradées (67 %) | Cockpit ; l'absence de revue ne prouve pas la qualité |
| Knowledge | 108 contenus IA, 1 090 chunks ; SAV 0/0 dans l'accueil | Santé/accueil ; les contenus communs/onboarding ne sont pas automatiquement des procédures SAV validées |
| Crons | renouvellement Gmail quotidien 04:11 UTC, réconciliation toutes les 5 min | vercel.json au commit déployé ; exécution effective non vérifiée individuellement |
| Neon / migrations | les vues SAV et Santé fonctionnent | Preuve de schéma utilisé, pas de toutes les migrations ; registre migrations non accessible |
| Runtime | recherche knowledge HTTP 200, revision `kb_2026_09_30_muo65ms7` | Logs Vercel fenêtre 1h ; détail projet inaccessible (schéma connecteur incohérent) |

## Écarts à fermer avant activation

1. **P1 — Pas de cutover.** Le réconciliateur peut analyser des messages historiques non traités. SAV-4 doit poser une frontière persistante, stable, basée sur `receivedAt`, appliquée aussi aux retries/pilotes ; conserver l'historique sans l'analyser rétrospectivement.
2. **P1 — assist n'est pas exclusivement humain.** `action-policy.ts` autorise log_email/update_ticket_status automatiques. Verrou V0 au point d'exécution, sans changer les comptes.
3. **P1 — Brouillon validé = file d'envoi.** `approveSavDraft` prépare send_reply. SAV-16 doit séparer validation locale et envoi ; V0 refuse toute émission, y compris accusés de transfert et relances.
4. **P1 — Ingestion en erreur.** Deux reçus atteignent 25 tentatives avec erreur d'insertion SQL. La vue masque la cause DB ; diagnostic précis requis. Ne pas rejouer les anciens emails pour produire des propositions.
5. **P1 — Qualité non démontrée.** Aucun verdict humain, 67 % des runs ADK actuels dégradés. Pas de promotion d'autonomie ; tests et revue manuelle obligatoires.
6. **P2 — Connaissances non partagées sémantiquement.** SAV et extension filtrent des corpus distincts. SAV-7 à SAV-11 : familles/projections avec provenance, sans publication automatique.

## Vérifications encore nécessaires

- Présence (sans valeurs) des variables SAV/Gmail/HubSpot ; identité OAuth et filtre contact@limova.ai.
- Registre migrations Neon et contrainte à l'origine des deux échecs d'insertion.
- Scopes du token de service HubSpot, IDs pipeline/stages/owner réels.
- Exécution effective des crons et validation du watch Pub/Sub/audience.

## Baseline locale

Installation réussie avec `npm ci --ignore-scripts --legacy-peer-deps` et cache workspace, lockfile inchangé. CI utilise Node 24 ; environnement local différent à prendre en compte. `npm test` initial : 159/160, échec préexistant dans memory/crypto.test.ts (mutation du dernier caractère potentiellement identique ou base64 équivalent). Aucun correctif hors SAV appliqué. npm signale 54 vulnérabilités : audit détaillé à qualifier, aucune mise à niveau automatique.

## Décision

Implémentation locale possible ; activation/deploiement non déclarés prêts. SAV-1 fournit un inventaire vérifié/partiel et reste en revue Ugo avec les limites ci-dessus. SAV-2 peut avancer sur le contrat indépendant de la configuration réelle.
