---
title: "Capacités des intégrations"
slug: "capacites-des-integrations"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/capacites-des-integrations"
keywords: ["specifique","modifie","liste","donnees","recupere","fichier","ajoute","contenu","supprime","carte"]
related_urls: ["/integrations/google-drive","/integrations/hubspot","/integrations/notion","/integrations/trello","/integrations/airtable","/campaigns","/settings","/settings/team"]
---

# Capacités des intégrations

# Capacités des intégrations 

******Voici les capacités de certaines intégrations disponibles dans Limova : ******

******Google sheets :******

### 📝 Ajout et Mise à jour de Données

- Ajoute une ligne de données à la fin de la feuille ou à un index spécifique.
- Ajoute plusieurs lignes de données en une seule opération.
- Modifie le contenu d'une ligne existante identifiée par son numéro.
- Met à jour plusieurs lignes dans une plage définie.
- Modifie la valeur d'une cellule unique (ex: A1).
- Met à jour une ligne si elle existe (selon un critère) ou en crée une nouvelle.
- Recherche une ligne spécifique basée sur une valeur dans une colonne.
### 🔍 Lecture et Extraction

- Récupère les données d'une plage (ex: A1:C10).
- Obtient les métadonnées et la structure complète d'un classeur.
- Liste tous les onglets (feuilles) présents dans un fichier.
- Recherche un fichier Google Sheets par son nom ou ses propriétés.
### 🧹 Suppression et Nettoyage

- Efface le contenu d'une cellule spécifique.
- Supprime le contenu de plusieurs lignes sans supprimer les lignes elles-mêmes.
- Vide intégralement le contenu d'un onglet.
- Supprime physiquement des lignes de la feuille.
- Supprime un onglet complet du classeur.
### 🏗️ Structure et Organisation

- Crée un tout nouveau fichier Google Sheets.
- Ajoute un nouvel onglet à un classeur existant.
- Ajoute une nouvelle colonne à la structure de la feuille.
- Insère des lignes ou des colonnes vides à un endroit précis.
- Déplace des lignes ou des colonnes d'un emplacement à un autre.
- Modifie le titre ou les paramètres généraux du fichier.
### 🎨 Formatage et Protection

- Modifie l'apparence des cellules (gras, couleurs, bordures).
- Crée une règle de mise en forme conditionnelle.
- Modifie une règle existante.
- Supprime une règle par son index.
- Fusionne plusieurs cellules en une seule.
- Ajoute des listes déroulantes ou des critères de validation.
- Verrouille une plage de cellules pour restreindre l'édition.
### 💬 Commentaires et Notes

- Ajoute un commentaire de discussion sur une cellule.
- Ajoute une note fixe (infobulle) sur une cellule.

Chacune de ces actions peut être combinée par l'IA pour automatiser des processus complexes (ex: "Cherche la ligne du client X, mets à jour son statut en vert et ajoute une note").

******Google Drive : ******

### 📂 Gestion des Fichiers et Dossiers

- Liste les fichiers et dossiers selon des critères (nom, type, emplacement).
- Téléverse un nouveau fichier vers le Drive.
- Récupère les métadonnées détaillées d'un fichier via son ID.
- Crée une copie d'un fichier existant.
- Déplace un fichier vers un autre dossier.
- Modifie le nom d'un fichier ou d'un dossier.
- Place un fichier ou un dossier dans la corbeille.
- Restaure un élément de la corbeille.
- Supprime définitivement un fichier (sans passer par la corbeille).
- Crée un nouveau dossier vide.
- Liste spécifiquement les dossiers du Drive.
### 👥 Drive Partagés et Permissions

- Liste tous les Drive d'équipe (Shared Drives) accessibles.
- Récupère les détails d'un Drive partagé spécifique.
- Crée un nouveau Drive partagé.
- Modifie les paramètres d'un Drive partagé.
- Partage un fichier ou dossier avec un utilisateur ou un groupe.
- Liste toutes les personnes ayant accès à un fichier.
- Modifie le rôle d'un utilisateur (ex: de "Lecteur" à "Éditeur").
- Révoque l'accès d'un utilisateur à un fichier.
### 💬 Commentaires et Collaboration

- Liste tous les commentaires présents sur un fichier.
- Récupère le contenu d'un commentaire spécifique.
- Ajoute un nouveau commentaire sur un fichier.
- Modifie un commentaire existant.
- Supprime un commentaire.
- Marque un fil de discussion comme résolu.
- Ajoute une réponse à un commentaire existant.
- Liste toutes les réponses d'un fil de discussion.
- Récupère une réponse spécifique.
- Modifie une réponse existante.
- Supprime une réponse.
### 🛠️ Fonctions Spéciales et Automation

- Recherche avancée utilisant la syntaxe de requête Google Drive.
- Récupère le contenu d'un fichier (pour traitement par l'IA).
- Exporte un document Google (Doc, Sheet) dans un format spécifique (PDF, Office).
- Génère un nouveau document basé sur un modèle existant.
- Récupère les informations sur l'utilisateur et le quota de stockage.
- Liste les modifications récentes apportées au Drive.
- Configure un webhook pour surveiller les modifications en temps réel.

Chacune de ces lignes représente une capacité précise que l'IA peut exploiter pour organiser, gérer ou extraire vos données stockées sur Google Drive.

******Notion :******

### 📄 Gestion des Pages

- Crée une nouvelle page (avec titre et icône) dans un parent ou une base de données.
- Récupère les métadonnées et les propriétés d'une page spécifique.
- Modifie les propriétés, l'icône ou l'image de couverture d'une page.
- Archive ou supprime une page existante.
- Crée une copie conforme d'une page existante.
### 🗄️ Bases de Données

- Recherche des pages ou des bases de données par titre.
- Filtre et trie les entrées d'une base de données selon des critères complexes.
- Récupère la structure et les réglages d'une base de données.
- Liste l'ensemble des bases de données accessibles dans l'espace de travail.
- Modifie le titre, la description ou la structure des colonnes (schéma).
- Crée une nouvelle base de données en tant qu'enfant d'une page.
### 🧱 Contenu et Blocs

- Récupère les informations d'un bloc de contenu spécifique.
- Modifie le contenu d'un bloc (texte, style, case à cocher, etc.).
- Ajoute de nouveaux blocs de contenu à l'intérieur d'une page ou d'un bloc parent.
- Liste tous les blocs enfants contenus dans un bloc ou une page.
- Supprime un bloc de contenu spécifique.
- Extrait tout le contenu d'une page converti au format Markdown.
### 👥 Utilisateurs et Espace de Travail

- Affiche la liste de tous les utilisateurs ayant accès à l'espace de travail.
- Récupère les informations détaillées d'un utilisateur via son ID.
- Récupère les informations de l'utilisateur ou du bot actuellement connecté.
### 🛠️ Fonctions Avancées et Automatisation

- Recherche uniquement des pages (exclut les bases de données).
- Recherche uniquement des bases de données.
- Effectue une requête personnalisée sur l'API Notion (pour des cas d'usage spécifiques).
- Surveille les modifications apportées à une page spécifique.
- Surveille l'ajout ou la modification d'entrées dans une base de données.

******Hubspot :******

### 👥 Gestion des Contacts (10)

- Créer un nouveau profil contact.
- Modifier les propriétés d'un contact existant.
- Récupérer les détails d'un contact par son ID ou email.
- Rechercher des contacts via des filtres (nom, ville, etc.).
- Supprimer un contact.
- Afficher tous les contacts du CRM.
- Lister les définitions des champs de contacts.
- Ajouter un nouveau champ personnalisé aux contacts.
- Inscrire un contact dans une liste statique.
- Retirer un contact d'une liste.
### 🏢 Entreprises (Companies) (7)

- Créer une fiche entreprise.
- Modifier les informations d'une entreprise.
- Récupérer les données d'une entreprise par son ID.
- Rechercher des entreprises par domaine ou critères.
- Supprimer une entreprise.
- Afficher la liste globale des entreprises.
- Lister les définitions des champs d'entreprises.
### 💰 Transactions (Deals) (7)

- Créer une nouvelle opportunité d'affaire.
- Modifier le montant, l'étape ou la date de clôture d'un deal.
- Récupérer les détails d'une transaction.
- Rechercher des transactions spécifiques.
- Supprimer un deal.
- Afficher toutes les transactions en cours.
- Lister les étapes et pipelines de vente.
### 🎫 Tickets (Support) (6)

- Ouvrir un ticket de support client.
- Modifier le statut ou la priorité d'un ticket.
- Récupérer les informations d'un ticket.
- Rechercher des tickets par critères.
- Supprimer un ticket.
- Afficher l'historique des tickets de support.
### 📝 Engagements &amp; Activités (CRM) (8)

- Ajouter une note sur une fiche CRM.
- Créer une tâche pour un collaborateur.
- Enregistrer un appel téléphonique.
- Programmer ou enregistrer un rendez-vous.
- Enregistrer un email envoyé/reçu.
- Rechercher dans les activités (notes, appels, tâches).
- Lier deux objets entre eux (ex: lier un contact à un deal).
- Lister les objets liés à un élément spécifique.
### 📈 Marketing &amp; Contenu (CMS) (12)

- Récupérer la liste des articles de blog.
- Publier un nouvel article.
- Modifier un article existant.
- Lister les pages du site web.
- Lister les pages d'atterrissage.
- Récupérer tous les formulaires HubSpot.
- Détails d'un formulaire spécifique.
- Simuler la soumission d'un formulaire.
- Voir les modèles et campagnes emails.
- Statistiques d'ouverture et de clic d'un email.
- Lister les comptes publicitaires liés.
- Afficher les campagnes marketing globales.
### 💬 Conversations &amp; Threads (4)

- Afficher les conversations de la messagerie.
- Détails d'une conversation spécifique.
- Lister les messages au sein d'un thread.
- Envoyer une réponse via la boîte de réception HubSpot.
### ⚙️ Workflows &amp; Automatisation (5)

- Afficher les automatisations actives.
- Détails d'un workflow spécifique.
- Inscrire manuellement un objet dans un workflow.
- Désinscrire un objet d'un workflow.
- Voir les déclencheurs HTTP configurés.
### 🛠️ Administration &amp; Propriétaires (4)

- Lister les utilisateurs HubSpot (propriétaires de fiches).
- Détails d'un collaborateur spécifique.
- Recherche globale sur tous les types d'objets.
- Effectuer une requête API personnalisée (cas complexes).

******Airtable :******

### 📊 Gestion des Bases et des Tables

- Récupère la liste de toutes les bases de données auxquelles l'utilisateur a donné accès.
- Obtient la structure complète d'une base (tables, noms des colonnes, types de champs).
- Affiche la liste des tables contenues dans une base spécifique.
- Crée une nouvelle table avec ses colonnes (champs) dans une base existante.
- Modifie le nom ou la description d'une table existante.
### 📝 Gestion des Enregistrements (Records)

- Récupère les lignes d'une table. Supporte le tri, la pagination et l'affichage par vue.
- Récupère les données détaillées d'une seule ligne via son ID unique.
- Recherche des lignes spécifiques en utilisant les formules natives d'Airtable (ex: NOT({Statut} = 'Terminé')).
- Ajoute un ou plusieurs nouveaux enregistrements (jusqu'à 10 par appel) dans une table.
- Modifie les champs de plusieurs lignes existantes.
- Supprime définitivement une ligne spécifique.
### 🛠️ Configuration des Champs (Fields)

- Ajoute une nouvelle colonne à une table (ex: texte, nombre, case à cocher).
- Modifie le nom ou les options d'une colonne existante.
### 💬 Commentaires et Collaboration

- Affiche tous les commentaires postés sur un enregistrement précis.
- Ajoute un nouveau commentaire (avec support des mentions) sur une ligne.
- Modifie le contenu d'un commentaire existant.
- Supprime un commentaire.
### ⚙️ Requêtes Personnalisées

- Permet d'effectuer une requête HTTP directe sur l'API Airtable pour des opérations avancées non couvertes par les outils standards.

******Trello :******

### 📋 Gestion des Tableaux (Boards)

- Affiche tous les tableaux accessibles par l'utilisateur.
- Récupère les détails complets d'un tableau (nom, description, préférences).
- Crée un tout nouveau tableau de projet.
- Modifie le nom, la description ou la visibilité d'un tableau.
- Supprime définitivement un tableau.
- Affiche la liste des membres collaborateurs sur un tableau.
### 📂 Gestion des Listes (Colonnes)

- Affiche toutes les listes (colonnes) d'un tableau donné.
- Récupère les détails d'une liste spécifique.
- Ajoute une nouvelle colonne à un tableau.
- Modifie le nom ou l'état d'une liste (ex: l'archiver).
- Déplace une colonne entière vers un autre tableau.
### 🗂️ Gestion des Cartes (Tasks)

- Affiche toutes les cartes contenues dans une colonne.
- Récupère les détails d'une carte (titre, description, dates).
- Crée une nouvelle carte dans une liste spécifique.
- Modifie les propriétés d'une carte (nom, description, position).
- Déplace une carte vers une autre liste ou un autre tableau.
- Retire une carte du tableau actif sans la supprimer.
- Supprime définitivement une carte.
- Recherche des cartes spécifiques par nom ou mots-clés.
### 🛠️ Checklists, Labels et Pièces Jointes

- Affiche les listes de tâches à l'intérieur d'une carte.
- Ajoute une nouvelle checklist à une carte.
- Ajoute une tâche spécifique dans une checklist.
- Modifie le statut (coché/décoché) ou le nom d'un item.
- Appose une étiquette de couleur sur une carte.
- Retire une étiquette d'une carte.
- Assigne un collaborateur à une carte spécifique.
- Joint un fichier ou un lien à une carte.
### 💬 Commentaires et Notifications

- Poste un nouveau message sur une carte.
- Modifie un commentaire existant.
- Supprime un commentaire sur une carte.

******Google analytics :******

### 📈 Les 4 Actions Google Analytics (GA4)

- Génère un rapport de données personnalisé (ex: nombre de sessions par ville sur les 7 derniers jours).
- Générer un rapport de données basique.
- Permet de configurer une nouvelle propriété de suivi au sein d'un compte.
- Permet de définir un événement spécifique comme "Key Event" (conversion) pour le suivi des objectifs.
