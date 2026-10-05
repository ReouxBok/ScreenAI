# SAV-4 — Frontière de traitement sans historique

## Activation explicite après déploiement approuvé

La frontière est une ligne immuable `sav.sync_state`, clé `sav-v0-cutover`, avec commit déployé, timestamp READY, boîte OAuth existante, destinataire contact@limova.ai et approbateur Ugo. Aucun cron ne la crée. Pas de migration de données historiques ni de remise à zéro du curseur Gmail.

Après validation du déploiement par Ugo, vérifier l'identité OAuth/filtre Gmail, puis exécuter sur l'environnement approuvé :

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/activate-sav-v0.ts \
  --confirm-ugo-approved-cutover \
  --deployment-sha=<SHA_REAL_DEPLOYE> \
  --deployed-at=<TIMESTAMP_READY_UTC_ISO> \
  --mailbox-email=<BOITE_OAUTH_EXISTANTE_VERIFIEE>
```

Cette commande est une écriture production : **ne pas l'exécuter sans validation Ugo**. Les paramètres doivent correspondre au déploiement réellement READY ; ne pas utiliser le vieux commit audité ni une date choisie arbitrairement. Le flag est une confirmation opérateur, pas un remplacement de l'autorisation administrative. Relancer avec exactement les mêmes paramètres est idempotent ; toute modification de frontière échoue.

## Comportement

- Sans activation : ingestion existante conservée, aucune nouvelle proposition V0 ; analyses/revues candidates/pilotes/workers externes échouent fermés sur l'éligibilité. Si un historyId doit être reconstruit avant activation, le reçu est conservé pour reprise, pas de scan historique.
- Critère : message entrant de la boîte vérifiée avec `receivedAt > receivedAfter`. Un email ancien synchronisé tard ne devient pas éligible ; l'heure de sync ne sert jamais de frontière.
- Le cron normal, analyse directe/retry, sélection pilote et le writer appliquent le même filtre. Aucun `processedAt` n'est artificiellement attribué aux anciens messages.
- Les données préexistantes sont conservées ; l'inbox V0 montre uniquement les messages éligibles. Leur historique peut être lu comme contexte d'un nouveau message du même dossier.
- Un ancien message retardé ne met pas le dossier en reprise humaine et n'invalide pas le brouillon courant.
- Le redéploiement, le renouvellement du watch ou une variable modifiée ne réinitialisent pas la frontière.
- InternalDate Gmail absent/invalide = quarantaine ; pas de repli sur Date.now qui transformerait l'ancien email en nouveau.

## History API expirée / reprise

Un 404 déclenche une récupération limitée à la fenêtre **post-cutover**, toutes étiquettes (y compris emails archivés), une page de 100 par passage. La fenêtre haute et le pageToken sont persistés dans `sav.sync_state` sous `gmail-v0-recovery:<mailboxId>`. Le reçu reste pending sans erreur tant qu'il reste des pages ; le historyId ne bouge qu'à la fin du scan complet.

La déduplication des Gmail IDs prévient le retraitement. Un token de page expiré redémarre la même fenêtre, sans élargir la frontière basse. Une défaillance d'ingestion ne valide pas la page ni le curseur. Aucun plafond silencieux de 500 messages en V0. Les messages supprimés définitivement chez Gmail ne sont évidemment plus récupérables.

## Tests

PGlite avec migrations réelles : activation auditée une fois/immuable, absence de frontière, strictement avant/à/après, arrivée historique tardive, isolation boîte, analyse retry idempotente, pageToken persistant et cursor Gmail validé seulement à la fin. Aucun appel de production.
