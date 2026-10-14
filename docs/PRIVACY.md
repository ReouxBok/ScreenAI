# Données et confidentialité

L’extension demande un consentement avant le premier message, tour navigateur ou démarrage vocal. Elle utilise ensuite la session Limova first-party sans lire, copier ou stocker les cookies et refresh tokens.

Le Deep Agent peut recevoir le message, l’audio de la session active, le titre et le chemin sans query string, une représentation DOM filtrée et une capture dont les champs et zones privées sont masqués. Les valeurs de formulaire, mots de passe, OTP, clés et secrets sont exclus des lectures de page.

La mémoire, les conversations et les intégrations appartiennent au compte et au workspace Limova. Elles suivent les politiques du backend principal. L’extension ne possède plus de mémoire, compte OTP ou backend IA séparé.

En mode formateur, le Studio reçoit les libellés et métadonnées des contrôles, l’indication qu’un champ a été rempli, et des résultats réseau limités à la méthode, au chemin généralisé, au statut et à la durée. Il ne reçoit pas la valeur saisie. L’enregistrement d’écran et de voix n’est lancé qu’après l’action explicite du formateur.

Les journaux techniques locaux sont stockés dans `chrome.storage.session`. Ils excluent les conversations, transcriptions, audio, DOM, corps réseau, cookies et tokens. Aucun analytics produit n’est collecté par l’extension.

La politique publique de référence est <https://www.limova.ai/legal/politique-de-confidentialite>.
