import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSavPreflight } from "./preflight";
import { GET } from "@/app/api/internal/sav/preflight/route";

beforeEach(() => {
  for (const [name, value] of Object.entries({ SAV_RELEASE_STAGE: "v0", SAV_AUTOMATION_MODE: "shadow", SAV_WRITES_DISABLED: "true", SAV_PILOT_MODE: "false", SAV_HUBSPOT_BACKFILL_ENABLED: "false", SAV_RETENTION_ENABLED: "false", DEV_AUTH_BYPASS: "false", GMAIL_SUPPORT_ADDRESS: "contact@limova.ai", GMAIL_CLIENT_ID: "private-client", GMAIL_CLIENT_SECRET: "private-secret", GMAIL_REFRESH_TOKEN: "private-refresh", HUBSPOT_ACCESS_TOKEN: "private-crm-token", HUBSPOT_TICKET_PIPELINE_ID: "pipeline", HUBSPOT_NEW_TICKET_STAGE_ID: "new", HUBSPOT_AWAITING_CUSTOMER_STAGE_ID: "awaiting", HUBSPOT_HUMAN_STAGE_ID: "human", SAV_AI_MODEL: "fixture-model", SAV_GEMINI_API_KEY: "private-model-key", STUDIO_SERVICE_TOKEN: "private-service-token-long-enough-for-auth" })) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const payload = url.endsWith("/token") ? { access_token: "private-access-token" }
      : url.endsWith("/profile") ? { emailAddress: "contact@limova.ai" }
      : url.endsWith("/labels") ? { labels: [{ name: "MAIL STUDIO SAV", type: "user" }] }
      : url.includes("/pipelines/") ? { stages: [{ id: "new" }, { id: "awaiting" }, { id: "human" }] }
      : url.includes("/models/") ? { supportedGenerationMethods: ["generateContent"] }
      : { results: [{ email: "customer-private@example.org" }] };
    return Response.json(payload);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("rejects unauthenticated diagnostics without contacting a provider", async () => {
  expect((await GET(new Request("http://localhost/api/internal/sav/preflight"))).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it("requires the explicit locked observation configuration", async () => {
  vi.stubEnv("SAV_WRITES_DISABLED", "false");
  expect(await readSavPreflight()).toMatchObject({ ok: false, errorCode: "SAV_PREFLIGHT_LOCK_REQUIRED" });
  expect(fetch).not.toHaveBeenCalled();
});
it("checks live read access without returning secrets or CRM records", async () => {
  const report = await readSavPreflight();
  expect(report).toMatchObject({ ok: true, gmail: { studioLabelExists: true }, hubspot: { pipelineStagesValid: true }, model: { inferenceNotTested: true } });
  expect(JSON.stringify(report)).not.toMatch(/private-|customer-private/);
  for (const [url, init] of vi.mocked(fetch).mock.calls) {
    if (String(url).endsWith("/token")) expect(init?.method).toBe("POST");
    else expect(init?.method ?? "GET").toBe("GET");
  }
});
it("fails closed on a wrong OAuth mailbox", async () => {
  vi.stubEnv("GMAIL_SUPPORT_ADDRESS", "different@limova.ai");
  expect(await readSavPreflight()).toMatchObject({ ok: false, gmail: { errorCode: "GMAIL_MAILBOX_IDENTITY_MISMATCH" } });
});
it("redacts provider failures", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("private-token and customer payload"));
  const report = await readSavPreflight();
  expect(report.ok).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(/private-token|customer payload/);
});
it("does not cache an authenticated report", async () => {
  const response = await GET(new Request("http://localhost/api/internal/sav/preflight", { headers: { authorization: `Bearer ${process.env.STUDIO_SERVICE_TOKEN}` } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
