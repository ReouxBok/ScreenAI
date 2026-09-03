# Passage en production

## État vérifié

- Le backend de production publie `POST /extension/token` et `GET /.well-known/jwks.json` depuis le merge `fcece8a` de la PR `Limova-2-0/api#1639`.
- Le JWKS répond `200` avec une seule clé RSA `RS256` publique (`kid: limova-extension-2026-07`) et aucune composante privée.
- Le proxy Heroku `limova-proxy` exécute la release `v16`. `/api/gemini` et `/api/live-token` répondent `401` sans JWT, une origine non autorisée reçoit `403` et `/healthz` répond `200`.
- La chaîne de confiance production a été testée avec un JWT `RS256` éphémère signé par la clé Render : le proxy charge le JWKS enveloppé par l’API, accepte la signature/issuer/audience et poursuit jusqu’à la validation du payload.
- L’extension utilise `https://api.new.limova.ai/extension/token` dans le contexte de la page connectée et accepte l’enveloppe standard de l’API.
- Le ZIP final est produit par le build validant explicitement `src/sidebar/sidebar.html`; le test d’installation visuel dans Chrome reste le dernier contrôle manuel avant téléversement CWS.

## Ordre de déploiement

1. Générer une clé RSA 2048 bits PKCS#8 dédiée. Ne jamais la committer.
2. Configurer l’API Render avec :
   - `EXTENSION_JWT_ISSUER=https://api.new.limova.ai`
   - `EXTENSION_JWT_KEY_ID=limova-extension-YYYY-MM`
   - `EXTENSION_JWT_PRIVATE_KEY_BASE64=<clé privée PKCS#8 encodée en base64>`
3. Faire relire, fusionner et déployer la branche backend.
4. Vérifier que le JWKS répond `200`, contient une clé RSA publique et aucune propriété privée (`d`, `p`, `q`, `dp`, `dq`, `qi`).
5. Vérifier que `POST /extension/token` répond `401` sans session et émet un JWT de cinq minutes avec une session Limova valide.
6. Configurer le proxy Heroku `limova-proxy` avec :
   - `ALLOWED_EXTENSION_ID=fpkgfhhomlijmhbgcpbpjnfafdedfccj`
   - `LIMOVA_JWT_ISSUER=https://api.new.limova.ai`
   - `LIMOVA_JWT_AUDIENCE=limova-extension`
   - `LIMOVA_JWKS_URL=https://api.new.limova.ai/.well-known/jwks.json`
7. Déployer le contenu de `proxy/`, vérifier `/healthz`, puis confirmer que `/api/gemini` répond `401` sans bearer token.
8. Installer le ZIP final dans Chrome, tester texte, voix, interruption, reprise et confirmations d’action avec un compte réel.
9. Publier la politique de confidentialité mise à jour avant la soumission CWS.

## Critères de rollback

- Ne pas publier l’extension si le JWKS ou `/healthz` ne répond pas `200`.
- Ne pas laisser le proxy en production s’il accepte `/api/gemini` sans JWT.
- En cas d’échec après déploiement du proxy, revenir à la release Heroku précédente uniquement le temps de corriger, puis désactiver l’ancienne route ouverte dès que possible.
