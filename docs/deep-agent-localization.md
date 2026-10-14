# Langues du panneau Deep Agent

Les contrôles de session, workspace, conversation, historique, consentement navigateur et sites autorisés utilisent le dictionnaire existant du panneau : français, anglais et espagnol. Les messages locaux de vérification/session, de reprise navigateur, d’ouverture de fichier et les libellés accessibles des légendes générées utilisent la même sélection. Le choix reste enregistré sous `limova_lang` par le mécanisme existant.

Le changement de langue applique les libellés sans recharger l’historique, changer le compte/workspace/conversation, arrêter la voix ou effacer le consentement du message. Les noms de workspace, titres de chat, fichiers, messages et contenus générés restent ceux de l’utilisateur. Un statut de permission déjà affiché peut être retraduit sans redemander un accès Chrome. Le texte d’accueil décrit maintenant le consentement requis pour accéder à l’onglet actif.

Tests : couverture identique des clés FR/EN/ES, consentement conservé lors de la traduction, statut de permission sans nouvel appel Chrome, voix toujours occupée après traduction. Chromium change la langue FR/EN/ES dans le panneau complet, conserve sélection/messages/consentement et confirme l’absence de nouvelle requête Deep Agent. Services de test simulés.

Périmètre : interface locale du panneau. Les erreurs opaques renvoyées par le worker/API et les écrans métier Studio/formation/évaluation ne sont pas tous traduits par cette couche. Le choix d’interface ne réécrit pas les messages ni le profil linguistique Limova ; la voix transmet déjà son `languageCode` par le transport natif. La recette linguistique du modèle et des services déployés reste nécessaire pour la parité complète.
