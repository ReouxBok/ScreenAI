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

## Actions navigateur sur le transport natif

`limova-browser-actions.spec.js` remplace trois scénarios legacy : remplissage exact et silencieux, récupération après mauvaise cible et clic ordinaire sans verbe explicite. La fixture émet plusieurs commandes canoniques dans le même tour ; le worker, le journal et le driver réels exécutent les commandes et renvoient les résultats. Chaque nouveau message reçoit un identifiant de tour distinct.

La récupération change de responsabilité : une saisie visant un bouton est refusée sans effet ; le serveur relit ensuite la page et désigne le champ correct. Le test simule cette décision serveur et ne démontre pas le raisonnement d’un modèle réel. Il vérifie une seule saisie effective, aucun clic accidentel, les identifiants du même tour et l’absence des anciennes valeurs privées dans les résultats.

Le clic ordinaire utilise désormais le consentement navigateur explicite du tour de chat. Le mode analyse refuse les mutations, même si le serveur demande de supprimer un brouillon. Un scénario supplémentaire vérifie la navigation et la lecture du nouveau document avec une version de contexte augmentée, dans la même conversation.

Les anciens scénarios de guidage visuel, curseur et analyse destructive restent présents tant que leur couverture visuelle n’est pas transférée. Les tests de navigation sémantique restent également présents : naviguer vers une URL ne démontre pas la sélection d’un contrôle mal étiqueté. Aucun seuil CI ni skip supplémentaire n’est ajouté.

Validation de cette couche : 12 tests ciblés réussis avec le paquet production, puis 12 avec le paquet staging (`limova-browser-actions.spec.js` et `limova-native-chat.spec.js`). La fixture sélectionne maintenant `build-staging` par défaut lorsque `LIMOVA_E2E_ENV=staging`, tout en respectant `EXTENSION_PATH`. Une première invocation staging avait chargé le paquet production ; elle a été interrompue et corrigée. Il reste 21 scénarios legacy dans `feature-flows.spec.js` ; la suite globale n’est pas déclarée verte.

## Guidage visuel pendant l’analyse

Le mode observation autorise désormais `highlight` en plus de la lecture et de la capture. Le driver applique son animation au contrôle exact enregistré dans son registre privé ; il ne recherche pas un autre contrôle à partir d’un identifiant inventé. Un test du parcours complet vérifie le champ animé, le refus d’une référence inconnue, l’absence de saisie/clic et le maintien du mode observation. Les tests du journal couvrent la persistance de cette permission après réouverture et le refus des quatre opérations mutantes ; ceux du document vérifient le rejet d’un contrôle remplacé.

Le scénario legacy de guidage reste présent : son exigence de capture automatique et les anciens overlays ne sont pas assimilés à la preuve du surlignage natif. Le [curseur natif](deep-agent-action-pointer.md) indique maintenant les clics et saisies ; sa trajectoire et le défilement automatique legacy restent à évaluer.
