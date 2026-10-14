# Diagnostic de disponibilité Limova

Le bouton Diagnostic et le téléchargement des logs utilisent désormais les services du parcours natif. Le diagnostic vérifie :

- extension et stockage local de session ;
- consentement IA enregistré ;
- session authentifiée et accès à `/users/me` et `/workspaces` via la passerelle first-party ;
- compte sélectionné, accès workspace et flag commun `is_charly_extension_enabled` ;
- agent principal existant via `/agent/by-slug/charly` ;
- conversation sélectionnée, lorsqu’elle existe, via `/conversation/:id` ;
- disponibilité informative du content script Limova et permission microphone.

Il ne crée pas de conversation, n’envoie pas de message, ne déclenche pas d’action navigateur et n’ouvre pas le microphone. Le refresh de session habituel peut intervenir. Sans onglet app, la passerelle peut en préparer un comme pour les autres requêtes natives ; avec un onglet existant, aucun nouvel onglet n’est nécessaire.

Un succès signifie « Connexion Limova vérifiée. Aucun test IA lancé. ». Le modèle, la mémoire, les intégrations, MCP Studio, LangSmith et la connexion vocale ne sont pas qualifiés par cette sonde. Le rapport les indique comme non exécutés. La permission microphone bloquée et les erreurs locales restent signalées. L’absence de content script sur l’app reste informative : elle ne suffit pas à déclarer le chat texte indisponible.

Le proxy legacy n’est plus interrogé et ses anciens compteurs d’actions, OAuth ou échecs Gemini Live ne déterminent plus l’état du chat Deep Agent. Les logs historiques restent dans le paquet de support existant ; ce diagnostic ne remplace pas une analyse des traces du moteur natif.

Les résultats de sondes contiennent des codes et libellés fixes, sans identifiants utilisateur, noms de conversations, emails, cookies, exceptions serveur ni contenu des pages. L’état de sélection et les conversations ne sont pas modifiés par le diagnostic.

## Validation

Tests unitaires : session absente, API indisponible, compte changé, workspace absent, flag désactivé, agent indisponible, conversation inaccessible, absence de conversation et absence de données sensibles dans le rapport. Les tests Chromium traversent le vrai worker/passerelle avec API HTTPS locale et vérifient le panneau healthy/degraded, l’absence de requête proxy, de mutation et de fenêtre supplémentaire sur une session app déjà ouverte. L’ancien test de diagnostic basé uniquement sur `/healthz` du proxy est remplacé par ces scénarios ; aucune exemption CI n’est ajoutée.
