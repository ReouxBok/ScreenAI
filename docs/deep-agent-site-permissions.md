# Validation des permissions de site dans Chromium

Le test de permissions utilise la session Limova native de la fixture HTTPS et les commandes du panneau en français, anglais et espagnol. Il ne masque plus le panneau d’authentification manuellement et ne dépend plus d’un libellé français figé.

Cette reprise a mis en évidence une différence de parsing : Chromium peut représenter l’hôte `*.example.test` sous la forme `%2A.example.test`. Le contrôle limité à `hostname.includes('*')` laissait alors une demande invalide atteindre `chrome.permissions.request`. La validation rejette désormais les hôtes contenant `*` ou `%`, ainsi que les identifiants et protocoles autres que HTTPS. Les chemins, queries et fragments d’une URL valide sont retirés avant la demande, qui ne porte que sur une origine précise.

Les exceptions synchrones de Chrome sont traitées comme les rejets asynchrones : message d’échec localisé et bouton réutilisable. Aucun accès n’est annoncé lorsque la demande échoue.

Les tests Chromium enregistrent les arguments de `chrome.permissions.request` et délèguent immédiatement à l’API Chrome réelle, depuis le clic. Ils vérifient une origine Limova déjà autorisée par le manifeste, l’absence de demande ou d’octroi global, les hôtes génériques bruts/encodés refusés et le consentement par message toujours décoché. Ils ne prouvent pas l’acceptation d’une nouvelle permission de site tiers via le dialogue natif de Chrome ; cette qualification multi-sites reste distincte.

Les profils de test sont isolés. Aucun changement de permissions du profil Chrome utilisateur n’est effectué.
