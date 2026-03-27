---
title: "De quoi mes agents sont ils capables avec Outlook mail ?"
slug: "de-quoi-mes-agents-sont-ils-capables-avec-outlook-mail"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/de-quoi-mes-agents-sont-ils-capables-avec-outlook-mail-"
keywords: ["outlook","mail","outils","agents","capables","categories","microsoft","emails","amp","email"]
related_urls: ["/integrations/gmail","/integrations/outlook","/settings/team"]
---

# De quoi mes agents sont ils capables avec Outlook mail ?

# De quoi mes agents sont ils capables avec Outlook mail ?

## ✉️ Capacités de l'intégration Outlook Mail

Cette documentation détaille les outils permettant aux agents IA d'interagir avec la messagerie Microsoft Outlook (Office 365). Avec ******21 outils LangChain******, ce module offre une parité fonctionnelle quasi-totale avec Gmail, tout en incluant des spécificités propres à l'écosystème Microsoft.

---

## 🛠️ Liste des Outils disponibles (21)

### 1. Gestion des Emails &amp; Pièces Jointes

Outils pour la communication quotidienne et le traitement des messages.

- Envoyer un nouvel email.
- Répondre au sein d'une conversation existante.
- Rechercher des messages selon divers critères.
- Créer un brouillon.
- Lister les fichiers joints d'un message.
- Télécharger une pièce jointe spécifique.
- ******Exclusivité Outlook :****** Rechercher des emails dans des ******dossiers partagés******, une fonction clé pour les environnements collaboratifs en entreprise.
### 2. Organisation &amp; Dossiers

Outils pour structurer la boîte de réception.

- Lister l'arborescence des dossiers.
- Déplacer un email vers un dossier cible.
- Archiver un message.
- Supprimer un message (envoi vers la corbeille).
### 3. Catégories (Équivalent des Labels)

Outlook utilise un système de catégories pour l'organisation visuelle.

- Lister les catégories disponibles.
- Assigner une catégorie à un email.
- Retirer une catégorie.
- ***Note : Contrairement à Gmail, l'outil de création dynamique de catégorie n'est pas présent ; on utilise les catégories existantes du compte.***
### 4. Gestion des Contacts

Accès complet à l'annuaire de contacts Outlook.

- Consulter et rechercher des fiches contacts.
- Ajouter un contact.
- Modifier les informations d'un contact.
- Supprimer un contact.
## ⚙️ Architecture &amp; Authentification

Le module Outlook Mail s'intègre de manière transparente dans l'architecture globale :

- ******Tools vs API :****** Aucune route REST n'est exposée directement. L'agent IA utilise des outils spécifiques pour transformer les intentions de l'utilisateur en requêtes Microsoft Graph.
- ******Flux OAuth :****** Les connexions sont pilotées par le contrôleur ******OAuth Pipedream******. Une fois l'autorisation accordée, l'agent peut lire, envoyer et organiser les emails.
