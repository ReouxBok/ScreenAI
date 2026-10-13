# Qualification de la connexion Limova en staging

Le paquet staging sert à vérifier la session de l’app et le chemin Deep Agent sans mélanger les données locales avec l’extension de production. Il ne constitue pas encore la livraison finale de la migration.

## Construire

```sh
npm run build
npm run build:staging
npm run validate:package
npm run validate:staging
```

| Paquet | Dossier à charger | Archive | App / API |
|---|---|---|---|
| Production | `build/` | `dist/limova-ai-extension-2.2.48.zip` | `new.limova.ai` / `api.new.limova.ai` |
| Staging | `build-staging/` | `dist/limova-ai-extension-2.2.48-staging.zip` | `staging.new.limova.ai` / `api.staging.new.limova.ai` |

Le build choisit uniquement `production` ou `staging` ; aucune URL arbitraire n’est acceptée. Les fichiers sources restent configurés pour production. La configuration du paquet et la passerelle isolée sont générées ensemble puis contrôlées. L’identité Chrome de production est conservée ; staging possède une clé publique distincte et stable. Les deux installations peuvent coexister avec des `chrome.storage.local` et bases IndexedDB séparés.

Le paquet staging n’autorise que l’app et l’API staging. Sa CSP empêche les requêtes vers l’API, le Studio et le proxy de production, même si du code legacy est encore présent. Les anciens parcours Studio/voix ne sont donc pas qualifiés par ce paquet ; leur migration et leurs endpoints de qualification restent à terminer. Aucun nouveau feature flag n’est créé : l’activation dépend toujours de `is_charly_extension_enabled` renvoyé par le backend ciblé.

## Installer pour vérifier une session réelle

1. Dans le profil Chrome déjà connecté à l’app staging, ouvrir le gestionnaire d’extensions.
2. Activer le mode développeur si nécessaire, puis « Charger l’extension non empaquetée ».
3. Sélectionner `/Users/reouven/ScreenAI/build-staging` ; vérifier le nom **Limova AI — Staging**. Ne pas remplacer l’extension de production.
4. Ouvrir l’app staging, puis le panneau de cette extension. La session doit être reconnue sans OTP ni copie de cookie. Un espace non activé doit rester indisponible ; ne pas activer le flag pour contourner cette vérification.
5. Vérifier le compte/espace affichés avant tout envoi. Le premier contrôle peut s’arrêter à l’identité et à l’état du flag, sans créer de conversation ni solliciter un modèle.

La passerelle conserve le contexte first-party de l’app. Elle réutilise son onglet ou le rouvre en arrière-plan ; cet onglet est nécessaire pendant une requête. Fermer un onglet pendant un envoi l’interrompt et ne doit pas déclencher une répétition automatique. Le bouton de connexion réactive l’onglet préparé. Ne pas utiliser « Déconnexion » pendant une simple qualification : ce bouton déconnecte aussi la session Limova de cet environnement.

## Preuves locales et limites

```sh
npm run test:session:staging
npm run build
pnpm exec playwright test tests/e2e/limova-cookie-session.spec.js tests/e2e/environment-isolation.spec.js
```

Les tests HTTPS locaux utilisent de vrais cookies Partitioned et des identités synthétiques. Ils couvrent session/refresh, comptes concurrents, déconnexion, SSE, multipart, annulation, coupure d’onglet et destinations interdites. Le test de coexistence charge réellement les deux extensions et écrit des valeurs distinctes dans leurs stockages local et IndexedDB. Le test CSP staging mappe les destinations production vers le serveur local et vérifie qu’aucune requête ne l’atteint.

Ces tests ne prouvent pas encore le partage de session d’un compte réel, la configuration du déploiement, la rotation concurrente avec l’app réelle ni la chaîne complète jusqu’au modèle. Les PR restent en draft ; rien n’est fusionné, déployé ou activé par la construction des paquets.
