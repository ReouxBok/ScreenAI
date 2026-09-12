# Plan de couverture Limova dans le Studio Charly

## Objectif et règles de sécurité

Ce plan transforme la connaissance déductible des dépôts Limova `client` et `api` en un curriculum exploitable dans le Studio. Le code fournit le squelette, les pages, les prérequis et les résultats observables. Le staff apporte la vérité métier, démontre les actions et valide les cas limites.

- Les dépôts Limova restent strictement en lecture seule sur `main`.
- Le contenu déjà présent dans le Studio est conservé. Les doublons sont signalés, jamais supprimés automatiquement.
- Tout nouveau parcours commence en brouillon et avec l'accès IA désactivé.
- Seule une version relue, évaluée et publiée devient accessible à Charly.
- Charly exécute uniquement des actions UI génériques sur le DOM courant. Un parcours publié lui apporte des repères et des vérifications, jamais un droit supplémentaire.

## État de départ observé le 12 septembre 2026

- 43 parcours sont présents dans le Studio de production.
- 1 parcours est publié et activé pour l'IA : « Créer une image avec John ».
- Aucun parcours ne contient de branche ni de question de qualification.
- Les critères de réussite sont presque tous génériques.
- Trois démonstrations atteignent la limite actuelle de 50 actions.
- Plusieurs sujets existent en double et devront être rapprochés manuellement, sans suppression.
- Le proxy est en ligne. Le moteur ADK texte est déployé en canary à 5 %.
- Le pont ADK supprimait les `actionHints` renvoyés par le Studio. La correction locale les conserve, les borne et les filtre avant de les fournir à Charly.

## Définition de « prêt pour Charly »

Un parcours est prêt lorsque les neuf contrôles suivants sont satisfaits :

1. au moins deux formulations naturelles de l'intention ;
2. les informations à demander avant d'agir ;
3. les pages de départ, intermédiaires et finales ;
4. un résultat final visible et vérifiable ;
5. les principales variantes et restrictions ;
6. des solutions de repli précises ;
7. une démonstration réelle avec des étapes structurées ;
8. aucune cible faible non revue ;
9. un test de bout en bout réussi avec Charly.

Le Studio affiche désormais ces contrôles dans la bibliothèque et dans la fiche du contenu, avec les sources techniques lorsqu'elles sont connues.

## Curriculum cible

Les entrées ci-dessous sont les unités recommandées. Avant de créer une entrée, le générateur doit rechercher un parcours existant par slug, titre, intentions et pages. En cas de proximité, il enrichit un brouillon ; il ne fusionne ni ne supprime automatiquement.

### 1. Accès et premiers pas

- Se connecter par code à usage unique, renvoyer le code et reprendre après expiration.
- Créer un compte et accepter les conditions.
- Accepter ou refuser une invitation à une organisation.
- Créer une organisation et compléter son entreprise.
- Choisir une offre, payer et reprendre un paiement interrompu.
- Créer le premier espace de travail.
- Rejoindre, sélectionner et changer d'espace de travail.
- Comprendre l'accueil et retrouver une fonctionnalité dans la navigation.
- Choisir un assistant et démarrer la première conversation.
- Récupérer d'un compte sans organisation ou sans espace accessible.

### 2. Compte, organisation et équipe

- Modifier le profil, la photo et les préférences personnelles.
- Changer l'adresse e-mail et confirmer la nouvelle adresse.
- Modifier la langue, le fuseau horaire et le consentement analytique.
- Modifier les informations et le logo de l'entreprise.
- Inviter un membre dans l'organisation.
- Modifier son rôle ou annuler une invitation.
- Retirer un membre et expliquer les conséquences sur ses accès.
- Créer, renommer, sélectionner et supprimer un espace de travail.
- Ajouter ou retirer les membres d'un espace.
- Expliquer les différences de rôles, de visibilité et de propriété.

### 3. Abonnement, crédits, API et téléphonie

- Consulter l'offre, les quotas et l'utilisation.
- Télécharger une facture et gérer le moyen de paiement.
- Changer d'offre, ajouter des utilisateurs, annuler ou réactiver.
- Résoudre un accès bloqué par le paiement ou les quotas.
- Acheter des crédits téléphoniques et configurer la recharge automatique.
- Acheter des crédits API et configurer la recharge automatique.
- Créer, renommer, régénérer, désactiver et supprimer une clé API.
- Activer la téléphonie et comprendre les prérequis.
- Ajouter un numéro entrant et configurer le transfert.
- Ajouter un numéro sortant avec vérification OTP ou appel.
- Reconfigurer, déconnecter ou supprimer un numéro.

### 4. Assistants, conversations et capacités IA

- Parcourir les assistants et choisir Charly, Charly+, John, Lou, Elio, Tom, Manue, Julia ou Rony.
- Démarrer, retrouver, filtrer, renommer et supprimer une conversation.
- Joindre un document ou un dossier à une conversation, puis le retirer.
- Modifier la visibilité d'une conversation.
- Créer un assistant à partir d'une conversation.
- Comprendre et utiliser la mémoire de Charly.
- Créer, modifier, suspendre et supprimer une routine planifiée.
- Utiliser la recherche web approfondie.
- Générer un document, une image, une vidéo ou un carrousel.
- Analyser des données tabulaires.
- Utiliser l'exécution de code lorsque l'assistant concerné la propose.
- Reprendre une génération longue, échouée ou interrompue.

### 5. Documents et contexte

- Importer un document pris en charge et comprendre son traitement.
- Créer, renommer et supprimer un dossier.
- Rechercher, déplacer, prévisualiser et télécharger un document.
- Retraiter un document en erreur.
- Télécharger un dossier en archive.
- Ajouter ou retirer des documents du contexte par défaut.
- Attacher une source à un assistant autonome.
- Expliquer la différence entre retrait du contexte et suppression de la bibliothèque.

### 6. Intégrations et comptes connectés

- Rechercher une intégration dans le catalogue.
- Connecter une intégration OAuth et revenir correctement dans Limova.
- Connecter Gmail, Google Drive, Google Sheets et Google Calendar.
- Connecter Outlook et les services de calendrier compatibles.
- Connecter LinkedIn pour la prospection et pour la publication.
- Connecter Facebook et Instagram.
- Connecter Axonaut par clé API.
- Connecter et configurer un CMS pris en charge.
- Renommer un compte connecté et modifier sa visibilité.
- Déconnecter, reconnecter et diagnostiquer un compte connecté.
- Résoudre une fenêtre OAuth bloquée, fermée ou refusée.

### 7. Power-ups et production de contenu

- Trouver le bon power-up et comprendre quel assistant l'exécute.
- Enregistrer, reprendre et supprimer un brouillon de power-up.
- Générer une image avec John et demander une itération.
- Retirer l'arrière-plan d'une image.
- Générer une vidéo et télécharger le résultat.
- Générer une présentation et la reprendre.
- Transcrire un fichier audio.
- Générer un média générique.
- Créer, modifier, planifier et annuler un post social.
- Créer une campagne de publications sociales.
- Réaliser un audit SEO.
- Générer un article de blog unique.
- Créer une campagne d'articles de blog.
- Publier un article vers un CMS connecté.
- Retrouver brouillons et contenus finalisés dans la bibliothèque.
- Utiliser le calendrier de publication.

### 8. Campagnes

- Comprendre les statuts et retrouver une campagne.
- Créer et modifier une campagne de prospection LinkedIn.
- Démarrer, suspendre, reprendre et archiver une campagne LinkedIn.
- Consulter prospects, messages, statistiques et actualiser les données LinkedIn.
- Créer et modifier une campagne d'appels sortants.
- Tester, démarrer, suspendre et archiver une campagne d'appels.
- Consulter appels, transcriptions, enregistrements et résultats.
- Piloter une campagne blog et ses articles.
- Piloter une campagne sociale et ses publications.

### 9. Agents autonomes et canaux

- Créer un agent de support et un agent téléphonique.
- Retrouver, modifier, tester, activer et archiver un agent.
- Ajouter des documents de connaissance à l'agent.
- Connecter les intégrations nécessaires à l'agent.
- Tester le widget web avant publication.
- Configurer le widget, copier le code et autoriser un domaine.
- Configurer l'ouverture automatique du widget.
- Connecter WhatsApp par OAuth ou QR code et diagnostiquer son statut.
- Consulter la boîte de réception, résoudre et supprimer une conversation.
- Consulter appels entrants, métriques, transcription, audio et notes.
- Créer, modifier, supprimer et attribuer des étiquettes.

### 10. Blocages et garde-fous transverses

- Expliquer une action indisponible à cause du rôle, de l'offre ou des crédits.
- Réagir à une page modifiée ou à une cible DOM devenue ambiguë.
- Réagir à une erreur réseau, une génération en attente ou un résultat absent.
- Refuser de saisir ou d'exposer un secret dans une zone non prévue.
- Demander une confirmation avant les actions à conséquence importante.
- Passer la main au staff avec le contexte utile lorsqu'une action ne peut pas être automatisée.

## Ordre de réalisation

### Phase 0 — Fiabiliser le socle

- Déployer le pont `actionHints` corrigé.
- Ajouter au healthcheck les indicateurs non secrets de connexion au Studio et à la mémoire.
- Vérifier en production qu'une recherche du parcours image renvoie ses actions structurées.
- Conserver le canary ADK à 5 % jusqu'au succès des tests critiques.

### Phase 1 — Assainir sans supprimer

- Afficher la complétude des 43 parcours existants.
- Marquer les groupes de doublons comme « à rapprocher ».
- Découper les démonstrations de 50 actions en sous-parcours réutilisables.
- Remplacer les réussites et fallbacks génériques.

### Phase 2 — Générer les brouillons depuis le code

- Générer de manière additive les entrées absentes du curriculum.
- Préremplir titre, slug, intentions proposées, pages, prérequis techniques, résultat attendu et sources.
- Ne jamais inventer les décisions métier, textes commerciaux, droits exacts ou effets de facturation.
- Laisser l'accès IA désactivé tant que la fiche n'est pas complète.

### Phase 3 — Travail du staff

- Confirmer les intentions et questions de qualification.
- Démontrer chaque chemin principal dans l'application réelle.
- Ajouter les variantes liées aux rôles, offres, connexions et états existants.
- Décrire les erreurs connues et la bonne reprise.

### Phase 4 — Évaluation et publication

- Exécuter au minimum un cas nominal et un cas de blocage par parcours critique.
- Refuser la publication si une cible est faible, si le résultat n'est pas observable ou si le test échoue.
- Publier puis activer pour l'IA seulement après validation d'un administrateur.
- Vérifier que la recherche retrouve le parcours avec la bonne page et les bons `actionHints`.

### Phase 5 — Généralisation progressive

- Priorité P0 : connexion, espaces, conversations, intégrations, documents, image et campagnes existantes.
- Priorité P1 : compte, équipe, facturation, API, téléphonie et agents autonomes.
- Priorité P2 : variantes avancées, dépannage et fonctionnalités moins utilisées.
- Passer le canary ADK de 5 % à 25 %, 50 % puis 100 % uniquement sur la base des évaluations et incidents.

## Indicateurs de réussite

- couverture : parcours publiés / curriculum cible ;
- complétude : contrôles satisfaits / contrôles attendus ;
- qualité : taux de réussite des évaluations nominales et de blocage ;
- robustesse : part d'étapes avec cible forte ou moyenne ;
- découverte : taux de recherches retournant le bon parcours dans les cinq premiers résultats ;
- exploitation : taux d'abandon, demandes de clarification et reprises par le staff ;
- fraîcheur : parcours revus depuis moins de 90 jours.

## Responsabilités

- Génération automatique : inventaire technique, pages, structures, rapprochement et brouillons.
- Staff métier : intentions réelles, règles commerciales, variantes, textes et démonstrations.
- Administrateur : arbitrage des doublons, évaluation, publication, activation IA et rollback.
- Charly : recherche du parcours publié, inspection du DOM courant, exécution prudente et vérification de chaque résultat.
