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

## Sécurité et confidentialité

- Consentement IA affirmatif et distinct.
- Permissions et hôtes limités au fonctionnement déclaré ; aucune permission supplémentaire ajoutée en 2.2.44.
- CSP sans script inline, `unsafe-eval` ou code distant.
- Clés Gemini uniquement sur le proxy.
- Payloads JSON bornés, rate limiting, idempotence et identifiants de requête.
- Logs serveur limités aux IDs de run, révisions, outils, statuts, latences, tokens et codes techniques.
- Rollback ADK immédiat côté serveur sans mise à jour Chrome.

Voir `docs/PRIVACY.md`, `docs/ADK_ROLLOUT.md` et `docs/RELEASE.md`.
