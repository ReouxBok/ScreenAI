# Architecture — Limova AI (Charly)

> **Glossaire SAV (noms d’interface)** : « Agent de tri » (anciennement « V1 ») et « Agent SAV » (anciennement « V2 »). Les noms de code, fichiers, URL (`/studio/sav/v2`), variables `SAV_V2_*`, valeurs en base et outils MCP gardent les anciens noms "v1"/"v2".

Charly est une extension Manifest V3 composée d’un panneau latéral, d’un service worker et de deux scripts de contenu limités à `https://new.limova.ai/*`.

```text
Page Limova ── DOM filtré / action ID ──► service worker ── session OTP ──► proxy
     ▲                                      │                               │
     └──── observation / clic validé ───────┘                               ├─ Google ADK / Gemini 3.6 Flash
                                                                            ├─ mémoire chiffrée Neon
                                                                            └─ session GPT Live authentifiée
Sidebar ── consentement / chat / micro ──► service worker
Sidebar ── audio WebRTC + événements ──────────────────────────────────────► GPT Live
```

## Analyse de page

`background.js` injecte un extracteur DOM via `chrome.scripting`. Il attribue des identifiants numériques éphémères aux contrôles visibles et produit une carte textuelle. L’URL est réduite à `origin + pathname`. Les champs exposent uniquement `filled: true/false`; les champs sensibles sont marqués sans valeur. Les logs sont expurgés. Les métriques réseau viennent de `PerformanceResourceTiming` : aucun corps, header ou paramètre d’URL n’est lu, sans permission `webRequest`.

Après une cible introuvable, ambiguë ou un résultat inattendu, le service worker peut appeler `captureVisibleTab` une seule fois. Les champs sont masqués et les repères sont dessinés dans `OffscreenCanvas`, sans overlay injecté, flash ou notification. La capture est envoyée à Gemini pour l’invocation courante puis supprimée ; elle n’entre ni dans Neon, ni dans `chrome.storage`, ni dans les événements ADK ou les logs.

## Authentification et IA

Le membre s’authentifie auprès de Charly par OTP Resend. Le proxy vérifie que le compte existe toujours dans Limova et dérive un identifiant mémoire pseudonyme ; l’email brut n’est pas enregistré dans Neon. Le modèle texte est fixé côté serveur à `gemini-3.6-flash` et ne peut pas être remplacé par le client.

Le texte utilise un `Runner` Google ADK avec `CharlySessionService`, `CharlyMemoryService`, sept outils typés et un `TokenBasedContextCompactor` à 32 000 tokens conservant 24 événements récents. L’extension ne fournit plus de prompt système au protocole v2. Le déploiement est commandé par `ADK_TEXT_MODE=off|shadow|canary|on` et `ADK_CANARY_PERCENT`; `/api/gemini` reste le fallback pendant la transition.

Pour la voix, le proxy crée une session `gpt-live-1` via `/api/live-session`, en WebRTC, avec la voix `marin`. Le backend délégué `gpt-6-luna` utilise les outils gardés du service worker. L’onglet est lié à la fenêtre du panneau avant l’autorisation du micro. La carte DOM complète est conservée et les grands résultats sont découpés en messages WebRTC ordonnés. Le texte et la voix utilisent le même `sessionId` et la même mémoire. Les anciens clients Gemini conservent `/api/live-token`. Le proxy doit être déployé avant l’extension : la réponse GPT annonce le protocole `gpt_live_webrtc_v1`, exigé par le nouveau client pour éviter un contrat d’outils incompatible.

## Actions contrôlées

ADK appelle `inspect_current_page`, `capture_current_view`, `click_element`, `fill_field`, `navigate_internal`, `verify_expected_result` ou `search_knowledge_base`. Les outils Chrome suspendent le run, sont exécutés localement, puis le résultat reprend le run. Le service worker vérifie les identifiants et classe le risque à partir des métadonnées locales. « Envoyer le message » exige une demande explicite et la cible exacte. Aucun clic par coordonnées, sélecteur distant, script ou URL arbitraire n’est accepté. L’ancien marqueur `{{ACTION:id}}` reste uniquement dans le fallback de transition.

Le membre choisit un niveau persistant : « Demander une approbation » demande avant les modifications et commandes ; « Approuver pour moi » (par défaut) demande pour les actions risquées ; « Accès complet » exécute les actions couvertes par la demande et demande rarement avant d’agir. Une création ou modification demandée inclut son enregistrement normal. Une action nécessitant un accord attend une confirmation dans le panneau ou à la voix ; le résultat réel reprend ensuite le run. La confirmation expire après cinq minutes et relit la page avant exécution ; une navigation, une nouvelle consigne ou un arrêt annule l’action en attente. Une cible ambiguë exige une clarification et une consigne explicite de ne pas enregistrer reste respectée.

## Sessions, mémoire et onboarding

Chaque conversation visible possède un `sessionId` distant. « Nouveau chat » ferme cette session sans supprimer la mémoire et ouvre une session vide qui reçoit une capsule privée de continuité : dernière décision, objectif pertinent et quatre échanges utiles. Les événements persistants ne contiennent que messages, réponses finales, résumés et statut technique d’action.

Le schéma privé `charly_memory` stocke les profils, sessions, messages, résumés, souvenirs, objectifs et métadonnées de runs chiffrés. Les captures, DOM, contenus réseau, valeurs de champs et arguments sensibles ne sont jamais persistés. L’état d’onboarding conserve sa révision et son étape ; les preuves de complétion restent validées localement avec l’URL et le DOM.

## Statistiques d’utilisation

`src/utils/analytics.js` met en file les événements d’usage du service worker (persistés dans `chrome.storage.session`, envoyés par lots au proxy sur `/api/events`). Le proxy (`proxy/analytics.js`) applique une liste blanche, rattache le compte OTP vérifié (`$identify` de l’identifiant d’installation) et transmet à PostHog UE. Il émet aussi des événements serveur (`server_*`) sur les routes copilote, voix, connaissances et OTP. `chrome.runtime.setUninstallURL` pointe vers `/api/uninstalled`. L’opt-out du menu coupe les deux sources. Détails : `docs/PRIVACY.md`.

## Limova Team dans Chrome (TEAM-724)

L’extension est aussi un « appareil navigateur » de Limova Team : l’agent de Limova Team, qui tourne dans le cloud, peut lire et agir dans le Chrome de la personne qui lui écrit. Le contrat est `docs/browser-device-protocol.md` du dépôt team-backend ; le résumé est dans `docs/LIMOVA_TEAM.md`. Tout le code vit dans `src/team/` ; `background.js` ne fait que créer le service et lui transmettre les messages `TEAM_*`.

```text
Panneau « Connexions » ── TEAM_* ──► team-service.js ── une connexion par produit
                                       ├─ vault.js (clé par socket), login-offers.js, session-export.js
                                       │
             connections.js (jeton lmd_, autonomie, pause) ── chrome.storage.local
             device-socket.js ── wss://api.team.limova.ai/api/v1/devices/me/socket
                                       │ call / set_autonomy / browser_control
             team-controller.js (autonomie, approbations, prise de main, Tout arrêter)
                                       │
             browser-engine.js (groupe d’onglets « Limova Team ») ── chrome.scripting
                                       │
             page-snapshot.js / page-actions.js (monde isolé de l’onglet)
```

- **Un moteur, une connexion par produit.** `products.js` fixe la liste des produits et de leurs origines (production, préproduction) ; aucune URL arbitraire n’est acceptée. Chaque produit a son jeton, son identifiant d’appareil, son groupe d’onglets et sa couleur. « Limova » s’ajoutera comme second produit sans voir les onglets de Limova Team.
- **Appairage PKCE** (`pairing.js`, `pair-callback.html`) : vérificateur et `state` dans `chrome.storage.session`, onglet normal sur le tableau de bord, retour sur une page de l’extension accessible seulement depuis les deux origines du tableau de bord, échange du code contre le jeton par le service worker.
- **Socket** : le jeton voyage comme second sous-protocole WebSocket, jamais dans l’URL. Ping toutes les 25 s, reconnexion exponentielle (1 s → 60 s), alarme `chrome.alarms` chaque minute après un redémarrage du service worker, résultats en cache 10 minutes par `call_id`.
- **Carte de page dans le monde isolé.** `chrome.scripting.executeScript` injecte des fonctions autonomes ; la carte `e1…` et ses éléments restent dans le monde isolé de l’extension, jamais en attributs dans la page. Un identifiant n’est valable qu’avec son `snapshot_id`, et l’élément vivant doit toujours porter le nom annoncé (`target`), sinon `stale_snapshot`.
- **Risque** (`risk.js`) : l’extension relit le risque sur l’élément vivant et garde la lecture la plus stricte entre celle du serveur et la sienne. LinkedIn, `lnkd.in`, le tableau de bord et l’API de Limova Team sont refusés (`blocked_site`) ; un champ sensible n’est jamais rempli (`sensitive_field`).
- **`browser.v2` (TEAM-726) : plus de fenêtre d’accord, sauf pour payer.** Les actions s’exécutent quel que soit le niveau d’autonomie ; les confirmations voulues par la personne se font dans le chat, décidées par le serveur à partir de ce niveau. Seul un paiement (`pay`, lu par le serveur ou par l’extension) ouvre la petite fenêtre Chrome (`approval.html`, qui ne reçoit qu’un identifiant opaque dans son URL). `set_autonomy` s’applique tout de suite, sans fenêtre ; une nouvelle connexion démarre en « Accès complet ». « Prendre la main », « Rendre la main » et « Tout arrêter » sont dans le panneau ; le badge affiche « IA » pendant une action et « ⏸ » pendant une prise de main.
- **Moins d’étapes** : `include_page: true` sur les actions renvoie la carte de page (`data.page`, même contenu que `read_page`) une fois la page stabilisée, et `browser.batch` enchaîne jusqu’à 20 saisies, choix, cases et clics sur un même instantané, vérifiés avant le premier. Les attentes suivent les événements de l’onglet et le calme du DOM plutôt que des délais fixes (plafond de 20 s pour une navigation).
- **Accueil** : le panneau demande d’abord « Limova » (Charly, inchangé) ou « Limova Team » (un bouton « Se connecter »). Les versions publiques ne parlent qu’à la production ; une version de test pour la préproduction se construit avec `LIMOVA_TEAM_ENV=staging npm run build`, et le réglage développeur `limova_team_developer_v1` affiche le choix d’environnement.
- **Connexions enregistrées (TEAM-729)** : chaque connexion WebSocket crée sa clé ECDH P-256 non exportable (`vault.js`), annonce `browser.v1+vault` et `browser.v1+cookies` et envoie sa clé publique dans le `hello`. `browser.fill_secret` ouvre le scellé du serveur, vérifie l’origine réelle de l’onglet, les champs et la destination du formulaire, tape la connexion puis l’oublie (`browser-engine.js`, `fillSecretInPage` dans `page-actions.js`) ; c’est le seul chemin qui tape dans un champ sensible. `login-offers.js` et `page-login-watch.js` repèrent une connexion réussie et la proposent à l’enregistrement dans `save-login.html` (identifiant opaque dans l’URL) ; `session-export.js` envoie les cookies d’un site après consentement (permission `cookies`). Détails : `docs/LIMOVA_TEAM.md`.
- **« Montrer à Limova » (TEAM-731)** : la personne enregistre une tâche, dans l’onglet courant (qui rejoint le groupe « Limova Team », son clic valant accord) ou dans un nouvel onglet du groupe. `page-recorder.js`, injecté dans le monde isolé, n’ajoute que des écouteurs en phase de capture et ignore les événements que la page déclenche elle-même ; il transforme les gestes en étapes sémantiques (clic, une saisie par champ à la sortie du champ, choix, case, touches pressées pour leur effet, noms de fichiers, téléchargement), dans chaque cadre de l’onglet depuis TEAM-751, décrites comme une personne les retrouve (rôle, nom accessible, libellé, placeholder, titre voisin, indices stables, rang), jamais par sélecteur, XPath ou coordonnées. `recorder.js` ajoute les navigations et leur cause (`chrome.webNavigation`), numérote les onglets 1, 2…, masque les secrets à la capture (`recording-redaction.js`), garde tout en mémoire, puis à « Arrêter » affiche la liste des étapes. « Envoyer à Limova » envoie une seule fois un `limova.recording.v1` (`recording-format.js`, ≤ 300 étapes, ≤ 2 h, ≤ 512 Ko) à `POST /api/v1/devices/me/recordings` et ouvre « Former Limova ». Pendant l’enregistrement, le groupe s’appelle « Limova Team · Limova regarde », le badge affiche « REC » et les appels de l’agent attendent comme pendant une prise de main. `browser.read_page` ajoute les mêmes champs descriptifs à ses éléments (`browser.record.v1`).
- **Touches, fichiers et cadres (TEAM-751)** : `browser.press_key` envoie la touche à la page puis, si elle ne l’a pas annulée, reproduit l’effet du navigateur (un événement créé par un script n’en a pas) ; `browser.upload` place des pièces jointes du chat (5 Mio au plus) dans un champ de fichier par `DataTransfer`, ou les dépose sur une zone de dépôt, et oublie les octets ; `read_page` lit les cadres visibles (`frame-tree.js`, identifiants `fr1.e3` propres à chaque lecture), chaque cadre gardant sa carte dans son monde isolé, et une action part vers le document exact du cadre. Les fonctionnalités annoncées par le serveur dans `ready.features` décident de « Montrer à Limova » et de la proposition d’enregistrer une connexion. Détails : `docs/LIMOVA_TEAM.md`.
- **Captures** : onglet mis au premier plan, `captureVisibleTab`, champs masqués et repères `#eN` dessinés par `renderSilentVisualCapture` (partagé avec Charly) dans un `OffscreenCanvas`, au plus 1,5 Mo, jamais stockés.

## Sécurité et confidentialité

- Consentement IA affirmatif et distinct.
- Permissions et hôtes limités au fonctionnement déclaré ; aucune permission supplémentaire ajoutée en 2.2.44. TEAM-724 ajoute `tabGroups` (le groupe d’onglets de Limova Team) et `alarms` (reconnexion après un redémarrage du service worker), et Chrome 116 au minimum ; aucun hôte nouveau. TEAM-729 ajoute `cookies`, utilisé seulement par « Envoyer ma session à Limova », site par site, après consentement, jamais par Charly. TEAM-731 n’ajoute aucune permission : l’enregistreur utilise `scripting`, `webNavigation` et `tabGroups`, déjà déclarées. TEAM-751 n’en ajoute pas non plus : les cadres sont lus avec `scripting` et `webNavigation` sous l’accès existant à tous les sites, et les fichiers déposés viennent du serveur, jamais du disque.
- CSP sans script inline, `unsafe-eval` ou code distant.
- Clés Gemini uniquement sur le proxy.
- Payloads JSON bornés, rate limiting, idempotence et identifiants de requête.
- Logs serveur limités aux IDs de run, révisions, outils, statuts, latences, tokens et codes techniques.
- Rollback ADK immédiat côté serveur sans mise à jour Chrome.

Voir `docs/PRIVACY.md`, `docs/ADK_ROLLOUT.md` et `docs/RELEASE.md`.
