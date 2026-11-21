# Limova Team dans Chrome (TEAM-724)

L’extension se connecte à Limova Team comme un appareil, à côté de Limova Desktop. L’agent de Limova Team peut alors lire et agir dans le Chrome de la personne, dans le groupe d’onglets « Limova Team » uniquement. Le contrat fait foi : `docs/browser-device-protocol.md` (protocole `browser.v1`) et `docs/desktop-device-protocol.md` (socket, codes de fermeture, `set_autonomy`) dans le dépôt team-backend. Côté serveur, la fonction est derrière `desktop_devices_enabled` et `browser_devices_enabled`.

## Modules (`src/team/`)

| Fichier | Rôle |
|---|---|
| `products.js` | Produits connus et leurs origines fixes, sites bloqués, URL réduites à `origin + pathname`. |
| `connections.js` | Une connexion par produit dans `chrome.storage.local` (`limova_connections_v1`), révocation `DELETE /api/v1/devices/me`. |
| `pairing.js`, `pair-callback.html/.js` | Appairage PKCE par un onglet normal du tableau de bord et une page de retour de l’extension. |
| `device-socket.js` | WebSocket `limova-device.v1`, hello, ping 25 s, état, appels, cache 10 min, reconnexion et codes 4401/4404/4409/4400. |
| `team-controller.js` | Autonomie, accords, prise de main, « Tout arrêter », `set_autonomy`, `browser_control`. |
| `risk.js` | Lecture du risque d’une action, choix « exécuter » ou « demander », vérification de `target`. |
| `browser-engine.js` | Outils `browser.*`, groupe d’onglets, vérification après action, captures. |
| `page-snapshot.js`, `page-actions.js` | Fonctions injectées dans le monde isolé de l’onglet : carte de page, actions, messages affichés. |
| `approvals.js`, `approval.html/.js` | Petite fenêtre « Autoriser » / « Refuser », et choix d’un onglet pour `browser.request_tab`. |
| `team-panel.js/.css` | Section « Connexions » du panneau latéral, bandeau d’activité. |
| `team-service.js` | Assemblage dans le service worker, badge, alarme de reconnexion. |

## Essayer en local

1. `npm ci`, puis `npm run build` ; ou utiliser le dossier non empaqueté fourni avec la PR.
2. `chrome://extensions` → « Mode développeur » → « Charger l’extension non empaquetée » → choisir le dossier.
3. Ouvrir le panneau, menu ⋮ → « Connexions » (ou « Connexions Limova Team » sur l’écran de connexion de Charly), choisir l’environnement, « Connecter », puis approuver sur le tableau de bord.

La clé du manifeste donne toujours l’identifiant `fpkgfhhomlijmhbgcpbpjnfafdedfccj`, celui que le tableau de bord reçoit dans `extension_id`.

## Ajouter le produit « Limova »

Ajouter une entrée dans `PRODUCTS` (`products.js`) avec ses origines, sa couleur et son groupe d’onglets, ajouter ses origines à la CSP et à `web_accessible_resources` du manifeste (et aux contrôles de `scripts/validate-package.mjs`). Le panneau affiche alors une seconde carte sans autre changement ; la connexion, le jeton, le groupe d’onglets et la carte de page sont séparés par produit.
