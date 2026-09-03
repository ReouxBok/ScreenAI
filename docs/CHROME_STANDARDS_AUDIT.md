# Audit des standards d’extension Chrome

Audit mis à jour le 4 août 2026 à partir de la documentation officielle Chrome.

## Références et état du projet

| Standard | Application dans Limova | Vérification automatisée |
|---|---|---|
| [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3) et code exécutable embarqué | Service worker MV3, aucun script distant, CSP stricte | Validation du manifest, CSP et ressources du ZIP |
| [Politiques Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/policies) | Finalité unique d’assistance Limova, consentement IA à l’usage, données minimisées | E2E consentement accepté/refusé et absence d’appel IA après refus |
| [Permissions minimales](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) | `sidePanel`, `storage`, `scripting`, `webNavigation`; deux hôtes seulement; pas de permission `tabs` | E2E manifest + liste blanche bloquante dans le validateur de paquet |
| [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Fichier présent dans l’archive, Chrome minimum 114 | Chargement de l’extension empaquetée et contrôle du chemin réel |
| [Cycle de vie du service worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) | État utile persisté dans `chrome.storage`, reprise de session | Tests d’intégration du service worker et E2E persistance/reset |
| [Confidentialité utilisateur](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy) | HTTPS, valeurs de formulaire exclues, URL sans query/fragment, journaux locaux | E2E anti-fuite avec secrets sentinelles + tests unitaires de redaction |
| [Messagerie](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) | Identité de l’extension, origine exacte et types de messages autorisés vérifiés | Tests positifs/négatifs du routeur + E2E content script |
| [Sécurité des extensions](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure) | CSP, aucun `eval`, contenu IA rendu sans HTML exécutable, confirmation des actions sensibles | E2E XSS, confirmation/annulation et navigation interne faible risque |
| [Accessibilité](https://developer.chrome.com/docs/extensions/how-to/ui/a11y) | Noms accessibles, navigation clavier, focus visible | E2E clavier et assertions de noms accessibles |
| [Tests de bout en bout](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing) | Le ZIP réel est chargé dans Chromium; les assertions portent sur l’UI et la page Limova | Playwright, avec simulation uniquement des frontières API externes |

## Matrice des parcours E2E

Les tests Playwright chargent `build/` comme une vraie extension Chrome Manifest V3. La page Limova de test est une vraie page HTTPS interceptée, les content scripts s’y injectent réellement, et les messages passent réellement par le service worker. Seules l’API Limova, le proxy et le WebSocket Gemini sont simulés afin de rendre le test déterministe.

| Fonction utilisateur | Scénario couvert |
|---|---|
| Installation et panneau latéral | Manifest, ID stable, service worker, fichier side panel, icônes, CSP |
| Chat texte | UI → DOM Limova → authentification → proxy → réponse affichée |
| Confidentialité | secret de formulaire et query string absents du payload; refus de consentement sans réseau |
| Authentification | session absente et renouvellement après `401` |
| Analyse de page | contexte DOM, indication visuelle et réponse affichée |
| Actions | confirmation et annulation d’une action sensible; navigation interne faible risque explicite |
| Sécurité du rendu | HTML/XSS et liens `javascript:` neutralisés |
| Navigation dynamique | changement SPA et apparition d’une modale détectés |
| Voix | permission média Chromium, jeton Live contraint, WebSocket, transcription, arrêt audio |
| Permission micro initiale | ouverture de l’onglet d’autorisation avant tout appel réseau |
| Onboarding | langue, état, étape suivante, reset et téléchargement des journaux |
| Verrouillage d’onglet | avertissement sur un autre onglet et retour vers la session Limova |
| Accessibilité et consentement | clavier, focus, noms accessibles, acceptation/refus persistant |
| Diagnostic et récupération | logs sans contenu sensible, persistance MV3, health check, codes stables, réparation content script et reconnexion voix |

## Contrôles restant nécessairement manuels

- Tester une fois l’archive finale dans Chrome Stable avec un vrai compte Limova et un vrai microphone. Les E2E vérifient toute la plomberie vocale, mais Google Live et le matériel réel restent des systèmes externes.
- Aligner les déclarations « Data usage » de la fiche Chrome Web Store et la politique publique sur `docs/PRIVACY.md`.
- Vérifier les captures, textes et liens de la fiche avant chaque soumission. Ces éléments vivent dans la console Chrome Web Store, pas dans le dépôt.
