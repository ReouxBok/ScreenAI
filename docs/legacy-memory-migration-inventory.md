# Inventaire de la mémoire historique avant migration

## Constat dans le code

Le proxy construit l’identité mémoire comme `v1:` + HMAC-SHA256 de `charly-memory:` + email normalisé (trim + minuscules), avec `MEMORY_IDENTITY_SECRET_V1`. Ce n’est pas l’UUID Limova. Le profil chiffré peut contenir `limovaUserId`, mais ce champ vient du profil synchronisé et ne constitue pas une preuve serveur suffisante pour rattacher les données.

Le schéma `charly_memory` contient neuf tables : utilisateurs/préférences, sessions, messages, résumés, souvenirs, objectifs, tombstones, runs et événements d’audit. Les contenus et états sont chiffrés ; les embeddings et métadonnées ne sont pas une sauvegarde de remplacement. La clé de chiffrement et la clé d’identité remplissent des rôles différents.

**L’ancien export était un contexte partiel et mutait la base.** Il appelait `bootstrapMemory` (lastSeenAt, sessions, lastUsedAt), limité à 24 messages, huit souvenirs, cinq objectifs ouverts et un résumé. Le service local est maintenant remplacé par un [export dédié en lecture seule](legacy-memory-export.md), version 2, couvrant les neuf tables et les préférences désactivées. Cette correction locale ne prouve ni son déploiement ni un export effectif de production. Les anciens fichiers exportés restent partiels.


## Commande disponible

Depuis `studio`, avec `MEMORY_DATABASE_URL` PostgreSQL configurée dans l’environnement ou le fichier dotenv choisi :

```sh
npm run --silent memory:inventory > memory-inventory.json
```

Pour choisir explicitement un fichier existant :

```sh
DOTENV_CONFIG_PATH=/chemin/vers/environnement.env npm run --silent memory:inventory > memory-inventory.json
```

La commande n’applique aucune migration. Elle utilise une transaction `REPEATABLE READ READ ONLY`, un timeout de 15 secondes par requête et deux secondes d’attente de verrou. Elle compte les lignes, les identités distinctes et les octets chiffrés de chaque table. Elle distingue aussi personnalisation désactivée, souvenirs actifs/expirés, runs actifs et tombstones encore applicables. Aucun contenu, email, userKey, ciphertext, embedding ou secret n’est affiché ; aucune clé de déchiffrement n’est nécessaire.

Codes de sortie : 0 = les neuf tables ont été mesurées ; 2 = inventaire incomplet (tables absentes) ; 1 = configuration, connexion ou requête en échec. Une table absente n’est pas assimilée à une table vide. Les nombres sont des chaînes décimales pour ne pas perdre de précision. La complétude concerne les tables attendues, pas une preuve de déchiffrement, d’identité ou de capacité à migrer.

Validation locale : migrations réelles appliquées dans PGlite avec pgvector, jeu de données multi-identités dont souvenirs expirés, personnalisation désactivée et tombstone ; inventaire exécuté en transaction read-only, sans déchiffrement ; absence du schéma et compteur invalide testés. Aucune connexion PostgreSQL n’était configurée pour l’exécution réelle : aucun volume de production n’est affirmé.

## Conditions avant import

1. Mesurer la base cible de l’ancien service avec cette commande et conserver un rapport daté ainsi que la référence du déploiement choisi.
2. Établir côté serveur le lien entre email vérifié du compte Limova et HMAC historique avec la clé d’identité d’origine. Ne pas accepter un UUID fourni par le DOM ou le profil comme preuve. Définir explicitement l’organisation de destination ; une identité historique ne fournit pas cette information.
3. Produire un export exhaustif et cohérent, avec identifiants source, statuts, dates, expirations et tombstones ; vérifier le déchiffrement. Utiliser le format version 2 et qualifier sa volumétrie sur le déploiement cible ; les anciens exports de contexte ne sont pas suffisants.
4. Prévisualiser un import idempotent vers les stores utilisateur/organisation natifs. Préserver les souvenirs existants, les demandes d’oubli et la préférence désactivée. Traiter l’historique comme archive, sans rejouer messages, commandes ou runs ADK.
5. Réconcilier les volumes, dédoublonnages, conflits, éléments exclus et erreurs avant tout retrait. Garder l’ancien service disponible tant que cette vérification, l’export et l’effacement n’ont pas de remplacement qualifié.

La commande n’effectue aucune de ces écritures et ne fournit pas de décision automatique de suppression.
