import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DB_ALLOWED"); } }));
import { caseTicketOwnerPortFromTransport, caseTicketOwnerReadPath, hubspotTicketOwnerReader, type CaseOwnerReadTransport } from "./admission-owner-reader";

/*
 * Lot A10, SYN only: synthetic ids, no database (any access throws), no HubSpot. The transport is a local double;
 * the global fetch is stubbed to throw and must never be called.
 */

const V2_OWNER = "90000001", TEAM_OWNER = "80000001", HUMAN = "70000001", TICKET = "201";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER };
const fetchSpy = vi.fn(async () => { throw Error("NO_NETWORK_ALLOWED"); });
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

/** A transport double that records every request and answers `body` (or throws it when it is an Error). */
function transport(body: unknown) {
  const requests: Array<{ method: string; path: string }> = [];
  const send: CaseOwnerReadTransport = async request => {
    requests.push({ ...request });
    if (body instanceof Error) throw body;
    return body;
  };
  return { send, requests };
}
const ticket = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: TICKET, properties: { hs_object_id: TICKET, createdate: "2026-10-20T09:00:00.000Z", hs_lastmodifieddate: "2026-10-21T09:00:00.000Z", ...properties },
    createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-21T09:00:00.000Z", archived: false, ...extra });

describe("the one request: GET of this ticket, owner property only", () => {
  it("builds exactly one GET on the numeric ticket with properties=hubspot_owner_id", async () => {
    const t = transport(ticket({ hubspot_owner_id: HUMAN }));
    expect(await hubspotTicketOwnerReader(t.send)(TICKET)).toBe(HUMAN);
    expect(t.requests).toEqual([{ method: "GET", path: "/crm/v3/objects/tickets/201?properties=hubspot_owner_id" }]);
    const url = new URL(t.requests[0]!.path, "https://local.invalid");
    expect(url.pathname).toBe("/crm/v3/objects/tickets/201");
    expect([...url.searchParams.entries()]).toEqual([["properties", "hubspot_owner_id"]]);
    expect(caseTicketOwnerReadPath(TICKET)).toBe(t.requests[0]!.path);
  });

  it.each([
    ["empty", ""], ["non-numeric", "abc"], ["path injection", "201/../../owners"], ["query injection", "201?archived=true"], ["absolute URL", "https://example.invalid/201"],
    ["too long", "1".repeat(31)], ["negative", "-201"], ["not a string", 201 as unknown as string], ["undefined", undefined as unknown as string],
  ])("refuses a %s ticket id before any transport", async (_label, id) => {
    const t = transport(ticket({ hubspot_owner_id: HUMAN }));
    await expect(hubspotTicketOwnerReader(t.send)(id)).rejects.toThrow("SAV_CASE_OWNER_READ_TICKET_INVALID");
    expect(t.requests).toEqual([]);
  });

  it("requires an injected transport: none is created by default", () => {
    for (const missing of [undefined, null, {}, "fetch"]) expect(() => hubspotTicketOwnerReader(missing as never)).toThrow("SAV_CASE_OWNER_READ_TRANSPORT_REQUIRED");
    expect(() => caseTicketOwnerPortFromTransport({ transport: undefined as never, env: ENV })).toThrow("SAV_CASE_OWNER_READ_TRANSPORT_REQUIRED");
  });

  it("requires an explicit env: the process environment is never read by default", () => {
    const t = transport(ticket({ hubspot_owner_id: V2_OWNER }));
    for (const env of [undefined, null]) expect(() => caseTicketOwnerPortFromTransport({ transport: t.send, env: env as never })).toThrow("SAV_CASE_OWNER_READ_ENV_REQUIRED");
  });
});

describe("through ticketOwnerPort: v2 / human / none only from a valid answer", () => {
  const port = (body: unknown) => { const t = transport(body); return { read: caseTicketOwnerPortFromTransport({ transport: t.send, env: ENV }), t }; };
  it.each([
    ["the V2 owner", V2_OWNER, "v2"],
    ["a human owner", HUMAN, "human"],
    ["the V1 team owner", TEAM_OWNER, "human"],
    ["explicit null (no owner)", null, "none"],
    ["explicit empty string (no owner)", "", "none"],
    ["a non-numeric owner value", "not-an-id", "unknown"],
    ["a whitespace owner value", " ", "unknown"],
  ] as const)("%s reads %s", async (_label, owner, expected) => {
    const { read, t } = port(ticket({ hubspot_owner_id: owner }));
    expect(await read({ ticketId: TICKET })).toBe(expected);
    expect(t.requests).toHaveLength(1);
  });

  it("the property missing from a valid answer is unknown, never none", async () => {
    const { read } = port(ticket({}));
    expect(await read({ ticketId: TICKET })).toBe("unknown");
    expect(await hubspotTicketOwnerReader(transport(ticket({})).send)(TICKET)).toBeUndefined();
  });

  it("without a valid V2 owner in the given env, the V2 owner reads as human (existing classification kept)", async () => {
    const t = transport(ticket({ hubspot_owner_id: V2_OWNER }));
    expect(await caseTicketOwnerPortFromTransport({ transport: t.send, env: {} })({ ticketId: TICKET })).toBe("human");
  });
});

describe("no reading is never none or v2: the read throws", () => {
  const reads = (body: unknown) => hubspotTicketOwnerReader(transport(body).send)(TICKET);
  it.each([
    ["another ticket's answer", ticket({ hubspot_owner_id: null }, { id: "202" }), "SAV_CASE_OWNER_READ_TICKET_MISMATCH"],
    ["a numeric id instead of the exact string", ticket({ hubspot_owner_id: null }, { id: 201 }), "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["an id with padding", ticket({ hubspot_owner_id: null }, { id: "0201" }), "SAV_CASE_OWNER_READ_TICKET_MISMATCH"],
    ["an archived ticket", ticket({ hubspot_owner_id: null }, { archived: true }), "SAV_CASE_OWNER_READ_TICKET_ARCHIVED"],
    ["a non-boolean archived flag", ticket({ hubspot_owner_id: null }, { archived: "false" }), "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["no properties", { id: TICKET, archived: false }, "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["no id", { properties: { hubspot_owner_id: null } }, "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["a numeric owner value", ticket({ hubspot_owner_id: 70000001 }), "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["an empty body", undefined, "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["a null body", null, "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["a text body", "<html>", "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
    ["a search page instead of a record", { results: [ticket({ hubspot_owner_id: null })] }, "SAV_CASE_OWNER_READ_RESPONSE_INVALID"],
  ])("%s", async (_label, body, code) => { await expect(reads(body)).rejects.toThrow(code); });

  it.each([["a 404 (ticket absent)", "SYNTHETIC_HTTP_404"], ["a 403 (no right)", "SYNTHETIC_HTTP_403"], ["a network error", "SYNTHETIC_NETWORK_DOWN"]])(
    "%s from the transport stays a failed read, never unowned", async (_label, code) => {
      const t = transport(Error(code));
      await expect(caseTicketOwnerPortFromTransport({ transport: t.send, env: ENV })({ ticketId: TICKET })).rejects.toThrow(code);
      expect(t.requests).toHaveLength(1);
    });
});

describe("the source holds no client, credential, host, fetch or mutation", () => {
  it("static guard on the file", () => {
    const source = readFileSync(new URL("./admission-owner-reader.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of ["fetch(", "process.env", "api.hubapi.com", "Bearer", "TOKEN", "hubspot-transport", "createSav", "\"POST\"", "\"PATCH\"", "\"PUT\"", "\"DELETE\"", "/search", "batch"])
      expect(code).not.toContain(banned);
    expect(source.startsWith('import "server-only";')).toBe(true);
  });
});
