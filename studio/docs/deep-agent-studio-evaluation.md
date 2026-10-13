# Évaluations Studio avec le moteur Deep Agent partagé

## Contrat Studio implémenté

Le même endpoint `POST /api/mcp` accepte un contexte d’évaluation serveur-à-serveur. L’authentification `STUDIO_SERVICE_TOKEN` reste obligatoire et les origines navigateur restent refusées. Le header optionnel `x-limova-evaluation-code` sélectionne un catalogue contenant uniquement `get_evaluation_guidance`. Sans ce header, seuls les deux outils publiés habituels existent.

Le code n’est ni un argument de tool ni une donnée de prompt. Aucun draftId n’est accepté. Chaque appel relit le code via `findEvaluationByToken` : expiration et version de brouillon courante sont vérifiées par ce service existant. Le contexte exige en plus un statut `ready` ou `running` et exclut le SAV. La réponse projette les identifiants du run/scénario/version, l’expiration, le scénario et le contenu du brouillon ; elle n’inclut pas les identités staff ni le hash du code. Aucun événement ou changement de statut n’est produit par cette lecture. Un code indisponible ou révoqué produit une erreur de tool sans repli sur la connaissance publiée.

Ce catalogue MCP ne constitue pas un nouvel agent. L’agent cible reste le Charly principal avec le moteur Deep Agent.

## Raccordement restant dans Limova API

Le mode évaluation ne doit pas être activé en ajoutant simplement ce header au client Studio habituel. Une conversation `general` normale conserve la mémoire et les intégrations du testeur, ce qui viole l’isolation prévue dans le plan.

Le prochain lot doit :

1. Accepter le code dans un contexte d’évaluation authentifié et contrôlé par le flag unique, sans le persister dans les messages, métadonnées publiques ou traces LangSmith.
2. Faire résoudre le run/version autorisé par Studio côté serveur, lier ce contexte au compte/workspace/conversation, et revérifier son expiration avant les tours et actions. Ne pas prendre le brouillon envoyé par le navigateur comme autorité.
3. Utiliser le même agent principal en excluant les stores de mémoire personnelle, les outils d’intégrations, les délégations susceptibles de les réintroduire et leurs blocs de prompt. Ne pas détourner le type technique onboarding pour obtenir cette isolation.
4. N’exposer que le tool Studio d’évaluation et les capacités navigateur explicitement autorisées pour ce test. Une conversation d’évaluation doit conserver cette isolation lors d’une reprise ou d’un appel sans le contexte initial ; aucun repli silencieux vers une conversation personnelle.
5. Relier résultats et preuves d’actions aux événements Studio existants avant le verdict, pour le texte puis la voix. Conserver l’exigence d’action et de vérification réelles du scoring ; un texte produit n’est pas une preuve de réussite.

Le chemin frontend d’évaluation reste legacy tant que ces protections ne sont pas implémentées. Le catalogue MCP est testé avec un vrai client SDK en transport HTTP local ; il ne prouve pas le parcours complet, la base de production ou un déploiement. Aucun secret de service n’est ajouté à l’extension.
