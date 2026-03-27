---
title: "Créer un Agent de Standard Téléphonique avec Tom"
slug: "creer-un-agent-de-standard-telephonique-avec-tom"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/creer-un-agent-de-standard-telephonique-avec-tom"
keywords: ["nbsp","transfert","numero","tom","agent","voix","standard","appels","support","telephonique"]
related_urls: ["/agents","/settings"]
---

# Créer un Agent de Standard Téléphonique avec Tom

# Créer un Agent de Standard Téléphonique avec Tom

## 📞 Agent de Standard Téléphonique IA

### L'essentiel
Créez un agent vocal IA qui répond automatiquement à vos appels entrants avec voix naturelle ElevenLabs et intelligence conversationnelle.
&nbsp;

### 🚀 Comment créer Tom ?

&nbsp;&nbsp;******Méthode rapide :******

- ******Super Pouvoirs******&nbsp;&gt;&nbsp;******Tom - Standard Téléphonique******
- Configurez votre agent :
- 
- ******Nom******&nbsp;: "Standard [Votre Entreprise]"
- ******Instructions******&nbsp;: Rôle et comportement de l'agent
- ******Voix IA******&nbsp;: Choix parmi voix ElevenLabs
- ******Langue******&nbsp;: Français (ou autre)
- ******Message d'accueil******&nbsp;: "Bonjour, [Entreprise], comment puis-je vous aider ?"
- ******Mode salutation******&nbsp;: Agent parle en premier OU attend l'appelant
- ******Durée max******&nbsp;: 1-60 minutes (nous recommandons 4 minutes)
- ******Numéro téléphone******&nbsp;: Votre numéro Twilio (format E.164)
- Ajoutez des outils (transferts, FAQ, etc.)
- Créez l'agent
&nbsp;&nbsp;******⚠️ Important :******&nbsp;Tom se crée UNIQUEMENT via Super Pouvoirs, pas dans le chat.
&nbsp;
### 📞 Configuration du numéro

&nbsp;&nbsp;******3 numéros dans le fonctionnement de Tom :******
&nbsp;&nbsp;******1. Numéro fourni par Limova (numéro étranger)******

- Trouvez-le dans&nbsp;******Paramètres******&nbsp;&gt;&nbsp;******Numéro de téléphone******&nbsp;&gt;&nbsp;******Reconfigurer transfert******
- ⚠️&nbsp;******DOIT commencer par +1 ou **21*******
- ⚠️&nbsp;******DOIT être envoyé au support******&nbsp;:&nbsp;contact@limova.ai&nbsp;(configuration spéciale requise)
- ❌ Si ne commence pas par +1 ou **21* → Contactez immédiatement le support
&nbsp;&nbsp;******2. Votre numéro personnel/standard******
- Votre 06 ou numéro d'entreprise habituel
&nbsp;&nbsp;******3. Numéro de transfert******
- Configuré par l'équipe Limova après envoi du numéro 1
### 🗣️ Ce que Tom peut faire

&nbsp;&nbsp;******Réception d'appels :******

- 📞 Répond automatiquement 24/7
- 💬 Conversation naturelle en langage humain
- 🎯 Qualifie les appels selon vos critères
- 📝 Prend des messages et notes
- 🏷️ Tague les appels (urgent, commercial, support, etc.)
&nbsp;&nbsp;******Actions intelligentes :******
- 🔄 Transfert vers numéro spécifique (conditions personnalisables)
- 📋 Répond aux FAQ avec base de connaissances
- 📅 Propose des créneaux de RDV
- 📧 Envoie des informations par email
- 🎵 Détection de messagerie vocale
&nbsp;

### 🔧 Outils de transfert

&nbsp;&nbsp;******Transfer to Number (Transfert vers numéro) :******
&nbsp;
Configurez des règles de transfert avec conditions :
&nbsp;&nbsp;******1. ADVISOR_REQUEST (Demande de conseiller)******

- Transfert automatique si l'appelant demande à parler à un humain
- Instruction personnalisée : "Transfert uniquement si demande urgente"
&nbsp;&nbsp;******2. UNHANDLED_ISSUE (Problème non géré)******
- Transfert si Tom ne peut pas résoudre le problème
- Instruction : "Transfert si la demande dépasse mes compétences"
&nbsp;&nbsp;******3. CRITICAL_STEP (Étape critique)******
- Transfert à un moment précis de la conversation
- Instruction : "Transfert après avoir qualifié le besoin et confirmé l'urgence"
&nbsp;&nbsp;******4. KEYWORDS (Mots-clés)******
- Transfert si certains mots sont prononcés
- Mots-clés : "urgent", "réclamation", "problème grave", "directeur"
&nbsp;&nbsp;******Exemple de configuration :******
Outil : Transfer to Number 
Numéro : +33612345678 (votre mobile) 
Condition : ADVISOR_REQUEST 
Instruction : "Transfert si l'appelant demande à parler 
à un commercial ou si c'est une opportunité business qualifiée" 

&nbsp;

### 📚 Base de connaissances

&nbsp;&nbsp;******Ajoutez des fichiers (max 20) :******

- 📄 FAQ de votre entreprise
- 📋 Scripts de réponse
- 📊 Informations produits/services
- 💰 Tarifs et conditions
- 📍 Horaires et localisation
&nbsp;
→ Tom utilise ces infos pour répondre précisément aux questions
&nbsp;
### 🏷️ Tags de qualification

&nbsp;&nbsp;******Configurez des tags pour évaluer les appels :******
&nbsp;&nbsp;******Exemple :******

- 🟢 "Opportunité commerciale" → Si demande de devis, intérêt produit
- 🔵 "Support technique" → Si problème technique, bug
- 🟡 "Information générale" → Si question simple, horaires
- 🔴 "Réclamation" → Si plainte, insatisfaction
- ⚪ "Spam" → Si appel publicitaire, robot
&nbsp;&nbsp;******Prompt de qualification :******

"Évalue cet appel :
- Tag 'Opportunité commerciale' si : demande devis, veut acheter
- Tag 'Support technique' si : problème produit, bug
- Tag 'Réclamation' si : plainte, insatisfaction
- Tag 'Information' si : question simple" 
### 🎭 Personnalisation de la voix

&nbsp;&nbsp;******Choix de voix ElevenLabs :******

- 🎤 Voix masculines ou féminines
- 🌍 Plusieurs langues disponibles
- 🎯 Ton professionnel ou casual
- 🗣️ Voix naturelles et expressives
&nbsp;&nbsp;******Exemples de voix populaires :******
- Rachel : Voix féminine professionnelle
- Adam : Voix masculine chaleureuse
- Bella : Voix féminine douce

******Pour retrouver et modifier vos agents, rendez vous dans agents autonomes -&gt; Votre agent******

### 💡 Cas d'usage

&nbsp;&nbsp;******Standard d'entreprise :******

- Accueil téléphonique 24/7
- Qualification des appels
- Transfert vers services appropriés
- Prise de messages hors horaires
&nbsp;&nbsp;******Service client :******
- Réponses aux questions fréquentes
- Support niveau 1
- Escalade vers humain si nécessaire
- Enquêtes de satisfaction
&nbsp;&nbsp;******Prospection entrante :******
- Qualification des leads entrants
- Prise de RDV automatique
- Collecte d'informations
- Transfert vers commerciaux
&nbsp;&nbsp;******Cabinet médical/professionnel :******
- Prise de RDV
- Informations pratiques
- Gestion des urgences
- Messages hors horaires
&nbsp;
### ⚠️ Vérifications importantes

&nbsp;&nbsp;******Avant de créer Tom :******

- ✅ Vérifiez que votre numéro Limova commence par +1 ou **21*
- ✅ Envoyez ce numéro au support :&nbsp;contact@limova.ai
- ✅ Configurez votre numéro Twilio dans Paramètres
- ✅ Préparez votre base de connaissances (FAQ, scripts)
- ✅ Testez avec quelques appels d'abord
&nbsp;&nbsp;******Support technique :******
- ******Téléphone :******&nbsp;+33 4 23 45 00 96
- ******Email :******&nbsp;contact@limova.ai
&nbsp;

******Coût de Tom****** : - ******0,20€ par minute d'appel en France****** (pour les numéros français)

- Pour les autres pays, consultez la documentation tarifaire

### 🎯 Résultat attendu

&nbsp;&nbsp;******Disponibilité :******

- 📞 Réponse 24/7 sans interruption
- ⏱️ Pas d'attente pour l'appelant
- 🌍 Multilingue si configuré
&nbsp;&nbsp;******Efficacité :******
- 🎯 Qualification automatique de tous les appels
- 📝 Transcriptions et résumés immédiats
- 🔄 Transfert intelligent vers la bonne personne
- ⏱️ Économisez 20-40h/semaine de standard
&nbsp;&nbsp;******Qualité :******
- 💬 Conversations naturelles et professionnelles
- 📚 Réponses précises grâce à la base de connaissances
- 🏷️ Traçabilité complète des appels
- 📊 Statistiques et analytics
