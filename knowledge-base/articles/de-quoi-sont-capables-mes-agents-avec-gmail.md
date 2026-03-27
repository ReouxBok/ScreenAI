---
title: "De quoi sont capables mes agents avec Gmail ?"
slug: "de-quoi-sont-capables-mes-agents-avec-gmail"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/de-quoi-sont-capables-mes-agents-avec-gmail-"
keywords: ["gmail","agents","labels","outils","gestion","message","capables","contacts","amp","envoyer"]
related_urls: ["/integrations/gmail","/integrations/outlook"]
---

# De quoi sont capables mes agents avec Gmail ?

# De quoi sont capables mes agents avec Gmail ?

## 📥 Capacités de l'intégration Gmail

Cette documentation détaille les outils et l'architecture permettant aux agents IA d'interagir avec l'écosystème Gmail. L'intégration repose sur une suite de ******21 outils LangChain****** couvrant la gestion des messages, l'organisation structurelle et la gestion des contacts.

---

## 🛠️ Liste des Outils disponibles (21)

### 1. Gestion des Emails &amp; Threads

Ces outils permettent de manipuler le flux de messagerie de l'utilisateur.

- Envoyer un nouvel email.
- Répondre directement au sein d'un thread existant.
- Rechercher des messages spécifiques avec des filtres avancés.
- Préparer un brouillon sans l'envoyer.
- Récupérer l'historique complet d'une conversation (thread).
- Lister les fichiers joints d'un message.
- Télécharger une pièce jointe spécifique.
### 2. Organisation &amp; Archivage

Outils dédiés à la maintenance de la boîte de réception.

- Lister l'ensemble des dossiers et labels disponibles.
- Déplacer un message vers un dossier spécifique.
- Archiver un email pour libérer la boîte de réception.
- Envoyer un message à la corbeille.
### 3. Gestion des Labels (Étiquettes)

Contrairement à d'autres services, Gmail permet une gestion dynamique des labels.

- Afficher tous les labels existants.
- Créer de nouveaux labels personnalisés.
- Apposer une étiquette sur un message.
- Retirer une étiquette d'un message.
### 4. Carnet d'adresses (Contacts)

Outils permettant de synchroniser et gérer les contacts associés au compte Gmail.

- Consulter et rechercher dans la liste de contacts.
- Ajouter une nouvelle fiche contact.
- Modifier les informations d'un contact existant.
- Supprimer un contact.
---

## 💡 Spécificités Gmail vs Outlook

Il est important de noter que Gmail offre des capacités uniques par rapport au module Outlook Mail :

- ******Labels dynamiques :****** Possibilité de créer de nouveaux labels à la volée, là où Outlook est limité à des catégories prédéfinies.
- ******Gestion native des threads :****** Un outil dédié permet de récupérer une conversation entière simplement, sans filtrage manuel complexe.
## ⚙️ Architecture &amp; Authentification

Le module Gmail ne dispose pas de routes REST en propre. Son fonctionnement est entièrement piloté par l'IA :

- ******Execution via Tools :****** Toutes les opérations sont des fonctions (******tools******) invoquées par les agents IA lors des échanges.
- ******Couche d'Authentification :****** Les connexions sont gérées par le contrôleur générique ******OAuth Pipedream******. Les agents utilisent les comptes connectés via les routes oauth/pipedream/....
