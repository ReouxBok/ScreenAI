import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, diagnostics: vi.fn(), list: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => { throw Error("NO_SESSION_ON_MCP"); }, clerkClient: async () => { throw Error("NO_REAL_CLERK"); } }));
vi.mock("@/lib/sav/intake/run-diagnostics", () => ({ readIntakeRunDiagnostics: state.diagnostics }));
vi.mock("@/lib/sav/intake/console-store", () => ({ listIntakeConsole: state.list }));
import { handleStudioMcpRequest, resetStudioMcpRateLimit, STUDIO_MCP_RATE } from "./server";
import { StudioMcpAuthError } from "./identity";
import { studioMcpConfig } from "./config";
import { encryptSavPayload } from "@/lib/sav/crypto";
import { aggregateSmartShadow, SAV_SMART_SHADOW_PREFIX, type SmartShadowStored } from "@/lib/sav/cases/smart/smart-shadow";

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
  const read = ["get_agent_pause", "get_budget", "get_diagnostics", "get_dossier", "get_fiche", "list_dossiers", "list_v2_cases", "search_fiches", "v2_daily_report", "v2_shadow_report", "whoami"];
  const write = ["classify_invalid_source_other", "classify_other", "close_handled_outside", "continue_dossier", "reconcile_effect", "reconcile_identification", "reconcile_note",
    "propose_fiche", "propose_fiche_update", "publish_fiche", "record_choice", "release_hold", "request_reinvestigation", "set_agent_pause"];
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

it("SAV-92 V2 inventory checks admin before reading and validates input", async () => {
  for (const caller of [contact, reouven]) {
    current = caller;
    expect((await callTool("list_v2_cases")).result?.structuredContent).toMatchObject({ outcome: "refused", code: "SAV_V2_INVENTORY_FORBIDDEN" });
  }
  current = ugo;
  expect((await callTool("list_v2_cases")).result?.structuredContent).toMatchObject({ outcome: "done", data: { attendus: 0, rows: [], nextCursor: null } });
  expect((await callTool("list_v2_cases", { limit: 101 })).result?.isError).toBe(true);
});

it("SAV-92 daily report is administrator-only and requires a bounded window", async () => {
  const args = { from: "2026-11-15T00:00:00Z", until: "2026-11-16T00:00:00Z" };
  for (const other of [reouven, contact]) {
    current = other;
    expect((await callTool("v2_daily_report", args)).result?.structuredContent).toMatchObject({ outcome: "refused", code: "SAV_V2_REPORT_FORBIDDEN" });
  }
  current = ugo;
  expect((await callTool("v2_daily_report", args)).result?.structuredContent).toMatchObject({ outcome: "done", data: { coverage: { expected: 0, checked: 0, complete: true } } });
  expect((await callTool("v2_daily_report")).result?.isError).toBe(true);
  expect((await callTool("v2_daily_report", { ...args, until: "2026-11-23T00:00:00Z" })).result?.isError).toBe(true);
});

/*
 * v2_shadow_report: the smart agent's shadow rows over a range of UTC days, codes and numbers only. FICTIONAL rows; every free-text field of the
 * stored turn carries a marker that must never come out of the tool.
 */
const LEAK = ["MARKER_MAIL_BODY", "MARKER_SUBJECT", "MARKER_REPLY", "MARKER_NOTE", "MARKER_READING", "MARKER_FACT", "MARKER_MEMORY", "MARKER_SENTENCE", "MARKER_THINKING",
  "fictif@exemple.invalid", "Jeanne Fictive"];
function shadowRow(messageId: string, outcome: "handoff" | "reply" | "ask", extra: Partial<SmartShadowStored> = {}): SmartShadowStored {
  const note = { raison: "no_source", besoin: "MARKER_NOTE besoin de Jeanne Fictive", compris: "MARKER_NOTE compris", verifie: [{ fait: "MARKER_NOTE fait", source: "fiche-x" }],
    essaye: [{ quoi: "MARKER_NOTE essai", resultat: "échec" }], hypotheses: [], prochaineVerification: "MARKER_NOTE vérifier", ditAuClient: null };
  return { v1Gate: "support", messageId, receivedAt: "2026-11-22T17:00:00.000Z", startedAt: "2026-11-22T18:10:00.000Z", durationMs: 4_200, costMicroUsd: 1_500,
    revision: "smart-v19", promptSha256: "a".repeat(64), contractRevision: "c5", model: "gemini-test", codeSha: "e0a23e6f",
    turn: { outcome, reasons: outcome === "handoff" ? ["refused_after_correction"] : [], sensitiveStop: null,
      reading: { summary: "MARKER_READING fictif@exemple.invalid" } as never,
      decision: { outcome, reply: "MARKER_REPLY Bonjour Jeanne Fictive", teamNote: outcome === "handoff" ? note : null, handoffReason: outcome === "handoff" ? "no_source" : null,
        coverage: [], facts: [{ sentence: "MARKER_FACT" }], memory: { newFacts: [{ text: "MARKER_MEMORY" }] } } as never,
      replyWithFooter: "MARKER_REPLY avec pied", checks: { first: ["need_not_covered"], second: outcome === "handoff" ? ["excerpt_not_found"] : null },
      verdicts: { first: { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: "MARKER_SENTENCE" }] }, second: null },
      corrected: true,
      calls: [{ kind: "decide", status: "ok", problem: null, inputBytes: 9_000, uncertain: false, sent: true, usage: { inputTokens: 1_000, outputTokens: 200 } }],
      sources: [{ cardId: "fiche-connexion", version: "v3", needIds: ["n1"] }],
      missing: [{ needId: "n2", theme: "Facturation" }],
      steps: [{ pass: 1, kind: "decide", action: "tools" }, { pass: 1, kind: "tool", tool: "chercher_fiches", status: "ok", code: null, argsHash: "h", bytes: 300 },
        { pass: 2, kind: "decide", action: "final" }],
      teamNote: outcome === "handoff" ? note as never : null, teamNoteText: outcome === "handoff" ? "MARKER_NOTE texte rendu" : null,
      memory: { facts: ["MARKER_MEMORY"], thinking: "MARKER_THINKING" } as never, progressed: true },
    ...extra };
}
async function storeShadow(day: string, status: string, result: SmartShadowStored | null, messageId: string = crypto.randomUUID()) {
  await f.db.insert(savSyncState).values({ key: `${SAV_SMART_SHADOW_PREFIX}:item:mail:${messageId}`, status, startedAt: new Date(`${day}T18:10:00.000Z`),
    cursor: encryptSavPayload({ version: 1, scope: day, reservedMicroUsd: 10_000, costMicroUsd: result ? result.costMicroUsd : null, result }) });
  return messageId;
}
describe("v2_shadow_report", () => {
  const args = { from: "2026-11-22", until: "2026-11-23" };
  beforeEach(async () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "mcp-shadow-report-fixture-key-32chars!!");
    await f.db.delete(savSyncState);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is administrator-only: owner and member are refused, even with rows in range", async () => {
    await storeShadow("2026-11-22", "done", shadowRow(crypto.randomUUID(), "handoff"));
    for (const other of [reouven, contact]) {
      current = other;
      const refusal = await callTool("v2_shadow_report", args);
      expect(refusal.result?.structuredContent).toMatchObject({ outcome: "refused", code: "SAV_V2_SHADOW_REPORT_FORBIDDEN" });
      expect(refusal.result?.structuredContent?.data).toBeUndefined();
    }
  });
  it("requires a range of UTC days, 7 days maximum, from before until", async () => {
    for (const bad of [{}, { from: "2026-11-22" }, { from: "2026-11-16", until: "2026-11-23" }, { from: "2026-11-23", until: "2026-11-22" },
      { from: "2026-11-22T00:00:00Z", until: "2026-11-23" }, { from: "2026-02-30", until: "2026-03-01" }, { ...args, extra: true }, { ...args, outcome: "maybe" }])
      expect((await callTool("v2_shadow_report", bad)).result?.isError).toBe(true);
    expect((await callTool("v2_shadow_report", { from: "2026-11-17", until: "2026-11-23" })).result?.structuredContent).toMatchObject({ outcome: "done", data: { cases: [], casesTotal: 0 } });
    expect((await callTool("v2_shadow_report", { from: "2026-11-23", until: "2026-11-23" })).result?.structuredContent).toMatchObject({ outcome: "done" });
  });
  it("passes the existing aggregate through, lists each mail with codes only, and never leaks customer content", async () => {
    const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${crypto.randomUUID()}@exemple.invalid` }).returning();
    const [thread] = await f.db.insert(savThreads).values({ mailboxId: mailbox!.id, gmailThreadId: `t-${crypto.randomUUID()}`, subject: "MARKER_SUBJECT", customerEmail: "fictif@exemple.invalid" }).returning();
    const [message] = await f.db.insert(savMessages).values({ threadId: thread!.id, mailboxId: mailbox!.id, direction: "inbound", fromEmail: "fictif@exemple.invalid", toEmails: [],
      subject: "MARKER_SUBJECT", bodyCiphertext: encryptSavPayload({ text: "MARKER_MAIL_BODY" }), receivedAt: new Date("2026-11-22T17:00:00.000Z"), gmailMessageId: `gm-${crypto.randomUUID()}` }).returning();
    const handoff = shadowRow(message!.id, "handoff"), reply = shadowRow(crypto.randomUUID(), "reply", { startedAt: "2026-11-23T08:00:00.000Z" });
    await storeShadow("2026-11-22", "done", handoff, handoff.messageId);
    await storeShadow("2026-11-23", "done", reply, reply.messageId);
    await storeShadow("2026-11-21", "done", shadowRow(crypto.randomUUID(), "ask"));
    await storeShadow("2026-11-23", "pending", null);
    await f.db.insert(savSyncState).values({ key: `${SAV_SMART_SHADOW_PREFIX}:gate:mail:${crypto.randomUUID()}`, status: "team", startedAt: new Date("2026-11-22T19:00:00.000Z"),
      cursor: encryptSavPayload({ messageId: crypto.randomUUID(), gate: "team", reason: "finance", at: "2026-11-22T19:00:00.000Z" }) });

    const response = await callTool("v2_shadow_report", args);
    const data = response.result?.structuredContent?.data as { summary: unknown; cases: Array<Record<string, unknown>>; casesTotal: number; itemsWithoutResult: unknown; rowsTruncated: boolean };
    expect(response.result?.structuredContent?.outcome).toBe("done");
    expect(data.summary).toEqual(JSON.parse(JSON.stringify(aggregateSmartShadow([handoff, reply], [{ reason: "finance" }]))));
    expect(data.summary).toMatchObject({ support: { mails: 2, outcomes: { handoff: 1, reply: 1 } }, discardedByV1: { mails: 1, byReason: { finance: 1 } } });
    expect(data).toMatchObject({ casesTotal: 2, itemsWithoutResult: { pending: 1 }, rowsTruncated: false });
    expect(data.cases.map(line => line.outcome)).toEqual(["reply", "handoff"]);
    expect(data.cases[1]).toEqual({
      messageId: message!.id, threadId: thread!.id, day: "2026-11-22", receivedAt: "2026-11-22T17:00:00.000Z", startedAt: "2026-11-22T18:10:00.000Z", durationMs: 4_200, v1Gate: "support",
      outcome: "handoff", reasons: ["refused_after_correction"], sensitiveStop: null, decisionOutcome: "handoff", handoffReason: "no_source",
      teamNote: { raison: "no_source", verified: 1, tried: 1, hypotheses: 0, nextCheck: true, toldCustomer: false },
      serverRefusals: { first: ["need_not_covered"], second: ["excerpt_not_found"] },
      verifyRefusals: { first: { verdict: "non_conforme", codes: ["unlisted_claim"] }, second: null },
      corrected: true, progressed: true, missingThemes: ["facturation"], sources: [{ cardId: "fiche-connexion", version: "v3", needs: 1 }],
      decidePasses: [{ pass: 1, action: "tools", status: null, code: null }, { pass: 2, action: "final", status: null, code: null }],
      tools: [{ pass: 1, tool: "chercher_fiches", status: "ok", code: null, bytes: 300 }],
      calls: [{ kind: "decide", status: "ok", problem: null, inputBytes: 9_000, uncertain: false, sent: true, inputTokens: 1_000, outputTokens: 200 }],
      costMicroUsd: 1_500, revision: { prompt: "smart-v19", promptSha256: "a".repeat(16), contract: "c5", model: "gemini-test", codeSha: "e0a23e6f" } });
    expect(data.cases[0]).toMatchObject({ threadId: null, teamNote: null, day: "2026-11-23" });
    const text = JSON.stringify(response);
    for (const marker of LEAK) expect(text).not.toContain(marker);

    const filtered = (await callTool("v2_shadow_report", { ...args, outcome: "handoff" })).result?.structuredContent?.data as { cases: unknown[]; casesTotal: number; summary: unknown };
    expect(filtered.cases).toHaveLength(1); expect(filtered.casesTotal).toBe(1); expect(filtered.summary).toEqual(data.summary);
  });
  it("lists 50 mails at most, newest first, and says how many remain", async () => {
    for (let n = 0; n < 53; n++) await storeShadow("2026-11-22", "done", shadowRow(crypto.randomUUID(), "handoff", { costMicroUsd: n }));
    const data = (await callTool("v2_shadow_report", args)).result?.structuredContent?.data as { cases: unknown[]; casesTotal: number; casesTruncated: boolean };
    expect(data.cases).toHaveLength(50); expect(data).toMatchObject({ casesTotal: 53, casesTruncated: true, summary: { support: { mails: 53 } } });
  });
});
