# SAV IA — configuration et mise en production

## Garanties produit

- Tous les emails entrants sont enregistrés avant traitement.
- Chaque email possède une décision actuelle et un historique de corrections.
- Toute réponse IA commence par l’identité de Charly et propose une réponse humaine sous trois jours.
- Une demande humaine suspend l’automatisation du fil.
- Les contenus clients et transcripts HubSpot sont chiffrés avec `SAV_ENCRYPTION_KEY_V1`.
- Les membres ne peuvent accéder ni aux pages ni aux Server Actions du SAV.
- Une résolution humaine crée une proposition de fiche ; elle ne modifie jamais silencieusement la base active.

## 1. Base de données

Appliquer les migrations après avoir vérifié que `DATABASE_URL` pointe vers la base du Studio :

```bash
npm run db:migrate
```

Les tables sont créées dans le schéma PostgreSQL `sav`. Utiliser une clé dédiée d’au moins 32 caractères :

```dotenv
SAV_ENCRYPTION_KEY_V1=<secret dédié>
SAV_AUTOMATION_MODE=shadow
SAV_WRITES_DISABLED=false
SAV_PILOT_MODE=false
SAV_AI_ANALYSIS=true
SAV_ADK_MODE=shadow
SAV_GEMINI_API_KEY=<clé Gemini utilisée par le SAV>
SAV_AI_MODEL=gemini-3.6-flash
SAV_HUBSPOT_BACKFILL_ENABLED=true
SAV_AUTO_REPLY_MIN_CONFIDENCE=920
SAV_AUTO_REPLY_CATEGORIES=technical,how_to
SAV_AUTO_REPLY_ROLLOUT_PERCENT=0
SAV_AUTO_REPLY_DAILY_LIMIT=10
SAV_TEST_MODE=false
SAV_TEST_OUTBOUND_ALLOWLIST=
SAV_RETENTION_ENABLED=false
SAV_RETENTION_DAYS=365
```

Ne jamais réutiliser `MEMORY_ENCRYPTION_KEY_V1`.

`SAV_GEMINI_API_KEY` reste une variable séparée pour pouvoir faire une rotation indépendante plus tard. Pendant le pilote, sa valeur peut être identique à celle de l’extension ; les prompts, outils, traces et mémoires restent isolés par le code.

En environnement de recette, définir impérativement `SAV_TEST_MODE=true` et une liste telle que `SAV_TEST_OUTBOUND_ALLOWLIST=reouven@limova.ai,ugo@limova.ai`. Sans allowlist, tous les envois sont refusés par le backend.

## Pilote supervisé sur de vrais mails

Définir `SAV_PILOT_MODE=true` pour mettre les nouveaux mails en attente et les traiter par lots de 10 depuis le laboratoire SAV. Un seul lot peut être ouvert à la fois.

Le pilote est une **simulation stricte** : il lit les messages, consulte les fiches et les tickets, puis enregistre localement ses décisions, brouillons et actions proposées. Aucun email n’est envoyé et aucun ticket, contact, statut ou note n’est écrit dans HubSpot. Les workers excluent les actions portant un identifiant de lot pilote ; le contrôle commun d’écriture les refuse également.

Le clic « Analyser les 10 prochains mails » lance un workflow durable, avec trois analyses simultanées. Le cron `/api/cron/sav-reconcile` reprend les éléments en attente si nécessaire. Chaque mail doit recevoir un verdict humain (`correct`, `partial`, `incorrect` ou `critical`) avant de clôturer le lot. Un lot peut être annulé sans supprimer ses preuves.

Les corrections restent des propositions : elles ne deviennent pas des connaissances actives sans validation et publication. La prise en charge des corrections sans ticket est suivie dans `SAV_IMPLEMENTATION.md`.

## 2. Gmail et Pub/Sub

Dans Google Cloud :

1. Activer Gmail API et Pub/Sub API.
2. Créer un topic, par exemple `projects/PROJECT_ID/topics/limova-sav-gmail`.
3. Autoriser `gmail-api-push@system.gserviceaccount.com` à publier sur ce topic.
4. Créer une souscription push vers :

   `https://studio.limova.ai/api/webhooks/gmail?token=GMAIL_WEBHOOK_TOKEN`

5. Activer l’authentification OIDC de la souscription avec un compte de service dédié et l’audience exacte du webhook.
6. Autoriser ce compte de service à invoquer l’application.
7. Connecter la boîte SAV par OAuth avec accès hors ligne et les droits Gmail lecture/envoi.

Variables :

```dotenv
GMAIL_SUPPORT_ADDRESS=
GMAIL_INTAKE_RECIPIENTS=contact@limova.ai
GMAIL_REPLY_FROM_ADDRESS=contact@limova.ai
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_PUBSUB_TOPIC=projects/PROJECT_ID/topics/limova-sav-gmail
GMAIL_WEBHOOK_TOKEN=
GMAIL_PUBSUB_AUDIENCE=https://studio.limova.ai/api/webhooks/gmail
GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL=
```

`GMAIL_SUPPORT_ADDRESS` est le compte Google réellement autorisé par OAuth. `GMAIL_INTAKE_RECIPIENTS` limite strictement l’ingestion aux destinataires SAV, notamment lorsqu’une adresse de groupe est transférée vers ce compte. `GMAIL_REPLY_FROM_ADDRESS` doit être une adresse « Envoyer des e-mails en tant que » déjà validée dans Gmail. Une boîte personnelle ne doit jamais être connectée sans ce filtre.

Le cron `/api/cron/gmail-watch-renew` renouvelle le `users.watch` chaque jour. Le webhook stocke la notification avant d’accuser réception ; `/api/cron/sav-reconcile` reprend les événements interrompus. Une erreur Gmail `404` sur `history.list` déclenche une resynchronisation bornée de l’Inbox.

## 3. HubSpot

Créer ou utiliser une application HubSpot disposant des droits nécessaires pour :

- lire et écrire les tickets ;
- lire et écrire les contacts ;
- lire et journaliser les emails CRM ;
- lire les pipelines ;
- recevoir les événements ticket et conversation.

La lecture des échanges historiques exige explicitement `crm.objects.emails.read`. Si cette permission manque, le Studio affiche « Autorisation HubSpot requise », conserve le curseur et reteste toutes les trente minutes sans interrompre Gmail ni les batches.

Configurer les abonnements webhook utiles :

- création de ticket ;
- changement de `hs_pipeline_stage` ;
- changement d’association ;
- nouveau message de conversation.

URL : `https://studio.limova.ai/api/webhooks/hubspot`

Variables :

```dotenv
HUBSPOT_ACCESS_TOKEN=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_WEBHOOK_PUBLIC_URL=https://studio.limova.ai/api/webhooks/hubspot
HUBSPOT_PORTAL_ID=143641967
HUBSPOT_TICKET_PIPELINE_ID=
HUBSPOT_NEW_TICKET_STAGE_ID=
HUBSPOT_AWAITING_CUSTOMER_STAGE_ID=
HUBSPOT_HUMAN_STAGE_ID=
HUBSPOT_SAV_OWNER_ID=
```

Les identifiants doivent être les IDs internes du pipeline, des étapes et du propriétaire. Le webhook refuse les signatures v3 invalides ou âgées de plus de cinq minutes.

## 4. Analyse historique

Le cron `/api/cron/sav-reconcile` analyse automatiquement une page bornée de 10 tickets par passage. Ouvrir `/studio/sav/resolutions` avec un compte admin ou owner pour suivre le curseur ou déclencher manuellement l’analyse de 25 tickets. Le curseur est persisté ; l’opération reprend sans retraiter inutilement les pages précédentes. Définir `SAV_HUBSPOT_BACKFILL_ENABLED=false` pour suspendre uniquement cet apprentissage sans interrompre le traitement des mails.

Pour chaque ticket :

1. le transcript est chiffré ;
2. le statut et les emails associés sont analysés ;
3. tout ticket fermé avec une résolution exploitable produit un candidat, qu’elle soit humaine ou issue de Charly ;
4. l’admin peut créer une fiche en brouillon ;
5. la fiche suit ensuite le workflow normal de validation et de publication du Studio.

## 5. Modes de fonctionnement

| Mode | Lecture | Tickets | Emails | Usage |
|---|---|---|---|---|
| `shadow` | oui | aucun | aucun | recette initiale |
| `assist` | oui | seulement après action admin | seulement après validation admin | exploitation supervisée |
| `semi` | oui | cas éligibles | confirmations humaines et réponses approuvées | montée en charge |
| `on` | oui | cas éligibles | réponses fondées et confiance suffisante | autonomie contrôlée |

`SAV_WRITES_DISABLED=true` bloque les écritures, indépendamment du mode. Les lectures et la conservation des événements continuent. `SAV_AI_ANALYSIS=false` désactive l’analyse par modèle et la recherche par embeddings dans les deux parcours d’analyse ; les règles locales continuent de qualifier les messages.

La purge de rétention est désactivée par défaut. Avec `SAV_RETENTION_ENABLED=true`, le worker supprime les dossiers terminés (`resolved` ou `closed_no_action`) au-delà de `SAV_RETENTION_DAYS` et les reçus de webhook déjà traités après 90 jours. Les dossiers ouverts ou confiés à un humain ne sont jamais sélectionnés. Le minimum configurable est 30 jours.

Les workers revérifient l’état courant avant les mutations. Une réponse liée à un ancien message ou à un fil suspendu est refusée, y compris si elle avait été approuvée avant le changement. Les brouillons et envois en attente sont invalidés à l’arrivée d’un mail ou lors d’une reprise humaine. Un accusé de transfert est distinct d’une réponse de résolution.

Le replay déterministe versionné s’exécute avec `npm run sav:replay`. Il sépare développement et contrôle et renvoie un code non nul en cas de régression. `npm run sav:replay:agent` exécute le harness ADK complet avec une clé Gemini SAV et des fiches synthétiques injectées. Ce second replay utilise les vrais budgets, schémas et validateurs sans lire ni écrire Gmail ou HubSpot.

Changer de mode uniquement après avoir vérifié les indicateurs du dashboard. Le retour à `shadow` est le kill switch global.

## 6. Recette avant activation

- Un email normal apparaît une seule fois et reçoit une justification.
- Un doublon Pub/Sub ne crée ni message ni ticket supplémentaire.
- Un bounce, spam ou message automatique reste visible sans ticket.
- Une demande « parler à un humain » suspend immédiatement l’IA et affiche l’échéance à trois jours.
- Une réponse IA contient les deux choix IA/humain.
- Un mail sensible ou une tentative de prompt injection exige un humain.
- Une réponse approuvée est envoyée une seule fois et journalisée dans HubSpot.
- Les relances J+2, J+5 et J+10 s’arrêtent dès qu’un nouveau mail arrive.
- Un ticket fermé avec correction humaine crée un candidat de résolution.
- Un compte `member` est redirigé hors de `/studio/sav` et ne peut appeler aucune action SAV.

## 7. Rollout

1. Garder `shadow` pendant au moins un échantillon représentatif.
2. Vérifier 100 % de couverture, aucune décision sans justification et aucun doublon.
3. Passer à `assist` et contrôler les brouillons et associations HubSpot.
4. Passer à `semi` uniquement pour les transferts et cas explicitement approuvés.
5. Passer à `on` avec un seuil initial de 920/1000 et augmenter progressivement `SAV_AUTO_REPLY_ROLLOUT_PERCENT` depuis 0, sous le plafond `SAV_AUTO_REPLY_DAILY_LIMIT`.
6. Revenir immédiatement à `shadow` en cas de mauvaise action sensible, doublon ou baisse anormale de qualité.

## 8. Boucle d’amélioration continue

Le système ne modifie jamais seul son prompt à partir d’un retour isolé. L’amélioration suit une chaîne vérifiable :

1. chaque mail reçoit une trace de modèle, runtime, version de prompt, sources et outils ;
2. l’admin attribue un verdict et des codes de défaut, avec une correction facultative ;
3. le dashboard agrège les défauts et la conformité par version ;
4. une correction exploitable devient un candidat de résolution, jamais une connaissance active directement ;
5. après double contrôle éditorial, publication et activation IA, la fiche peut étayer les réponses suivantes ;
6. chaque paire exacte version de prompt/modèle doit obtenir au moins 30 revues propres à ≥ 90 %, sans critique ni repli, et le pilote global doit atteindre 100 revues sans action en échec avant toute autonomie.

Optimisations suivantes, dans l’ordre :

- transformer les 100 revues du pilote en jeu de replay chiffré et anonymisé ;
- exécuter le replay ADK contre chaque nouveau prompt ou modèle avec un budget contrôlé et bloquer toute régression ;
- tester un challenger en `shadow` sur les mêmes mails avant promotion ;
- mesurer la dérive par catégorie et par semaine, avec retour automatique en `shadow` au-delà d’un seuil ;
- échantillonner continuellement des réponses « faciles » pour détecter les faux positifs invisibles.
