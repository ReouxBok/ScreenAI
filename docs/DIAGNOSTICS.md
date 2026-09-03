# Diagnostic et logs support

## Principes

Le journal de diagnostic est local, borné à 1 000 événements et conservé dans `chrome.storage.session`. Il survit aux redémarrages du service worker, mais disparaît lorsque la session Chrome se termine. Aucun log n’est envoyé automatiquement à Limova.

L’export exclut systématiquement :

- le texte des messages utilisateur et des réponses Gemini ;
- le DOM et les valeurs de formulaire ;
- les transcriptions et données audio ;
- les corps de requête et réponses ;
- les headers, cookies, JWT, clés API et jetons ;
- les query strings, emails et numéros de téléphone.

La redaction est récursive et s’applique également aux messages d’erreur, stacks et événements envoyés par le panneau vocal.

## Utilisation par le support

1. Demander à l’utilisateur de cliquer sur **Vérifier Charly**.
2. Lui faire appliquer l’action corrective indiquée, si elle existe.
3. Si le problème persiste, lui demander **Télécharger les logs**.
4. Rechercher d’abord l’identifiant `Incident`, puis le dernier événement `ERROR` et son code stable.
5. Corréler les lignes partageant le même champ `op=`.

Le diagnostic contrôle localement la version, le stockage de session, l’onglet Limova, le content script, le proxy et l’état de permission du microphone. Le contrôle du proxy appelle uniquement `/healthz` et n’envoie aucune donnée utilisateur.

## Principaux codes

| Famille | Exemples |
|---|---|
| Authentification | `AUTH_LIMOVA_TAB_MISSING`, `AUTH_SESSION_MISSING`, `AUTH_NETWORK_FAILED`, `AUTH_TOKEN_INVALID_RESPONSE` |
| Proxy/Gemini | `PROXY_REQUEST_TIMEOUT`, `PROXY_NETWORK_FAILED`, `PROXY_RATE_LIMITED`, `GEMINI_HTTP_5XX` |
| Voix | `MIC_PERMISSION_DENIED`, `VOICE_MIC_UNAVAILABLE`, `LIVE_TOKEN_SERVICE_FAILED`, `LIVE_WS_ERROR`, `LIVE_WS_CLOSED` |
| Page Limova | `CONTENT_SCRIPT_REPAIR_STARTED`, `CONTENT_SCRIPT_REPAIR_SUCCEEDED`, `CONTENT_SCRIPT_REPAIR_FAILED`, `ACTION_CONTEXT_CHANGED` |
| Runtime | `SERVICE_WORKER_STARTED`, `UNHANDLED_REJECTION`, `UNCAUGHT_ERROR`, `SIDEBAR_UNHANDLED_REJECTION` |

## Rétention et limites

Le tampon est circulaire : les plus anciens événements sont supprimés au-delà de 1 000 entrées. Un reset de session efface également le journal. Les logs permettent d’identifier une étape et un code de panne, mais ne doivent pas permettre de reconstruire une conversation utilisateur.
