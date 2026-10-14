# Migration de la recette E2E vers Deep Agent

## Audit du 14 octobre 2026

`npx playwright test --max-failures=8` a terminé avec 42 réussites, 8 échecs et 64 tests non exécutés. L’arrêt à huit échecs sert à borner le diagnostic ; la commande complète et ses seuils CI ne sont pas modifiés. La suite globale n’est pas déclarée verte.

Les échecs observés concernent une attente de manifeste interdisant l’API Limova, puis les anciennes fixtures chat/ADK, évaluation, observation vocale et formation. Ces fixtures ne créent qu’une session OTP du proxy : elles ne connectent pas le compte Limova et peuvent donc être arrêtées par le panneau d’authentification. Chaque parcours restant doit être migré avant de conclure à une régression ou à sa résolution.

## Couverture transférée

| Ancien scénario dans feature-flows | Scénario natif de remplacement |
|---|---|
| Chat via proxy, DOM et confidentialité | `limova-native-chat.spec.js` : panneau → vrai worker → passerelle app → HTTPS/SSE → driver DOM → résultat natif ; valeurs privées et query exclus |
| Markdown assistant | Même fichier : HTML échappé, pas de script ni lien javascript, Markdown sûr conservé |
| Token proxy expiré | Session Limova révoquée : refresh existant refusé, aucun message ni création de chat, feedback et connexion dans l’app après rechargement |
| Session Charly non connectée | Même scénario : panneau de connexion Limova visible, absence du formulaire OTP et de fallback legacy |

Les quatre tests transférés sont remplacés par les scénarios ci-dessus, pas désactivés par des skips. Un cas supplémentaire vérifie la désactivation du flag entre l’ouverture du panneau et l’envoi. Les autres tests legacy restent présents, y compris ceux qui échouent.

Le test de manifeste vérifie désormais la liste exacte des hôtes par environnement, les permissions facultatives non accordées, les identités Chrome distinctes et les matches content-script. Il ne retire pas le contrôle de portée réseau.

## Portée de la fixture native

`native-chat-fixture.js` démarre un serveur HTTPS temporaire, utilise de vrais cookies HttpOnly/Secure/Partitioned, et charge le paquet dans un profil Chromium isolé. Les domaines app/API sont résolus vers localhost ; les autres domaines ne sont pas résolus. Les requêtes legacy sont surveillées et refusées par les assertions. Les méthodes d’envoi du panneau ne sont pas remplacées.

Le contrat API est simulé : ce test prouve l’intégration client/Chrome, pas l’exécution réelle de NestJS, du modèle, de la mémoire, du MCP Studio ou de LangSmith. La continuité testée est le rechargement du panneau sur la même conversation persistée dans la fixture ; une reprise dans l’app Limova réelle reste à qualifier.
