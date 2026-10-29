import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, diagnostics: vi.fn(), list: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => { throw Error("NO_SESSION_ON_MCP"); }, clerkClient: async () => { throw Error("NO_REAL_CLERK"); } }));
vi.mock("@/lib/sav/intake/run-diagnostics", () => ({ readIntakeRunDiagnostics: state.diagnostics }));
vi.mock("@/lib/sav/intake/console-store", () => ({ listIntakeConsole: state.list }));
import { handleStudioMcpRequest, resetStudioMcpRateLimit, STUDIO_MCP_RATE } from "./server";
import { StudioMcpAuthError } from "./identity";
import { studioMcpConfig } from "./config";

/** SAV-23/24/26: the MCP applies the console's staff checks to a token identity. Synthetic users only. */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const env = { STUDIO_MCP_ENABLED: "true" };
type User = { id: string; primaryEmailAddress: { emailAddress: string; verification: { status: string } } };
const user = (id: string, email: string, status = "verified"): User => ({ id, primaryEmailAddress: { emailAddress: email, verification: { status } } });
const ugo = user("user_ugo", "ugo@limova.ai"), reouven = user("user_reouven", "reouven@limova.ai"), contact = user("user_contact", "contact@limova.ai");
let current: User | Error = ugo;
const resolveUser = vi.fn(async () => { if (current instanceof Error) throw current; return current as never; });
const url = "https://studio.example.invalid/api/mcp";
let id = 0;
async function rpc(method: string, params: unknown = {}, options: { headers?: Record<string, string>; env?: Record<string, string> } = {}) {
  const request = new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer synthetic-token-0123456789", ...options.headers } });
  return handleStudioMcpRequest(request, { resolveUser, env: options.env ?? env });
}
const callTool = async (name: string, args: unknown = {}) => {
  const response = await rpc("tools/call", { name, arguments: args });
  return (await response.json()) as { result?: { structuredContent?: { outcome: string; code: string; data?: unknown }; isError?: boolean; content?: { text: string }[] }; error?: { code: number; message: string } };
};
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  await f.client.exec("TRUNCATE public.staff_users CASCADE");
  await f.db.insert(staffUsers).values([{ clerkId: "user_ugo", email: "ugo@limova.ai", name: "Ugo", role: "admin" },
    { clerkId: "user_reouven", email: "reouven@limova.ai", name: "Reouven", role: "owner" },
    { clerkId: "user_contact", email: "contact@limova.ai", name: "Contact", role: "member" },
    { clerkId: "user_arnaud", email: "arnaud@limova.ai", name: "Arnaud", role: "member" }]);
  current = ugo; resolveUser.mockClear(); state.diagnostics.mockReset(); state.list.mockReset(); resetStudioMcpRateLimit();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

it("SAV-24 is absent unless enabled, and writes need both flags", async () => {
  for (const off of [{}, { STUDIO_MCP_ENABLED: "1" }, { STUDIO_MCP_ENABLED: "TRUE" }]) expect((await rpc("tools/list", {}, { env: off as Record<string, string> })).status).toBe(404);
  expect(resolveUser).not.toHaveBeenCalled();
  expect(studioMcpConfig({ STUDIO_MCP_WRITES_ENABLED: "true" })).toEqual({ enabled: false, writes: false });
  expect(studioMcpConfig({ STUDIO_MCP_ENABLED: "true", STUDIO_MCP_WRITES_ENABLED: "true" })).toEqual({ enabled: true, writes: true });
});
it("SAV-23 an absent or invalid key gets 401", async () => {
  for (const code of ["MCP_TOKEN_MISSING", "MCP_TOKEN_INVALID"] as const) {
    current = new StudioMcpAuthError(code);
    const response = await rpc("tools/list");
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: "invalid_token", code });
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="studio-limova", error="invalid_token"');
  }
});
it.each([
  ["unverified email", () => user("user_ugo", "ugo@limova.ai", "unverified")],
  ["staff without SAV access", () => user("user_arnaud", "arnaud@limova.ai")],
  ["Clerk id of another staff row", () => user("user_contact", "ugo@limova.ai")],
  ["unknown user", () => user("user_nobody", "nobody@limova.ai")],
])("SAV-23 %s is refused with 403 before any tool", async (_name, make) => {
  current = make();
  const response = await rpc("tools/list");
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "MCP_STAFF_UNAUTHORIZED" });
});
it("SAV-23 deactivating or removing the staff row stops a token that is still valid", async () => {
  expect((await rpc("tools/list")).status).toBe(200);
  await f.db.update(staffUsers).set({ active: false }).where(eq(staffUsers.clerkId, "user_ugo"));
  expect((await rpc("tools/list")).status).toBe(403);
  await f.db.delete(staffUsers).where(eq(staffUsers.clerkId, "user_ugo"));
  expect((await rpc("tools/list")).status).toBe(403);
});
it("SAV-24 refuses browsers: cross-origin requests and preflights", async () => {
  expect((await rpc("tools/list", {}, { headers: { origin: "https://attacker.example" } })).status).toBe(403);
  const preflight = await handleStudioMcpRequest(new Request(url, { method: "OPTIONS", headers: { origin: "https://attacker.example" } }), { resolveUser, env });
  expect(preflight.status).toBe(403); expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
});
it("SAV-24 lists read tools only while writes are off; with writes on, write tools carry write annotations", async () => {
  const read = ["get_agent_pause", "get_budget", "get_diagnostics", "get_dossier", "list_dossiers", "whoami"];
  const write = ["classify_invalid_source_other", "classify_other", "close_handled_outside", "continue_dossier", "reconcile_identification", "reconcile_note",
    "record_choice", "release_hold", "request_reinvestigation", "set_agent_pause"];
  const list = async (flags: Record<string, string>) => ((await (await rpc("tools/list", {}, { env: flags })).json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[] } }).result.tools;
  const off = await list(env);
  expect(off.map(t => t.name).sort()).toEqual(read);
  expect(off.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true);
  const on = await list({ ...env, STUDIO_MCP_WRITES_ENABLED: "true" });
  expect(on.map(t => t.name).sort()).toEqual([...read, ...write].sort());
  expect(on.filter(t => write.includes(t.name)).every(t => !t.annotations.readOnlyHint && t.annotations.destructiveHint)).toBe(true);
});
it("SAV-23 whoami returns the staff row resolved from the token", async () => {
  expect((await callTool("whoami")).result?.structuredContent).toMatchObject({ outcome: "done", data: { email: "ugo@limova.ai", role: "admin" } });
  current = contact;
  expect((await callTool("whoami")).result?.structuredContent).toMatchObject({ outcome: "done", data: { email: "contact@limova.ai", role: "member" } });
});
it("SAV-24 unknown tools and schema violations are refused without running anything", async () => {
  const unknown = await callTool("reset_budget");
  expect(unknown.error ?? unknown.result?.isError).toBeTruthy();
  for (const args of [{ threadId: "not-a-uuid" }, { threadId: "10000000-0000-4000-8000-000000000001", extra: true }]) {
    const invalid = await callTool("get_diagnostics", args);
    expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
  }
  expect(state.diagnostics).not.toHaveBeenCalled();
});
it("SAV-26 get_diagnostics follows the diagnostics API: role admin only", async () => {
  state.diagnostics.mockResolvedValue({ runs: [], messageId: "m" });
  const threadId = "10000000-0000-4000-8000-000000000001";
  expect((await callTool("get_diagnostics", { threadId })).result?.structuredContent).toMatchObject({ outcome: "done", data: { runs: [] } });
  for (const who of [reouven, contact]) {
    current = who;
    expect((await callTool("get_diagnostics", { threadId })).result?.structuredContent).toMatchObject({ outcome: "refused", code: "SAV_INTAKE_DIAGNOSTICS_FORBIDDEN" });
  }
  expect(state.diagnostics).toHaveBeenCalledTimes(1);
});
it("SAV-26 get_budget follows the budget page: the budget owner only, read-only", async () => {
  const owner = await callTool("get_budget");
  expect(owner.result?.structuredContent).toMatchObject({ outcome: "done", data: { ceilingNanoUsd: 20_000_000_000 } });
  for (const who of [reouven, contact]) {
    current = who;
    expect((await callTool("get_budget")).result?.structuredContent).toMatchObject({ outcome: "refused", code: "SAV_INTAKE_BUDGET_UNAUTHORIZED" });
  }
});
it("SAV-24 business refusals keep their code, internal errors never leak, every call is logged without content", async () => {
  const info = vi.mocked(console.info);
  state.list.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
  expect((await callTool("list_dossiers", { search: "client privé" })).result?.structuredContent).toMatchObject({ outcome: "refused", code: "SAV_INTAKE_CONSOLE_UNAUTHORIZED" });
  state.list.mockRejectedValueOnce(Error("connection string postgres://secret@db"));
  const internal = await callTool("list_dossiers");
  expect(internal.result?.structuredContent).toMatchObject({ outcome: "refused", code: "MCP_INTERNAL_ERROR" });
  expect(JSON.stringify(internal)).not.toContain("secret");
  const logged = JSON.stringify(info.mock.calls);
  expect(logged).toContain("list_dossiers"); expect(logged).not.toContain("client privé"); expect(logged).not.toContain("secret");
});
it("SAV-24 rate-limits one staff member per instance", async () => {
  state.diagnostics.mockResolvedValue(null);
  for (let n = 0; n < STUDIO_MCP_RATE.calls; n++) await callTool("whoami");
  expect((await callTool("whoami")).result?.structuredContent).toMatchObject({ outcome: "refused", code: "MCP_RATE_LIMITED" });
  current = contact;
  expect((await callTool("whoami")).result?.structuredContent).toMatchObject({ outcome: "done" });
});


it("REVIEW-bf05 stateless JSON MCP must not advertise a GET SSE that closes immediately", async () => {
  const response = await handleStudioMcpRequest(new Request(url, {
    method: "GET", headers: { accept: "text/event-stream", authorization: "Bearer synthetic-token-0123456789" },
  }), { resolveUser, env });
  expect(response.status).toBe(405);
});
it("BF05 the real SDK client works against the JSON transport and tries the GET stream at most once", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const methods: string[] = [], statuses: number[] = [];
  const fetchInMemory = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); methods.push(request.method);
    const response = await handleStudioMcpRequest(request, { resolveUser, env }); statuses.push(response.status); return response;
  };
  const client = new Client({ name: "interop", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: fetchInMemory, requestInit: { headers: { authorization: "Bearer synthetic-token-0123456789" } },
    reconnectionOptions: { initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1, maxRetries: 50 } });
  await client.connect(transport);
  expect((await client.listTools()).tools.map(t => t.name)).toContain("get_dossier");
  expect((await client.callTool({ name: "whoami", arguments: {} })).structuredContent).toMatchObject({ outcome: "done", data: { email: "ugo@limova.ai" } });
  await new Promise(resolve => setTimeout(resolve, 50));
  await client.close();
  expect(methods.filter(m => m === "GET").length).toBeLessThanOrEqual(1);
  expect(statuses.filter((s, i) => methods[i] === "GET").every(s => s === 405)).toBe(true);
});
it("BF05 GET and DELETE keep every guard before the 405, and replies are private", async () => {
  const get = (headers: Record<string, string> = {}, flags: Record<string, string> = env, method = "GET") => handleStudioMcpRequest(new Request(url, { method,
    headers: { accept: "text/event-stream", authorization: "Bearer synthetic-token-0123456789", ...headers } }), { resolveUser, env: flags });
  expect((await get({}, {})).status).toBe(404);
  expect((await get({ origin: "https://attacker.example" })).status).toBe(403);
  current = new StudioMcpAuthError("MCP_TOKEN_INVALID"); expect((await get()).status).toBe(401);
  current = user("user_arnaud", "arnaud@limova.ai"); expect((await get()).status).toBe(403);
  current = ugo;
  for (const method of ["GET", "DELETE"]) {
    const response = await get({}, env, method);
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST"); expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  const post = await rpc("tools/list");
  expect(post.status).toBe(200); expect(post.headers.get("cache-control")).toBe("private, no-store"); expect(post.headers.get("x-content-type-options")).toBe("nosniff");
});
