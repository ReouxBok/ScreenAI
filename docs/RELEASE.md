# Release de l’extension

```bash
npm ci
npm run test:all
npm run build
```

Le paquet production et son SHA-256 sont générés dans `dist/`. Le build vérifie le manifest, les permissions, la CSP, les bridges first-party et la présence des ressources.

Avant publication, qualifier un compte réel sur un workspace pilote activé par `is_charly_extension_enabled` : connexion Limova, conversations, texte, voix, navigateur, mémoire en lecture/écriture, intégration et contenu Studio MCP. Vérifier les traces LangSmith correspondantes.

La publication Chrome Web Store, le déploiement API/Studio et l’activation du flag sont trois opérations distinctes. Le rollback immédiat consiste à désactiver le flag; conserver aussi le ZIP précédent pour un rollback Web Store.
