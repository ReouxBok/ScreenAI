# Données et confidentialité de l’extension

Ce document sert de référence technique pour la fiche Chrome Web Store et la politique publique. La politique publique liée depuis l’extension est : <https://www.limova.ai/legal/politique-de-confidentialite>.

## Traitement IA soumis au consentement

Le panneau s’ouvre sans fenêtre de consentement. Un accord est demandé uniquement lorsque l’utilisateur déclenche sa première action IA : envoi d’un message, analyse de page ou démarrage vocal. Si l’utilisateur refuse, aucun contexte de page, message ou audio n’est envoyé aux prestataires IA.

Après accord, Charly peut envoyer à Google Gemini pour le texte, ou à OpenAI GPT Live et son backend délégué pour la voix :

- le titre et le chemin de la page Limova, sans query string ni fragment ;
- les libellés, rôles, états visibles et positions approximatives des éléments DOM ;
- l’état rempli/vide des champs, jamais leur valeur ;
- les erreurs et avertissements techniques après suppression des jetons, secrets, emails, téléphones et paramètres d’URL ;
- les métadonnées réseau récentes (type, durée, statut et chemin généralisé pour Limova ; origine seule pour un tiers), sans corps ni headers ;
- le message, un résumé compacté, jusqu’aux 24 événements récents utiles et les souvenirs personnels pertinents lorsque la personnalisation est active ; le fallback transitoire borne encore l’historique visible à 200 messages ;
- une capture masquée de la zone visible, uniquement sur demande ou après une cible introuvable, ambiguë ou un résultat inattendu ;
- l’audio, uniquement pendant une session vocale explicitement démarrée.

L’extension n’envoie jamais de mot de passe, clé API, valeur de formulaire ni enregistrement audio persistant. Une capture éventuelle est préparée hors écran, masque les champs, ne modifie pas la page et n’existe que pendant l’invocation IA. Elle n’est enregistrée ni dans Neon, ni dans Chrome, ni dans les logs. Le flux vocal reste en mémoire et s’arrête à la fermeture du panneau ou sur action de l’utilisateur.

## Actions sur la page

Le modèle ne peut fournir que l’identifiant numérique d’un élément cartographié localement. Aucun sélecteur, script, clic par coordonnées ni URL distant n’est exécuté. L’envoi d’un message nécessite une demande explicite associée au bouton exact. Le membre choisit dans le panneau « Demander une approbation », « Approuver pour moi » (par défaut) ou « Accès complet ». Le niveau est conservé localement et communiqué à la session IA pour adapter son comportement. Selon ce niveau et le risque, une action attend un accord dans le panneau ou à la voix avant de poursuivre ; une cible ambiguë entraîne une nouvelle observation puis une clarification. Les approbations en attente restent en mémoire, expirent après cinq minutes et sont annulées si la consigne change ou si la session s’arrête. Charly vérifie à nouveau la page avant d’exécuter une action approuvée.

## Limova Team dans Chrome (TEAM-724)

Ce traitement n’a lieu que si la personne choisit « Limova Team » sur l’écran d’accueil du panneau (ou « Connexions » dans le menu), clique sur « Se connecter » et se connecte au tableau de bord de Limova Team. Depuis TEAM-726, cette connexion vaut accord pour agir : le tableau de bord approuve l’extension Limova sans écran supplémentaire. L’extension ne demande ensuite plus d’accord avant une action, sauf pour un paiement ; elle ne saisit jamais un mot de passe, un numéro de carte ou un code dicté par le modèle. Depuis TEAM-729, elle tape seulement une connexion que la personne a elle-même enregistrée pour Limova, sur le site exact de cette connexion (voir « Connexions enregistrées et sessions »). Il s’arrête avec « Déconnecter », qui révoque le jeton sur le serveur, ou quand le tableau de bord révoque l’appareil.

Envoyé à l’API Limova Team (`api.team.limova.ai`, ou `api.staging.team.limova.ai` si la personne a choisi la préproduction), uniquement en réponse à une demande de l’agent et uniquement pour les onglets du groupe « Limova Team » (ou un onglet que la personne a choisi de partager) :

- le titre, l’origine et le chemin de l’onglet (jamais la query string ni le fragment), l’adresse `https` de son icône ;
- le texte visible de la page (au plus 20 000 caractères), sans le texte saisi dans les zones de saisie ;
- la carte des éléments interactifs : rôle, nom visible, état `empty` / `filled` / `sensitive`, libellé de l’option choisie d’une liste, case cochée ou non ; jamais la valeur d’un champ ;
- les textes cachés qui ressemblent à des consignes adressées à un assistant (pour la protection contre l’injection de consignes) ;
- une capture JPEG de la zone visible, avec tous les champs masqués, uniquement quand l’agent la demande ; le serveur la fait décrire puis la supprime ;
- le nombre d’autres onglets ouverts (un nombre, sans titre ni adresse) ;
- ce que la page affiche après une action (alertes et messages de statut, au plus 5 lignes).

Jamais envoyé : les valeurs des champs, les mots de passe, numéros de carte et codes tapés par la personne (l’extension refuse de les saisir à la demande du modèle), les cookies (sauf « Envoyer ma session à Limova », ci-dessous), les onglets hors du groupe, le contenu des iframes.

Conservé dans Chrome : dans `chrome.storage.local`, pour chaque produit connecté, le jeton d’appareil `lmd_…`, l’identifiant d’appareil, un identifiant de machine aléatoire, le nom affiché (« Chrome · macOS »), l’environnement, le niveau d’autonomie et la pause ; le produit choisi sur l’écran d’accueil (`limova_home_product_v1`) et, pour les développeurs seulement, le réglage `limova_team_developer_v1` ; dans `chrome.storage.session` (effacé à la fermeture de Chrome), le vérificateur PKCE et le `state` d’un appairage en cours, l’identifiant du groupe d’onglets et l’attente imposée par le serveur avant une reconnexion. L’adresse e-mail du compte (« Connecté en tant que … ») et la liste d’activité récente (domaine et libellé de l’action) restent en mémoire. Aucune capture, aucun DOM, aucun texte de page ni aucune valeur de champ n’est écrit dans `chrome.storage` ni dans les journaux.

Justification des permissions ajoutées : `tabGroups` crée et nomme le groupe d’onglets « Limova Team », seul endroit où l’agent peut agir ; `alarms` reconnecte la connexion chaque minute après un redémarrage du service worker par Chrome. Aucun hôte n’est ajouté : les appels vers l’API Limova Team sont couverts par l’accès existant à tous les sites, et la CSP autorise explicitement ses deux origines `https` et `wss`.

### Connexions enregistrées et sessions (TEAM-729)

Contrat : `docs/login-vault.md` du dépôt team-backend. Tout est derrière le réglage serveur `login_vault_enabled` ; quand il est coupé, les routes répondent 404 et l’extension ne propose rien.

**Remplir une connexion enregistrée (`browser.fill_secret`).** Le modèle ne voit jamais un mot de passe : il nomme une connexion enregistrée, le serveur la déchiffre et la scelle pour ce navigateur seulement. À chaque ouverture de la connexion, l’extension crée une paire de clés ECDH P-256 avec WebCrypto ; la clé privée est non exportable, reste en mémoire du service worker et disparaît à la fermeture de la connexion. Seule la clé publique (`kty`, `crv`, `x`, `y`) part dans le `hello`. Le scellé ouvert (identifiant, mot de passe, code à usage unique) n’existe qu’en mémoire pendant l’appel : l’extension vérifie l’appel, l’appareil, l’expiration, l’origine réelle de l’onglet au moment de taper, les champs et la destination du formulaire, tape les valeurs dans la page, puis les oublie. La réponse ne contient que des indicateurs `filled` ; aucune valeur n’est écrite dans `chrome.storage`, les journaux, la liste d’activité, les statistiques d’utilisation ni le cache des réponses (qui ne garde que la réponse). Si la page réaffiche ce qui a été tapé, la réponse le masque.

**Proposer d’enregistrer une connexion.** Dans les onglets du groupe « Limova Team », et dans les autres onglets seulement si la personne a coché « Proposer aussi d’enregistrer mes connexions dans mes onglets » (décoché par défaut), l’extension injecte dans le monde isolé de la page (`chrome.scripting`) un petit observateur qui ne lit rien tant qu’un formulaire avec un mot de passe rempli n’est pas envoyé. À cet envoi seulement, il transmet au service worker l’identifiant et le mot de passe ; l’origine est celle que Chrome indique pour l’onglet. Rien n’est proposé sur une page `http:`, sur LinkedIn ou Limova Team, sur un formulaire d’inscription (deux mots de passe), juste après un remplissage par Limova, ni sur un site de la liste « Jamais pour ce site ». Si la connexion réussit (navigation ou disparition du champ dans les 10 s, sans que le formulaire revienne), une petite fenêtre de l’extension demande « Enregistrer cette connexion pour Limova ? » ; son adresse ne contient qu’un identifiant opaque, jamais le site, l’identifiant ou le mot de passe. Le mot de passe reste en mémoire au plus deux minutes. Il n’est envoyé à l’API Limova Team (`POST /api/v1/devices/me/login-secrets`, jeton d’appareil) qu’après « Enregistrer », puis oublié ; « Pas maintenant », la fermeture de la fenêtre ou l’expiration l’oublient aussi. Pour formuler la question, l’extension demande au serveur les connexions déjà enregistrées pour cette origine (identifiants seulement).

**« Envoyer ma session à Limova ».** Depuis le panneau Limova Team, pour un seul site à la fois, et seulement après un écran de consentement qui nomme ce site (« Limova pourra utiliser ta session free.fr depuis ses navigateurs dans le cloud. Elle est chiffrée et tu peux la supprimer à tout moment. »), l’extension lit les cookies de ce domaine et de ses sous-domaines (`chrome.cookies.getAll({ domain })`) et les envoie à `POST /api/v1/devices/me/session-profiles`, où ils sont chiffrés. Au plus 300 cookies et 256 Kio ; LinkedIn et les domaines de Limova sont refusés. Les cookies ne sont ni stockés, ni journalisés, ni affichés.

**Conservé dans Chrome** (`chrome.storage.local`, clé `limova_team_vault_prefs_v1`) : la case « Proposer aussi d’enregistrer mes connexions dans mes onglets » et la liste des origines « Jamais pour ce site ». Aucun identifiant, mot de passe, code ou cookie.

**Permission `cookies`.** Ajoutée pour « Envoyer ma session à Limova » uniquement : elle n’est utilisée que par `src/team/session-export.js`, sur action explicite et consentement pour un site donné, et les cookies ne vont qu’à Limova Team. Charly ne lit ni n’écrit aucun cookie. L’accès aux sites lui-même vient de l’autorisation d’hôte existante (`<all_urls>`).

### « Montrer à Limova » : enregistrer une tâche (TEAM-731)

Rien n’est enregistré tant que la personne n’a pas cliqué « Montrer à Limova » puis choisi l’onglet. Pendant l’enregistrement, le panneau affiche « Limova regarde · Pause · Arrêter », le groupe d’onglets s’appelle « Limova Team · Limova regarde » et l’icône affiche « REC ». En pause, rien n’est capturé.

Ce qui est enregistré, dans les onglets de l’enregistrement seulement : les pages ouvertes (origine et chemin, jamais la query string ni le fragment) et la façon d’y arriver ; les clics sur des éléments interactifs, décrits par leur rôle, leur nom visible, leur libellé, leur placeholder, le titre voisin et quelques attributs stables (`name`, `data-testid`, `id` non généré, lien) ; la valeur finale de chaque champ rempli ; l’option choisie dans une liste ; l’état d’une case ; les touches Entrée et Échap ; le nom, le type et la taille des fichiers choisis ou téléchargés, jamais leur contenu ; les messages affichés après une action (alertes, confirmations). Jamais : la frappe touche par touche, les captures d’écran, l’audio, les sélecteurs, les coordonnées.

Masqué sur l’appareil avant tout envoi : la valeur de tout champ mot de passe, carte, code à usage unique ou secret (par son type, son `autocomplete`, son libellé, ou la règle « sensible » de `browser.read_page`), et toute valeur qui ressemble à un numéro de carte (contrôle de Luhn), une clé ou un jeton (`sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`, JWT, chaîne aléatoire de 32 caractères ou plus) ou un code de 4 à 8 chiffres dans un champ de code. Ces valeurs sont remplacées par leur seule nature (`{"redacted": "password"}`…). Dans les messages et les titres, les numéros de carte et les « code 482913 » deviennent « [masqué] ». Les champs dont la nature est évidente (mot de passe, carte, code) ne transmettent même pas leur valeur au service worker.

Conservation : l’enregistrement reste dans la mémoire du service worker, jamais dans `chrome.storage` ni dans les journaux. Il disparaît à l’envoi, à « Abandonner », ou si Chrome arrête l’extension.

Envoi : une seule fois, quand la personne clique « Envoyer à Limova » après avoir relu la liste des étapes (elle peut en supprimer, nommer la tâche et marquer les valeurs qui changent). Destination : `POST https://api.team.limova.ai/api/v1/devices/me/recordings` avec le jeton de l’appareil. Pour savoir s’il doit afficher le bouton, le panneau envoie à la connexion une requête vide à la même adresse ; elle ne contient aucune donnée.

## Cookies et statistiques d’utilisation

L’extension n’écrit aucun cookie. Elle ne lit les cookies d’un site que lorsque la personne choisit « Envoyer ma session à Limova » pour ce site précis dans le panneau Limova Team et confirme l’écran de consentement ; ils sont alors envoyés uniquement à Limova Team (voir « Connexions enregistrées et sessions » ci-dessus). Charly ne lit jamais de cookie.

Charly mesure l’utilisation du produit avec PostHog (hébergement UE, projet « Chrome Extension », adresses IP anonymisées). Les événements transitent par le proxy Limova, qui applique une liste blanche de noms et de propriétés avant l’envoi ; la clé PostHog reste côté serveur et aucune librairie tierce n’est chargée dans l’extension.

- **Collecté** : nom de l’événement (ouverture du panneau, message envoyé, réponse reçue, session vocale démarrée/terminée, action exécutée, étape d’onboarding, clic sur un lien Webinaire/Academy, installation/désinstallation…), compteurs, durées, codes d’erreur techniques, chemin de page généralisé (sans identifiants, query string ni fragment), domaine d’un lien cliqué, version de l’extension et de Chrome, langue, pays déduit de l’IP.
- **Identité** : un identifiant d’installation aléatoire avant connexion. Après la connexion OTP, les événements sont rattachés au compte Limova (identifiant opaque) et l’email, son domaine, le prénom et le nom figurent sur le profil PostHog. L’identifiant d’installation est renouvelé à la déconnexion.
- **Jamais collecté** : texte des messages, réponses de Charly, transcriptions, audio, contenu ou DOM des pages, valeurs de formulaire, URL complètes, captures.
- **Opposition** : le menu « Statistiques d’utilisation » désactive immédiatement l’envoi côté extension et ajoute l’en-tête `X-Charly-Analytics: off` aux requêtes du proxy, qui cesse aussi les événements serveur. Pour les versions antérieures à 2.2.53, le support ajoute l’email à `POSTHOG_BLOCKED_SUBS`.

Les journaux techniques restent locaux dans `chrome.storage.session` jusqu’à la fermeture de la session Chrome. Ils excluent les conversations, réponses IA, transcriptions, audio, valeurs de formulaire, corps réseau et identifiants. Ils ne quittent l’appareil que si l’utilisateur choisit explicitement de les télécharger puis de les transmettre au support.

Le bouton « Vérifier Charly » contacte uniquement le endpoint public `/healthz` du proxy, sans authentification ni donnée utilisateur, afin de confirmer sa disponibilité.

## Checklist Chrome Web Store

- Déclarer « website content », « user activity » et « personally identifiable information » (email rattaché aux statistiques d’utilisation) selon les catégories exactes du formulaire CWS.
- Mentionner PostHog (UE) comme sous-traitant des statistiques d’utilisation dans la politique publique.
- Décrire Google Gemini et OpenAI comme prestataires de traitement et aligner la politique publique sur les flux ci-dessus.
- Cocher l’engagement Limited Use et ne pas utiliser les données pour la publicité ou le scoring.
- Fournir une justification distincte pour `storage`, `scripting`, `webNavigation`, `sidePanel`, `tabGroups`, `alarms`, `cookies` (envoi d’une session à Limova Team, site par site, après consentement) et les deux hôtes déclarés (application Limova et proxy IA).
- Déclarer « authentication information » : les identifiants enregistrés par la personne pour Limova Team et les cookies d’une session envoyée, uniquement sur son choix explicite.
- Mentionner Limova Team comme destinataire des données de page décrites ci-dessus, uniquement après connexion explicite. L’extension ne demande pas la permission sensible `tabs` ; l’authentification est appelée dans le contexte isolé de la page Limova.
- Vérifier la suppression/rétention dans les contrats et journaux du proxy avant publication.
