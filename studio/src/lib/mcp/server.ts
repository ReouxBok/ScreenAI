import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorizeSavStaffUser, withSavRequestUser } from "@/lib/sav/intake/console-auth";
import { studioMcpConfig } from "./config";
import { resolveStudioMcpUser, StudioMcpAuthError } from "./identity";
import { studioMcpTools, type StudioMcpContext, type StudioMcpResult, type StudioMcpTool } from "./tools";
import { studioMcpPauseReadTool, studioMcpWriteTools } from "./writes";

const json = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
/** Per staff member and instance: enough for an agent, bounded against a loop. */
export const STUDIO_MCP_RATE = { calls: 120, windowMs: 60_000 } as const;
const windows = new Map<string, { start: number; count: number }>();
export function studioMcpRateLimited(actorId: string, now = Date.now()) {
  const window = windows.get(actorId);
  if (!window || now - window.start >= STUDIO_MCP_RATE.windowMs) { windows.set(actorId, { start: now, count: 1 }); return false; }
  return ++window.count > STUDIO_MCP_RATE.calls;
}
export function resetStudioMcpRateLimit() { windows.clear(); }

/** Known business refusals keep their stable code; anything else is internal and never leaks. */
function failure(error: unknown): StudioMcpResult {
  const code = error instanceof Error && /^SAV_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : null;
  return code ? { outcome: "refused", code, message: "Refusé par le contrôle serveur existant." }
    : { outcome: "refused", code: "MCP_INTERNAL_ERROR", message: "Erreur interne ; aucune action n’a été tentée par cet outil de lecture." };
}
async function call(tool: StudioMcpTool, context: StudioMcpContext, input: unknown) {
  const started = Date.now();
  // The console's own server functions authenticate this staff member, exactly as for a session.
  const result = await withSavRequestUser(context.user, () => tool.run(context, input as never)).catch(failure);
  // No dossier content, no arguments: tool, outcome, code and duration only.
  console.info("studio_mcp", { tool: tool.name, actorId: context.staff.id, outcome: result.outcome, code: result.code, durationMs: Date.now() - started });
  return result;
}
export function createStudioMcpServer(context: StudioMcpContext, options: { writes: boolean }) {
  const server = new McpServer({ name: "studio-limova-sav", version: "1.0.0" });
  for (const tool of [...studioMcpTools, studioMcpPauseReadTool, ...studioMcpWriteTools].filter(t => options.writes || !t.write)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input,
      annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write, idempotentHint: !tool.write, openWorldHint: false } },
    async (input: unknown) => {
      const result = studioMcpRateLimited(context.staff.id)
        ? { outcome: "refused" as const, code: "MCP_RATE_LIMITED", message: `Plus de ${STUDIO_MCP_RATE.calls} appels par minute.` }
        : await call(tool, context, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: result.outcome === "refused" && result.code.startsWith("MCP_") };
    });
  }
  return server;
}

function unauthorized(code: string, status = 401) {
  const error = status === 401 ? "invalid_token" : "insufficient_scope";
  return Response.json({ error, code }, { status, headers: { ...json, "WWW-Authenticate": `Bearer realm="studio-limova", error="${error}"` } });
}
/** Streamable HTTP, stateless: one server and transport per request. */
export async function handleStudioMcpRequest(request: Request, deps: { resolveUser?: typeof resolveStudioMcpUser; env?: Record<string, string | undefined> } = {}) {
  const config = studioMcpConfig(deps.env);
  if (!config.enabled) return new Response(null, { status: 404, headers: json });
  // Not a browser API: a cross-origin page may not drive it (no CORS, DNS rebinding).
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS" || origin && origin !== new URL(request.url).origin) return Response.json({ error: "forbidden" }, { status: 403, headers: json });
  let context: StudioMcpContext;
  try {
    const user = await (deps.resolveUser ?? resolveStudioMcpUser)(request);
    // The same staff checks as the console, at every request: a removed staff row stops a live token.
    context = { user, staff: await authorizeSavStaffUser(user, "MCP_STAFF_UNAUTHORIZED") };
  } catch (error) {
    if (error instanceof StudioMcpAuthError) return unauthorized(error.code);
    if (error instanceof Error && error.message === "MCP_STAFF_UNAUTHORIZED") return unauthorized(error.message, 403);
    return Response.json({ error: "server_error" }, { status: 500, headers: json });
  }
  // JSON responses without sessions: no standalone SSE stream (GET) and no session to close
  // (DELETE). A 405 tells the SDK client not to open, then endlessly reopen, an empty stream.
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...json, Allow: "POST" } });
  const server = createStudioMcpServer(context, { writes: config.writes });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request), headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(json)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  finally { await server.close().catch(() => undefined); }
}
