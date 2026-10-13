import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const services = vi.hoisted(() => ({ search: vi.fn(), guidance: vi.fn(), evaluation: vi.fn() }));
vi.mock("@/lib/search", () => ({ searchKnowledge: services.search }));
vi.mock("@/lib/onboarding-template", () => ({ getPublishedOnboardingTemplate: services.guidance }));
vi.mock("@/lib/studio-evaluation-context", () => ({ readStudioEvaluationContext: services.evaluation }));
import { POST } from "./route";

const token = "test-service-token-with-at-least-32-characters";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
let client: Client | undefined;

async function connect(evaluationCode?: string) {
  client = new Client({ name: "limova-backend-test", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://studio.test/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...(evaluationCode === undefined ? {} : { "x-limova-evaluation-code": evaluationCode }) } },
    fetch: async (url, init) => {
      const request = new Request(url, init);
      return request.method === "POST" ? POST(request) : new Response(null, { status: 405 });
    },
  }));
  return client;
}

beforeEach(() => {
  vi.stubEnv("STUDIO_SERVICE_TOKEN", token);
  services.evaluation.mockReset().mockResolvedValue({ runId: "run-1", draft: { versionId: "draft-1", bodyMarkdown: "staff draft" } });
  services.search.mockReset().mockResolvedValue({ revision: "kb_12", results: [] });
  services.guidance.mockReset().mockResolvedValue({ revision: "onboarding_v3", steps: [] });
});
afterEach(async () => { await client?.close(); client = undefined; vi.unstubAllEnvs(); });

describe("Studio MCP HTTP contract", () => {
  it("initializes with the real MCP client, discovers and calls both published tools", async () => {
    const connected = await connect();
    expect((await connected.listTools()).tools.map(tool => tool.name)).toEqual(["search_knowledge", "get_onboarding_guidance"]);
    const search = await connected.callTool({ name: "search_knowledge", arguments: { query: "connecter gmail" } });
    expect(search.isError).not.toBe(true);
    expect(search.content).toEqual([{ type: "text", text: JSON.stringify({ revision: "kb_12", results: [] }) }]);
    expect(services.search).toHaveBeenCalledWith(expect.objectContaining({ scope: "extension", query: "connecter gmail" }));
    await connected.callTool({ name: "get_onboarding_guidance", arguments: {} });
    expect(services.guidance).toHaveBeenCalledWith({ excludeSav: true });
  });

  it("rejects a request to access SAV or drafts before calling services", async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: "search_knowledge", arguments: { query: "support", scope: "sav" } });
    expect(result.isError).toBe(true);
    const draft = await connected.callTool({ name: "get_onboarding_guidance", arguments: { draftId: "private" } });
    expect(draft.isError).toBe(true);
    expect(services.search).not.toHaveBeenCalled();
    expect(services.guidance).not.toHaveBeenCalled();
  });

  it("returns a recoverable tool error without exposing provider details", async () => {
    services.search.mockRejectedValue(new Error("secret-database-credential"));
    const connected = await connect();
    const result = await connected.callTool({ name: "search_knowledge", arguments: { query: "gmail" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-database-credential");
  });

  it("rejects unauthenticated calls and browser origins", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await POST(new Request("https://studio.test/api/mcp", { method: "POST", body }))).status).toBe(401);
    expect((await POST(new Request("https://studio.test/api/mcp", { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body }))).status).toBe(403);
    expect(services.search).not.toHaveBeenCalled();
  });
  it("isolates evaluation tools from published guidance and never accepts model-selected drafts", async () => {
    const code = "staff-evaluation-code-with-enough-characters";
    const connected = await connect(code);
    expect((await connected.listTools()).tools.map(tool => tool.name)).toEqual(["get_evaluation_guidance"]);
    const draft = await connected.callTool({ name: "get_evaluation_guidance", arguments: {} });
    expect(draft.isError).not.toBe(true);
    expect(JSON.stringify(draft)).toContain("staff draft");
    expect(JSON.stringify(draft)).not.toContain(code);
    expect(services.evaluation).toHaveBeenCalledWith(code);
    expect((await connected.callTool({ name: "search_knowledge", arguments: { query: "gmail" } })).isError).toBe(true);
    expect((await connected.callTool({ name: "get_evaluation_guidance", arguments: { draftId: "other" } })).isError).toBe(true);
    expect(services.evaluation).toHaveBeenCalledTimes(1);
    expect(services.search).not.toHaveBeenCalled();
    expect(services.guidance).not.toHaveBeenCalled();
  });

  it("rechecks the evaluation grant on every tool call and fails closed after revocation", async () => {
    const connected = await connect("staff-evaluation-code-with-enough-characters");
    expect((await connected.callTool({ name: "get_evaluation_guidance", arguments: {} })).isError).not.toBe(true);
    services.evaluation.mockResolvedValue(null);
    expect((await connected.callTool({ name: "get_evaluation_guidance", arguments: {} })).isError).toBe(true);
    services.evaluation.mockRejectedValue(new Error("private-code-and-database-error"));
    const failed = await connected.callTool({ name: "get_evaluation_guidance", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("private-code");
    expect(services.evaluation).toHaveBeenCalledTimes(3);
  });

  it("does not expose evaluation tools without an explicit server-side grant header", async () => {
    const connected = await connect();
    expect((await connected.callTool({ name: "get_evaluation_guidance", arguments: {} })).isError).toBe(true);
    expect(services.evaluation).not.toHaveBeenCalled();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const code of ["", "short", "x".repeat(101), "bad token with spaces in its value"]) {
      expect((await POST(new Request("https://studio.test/api/mcp", { method: "POST", headers: { ...headers, "x-limova-evaluation-code": code }, body }))).status).toBe(400);
    }
  });

});
