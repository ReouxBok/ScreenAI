# SAV-3 — Mapping Support vérifié

Source : connecteur HubSpot authentifié Ugo, portail **143641967**, propriétés TICKET lues le 2 octobre 2026. Aucune écriture CRM. Les scopes du token de service du Studio ne sont pas déduits des droits de ce connecteur.

| Métier | Propriété | Valeur vérifiée |
| --- | --- | --- |
| Pipeline Support | hs_pipeline | `0` (Support Pipeline) |
| Nouveau | hs_pipeline_stage | `1` (New) |
| En attente de contact | hs_pipeline_stage | `2` (Waiting on contact) |
| En attente équipe | hs_pipeline_stage | `3` (Waiting on us) |
| Fermé | hs_pipeline_stage | `4` (Closed) |
| Source Email | source_type | `EMAIL` |
| Nom ≤ cinq mots | subject | texte |
| Mail original complet | content | texte ; ne pas tronquer silencieusement |
| Propriétaire à la création | hubspot_owner_id | omis conformément à la procédure Ugo |
| Catégories | hs_ticket_category | valeurs exactes ci-dessous, multi-sélection sérialisée avec `;` |

La correspondance des stages 1–4 au pipeline Support est corroborée par les propriétés `hs_v2_date_entered_1` à `_4`. Le writer vérifie aussi la définition live du pipeline avant toute création de contact/ticket pour détecter une configuration divergente.

| Clé métier | Valeur HubSpot exacte |
| --- | --- |
| access | Acces |
| misuse | Mauvaise utiisation |
| missing_feature | Manque de fonctionalité |
| technical | Problème technique |
| cancellation | Résiliation |
| billing | Facturation |
| feedback | Feedback |
| other | Autres |

L'option `Churnkey` existe mais n'est pas automatiquement sélectionnée. Ne pas corriger les fautes des options CRM : cela créerait des valeurs incompatibles. Les catégories techniques du modèle (integration, how_to…) ne sont pas des options HubSpot : SAV-5/SAV-15 doivent proposer une taxonomie métier et permettre la correction humaine.

## Associations et idempotence

- Ticket → contact : association HubSpot standard actuellement utilisée `16`. Lire la définition runtime avant généralisation à d'autres portails (pas de mapping inter-portail supposé).
- Email/notes/tâches : propositions uniquement en V0 ; les associations/actions exactes doivent être choisies séparément par l'humain. Les workers ne doivent pas transformer un clic « créer » en envoi/relance/assignation.
- Réutiliser le ticket ouvert même client/même sujet ; ambiguïté = revue, jamais choix arbitraire. Le ticket fermé n'est pas automatiquement rouvert.
- Persister l'identifiant créé avant toute étape suivante. La fenêtre « écriture HubSpot réussie mais commit local échoué » doit être traitée dans SAV-15 ; la déduplication locale seule ne suffit pas.
- Ne pas créer un contact de façon silencieuse quand la fiche client manque : SAV-15 doit proposer la demande d'identité dans le Studio et requérir une décision explicite.

## Vérification

`hubspot-mapping.test.ts` référence les valeurs réelles et couvre configuration divergente, membership/stage fermé, catégories invalides, multi-sélection et conservation du texte. Il n'effectue aucune écriture réelle. Les tests bout en bout avec le token de service sont différés à la recette autorisée SAV-19.

## Tickets créés depuis l'app (SAV-138)

Lecture régulière existante (`reconcile-pass.ts`, étape `v2_app_tickets`), code dans `src/lib/sav/cases/app-tickets.ts` :

- `SAV_APP_TICKETS_MODE` : `off` par défaut (aucun appel HubSpot), `shadow` (décision enregistrée, aucun effet), `live` (attribution à `SAV_V2_HUBSPOT_OWNER_ID` puis entrée sans fil existante). Production uniquement.
- `SAV_APP_TICKETS_SOURCE_TYPES` : valeurs `source_type` des tickets de l'app, obligatoires en `live` (`EMAIL` toujours refusé).
- `SAV_APP_TICKETS_LOOKBACK_MINUTES` : fenêtre avant la première lecture de chaque mode (60 par défaut, 1440 au plus).
- Catégories `Facturation` et `Résiliation` : jamais touchées (ni attribution, ni modèle, ni Slack, ni mail). Rapport : outil MCP administrateur `app_tickets_report`.
- Premier mail (`live` seulement, avec `SAV_V2_ENTRY_SMART=on`) : un case ouvert par ce chemin (clé de transition `hubspot-app-ticket:…`) naît chez l'agent au lieu de `smart_no_thread` ; le cerveau smart écrit le premier mail, envoyé sur un nouveau fil Gmail depuis contact@ au contact HubSpot, sujet = sujet du ticket (sinon « Votre demande Limova »). Droits : ceux de la réponse smart (`SAV_V2_SMART_SUPPORT_MODE=auto`, réponse automatique et approbateur, garde d'envoi smart, bloc `smart-support`), relus à l'envoi. Passage de main, contact sans e-mail ou mode changé : rien n'est envoyé, le ticket va à l'équipe. Les tickets sans fil attribués par une personne ne changent pas.
- Garde-fous (revue du 25/11) : aucune attribution sans `SAV_V2_ENTRY_SMART=on` ; au plus une entrée (un appel modèle) par passe, avec 100 s de marge ; configuration de la réponse automatique vérifiée avant tout appel modèle ; catégorie relue à l'entrée ; recherche HubSpot avec `source_type NEQ EMAIL`. En `shadow`, un ticket resté attribué entre l'attribution et l'entrée par un ancien passage `live` est rendu une fois à l'équipe (visible dans `app_tickets_report`, mode `live`) ; si le V2 est en pause ou l'entrée indisponible, la ligne est retentée à la passe suivante. `off` ne fait strictement rien (aucune requête, module non chargé).
- Sortie du `live` : 1) passer `SAV_APP_TICKETS_MODE=shadow` pendant au moins une passe ; 2) vérifier dans `app_tickets_report` (mode `live`) qu'il ne reste aucune ligne `assigning` ni `assigned` ; 3) seulement alors passer en `off`.
