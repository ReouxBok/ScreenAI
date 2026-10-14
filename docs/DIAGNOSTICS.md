# Diagnostic et logs support

Le bouton **Vérifier Charly** contrôle le runtime de l’extension, le stockage de session, le consentement, la session Limova, le flag du workspace, l’agent principal `charly`, le content script et l’état du microphone. Il ne lance pas de tour IA et ne contacte aucun proxy historique.

Le journal local est borné à 1 000 événements dans `chrome.storage.session`. La redaction retire tokens, cookies, clés, emails, téléphones, query strings, valeurs de formulaire, texte des conversations, audio et contenu des pages.

Pour un incident, relever l’identifiant `Incident`, le premier check en erreur et les événements partageant le même `op`. Les familles principales sont `DIAGNOSTIC_*`, `DEEP_AGENT_*`, `LIVE_*`, `BROWSER_*`, `CONTENT_SCRIPT_*`, `TRAINING_*` et `REAL_EVALUATION_*`.

Les traces LangSmith sont produites côté backend pour les runs Deep Agent de l’extension. Le journal Chrome sert au transport et aux permissions locales ; il ne remplace pas ces traces serveur.
