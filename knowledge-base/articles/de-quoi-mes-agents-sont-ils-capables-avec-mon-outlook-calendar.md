---
title: "De quoi mes agents sont-ils capables avec mon Outlook calendar ?"
slug: "de-quoi-mes-agents-sont-ils-capables-avec-mon-outlook-calendar"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/de-quoi-mes-agents-sont-ils-capables-avec-mon-outlook-calendar-"
keywords: ["outlook","calendar","agents","outils","capables","microsoft","calendrier","google","gestion","liste"]
related_urls: ["/integrations/gmail","/integrations/outlook","/integrations/google-calendar","/integrations/microsoft"]
---

# De quoi mes agents sont-ils capables avec mon Outlook calendar ?

# De quoi mes agents sont-ils capables avec mon Outlook calendar ?

## 📅 Capacités de l'intégration Outlook Calendar

Cette documentation détaille les outils permettant aux agents IA de gérer les agendas au sein de l'écosystème Microsoft 365. Le module repose sur ******6 outils LangChain****** optimisés pour la planification et la gestion du temps.

---

## 🛠️ Liste des Outils disponibles (6)

Ces outils offrent les fonctionnalités essentielles pour la gestion d'un agenda professionnel.

### 1. Lecture et Disponibilité

- Retourne le calendrier de l'utilisateur.
- 
- ***Note technique : Contrairement à Gmail, cet outil retourne actuellement uniquement le ***********calendrier par défaut***********.***
- Liste les événements programmés. Permet l'application de ******filtres de dates****** pour une lecture précise du planning.
- Analyse les créneaux horaires pour identifier les périodes libres ou occupées.
### 2. Création et Modification

- Génère un nouvel événement dans le calendrier par défaut.
- Modifie les détails (horaires, lieu, objet) d'un rendez-vous existant.
- Supprime un événement spécifique à partir de son ID.
---

## 💡 Différences notables (Outlook vs Google)

Bien que les outils soient similaires en apparence, le module Outlook présente des spécificités de fonctionnement :

******Fonctionnalité******

******Outlook Calendar******

******Google Calendar******

******Portée des calendriers******

Calendrier ******par défaut****** uniquement.

Liste ******tous****** les calendriers.

******API Sous-jacente******

Microsoft Graph API.

Google Calendar API.

******Gestion des ID******

Format d'ID spécifique à Microsoft.

Format d'ID Google.

## ⚙️ Architecture &amp; Authentification

Outlook Calendar opère sans routes REST dédiées :

- ******Invocations IA :****** Les opérations sont exécutées sous forme de ******tools****** par l'agent IA.
- ******Sécurité OAuth :****** L'authentification est centralisée via le contrôleur ******OAuth Pipedream******. L'agent accède aux ressources Microsoft Graph via les jetons de connexion sécurisés générés par l'utilisateur.
