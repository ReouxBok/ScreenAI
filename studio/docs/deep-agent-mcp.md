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
