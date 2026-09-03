# Déploiement et publication

## Extension 2.2.44 et Studio

La CI obligatoire exécute les audits de sévérité haute, les tests unitaires de l’extension, du Studio et du proxy, le typage, le lint, le build Next.js, les parcours Playwright et la validation du paquet. Le build final produit :

```text
dist/limova-ai-extension-2.2.44.zip
dist/limova-ai-extension-2.2.44.zip.sha256
```

Le Studio est déployé depuis le dossier Git `studio/`. Une préproduction doit être vérifiée avant promotion de l’exact même déploiement en production.

## État production au 31 juillet 2026

- API Render déployée sur le merge `fcece8a` de la PR `#1639`.
- JWKS public vérifié : RSA 2048 bits, `RS256`, aucune donnée privée.
- Proxy Heroku déployé en release `v9`, Node `24.x`, authentification JWT active et CORS limité à l’ID CWS `fpkgfhhomlijmhbgcpbpjnfafdedfccj`.
- Chaîne cryptographique API → JWKS → proxy testée en production.
- Suite extension : 163 tests Vitest et 36 parcours Chrome Playwright passants pour la version 2.2.3.

## Contrat d’authentification requis côté Limova

L’API `https://api.new.limova.ai` doit exposer `POST /extension/token`. L’appel est exécuté dans le contexte de la page Limova connectée afin que le cookie `HttpOnly` partitionné reste inaccessible à l’extension. La réponse standard de l’API contient :

```json
{
  "data": {
    "accessToken": "<JWT signé>",
    "expiresIn": 300
  }
}
```

Le JWT doit contenir `iss`, `aud: "limova-extension"`, `sub`, `iat` et `exp` (durée recommandée : 5 minutes, maximum : 15 minutes). La clé publique correspondante doit être publiée sur une URL JWKS HTTPS. L’extension conserve ce jeton uniquement en mémoire.

Variables de l’API Limova :

```text
EXTENSION_JWT_ISSUER=https://api.new.limova.ai
EXTENSION_JWT_KEY_ID=limova-extension-YYYY-MM
EXTENSION_JWT_PRIVATE_KEY_BASE64=<clé RSA PKCS#8 encodée en base64>
```

Variables du proxy :

```text
GEMINI_API_KEY=...
ALLOWED_EXTENSION_ID=...
LIMOVA_JWT_ISSUER=https://api.new.limova.ai
LIMOVA_JWT_AUDIENCE=limova-extension
LIMOVA_JWKS_URL=https://api.new.limova.ai/.well-known/jwks.json
```

`AUTH_DISABLED=true` est réservé au développement local et ne doit jamais être configuré en production.

Ordre de déploiement sans interruption : configurer les trois variables de l’API, déployer et vérifier le JWKS, configurer ensuite le proxy avec l’issuer/JWKS et l’ID CWS, déployer le proxy, puis publier l’extension. Le proxy public historique ne doit pas rester accessible sans JWT.

## Construction CWS

```bash
npm ci
npm ci --prefix proxy
npm test
npm run test:e2e
npm run build
```

Le build valide chaque chemin du manifest et chaque ressource HTML avant de zipper. Il vérifie ensuite l’intégrité de l’archive et la présence exacte de `manifest.json` et `src/sidebar/sidebar.html` à sa racine. Le fichier à téléverser est le ZIP versionné présent dans `dist/`; son checksum doit correspondre au fichier `.sha256` voisin.

## Gates avant publication

- Déployer le proxy avec JWT/JWKS actifs et tester un compte réel.
- Vérifier que le modèle texte et le modèle Live sont disponibles dans le projet Google utilisé.
- Tester le micro, l’interruption vocale et chaque classe d’action sur Chrome stable.
- Mettre à jour la politique publique avec les traitements décrits dans `docs/PRIVACY.md`.
- Aligner la fiche CWS, les captures, la vidéo éventuelle et les permissions sur le comportement réel.
- Inscrire le bon `ALLOWED_EXTENSION_ID` de production, puis reconstruire et tester l’archive finale.
