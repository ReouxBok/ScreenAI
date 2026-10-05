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
