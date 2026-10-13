import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createStudioMcpServer } from "@/lib/studio-mcp";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const expected = process.env.STUDIO_SERVICE_TOKEN;
  const provided = request.headers.get("authorization") ?? "";
  const expectedBuffer = Buffer.from(`Bearer ${expected ?? ""}`);
  const providedBuffer = Buffer.from(provided);
  if (!expected || expected.length < 32 || expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  // This endpoint is server-to-server only, never a browser credential bridge.
  if (request.headers.has("origin")) {
    return Response.json({ error: "forbidden_origin" }, { status: 403 });
  }
  const server = createStudioMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 32 * 1024,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } finally {
    await server.close();
  }
}
