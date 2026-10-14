# Passage en production

1. Qualifier l’API Limova avec un compte réel : session first-party, workspace activé, agent `charly`, création/reprise de conversation, mémoire et intégrations.
2. Qualifier le MCP Studio avec un contenu publié et revu, puis vérifier sa réponse dans un vrai run Deep Agent.
3. Vérifier les traces LangSmith et leur attribution `clientSurface=chrome_extension`.
4. Exécuter les suites unitaires et Playwright sur les builds production et staging.
5. Déployer l’API et le Studio sans activer le flag globalement.
6. Activer `is_charly_extension_enabled` sur un workspace pilote, effectuer le smoke texte/voix/navigateur/mémoire/intégration, puis élargir progressivement.
7. Publier le ZIP Chrome validé. Conserver le paquet précédent pour le rollback Web Store.

Le rollback immédiat consiste à désactiver le flag backend. Le paquet actuel ne contient aucun fallback vers le proxy historique.
