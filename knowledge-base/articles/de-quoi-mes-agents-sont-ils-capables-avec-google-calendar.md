---
title: "De quoi mes agents sont-ils capables avec Google calendar ?"
slug: "de-quoi-mes-agents-sont-ils-capables-avec-google-calendar"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/de-quoi-mes-agents-sont-ils-capables-avec-google-calendar-"
keywords: ["calendar","google","agents","capables","outils","liste","calendriers","utilisateur","integration","via"]
related_urls: ["/integrations/outlook","/integrations/google-calendar","/settings","/settings/team"]
---

# De quoi mes agents sont-ils capables avec Google calendar ?

# De quoi mes agents sont-ils capables avec Google calendar ?

## 📅 Capacités de l'intégration Google Calendar

Cette documentation détaille les outils et l'architecture permettant aux agents IA de gérer les agendas et les disponibilités via Google Calendar. L'intégration repose sur ******6 outils LangChain****** performants.

---

## 🛠️ Liste des Outils disponibles (6)

Ces outils permettent une gestion complète du cycle de vie des événements et une lecture granulaire des calendriers.

### 1. Lecture et Consultation

- Liste ******tous****** les calendriers accessibles par l'utilisateur (calendrier principal, calendriers partagés, anniversaires, etc.).
- Recherche et liste les événements. Supporte des ******filtres de dates****** précis pour extraire l'agenda d'une journée ou d'une semaine spécifique.
- Vérifie les créneaux libres ou occupés sur une période donnée. Indispensable pour la planification automatique de rendez-vous.
### 2. Actions et Modification

- Crée un nouvel événement. Supporte les paramètres suivants :
- 
- Titre et description.
- Dates et heures de début/fin.
- Liste des participants.
- ******Récurrence****** (ex: tous les lundis).
- Modifie un événement existant (changement d'horaire, ajout d'un invité).
- Supprime définitivement un événement via son identifiant unique (ID).
---

## 💡 Points forts face à Outlook Calendar

Le module Google Calendar présente un avantage majeur en termes de visibilité :

- ******Multi-agendas :****** Contrairement à l'intégration Outlook qui ne retourne actuellement que le calendrier par défaut, Google Calendar permet de lister et d'interagir avec ******l'intégralité des calendriers****** auxquels l'utilisateur a accès.
## ⚙️ Architecture &amp; Authentification

Le module Google Calendar suit la même philosophie "Serverless" que le reste de la suite :

- ******Zéro Route REST Dédiée :****** Il n'existe pas de points de terminaison API directs pour le calendrier. Les actions sont déclenchées par l'agent IA via des ******tools******.
- ******Contrôle OAuth :****** L'accès aux données de l'utilisateur est sécurisé par le contrôleur ******OAuth Pipedream******. L'agent utilise un jeton d'accès pour agir au nom de l'utilisateur connecté.
