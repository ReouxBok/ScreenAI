# Essai local GPT Live en français

1. `node scripts/local/build-gpt-live.mjs`
2. `node scripts/local/run-gpt-live.mjs` (laisser le terminal ouvert).
3. Dans `chrome://extensions`, activer le mode développeur, choisir **Charger l'extension non empaquetée** et sélectionner le dossier `build/gpt-live` de ce worktree.
4. Ouvrir une page web, puis le panneau de **Charly — GPT Live local (FR)** et démarrer la voix. Accepter le consentement IA et la permission du micro.

Le proxy écoute uniquement sur `127.0.0.1:4317`. La clé OpenAI est chargée en mémoire via la configuration Heroku en lecture seule ; elle n'est jamais écrite dans la build. L'extension locale possède un identifiant distinct. Elle utilise `gpt-live-1`, la voix `marin` et une consigne de français de France. Le modèle est hébergé par OpenAI ; les appels API sont facturés normalement.

Cette build est réservée au développement : authentification locale, statistiques désactivées côté serveur et mémoire distante désactivée. Les captures masquées demandées par les outils sont transmises au modèle visuel du backend, après réduction pour le canal WebRTC. La reconnexion demande de relancer manuellement la voix.

Ne pas publier cette build sur le Chrome Web Store. Le script de build de production ne charge pas `voice-openai.js`. Aucun changement de configuration de production n'est effectué par ces commandes.

Le contexte de page GPT Live n'est pas tronqué à 12 000 caractères, ni au démarrage ni lors des lectures et mises à jour. La carte DOM conserve tous les contrôles extraits, y compris ceux au-delà des 150 premières entrées. Le filtrage des surfaces masquées et des données sensibles reste actif.

Les sélections réversibles utilisent `set_control_state` et leur état observé. `verify_expected_result` attend des conditions explicites (`text_present`, `url_path`, `control_checked`) et distingue relecture et confirmation. Chaque nouvelle prise de parole invalide les anciens appels en attente ; les corrections restent accessibles au backend dans l'historique. Les diagnostics séparent la connexion vocale et la dernière condition vérifiée.

Pour sélectionner un contrôle nommé, `select_control` relit la page, recherche une correspondance unique, fixe l'état et vérifie la sélection dans un seul appel. La réponse contient la preuve ciblée ; la carte complète reste disponible via l'inspection. Les cases natives transparentes sont prises en charge lorsqu'un libellé ou un habillage visible permet de les activer. Les contrôles cachés, désactivés et ambigus restent refusés. Le proxy local active un mode de pilotage sans questionnaire d'onboarding.

L'intégration conserve les correctifs 2.2.57 de `main` (envois explicitement demandés, liens externes et suivi du nouvel onglet ouvert par un clic). Gemini reste le fournisseur de la build standard ; GPT Live est chargé uniquement par ce script local. Les changements de contrat de vérification concernent à la fois l'extension et le proxy : une future publication doit coordonner ces deux composants. Fusionner ce code ne publie pas une version Chrome Web Store et ne déploie pas le proxy Heroku.
