---
title: "Impossible de connecter un compte Outlook"
slug: "impossible-de-connecter-un-compte-outlook"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/impossible-de-connecter-un-compte-outlook"
keywords: ["nbsp","compte","email","span","outlook","microsoft","365","code","com","class"]
related_urls: ["/integrations/gmail","/integrations/outlook","/integrations/microsoft","/settings/security","/settings"]
---

# Impossible de connecter un compte Outlook

# Impossible de connecter un compte Outlook

## ❌ Impossible de connecter mon compte Outlook

### Le problème
Vous essayez de connecter votre compte Outlook dans&nbsp;******Intégrations******, mais la connexion échoue ou ne fonctionne pas.
&nbsp;

### 🔍 Cause
Pour que la connexion Outlook fonctionne, votre compte doit être un&nbsp;******compte principal hébergé directement sur Microsoft 365******.
&nbsp;

### ✅ Ce qui fonctionne

&nbsp;&nbsp;******Comptes compatibles :******

- ✅<a href="mailto:prenom.nom@outlook.com" class="LexTKB__link" dir="ltr"><code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">prenom.nom@outlook.com</span></code></a>
- ✅<a href="mailto:prenom.nom@hotmail.com" class="LexTKB__link" dir="ltr"><code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">prenom.nom@hotmail.com</span></code></a>
- ✅<a href="mailto:entreprise@votredomaine.fr" class="LexTKB__link" dir="ltr"><code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">entreprise@votredomaine.fr</span></code></a>(si géré par&nbsp;******Microsoft 365******)
- ✅ Comptes Microsoft 365 Business/Enterprise
&nbsp;&nbsp;******Vérification :******
- Connectez-vous sur&nbsp;outlook.com&nbsp;ou&nbsp;office.com
- Si vous accédez directement à votre boîte mail → Compatible ✅
&nbsp;
### ❌ Ce qui ne fonctionne PAS

&nbsp;&nbsp;******Comptes incompatibles :******

- ❌&nbsp;******Alias******&nbsp;(adresses secondaires)
- ❌ Comptes email hébergés sur&nbsp;******OVH******
- ❌ Comptes email hébergés sur&nbsp;******Zimbra******
- ❌ Comptes email hébergés sur&nbsp;******cPanel******
- ❌ Serveurs email personnalisés (non Microsoft)
&nbsp;&nbsp;******Même si votre adresse se termine par******<span style="font-size: 15px; white-space: pre-wrap;">@votredomaine.fr</span>******:******
- Si elle n'est&nbsp;******pas hébergée sur Microsoft 365******&nbsp;→ Incompatible ❌
&nbsp;
### 🔧 Comment vérifier si votre compte est sur Microsoft 365 ?

&nbsp;&nbsp;******Test simple :******

- Allez sur&nbsp;office.com
- Connectez-vous avec votre email
- ******Si vous accédez à Outlook en ligne******&nbsp;→ Compte Microsoft 365 ✅
- ******Si erreur ou redirection ailleurs******&nbsp;→ Compte non Microsoft 365 ❌
&nbsp;
### ✅ Solution alternative : Connexion IMAP

&nbsp;&nbsp;******Si votre compte n'est PAS sur Microsoft 365 :******
&nbsp;
Utilisez la&nbsp;******connexion IMAP******&nbsp;pour connecter votre email à Limova :
&nbsp;&nbsp;******Étapes :******

- ******Intégrations******&nbsp;&gt; Recherchez&nbsp;******IMAP******&nbsp;ou&nbsp;******Email IMAP******
- Renseignez vos paramètres IMAP :
- 
- ******Serveur IMAP******&nbsp;: (ex:<code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">imap.ovh.net</span></code>,<code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">mail.votredomaine.fr</span></code>)
- ******Port******&nbsp;: 993 (généralement)
- ******Email******&nbsp;:&nbsp;votre@email.com
- ******Mot de passe******&nbsp;: votre mot de passe email
- ******SSL******&nbsp;: Activé
- Connectez
&nbsp;&nbsp;******Où trouver vos paramètres IMAP ?******
- Contactez votre hébergeur email (OVH, Zimbra, etc.)
- Consultez la documentation de votre service email
- Généralement disponibles dans les paramètres de votre compte
&nbsp;
### 💡 Recommandation

&nbsp;&nbsp;******Pour une intégration optimale avec Limova :******
&nbsp;
Si vous utilisez beaucoup l'automatisation email, envisagez de :

- ✅ Migrer vers&nbsp;******Microsoft 365******&nbsp;(meilleure intégration)
- ✅ Ou utiliser&nbsp;******Gmail******&nbsp;(également bien intégré)
&nbsp;&nbsp;******Avantages Microsoft 365/Gmail :******
- 🔄 Synchronisation automatique
- ⚡ Connexion OAuth sécurisée (pas de mot de passe stocké)
- 🎯 Toutes les fonctionnalités Limova disponibles
- 📊 Meilleure fiabilité
&nbsp;
