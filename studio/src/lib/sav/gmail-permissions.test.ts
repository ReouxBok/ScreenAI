import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSavGmailPermissions } from "./gmail-permissions";
import { GET } from "@/app/api/internal/sav/gmail-permissions/route";

const prefix = "https://www.googleapis.com/auth/gmail.";
let scope: unknown;
const network = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("/token")
  ? { access_token: "private-fixture-access", scope }
  : { emailAddress: "contact@limova.ai" }));
beforeEach(() => {
  for (const [name, value] of Object.entries({ GMAIL_CLIENT_ID: "private-client", GMAIL_CLIENT_SECRET: "private-secret", GMAIL_REFRESH_TOKEN: "private-refresh", GMAIL_SUPPORT_ADDRESS: "contact@limova.ai", STUDIO_SERVICE_TOKEN: "private-service-token-at-least-32-characters", SAV_AUTOMATION_MODE: "assist", SAV_WRITES_DISABLED: "false" })) vi.stubEnv(name, value);
  scope = `${prefix}readonly`; network.mockClear(); vi.stubGlobal("fetch", network);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("read-only Gmail grant diagnostics", () => {
  it("rejects unauthenticated or undersized service tokens before contacting Google", async () => {
    expect((await GET(new Request("http://localhost/api/internal/sav/gmail-permissions"))).status).toBe(401);
    vi.stubEnv("STUDIO_SERVICE_TOKEN", "short");
    expect((await GET(new Request("http://localhost", { headers: { authorization: "Bearer short" } }))).status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });
  it("reports missing send and modify scopes in assist without doing an email write", async () => {
    const response = await GET(new Request("http://localhost", { headers: { authorization: `Bearer ${process.env.STUDIO_SERVICE_TOKEN}` } }));
    expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json();
    expect(report).toMatchObject({ scopeKnown: true, modifyScopeGranted: false, sendScopeGranted: false, errorCode: "SAV_GMAIL_WRITE_SCOPES_MISSING", writesNotTested: true });
    expect(JSON.stringify(report)).not.toContain("private-");
    expect(network.mock.calls.map(([url]) => String(url))).toEqual(["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/profile"]);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("POST");
    expect(vi.mocked(fetch).mock.calls[1][1]?.method ?? "GET").toBe("GET");
  });
  it.each([`${prefix}modify`, "https://mail.google.com/"])("recognizes the %s grant without claiming a tested send", async (grant) => {
    scope = grant;
    expect(await readSavGmailPermissions()).toMatchObject({ ok: true, modifyScopeGranted: true, sendScopeGranted: true, writesNotTested: true });
  });
  it("distinguishes send-only permission from Gmail classification permission", async () => {
    scope = `${prefix}readonly ${prefix}send`;
    expect(await readSavGmailPermissions()).toMatchObject({ ok: false, modifyScopeGranted: false, sendScopeGranted: true });
  });
  it.each([undefined, "", []])("fails closed on unavailable scope information (%s)", async (missing) => {
    scope = missing;
    expect(await readSavGmailPermissions()).toMatchObject({ ok: false, scopeKnown: false, modifyScopeGranted: null, sendScopeGranted: null, errorCode: "SAV_GMAIL_SCOPES_UNKNOWN" });
  });
  it("does not reveal a different mailbox identity", async () => {
    network.mockResolvedValueOnce(Response.json({ access_token: "private-fixture-access", scope })).mockResolvedValueOnce(Response.json({ emailAddress: "private-person@example.invalid" }));
    const report = await readSavGmailPermissions();
    expect(report).toMatchObject({ ok: false, errorCode: "SAV_GMAIL_MAILBOX_IDENTITY_MISMATCH" });
    expect(JSON.stringify(report)).not.toContain("private-");
  });
  it("redacts Google errors and arbitrary exception text", async () => {
    network.mockResolvedValueOnce(new Response("private-provider-body", { status: 401 }));
    expect(await readSavGmailPermissions()).toEqual({ ok: false, errorCode: "SAV_GMAIL_OAUTH_CHECK_FAILED", providerStatus: 401 });
    network.mockRejectedValueOnce(new Error("PRIVATE_SECRET_PROVIDER_ERROR"));
    expect(await readSavGmailPermissions()).toEqual({ ok: false, errorCode: "SAV_GMAIL_PERMISSIONS_CHECK_FAILED" });
  });
});
