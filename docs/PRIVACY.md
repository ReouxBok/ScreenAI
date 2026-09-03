# Données et confidentialité de l’extension

Ce document sert de référence technique pour la fiche Chrome Web Store et la politique publique. La politique publique liée depuis l’extension est : <https://www.limova.ai/legal/politique-de-confidentialite>.

## Traitement IA soumis au consentement

Le panneau s’ouvre sans fenêtre de consentement. Un accord est demandé uniquement lorsque l’utilisateur déclenche sa première action IA : envoi d’un message, analyse de page ou démarrage vocal. Si l’utilisateur refuse, aucun contexte de page, message ou audio n’est envoyé à Gemini.

Après accord, Charly peut envoyer à Google Gemini :

- le titre et le chemin de la page Limova, sans query string ni fragment ;
- les libellés, rôles, états visibles et positions approximatives des éléments DOM ;
- l’état rempli/vide des champs, jamais leur valeur ;
- les erreurs et avertissements techniques après suppression des jetons, secrets, emails, téléphones et paramètres d’URL ;
- les métadonnées réseau récentes (type, durée, statut et chemin généralisé pour Limova ; origine seule pour un tiers), sans corps ni headers ;
- le message, un résumé compacté, jusqu’aux 24 événements récents utiles et les souvenirs personnels pertinents lorsque la personnalisation est active ; le fallback transitoire borne encore l’historique visible à 200 messages ;
- une capture masquée de la zone visible, uniquement sur demande ou après une cible introuvable, ambiguë ou un résultat inattendu ;
- l’audio, uniquement pendant une session vocale explicitement démarrée.

L’extension n’envoie jamais de mot de passe, clé API, valeur de formulaire ni enregistrement audio persistant. Une capture éventuelle est préparée hors écran, masque les champs, ne modifie pas la page et n’existe que pendant l’invocation Gemini. Elle n’est enregistrée ni dans Neon, ni dans Chrome, ni dans les logs. Le flux vocal reste en mémoire et s’arrête à la fermeture du panneau ou sur action de l’utilisateur.

## Actions sur la page

Gemini ne peut fournir que l’identifiant numérique d’un élément cartographié localement. Aucun sélecteur, script, clic par coordonnées ni URL distant n’est exécuté. Les navigations internes à faible risque nécessitent une commande explicite. L’envoi d’un message nécessite une demande explicite associée au bouton exact. Les suppressions, publications, paiements, autorisations OAuth et autres actions sensibles sont refusés localement ; une cible ambiguë entraîne une nouvelle observation puis une clarification.

## Cookies et analytics

L’extension ne lit, n’écrit et ne demande aucun cookie. Elle ne collecte aucun analytics produit et n’affiche donc pas de bannière cookies ou analytics. Les journaux techniques restent locaux dans `chrome.storage.session` jusqu’à la fermeture de la session Chrome. Ils excluent les conversations, réponses Gemini, transcriptions, audio, valeurs de formulaire, corps réseau et identifiants. Ils ne quittent l’appareil que si l’utilisateur choisit explicitement de les télécharger puis de les transmettre au support.

Le bouton « Vérifier Charly » contacte uniquement le endpoint public `/healthz` du proxy, sans authentification ni donnée utilisateur, afin de confirmer sa disponibilité.

## Checklist Chrome Web Store

- Déclarer « website content » et « user activity » uniquement selon les catégories exactes du formulaire CWS.
- Décrire Google Gemini comme prestataire de traitement et aligner la politique publique sur les flux ci-dessus.
- Cocher l’engagement Limited Use et ne pas utiliser les données pour la publicité ou le scoring.
- Fournir une justification distincte pour `storage`, `scripting`, `webNavigation`, `sidePanel` et les deux hôtes déclarés (application Limova et proxy IA). L’extension ne demande pas la permission sensible `tabs` ; l’authentification est appelée dans le contexte isolé de la page Limova.
- Vérifier la suppression/rétention dans les contrats et journaux du proxy avant publication.
