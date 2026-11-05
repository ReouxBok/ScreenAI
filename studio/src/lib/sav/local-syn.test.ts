import { afterEach, describe, expect, it, vi } from "vitest";
import { canAccessSav } from "./access";
import { SYN_EMAIL, synPreviewEnabled, synRequestAuthorized } from "./local-syn";
vi.mock("@clerk/nextjs/server", () => ({ clerkMiddleware: () => { throw Error("SYN must not contact Clerk"); } }));
const env = { NODE_ENV: "development", SAV_SYN_PREVIEW: "true", DATABASE_URL: "pglite:/private/tmp/studio-synthetic-preview/.sav-preview/sav-preview-db", SAV_SYN_TOKEN: "a".repeat(64), SAV_WRITES_DISABLED: "true", SAV_AI_ANALYSIS: "false" };
const headers = (host = "127.0.0.1:3044", password = env.SAV_SYN_TOKEN) => new Headers({ host, authorization: `Basic ${Buffer.from(`SYN:${password}`).toString("base64")}` });
afterEach(() => vi.unstubAllEnvs());
describe("local SYN session is isolated and fail closed", () => {
  it("requires the exact local environment and a valid session", () => { expect(synPreviewEnabled(env)).toBe(true); expect(synRequestAuthorized(headers(), env)).toBe(true); });
  it.each([
    ["NODE_ENV", "production"], ["VERCEL", "1"], ["SAV_SYN_PREVIEW", "false"], ["SAV_SYN_TOKEN", "short"],
    ["SAV_WRITES_DISABLED", "false"], ["SAV_AI_ANALYSIS", "true"], ["DATABASE_URL", "postgres://remote/db"],
    ["DATABASE_URL", "pglite:/private/tmp/another-db"],
    ["DATABASE_URL", "pglite:/private/tmp/studio-synthetic-visual/other/.sav-preview/sav-preview-db"],
  ])("refuses %s=%s", (key, value) => { expect(synRequestAuthorized(headers(), { ...env, [key]: value })).toBe(false); });
  it.each(["studio.limova.ai", "127.0.0.1.attacker.invalid:3044", "localhost:3044", "[::]:3044"])("refuses a non-pinned host %s", host => expect(synRequestAuthorized(headers(host), env)).toBe(false));
  it("accepts the second exact local database, still only with every other condition", () => { const visual = { ...env, DATABASE_URL: "pglite:/private/tmp/studio-synthetic-visual/.sav-preview/sav-preview-db" }; expect(synRequestAuthorized(headers(), visual)).toBe(true); expect(synRequestAuthorized(headers(), { ...visual, NODE_ENV: "production" })).toBe(false); expect(synRequestAuthorized(headers("127.0.0.1:3044", "f".repeat(64)), visual)).toBe(false); });
  it("refuses absent and incorrect credentials", () => { expect(synRequestAuthorized(new Headers({ host: "127.0.0.1:3044" }), env)).toBe(false); expect(synRequestAuthorized(headers(undefined, "b".repeat(64)), env)).toBe(false); });
  it("never grants the fictitious identity production SAV access", () => { for (const [k,v] of Object.entries(env)) vi.stubEnv(k,v); expect(canAccessSav(SYN_EMAIL, "admin")).toBe(true); expect(canAccessSav(SYN_EMAIL, "member")).toBe(false); vi.stubEnv("NODE_ENV", "production"); expect(canAccessSav(SYN_EMAIL, "admin")).toBe(false); });
});

describe("the SYN HTTP guard protects the real Studio entry", () => {
  it("challenges anonymous access, allows authenticated reads and refuses POST", async () => {
    for (const [k,v] of Object.entries(env)) vi.stubEnv(k,v);
    vi.resetModules();
    const { default: proxy } = await import("@/proxy");
    const request = (method: string, h: Headers) => ({ method, headers: h }) as Parameters<typeof proxy>[0];
    const anonymous = await proxy(request("GET", new Headers({host: "127.0.0.1:3044"})), {} as never);
    expect(anonymous?.status).toBe(401);
    expect(anonymous?.headers.get("www-authenticate")).toContain("Studio SYN local");
    expect((await proxy(request("GET", headers()), {} as never))?.status).toBe(200);
    expect((await proxy(request("POST", headers()), {} as never))?.status).toBe(405);
  });
});
