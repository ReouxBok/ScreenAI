# Déploiement et publication

## Extension 2.2.63 — clics sur les champs et fenêtres superposées

Les champs texte, date, heure, les zones de texte et les éditeurs peuvent recevoir un clic même sans `tabindex` explicite. Le focus constaté sur un champ compte comme un effet du clic, sans valider l’envoi du formulaire. La détection des fenêtres bloquantes suit les mêmes critères que la carte de page ; une simple classe CSS « popup » ou « overlay » ne suffit plus.

Les rejets de clic remontent un code précis (cible masquée, désactivée, absente ou contexte périmé) dans le résultat de l’outil et les diagnostics, sans journaliser le texte de la page. GPT Live, Marin en français, les permissions et les niveaux d’autonomie sont conservés.

Correctif limité à l’extension : le proxy v81 est compatible et ne nécessite aucun redéploiement. Soumettre `dist/limova-ai-extension-2.2.63.zip` après validation ; remplacer l’examen en attente de la 2.2.62 si nécessaire.

## Extension 2.2.62 — autonomie, accord vocal et formulaires rapides

Les accords vocaux naturels reprennent une action en attente une seule fois. Une réponse ambiguë conserve la carte d’approbation ; un refus ou une modification explicite l’annule. Le mode « Accès complet » accepte les étapes ordinaires d’une tâche vocale dont la cible a été vérifiée, sans exiger que le membre prononce le libellé exact du bouton final. Les restrictions explicites du membre et les contrôles des cibles sont conservés.

La capacité `batch_fields` active `fill_fields` et le raisonnement `low` du backend GPT-6 Luna. Chaque champ passe par les validations existantes ; un échec arrête le lot. Les anciens clients ne reçoivent pas ce nouvel outil. Les animations sont raccourcies et les clics ayant déjà un effet visible n’attendent plus systématiquement 700 ms.

Les champs natifs `date`, `time` et `datetime-local` acceptent leur format canonique. Le navigateur valide la valeur et ses contraintes avant toute modification ; une valeur invalide ne vide pas le champ existant.

Déployer le proxy avant de soumettre `dist/limova-ai-extension-2.2.62.zip`. Le dossier du bureau utilise un proxy local distinct. Une validation locale ne constitue pas une publication au Store.

## Extension 2.2.61 — continuité des consignes vocales

Ce correctif conserve la tâche et la consigne complète après une pause vocale, évite les doubles résultats d’outils lors d’une interruption et distingue une commande rejetée d’une coupure de session. GPT Live et la voix Marin sont conservés.

Le paquet `dist/limova-ai-extension-2.2.61.zip` doit remplacer la 2.2.60 soumise au Chrome Web Store et faire l’objet d’un nouvel examen pour être distribué. Ce correctif concerne uniquement l’extension ; le proxy v80 reste compatible. Le dossier local du bureau doit être rechargé dans `chrome://extensions/` pour afficher la nouvelle version.

## Extension 2.2.60 — GPT Live et autonomie

Le paquet standard utilise GPT Live (`gpt-live-1`), la voix Marin et un backend délégué `gpt-6-luna`. Le proxy conserve `/api/live-token` pour les anciens clients Gemini.

Ordre de publication :

1. Fusionner les correctifs de l’extension et du proxy sur `main` après validation.
2. Comparer l’arbre `proxy/` au commit Heroku courant, puis déployer uniquement ce sous-arbre en fast-forward.
3. Vérifier `/healthz` : `voiceConfigured: true`, `voiceModel: gpt-live-1` et `voiceProtocol: gpt_live_webrtc_v1`. Vérifier aussi l’authentification, une session WebRTC et les outils de page.
4. Soumettre `dist/limova-ai-extension-2.2.60.zip` au Chrome Web Store après contrôle du checksum. Ce paquet utilise le proxy de production ; le dossier « Charly GPT Live FR » du bureau reste un laboratoire local distinct.

Le niveau par défaut est « Approuver pour moi ». Les niveaux « Demander une approbation » et « Accès complet » sont mémorisés localement. Une confirmation reprend l’action en attente une seule fois ; un changement de consigne, un arrêt ou une expiration l’annule.

Le sélecteur d’autonomie se trouve à côté de la zone de saisie. L’analyse manuelle de la page reste disponible dans le menu ; les navigations et changements de page continuent d’actualiser le contexte automatiquement.

Une soumission au Chrome Web Store reste en attente de la validation Google ; elle ne prouve pas que les utilisateurs ont déjà reçu la version.

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
