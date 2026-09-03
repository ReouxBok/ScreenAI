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
SAV_PILOT_MODE=false
SAV_AI_ANALYSIS=true
SAV_ADK_MODE=shadow
SAV_GEMINI_API_KEY=<clé Gemini utilisée par le SAV>
SAV_AI_MODEL=gemini-3.6-flash
SAV_HUBSPOT_BACKFILL_ENABLED=true
SAV_AUTO_REPLY_MIN_CONFIDENCE=920
SAV_TEST_MODE=false
SAV_TEST_OUTBOUND_ALLOWLIST=
```

Ne jamais réutiliser `MEMORY_ENCRYPTION_KEY_V1`.

`SAV_GEMINI_API_KEY` reste une variable séparée pour pouvoir faire une rotation indépendante plus tard. Pendant le pilote, sa valeur peut être identique à celle de l’extension ; les prompts, outils, traces et mémoires restent isolés par le code.

En environnement de recette, définir impérativement `SAV_TEST_MODE=true` et une liste telle que `SAV_TEST_OUTBOUND_ALLOWLIST=reouven@limova.ai,ugo@limova.ai`. Sans allowlist, tous les envois sont refusés par le backend.

## Pilote supervisé sur de vrais mails

Définir `SAV_PILOT_MODE=true` pour mettre les nouveaux mails en attente et les traiter par batches stricts de 10 depuis le registre SAV. Un seul batch peut être ouvert à la fois. Le pilote peut qualifier les messages, créer ou rattacher un ticket HubSpot, journaliser le mail, préparer un brouillon et publier une note interne marquée « Analyse pilote IA — à valider ».

Les actions Gmail du pilote sont exclues du worker d’envoi et les mises à jour de statut HubSpot sont exclues de son worker dédié. Une vérification supplémentaire refuse toute étape HubSpot reconnue comme fermée. Chaque mail doit recevoir un verdict humain (`correct`, `partial`, `incorrect` ou `critical`) avant que le batch soit clôturé et que le suivant puisse démarrer.

Le clic « Analyser les 10 prochains mails » démarre immédiatement un workflow durable Vercel. Les analyses sont exécutées par groupes de trois pour réduire la latence sans saturer le modèle, puis les actions HubSpot réversibles sont synchronisées. La page s’actualise automatiquement pendant l’exécution. Le cron `/api/cron/sav-reconcile` reste un filet de sécurité idempotent : il reprend les éléments encore en attente si le lancement immédiat n’a pas pu être créé.

Un batch en cours peut être annulé depuis le Studio sans supprimer ses preuves. Une correction humaine associée à un ticket crée une proposition d’apprentissage séparée ; elle doit être relue par un admin, puis suivre le workflow normal de validation/publication avant d’être utilisable par l’agent.

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
5. Passer à `on` avec un seuil initial de 920/1000.
6. Revenir immédiatement à `shadow` en cas de mauvaise action sensible, doublon ou baisse anormale de qualité.

## 8. Boucle d’amélioration continue

Le système ne modifie jamais seul son prompt à partir d’un retour isolé. L’amélioration suit une chaîne vérifiable :

1. chaque mail reçoit une trace de modèle, runtime, version de prompt, sources et outils ;
2. l’admin attribue un verdict et des codes de défaut, avec une correction facultative ;
3. le dashboard agrège les défauts et la conformité par version ;
4. une correction exploitable devient un candidat de résolution, jamais une connaissance active directement ;
5. après double contrôle éditorial, publication et activation IA, la fiche peut étayer les réponses suivantes ;
6. toute nouvelle version doit obtenir au moins 30 revues propres à ≥ 90 %, sans critique ni repli, et le pilote global doit atteindre 100 revues sans action en échec avant toute autonomie.

Optimisations suivantes, dans l’ordre :

- transformer les 100 revues du pilote en jeu de replay chiffré et anonymisé ;
- exécuter automatiquement ce jeu contre chaque nouveau prompt ou modèle et bloquer toute régression ;
- tester un challenger en `shadow` sur les mêmes mails avant promotion ;
- suivre séparément précision de tri, décision de ticket, rattachement, grounding, ton et calibration de confiance ;
- mesurer la dérive par catégorie et par semaine, avec retour automatique en `shadow` au-delà d’un seuil ;
- échantillonner continuellement des réponses « faciles » pour détecter les faux positifs invisibles.
