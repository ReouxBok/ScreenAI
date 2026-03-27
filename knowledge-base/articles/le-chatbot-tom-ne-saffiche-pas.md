---
title: "Le Chatbot Tom ne s'affiche pas"
slug: "le-chatbot-tom-ne-saffiche-pas"
url: "https://7dz0vo1hbc1iawf.productfruits.help/fr/article/le-chatbot-tom-ne-saffiche-pas"
keywords: ["nbsp","chatbot","google","sites","securite","url","code","affiche","site","console"]
related_urls: ["/integrations/shopify","/integrations/wordpress","/integrations/wix","/settings"]
---

# Le Chatbot Tom ne s'affiche pas

# Le Chatbot Tom ne s&#x27;affiche pas

## 🌐 Pourquoi mon chatbot ne s'affiche pas sur Google Sites ?

### Le problème
Vous avez intégré le code du chatbot Tom sur votre site Google Sites, mais il ne s'affiche pas ou ne fonctionne pas correctement.
&nbsp;

### 🔍 Explication technique

&nbsp;&nbsp;******Système de sécurité Limova :******

- 🔒 Le chatbot n'autorise que les&nbsp;******domaines validés******&nbsp;dans votre liste blanche
- ✅ Lors de la connexion, le système vérifie l'******URL d'origine******&nbsp;envoyée par le navigateur
- ❌ Si l'URL ne correspond pas à votre liste blanche → Erreur 403 (Interdit)
&nbsp;&nbsp;******Problème spécifique Google Sites :******
&nbsp;
Google Sites applique une sécurité qui&nbsp;******masque ou modifie l'URL réelle******&nbsp;lors de l'exécution de scripts externes :
&nbsp;
- ******URL instable******
- 
- Au lieu de votre adresse officielle (ex:<code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">monsite.com</span></code>)
- Google génère une URL technique aléatoire
&nbsp;
- ******Changement dynamique******
- 
- Cette URL technique change à chaque rechargement de page
- Impossible de la valider dans la liste blanche
&nbsp;
- ******Masquage de l'origine******
- 
- Google "cache" l'URL réelle de votre site
- Le chatbot ne peut pas vérifier le domaine
&nbsp;
→&nbsp;******Résultat :******&nbsp;Le chatbot bloque l'affichage pour des raisons de sécurité
&nbsp;
## ✅ Solutions possibles

### Solution 1 : Désactiver la sécurité Google Sites

&nbsp;&nbsp;******Objectif :******&nbsp;Permettre à Google Sites de transmettre votre URL réelle
&nbsp;&nbsp;******Étapes à vérifier :******
&nbsp;

- ******Accédez aux paramètres de votre Google Sites******
- 
- Console d'administration Google Sites
- Paramètres du site
&nbsp;
- ******Recherchez les options de sécurité******
- 
- Option "Partage de l'origine"
- "Sécurité des scripts tiers"
- "Autoriser les scripts externes"
&nbsp;
- ******Ajustez les paramètres******
- 
- Autorisez les scripts tiers à accéder à l'URL d'origine
- Désactivez le masquage de domaine si possible
&nbsp;
- ******Testez le chatbot******
- 
- Rechargez votre page
- Vérifiez si le chatbot s'affiche
&nbsp;
### Solution 2 : Utiliser une plateforme alternative

&nbsp;&nbsp;******Recommandation :******
&nbsp;
Si Google Sites ne permet pas de désactiver cette sécurité, le chatbot fonctionnera parfaitement sur :
&nbsp;&nbsp;******Plateformes compatibles :******

- ✅&nbsp;******WordPress******&nbsp;(recommandé)
- ✅&nbsp;******Wix******
- ✅&nbsp;******Webflow******
- ✅&nbsp;******Shopify******
- ✅&nbsp;******Site personnalisé******&nbsp;(HTML/CSS/JS)
- ✅&nbsp;******Squarespace******
- ✅&nbsp;******Joomla******
&nbsp;&nbsp;******Avantages :******
- 🔒 Contrôle total de la sécurité
- 🌐 URL stable et prévisible
- ⚡ Intégration immédiate du chatbot
- 🎨 Plus de flexibilité de design
&nbsp;
### Solution 3 : Validation de domaines multiples

&nbsp;&nbsp;******Si votre Google Sites génère plusieurs URLs :******
&nbsp;

- ******Identifiez toutes les URLs générées******
- 
- Ouvrez la console développeur (F12)
- Onglet "Network" ou "Réseau"
- Rechargez la page
- Notez toutes les URLs d'origine
&nbsp;
- ******Ajoutez-les à votre liste blanche******
- 
- Contactez le support Limova
- Fournissez la liste complète des URLs
- Nous les ajouterons à votre configuration
&nbsp;
⚠️&nbsp;******Limitation :******&nbsp;Si les URLs changent constamment, cette solution ne sera pas viable
&nbsp;
## 🔧 Vérifications à effectuer

### Avant de contacter le support

&nbsp;&nbsp;******1. Vérifiez votre domaine validé******

- Allez dans les paramètres de votre chatbot Tom
- Section "Domaines autorisés"
- Votre domaine Google Sites est-il bien listé ?
&nbsp;&nbsp;******2. Testez sur une autre plateforme******
- Créez une page HTML simple
- Intégrez le même code du chatbot
- Si ça fonctionne → Problème spécifique Google Sites
&nbsp;&nbsp;******3. Vérifiez la console développeur******
- Ouvrez votre site Google Sites
- Appuyez sur F12 (console développeur)
- Onglet "Console"
- Y a-t-il des erreurs 403 ou CORS ?
&nbsp;&nbsp;******4. Vérifiez le code d'intégration******
- Le code du chatbot est-il complet ?
- Pas de caractères manquants ?
- Bien placé avant la balise<code spellcheck="false" style="font-size: 15px; white-space: nowrap;"><span class="LexTKB__textCode">&lt;/body&gt;</span></code>?
&nbsp;
## 📞 Besoin d'aide ?

&nbsp;&nbsp;******Support Limova :******

- ☎️&nbsp;******+33 4 23 45 00 96******
- ✉️&nbsp;******contact@limova.ai******
- 🕐 Lun-Ven, 9h-18h (Paris)
&nbsp;&nbsp;******Informations à fournir :******
- URL de votre site Google Sites
- Capture d'écran de la console développeur (F12 &gt; Console)
- Capture d'écran des erreurs éventuelles
- Domaines validés dans votre configuration chatbot
&nbsp;
## 💡 Recommandation finale

&nbsp;&nbsp;******Pour une intégration optimale du chatbot :******
&nbsp;
Si vous rencontrez des difficultés persistantes avec Google Sites, nous recommandons fortement de&nbsp;******migrer vers WordPress******&nbsp;ou une autre plateforme compatible.
&nbsp;&nbsp;******Avantages de la migration :******

- ✅ Chatbot fonctionne immédiatement
- ✅ Plus de contrôle sur votre site
- ✅ Meilleures performances SEO
- ✅ Plus de flexibilité de design
- ✅ Pas de limitations techniques
&nbsp;&nbsp;******Nous restons à votre disposition pour vous accompagner dans cette transition si nécessaire.******
&nbsp;
## 🔒 Note sur la sécurité
Cette limitation de sécurité existe pour&nbsp;******protéger votre chatbot******&nbsp;:
&nbsp;

- 🛡️ Empêche l'utilisation non autorisée sur d'autres sites
- 🔐 Garantit que seuls VOS domaines peuvent utiliser VOTRE chatbot
- ⚡ Évite les abus et la surcharge de votre quota
&nbsp;
C'est une fonctionnalité de sécurité essentielle, pas un bug ! 🚀
