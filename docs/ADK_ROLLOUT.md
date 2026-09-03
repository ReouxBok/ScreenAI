# Déploiement Google ADK

## Préparation

1. Déployer le Studio avec la migration `studio/memory-drizzle/0001_supreme_valeria_richards.sql`.
2. Déployer le proxy sous Node 24 avec `@google/adk@1.5.0` et les variables `GEMINI_API_KEY`, `MEMORY_API_URL`, `MEMORY_SERVICE_TOKEN`, `MEMORY_IDENTITY_SECRET_V1`, `KNOWLEDGE_API_URL` et `KNOWLEDGE_SERVICE_TOKEN`.
3. Vérifier côté Studio `MEMORY_DATABASE_URL`, `MEMORY_SERVICE_TOKEN`, `MEMORY_IDENTITY_SECRET_V1` et `MEMORY_ENCRYPTION_KEY_V1`. Les secrets d’identité et de service doivent correspondre à ceux du proxy ; la clé de chiffrement reste uniquement dans le Studio.
4. Conserver `MEMORY_READ`, `MEMORY_WRITE` et `PROFILE_SYNC` séparés.
5. Publier l’extension `2.2.27`. Elle ne demande aucune permission Chrome supplémentaire.

## Flags

- `ADK_TEXT_MODE=off` : protocole historique uniquement.
- `ADK_TEXT_MODE=shadow` : capability v2 non annoncée ; réservé aux comparaisons serveur sans effet utilisateur.
- `ADK_TEXT_MODE=canary` avec `ADK_CANARY_PERCENT=5`, puis `25` : sélection stable par identité pseudonyme.
- `ADK_TEXT_MODE=on` : v2 pour tous les membres éligibles.

Le rollback est immédiat avec `ADK_TEXT_MODE=off` et ne nécessite pas de nouvelle extension.

## Contrôles avant passage de palier

- migration mémoire appliquée sans erreur ;
- `/api/copilot/bootstrap` retourne `serverOrchestration`, `sessionId`, `sessionRevision` et `promptRevision` ;
- enchaînement `/v2/turn → tool_call → /runs/:runId/result → message` réussi ;
- aucun DOM, capture, contenu réseau ou texte de champ dans Neon et les logs ;
- aucun double clic après retry ou résultat dupliqué ;
- texte → voix → texte conserve le même `sessionId` ;
- « Nouveau chat » ferme la session visible et conserve la capsule de continuité ;
- mode formateur sans chat ni outil d’action.
