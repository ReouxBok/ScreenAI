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
| `vault.js` | TEAM-729 : clé ECDH P-256 par connexion (non exportable, en mémoire), ouverture du scellé de `browser.fill_secret`. |
| `login-offers.js`, `page-login-watch.js`, `save-login.html/.js` | TEAM-729 : repérer une connexion réussie, demander « Enregistrer cette connexion pour Limova ? », l’envoyer après « Enregistrer ». |
| `session-export.js` | TEAM-729 : « Envoyer ma session à Limova », un site à la fois, après consentement. |

## `browser.v2` (TEAM-726)

- Annoncé dans le `hello` à côté de `browser.v1`.
- Écran d’accueil : « Limova » (Charly, inchangé) ou « Limova Team » (un seul bouton « Se connecter »). Une personne déjà connectée à Charly ne voit pas ce choix ; « Changer de produit » y revient.
- Aucune fenêtre d’accord, à aucun niveau d’autonomie, sauf pour payer. Champs sensibles, sites bloqués, pause, prise de main et « Tout arrêter » restent appliqués. `set_autonomy` s’applique tout de suite ; une nouvelle connexion démarre en « Accès complet ».
- `include_page: true` sur `open_tab`, `navigate`, `scroll`, `click`, `fill`, `select`, `submit`, `download` et `batch` renvoie `data.page` (4000 caractères et 200 éléments par défaut).
- `browser.batch` : 1 à 20 étapes `fill` / `select` / `check` / `click` sur un même instantané, toutes vérifiées avant la première, arrêt à la première erreur, et une navigation termine le lot (`stale_snapshot` pour la suite).

## Connexions enregistrées et sessions (TEAM-729)

Contrat : `docs/login-vault.md` du dépôt team-backend (`browser.v1+vault`, `browser.v1+cookies`), derrière `login_vault_enabled` côté serveur.

- **Clé du coffre.** À chaque ouverture de la connexion, une nouvelle paire ECDH P-256 (WebCrypto, clé privée non exportable, en mémoire seulement, oubliée à la fermeture). Le `hello` annonce `browser.v1+vault` et `browser.v1+cookies` et porte `vault_key` (`kty`, `crv`, `x`, `y`).
- **`browser.fill_secret`.** Ouverture : ECDH → HKDF-SHA256 (sel = `call_id`, info = `limova-vault-fill.v1`) → AES-256-GCM avec l’AAD `limova-vault-fill.v1|<call_id>|<device_id>` (`device_id` du `ready`). Puis, dans l’ordre : groupe, pause et prise de main ; scellé (`secret_unreadable` pour un autre appel, un autre appareil ou une expiration) ; origine réelle de l’onglet, lue dans Chrome puis dans la page, égale à `args.origin` et à l’une des origines scellées (`origin_mismatch`) ; identifiants de l’instantané (`stale_snapshot`, `element_not_found`) et nature des champs (`invalid_args`) ; destination du formulaire, `formaction` compris (`origin_mismatch`). Chaque champ est revérifié juste avant d’être tapé, car les scripts de la page s’exécutent pendant les événements du champ précédent. Réponse : `ActionResult`, `filled`, `page` si demandé, jamais une valeur. `browser.fill` et `browser.batch` refusent toujours les champs sensibles.
- **Proposer d’enregistrer.** Observateur injecté dans le monde isolé des onglets du groupe (et des autres onglets si la case « Proposer aussi d’enregistrer mes connexions dans mes onglets » est cochée). Connexion réussie = navigation ou disparition du champ dans les 10 s, sans retour du formulaire. Pas sur `http:`, les sites bloqués, un formulaire d’inscription, juste après un remplissage par Limova ni sur la liste « Jamais pour ce site ». `GET /devices/me/login-secrets?origin=` choisit entre « Enregistrer cette connexion pour Limova ? » et « Mettre à jour la connexion enregistrée ? » (un 404 coupe la proposition 10 minutes) ; la fenêtre ne reçoit qu’un identifiant opaque ; « Enregistrer » envoie `POST /devices/me/login-secrets`. Mot de passe en mémoire deux minutes au plus. Après « Pas maintenant », le site n’est plus proposé pendant 10 minutes.
- **« Envoyer ma session à Limova ».** Dans le panneau, site de l’onglet courant proposé, modifiable ; le service worker le ramène au domaine enregistrable, l’écran de consentement nomme ce domaine, puis `chrome.cookies.getAll({ domain })` et `POST /devices/me/session-profiles` (300 cookies et 256 Kio au plus, LinkedIn et Limova refusés).
- **`import_sessions`.** Réservé à Limova Desktop : l’extension répond toujours `cancelled`, les cookies sont déjà dans Chrome.

## Environnements

- Version publique (`npm run build`) : production uniquement, aucun choix affiché.
- Version de test pour la préproduction : `LIMOVA_TEAM_ENV=staging npm run build` réécrit `src/team/build-config.js` dans `build/` seulement et nomme l’archive `limova-ai-extension-<version>-team-staging.zip`.
- Réglage développeur : `chrome.storage.local.set({ limova_team_developer_v1: true })` dans la console du service worker affiche le choix d’environnement dans le panneau, sur n’importe quelle version.

## Essayer en local

1. `npm ci`, puis `npm run build` (ou `LIMOVA_TEAM_ENV=staging npm run build`) ; ou utiliser le dossier non empaqueté fourni avec la PR.
2. `chrome://extensions` → « Mode développeur » → « Charger l’extension non empaquetée » → choisir le dossier.
3. Ouvrir le panneau, choisir « Limova Team », « Se connecter », puis se connecter sur le tableau de bord.

La clé du manifeste donne toujours l’identifiant `fpkgfhhomlijmhbgcpbpjnfafdedfccj`, celui que le tableau de bord reçoit dans `extension_id`.

## Ajouter le produit « Limova »

Ajouter une entrée dans `PRODUCTS` (`products.js`) avec ses origines, sa couleur et son groupe d’onglets, ajouter ses origines à la CSP et à `web_accessible_resources` du manifeste (et aux contrôles de `scripts/validate-package.mjs`). Le panneau affiche alors une seconde carte sans autre changement ; la connexion, le jeton, le groupe d’onglets et la carte de page sont séparés par produit.
