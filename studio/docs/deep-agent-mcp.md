# Studio MCP for the existing Limova main agent

`POST /api/mcp` implements stateless MCP Streamable HTTP with JSON responses.
The API client must send `Authorization: Bearer <STUDIO_SERVICE_TOKEN>` on every
request. Use the existing server-side secret (at least 32 characters); never
include it in extension bundles, page scripts, prompts or tracing payloads.
Browser Origin headers are rejected. GET/SSE subscriptions and DELETE sessions
are not supported: there are no long-lived server sessions.

Tools:

- `search_knowledge`: accepts `query`, optional `path`, `locale`, `contentTypes`
  and `limit`. Searches only published extension content, excluding SAV. Returns
  the existing search response including revision, source IDs and excerpts.
- `get_onboarding_guidance`: no arguments. Returns the published template with
  published, AI-enabled, non-archived steps and excludes SAV content references.
  An absent template returns `{ "revision": "onboarding_fallback", "template": null }`.

The server does not offer draft/evaluation or SAV tools. Provider failures become
recoverable MCP tool errors without provider exception text. Logs contain only
the tool name and duration, never queries, retrieved content or credentials.

This is layer S1 of the migration. The Limova API must evaluate the shared
`is_charly_extension_enabled` flag for the authenticated user/workspace before
enabling or invoking these tools for the existing `charly` agent. The service
token is infrastructure authentication, not proof of end-user authorization.
No extension capability or rollout is activated by deploying this endpoint alone.
Existing internal Studio routes and their consumers remain available.

Validation:

```sh
npm test -- src/app/api/mcp/route.test.ts src/lib/onboarding-template-published.test.ts
npm run typecheck
```

The HTTP contract test uses the official MCP client for initialization, tool
discovery and calls. The PostgreSQL fixture applies real migrations and checks
published-version selection and exclusion of SAV references.

## Local HTTPS and PostgreSQL qualification

Run `npm run test:mcp:postgres` from `studio` with `STUDIO_MCP_TEST_DATABASE_URL` pointing to a disposable local database named `extension_mcp_test`. The command fails if the variable is absent; the test refuses other database names and remote hosts. It is separate from the normal unit suite and adds no skipped unit test.

Example using a new, isolated pgvector container (test credentials only):

```sh
docker run --rm -d --name limova-mcp-test \
  -e POSTGRES_DB=extension_mcp_test -e POSTGRES_USER=mcp_test \
  -e POSTGRES_PASSWORD=mcp_test_local_only \
  -p 127.0.0.1:55439:5432 pgvector/pgvector:pg16
# Wait for pg_isready before the test.
STUDIO_MCP_TEST_DATABASE_URL=postgresql://mcp_test:mcp_test_local_only@127.0.0.1:55439/extension_mcp_test npm run test:mcp:postgres
docker stop limova-mcp-test
```

The runner requires OpenSSL and creates a temporary localhost certificate, trusted only through `NODE_EXTRA_CA_CERTS` for the test process. Certificate validation stays enabled. It removes the certificate directory on exit. The test applies the real Drizzle migrations and calls the real MCP route, search service and onboarding-template service over a local HTTPS socket using the installed MCP client. It seeds only synthetic records and removes them afterward; the caller remains responsible for stopping its database container.

Coverage includes published revision/body selection, exclusion of draft versions, SAV, archived, unpublished and AI-disabled items, rejection of missing credentials/browser origins/model-selected private scopes, and immediate removal after AI access is disabled. Embeddings use the existing deterministic test fallback with all provider keys cleared. No content services or SQL calls are mocked.

This qualifies the handler and database locally, not the Next middleware/reverse proxy, deployed credentials, the API's own MCP client version, provider embeddings, or production content. Those remain separate release checks.
