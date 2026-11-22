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

## « Montrer à Limova » (TEAM-731)

Contrat : `docs/procedure-recording-format.md` (team-backend), `limova.recording.v1`, et les modèles serveur `app/schemas/procedure_recording.py`, qui font foi.

| Fichier | Rôle |
|---|---|
| `recorder.js` | Cycle de vie (démarrer, pause, arrêter, relire, envoyer), navigations et leurs causes, onglets numérotés, `wait`, `observed`, envoi et erreurs (413, 422, 401, 404). |
| `page-recorder.js` | Fonctions injectées dans le monde isolé : écouteurs en phase de capture, une saisie par champ, valeurs secrètes jamais transmises, `observed` 600 ms à 3 s après l’action. |
| `recording-redaction.js` | Les règles de masquage, en un seul endroit (Luhn, jetons, codes, libellés). |
| `recording-format.js` | Construction du JSON, contrôle des limites du serveur, réduction sous 512 Ko, valeurs qui changent devinées, libellés des étapes. |

- Démarrage : « Montrer à Limova » dans la carte Limova Team, puis « Dans cet onglet » (l’onglet rejoint le groupe) ou « Dans un nouvel onglet ». Refusé sur LinkedIn, le tableau de bord, les pages `chrome://`.
- Pendant l’enregistrement, les appels de l’agent attendent (comme « Prendre la main ») ; ils reprennent à « Arrêter ».
- Le bouton est masqué quand le serveur annonce `features.procedures: false` dans son `ready` (relu à chaque reconnexion). Un serveur plus ancien, sans `features`, est encore sondé avec un corps vide à l’adresse d’envoi (404 : désactivé ; 400 ou 422 : activé), et un 404 à l’envoi masque aussi le bouton.
- Le message d’un 422 vient de `detail` ou de `error.message`.
- Pas de narration vocale en v1 : `narration` n’est pas envoyée.
- Pas d’indicateur dans la page : il faudrait ajouter un élément au DOM, visible et modifiable par la page, qui fausserait aussi `dom_changed`. Le panneau, le titre du groupe et le badge suffisent.

## Touches, fichiers et cadres (TEAM-751)

Contrat : `docs/browser-device-protocol.md` (team-backend), « Keys, file uploads and iframes ». Le `hello` annonce `browser.v2+keys`, `browser.v2+upload` et `browser.v2+frames`.

| Fichier | Rôle |
|---|---|
| `page-actions.js` | Actions `key` et `upload` de `performPageAction`, `probeFocus` (quel cadre a le focus). |
| `page-snapshot.js` | Champs de fichier cachés et leur déclencheur, `probeFrame` (place d’un cadre), lecture d’un cadre avec les budgets restants. |
| `frame-tree.js` | Quels cadres lire et comment les nommer (`fr1`, `fr2`…), limites, sites bloqués. Pur. |
| `browser-engine.js` | `browser.press_key`, `browser.upload`, étapes `key` de `browser.batch`, actions envoyées au bon cadre. |

- **`browser.press_key`.** `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`, les flèches, `Home`, `End`, `PageUp`, `PageDown`, avec `shift` en option ; rien d’autre (écrire, c’est `browser.fill`). Un événement clavier créé par un script n’a pas d’effet par défaut : l’extension envoie `keydown`, `keypress` (Entrée, Espace) et `keyup` avec `key`, `code`, `keyCode` et `which`, puis, si la page n’a pas annulé la touche, fait ce que le navigateur aurait fait (focus suivant dans l’ordre de tabulation, envoi du formulaire par son bouton par défaut, clic, saut de ligne, suppression d’un caractère avec `input`, option ou bouton radio suivant, curseur, défilement, fermeture d’un `<dialog>`). Entrée et Espace nomment toujours leur élément (`invalid_args` sinon). Retour arrière, Suppr et Espace sont refusés dans un champ sensible (`sensitive_field`). Sans élément, la touche va à l’élément qui a le focus, dans le cadre qui a le focus. La réponse ajoute `focused` (rôle et nom, jamais la valeur). Risque : Entrée dans un champ de formulaire se lit comme un envoi de ce formulaire, Entrée ou Espace sur un bouton comme un clic dessus ; seul `pay` attend la personne.
- **`browser.upload`.** Fichiers `inline` (pièces jointes du chat, 1 à 10, 5 Mio en tout, base64 vérifié et taille exacte) : `File` → `DataTransfer` → `input.files`, puis `input` et `change`. L’élément peut être le champ, son libellé, le bouton à côté ou `aria-controls`, ou une zone de dépôt (`dragenter`, `dragover`, `drop` ; une zone qui n’annule ni `dragenter` ni `dragover` ne prend pas de fichiers et répond `invalid_args`). `accept` et `multiple` sont vérifiés avant de toucher la page. `source: "mac"` répond `unsupported` : seul Limova Desktop lit les dossiers du Mac. Les octets ne vivent que le temps de l’appel, jamais dans le cache des résultats ni dans les journaux. `read_page` liste chaque champ de fichier, même caché derrière un libellé ou un bouton, avec `accept`, `multiple`, `state` et `files` (un nombre). Un clic sur un champ de fichier est refusé (`invalid_args`).
- **Cadres.** `read_page` lit les cadres visibles (au plus 20, 5 niveaux), le haut de la page d’abord pour `max_elements` et `max_text_chars` ; le texte d’un cadre suit une ligne `[Cadre fr1 · hôte]`. Les identifiants d’un cadre sont `fr1.e3`, `fr1.f1`, et chaque élément dit `frame`. Chaque cadre garde sa propre carte dans son monde isolé ; une action part vers le document du cadre (`documentIds`), et un cadre qui a navigué répond `stale_snapshot`. Un cadre sur un site bloqué est listé (`blocked_site`) sans être lu ; un cadre que Chrome ne laisse pas lire est `page_unavailable`. Les cadres invisibles ne sont pas listés. La capture masque aussi les champs des cadres placés dans la page et peut afficher `#fr1.e3`.
- **Enregistrement.** L’enregistreur tourne dans les cadres de l’onglet (sauf sites bloqués) et ajoute `target.frame` (`origin`, `name`, `path`) ; la page d’une étape de cadre est celle de l’onglet. Il enregistre les touches utiles (voir `page-recorder.js`) ; un serveur antérieur qui refuse ces touches reçoit l’enregistrement une seconde fois avec Entrée, Échap et Tab seulement.
- **`features.login_vault`.** À `false`, la proposition d’enregistrer une connexion ne garde même pas le mot de passe.

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
