# SAV-19 — préparation du pilote, sans activation

Agent : Codex. Approbateur : Ugo. Ticket parent : https://app.notion.com/p/3ec4e1ce0bc98196a524cb3765b1c2de

## 1. Revue locale

- Examiner inbox, conversation entière, contexte CRM, revue du process, brouillon versionné et dashboard.
- Vérifier un cas nominal, un email inconnu, une erreur critique corrigée, une exclusion et un problème distinct de ticket ouvert.
- La démo utilise des données fictives et aucune connexion Gmail/HubSpot/IA. Ne pas confondre ses résultats avec une qualification réelle.

## 2. Qualification réelle : option à choisir avec Ugo

- Préférer application/base de test isolées, credentials dédiés stockés hors Git et actions externes bloquées. Le lanceur sav:preview ne doit pas être adapté avec des secrets réels : il les refuse volontairement.
- Si Ugo choisit un pilote live : présenter avant exécution le diff, versions, migrations, environnement cible, flags, coût/permissions des intégrations, cutover et rollback. Attendre l’accord explicite. « Continuer les tickets » ou « je testerai en live » n’autorisent pas un déploiement.
- Ne jamais copier DATABASE_URL production ou credentials chiffrants de production dans la démo. Pas de création de contact. La réponse Gmail V0 est autorisée seulement par le CTA humain séparé, dans le fil d'origine ; recette réelle uniquement sur un cas désigné et approuvé.

## 3. Opérations après autorisation explicite, non exécutées

1. Sauvegarde/restauration vérifiées et plan de livraison privée convenu ; aucun push vers le dépôt public par défaut.
2. Déploiement approuvé avec migrations additives SAV ; conserver V0, shadow, écritures externes bloquées et backfill désactivé. Version exacte qualifiée ; DEV_AUTH_BYPASS interdit en production.
3. Vérifier mailbox OAuth déjà synchronisée, destinataire contact@limova.ai, watch/curseur et événements entrants. Ne pas réinitialiser l’historique ni détourner les webhooks production vers localhost.
4. Enregistrer une seule fois le cutover correspondant au déploiement réellement READY, selon SAV_V0_CUTOVER.md, après autorisation Ugo spécifique.
5. Observer uniquement les prochains entrants. Comparer réception Gmail et ingestion SAV, vérifier idempotence, revue, références versionnées et absence de mutations externes.
6. Qualifier HubSpot en lecture seule : email reconnu, inconnu, indices nom/téléphone, même problème, problème différent, ambiguïté, ticket fermé, données/pièces jointes manquantes.
7. Autorisation séparée avant test de création/rattachement manuel sur un cas précisément désigné. Vérifier un seul ticket, aucune fiche contact créée, associations, pipeline/statut, arrêt/reprise et réconciliation d’une création incertaine.
8. Passage assist uniquement après nouvel accord Ugo, sans semi/on. Réponse V0 manuelle distincte de la validation du process, selon SAV_V0_MANUAL_REPLY.md. Les futures gates d’autonomie ne doivent pas bloquer la collecte initiale shadow.

## 4. Arrêt et rollback

- D’abord bloquer les écritures externes et les nouvelles propositions selon le kill switch validé ; conserver reçus, emails, audits et cutover.
- Ne jamais effacer la frontière, réinitialiser le curseur Gmail ou rejouer les créations incertaines.
- Restaurer le code/déploiement connu sans retirer aveuglément les tables additives ni détruire les données collectées. Tester cette procédure sur base isolée avant production.

## Preuves nécessaires pour clôturer SAV-19

Rapport terrain horodaté : couverture des nouveaux emails, incidents/résolutions, version exacte du code/prompt/knowledge, cas revus, replay agent réel autorisé, test kill switch/rollback, test manuel CRM validé et décisions explicites Ugo. Aucun de ces points n’est présumé acquis par les fixtures ou les 326 tests locaux.
