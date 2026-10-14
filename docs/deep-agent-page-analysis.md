# Analyse de page avec le main Deep Agent

Le bouton d’analyse du panneau utilise désormais `LIMOVA_SEND_MESSAGE` dans la conversation sélectionnée du Charly existant. Il demande un tour navigateur avec `browserMode: observe`, après le consentement IA habituel. Le prompt est traduit en français, anglais et espagnol. Aucun appel `ANALYZE_PAGE` ne part de ce bouton.

Le journal IndexedDB conserve le mode avec le compte, workspace, conversation, session navigateur et identifiant serveur du tour. La clé de politique est distincte des clés de reçus, même si une action s’appelle `policy`. Le mode est immuable et enregistré dès le premier événement identifiant le tour, avant toute exécution. Une reprise texte relit le mode ; sans politique connue, elle utilise `observe`.

En observation, seuls `read_page` et `screenshot` atteignent l’exécuteur. Clic, saisie, navigation, défilement et surlignage produisent un reçu durable `rejected`, renvoyé au moteur. Les contrôles de session, site, document et consentement du driver restent applicables. Le bouton ne coche pas l’autorisation générale « lire et agir » et est désactivé pendant un tour texte ou vocal.

Cette restriction porte sur les outils du navigateur local. Elle n’est pas un mode lecture seule de la mémoire ou de toutes les intégrations de Charly. Les tours navigateur ordinaires conservent leur mode `act`. Les consommateurs du journal sans politique explicite, notamment les nouveaux tours vocaux, conservent leur comportement existant ; une politique d’observation déjà enregistrée est néanmoins appliquée par le journal commun.

Validation locale : tests unitaires panneau/worker/reprise et Chromium avec IndexedDB réel, dont fermeture/réouverture, refus des cinq opérations mutantes, lecture/capture autorisées, révocation de session et collision de clé. Les tests de panneau et d’évaluation utilisent des réponses backend contrôlées : ils ne prouvent pas la qualification du compte Limova, du provider ni du déploiement réel.

Les handlers legacy restants, dont `NEXT_STEP`, ne sont pas supprimés par cette couche. Leur retrait reste conditionné à la parité des parcours.
