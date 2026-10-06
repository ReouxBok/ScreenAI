import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSavHubspotContext } from "./hubspot";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("HubSpot dossier context reads", () => {
  it("does not filter associated tickets by the incoming email subject", async () => {
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture-token");
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("contacts/search")) return Response.json({ results: [{ id: "42", properties: { email: "client@example.invalid" } }] });
      if (url.endsWith("tickets/search")) {
        expect(JSON.parse(String(init?.body))).not.toHaveProperty("query");
        return Response.json({ results: [{ id: "99", properties: { subject: "Une autre question", content: "Historique utile", hs_pipeline: "0", hs_pipeline_stage: "1" } }] });
      }
      return Response.json({ results: [{ id: "0", stages: [{ id: "1", metadata: { isClosed: false } }] }] });
    });
    vi.stubGlobal("fetch", network);
    const context = await readSavHubspotContext({ email: "client@example.invalid", subject: "Question actuelle" });
    expect(context.tickets).toMatchObject([{ id: "99", subject: "Une autre question", description: "Historique utile" }]);
  });
  it("preserves a contact if ticket lookup fails, while write preflights remain strict", async () => {
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture-token");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("contacts/search")
      ? Response.json({ results: [{ id: "42", properties: { email: "client@example.invalid" } }] })
      : new Response("private provider error", { status: 403 })));
    await expect(readSavHubspotContext({ email: "client@example.invalid", subject: "Aide", toleratePartial: true })).resolves.toMatchObject({ contactId: "42", contactFound: true, errorCode: "SAV_HUBSPOT_TICKETS_UNAVAILABLE" });
    await expect(readSavHubspotContext({ email: "client@example.invalid", subject: "Aide" })).rejects.toThrow("HUBSPOT_HTTP_403");
  });
});
import { compactHubspotTicketTranscript, HUBSPOT_TICKET_TRANSCRIPT_MAX_BYTES, isHubspotEmailReadScopeError, processPendingPilotHubspotActions, processPendingPilotHubspotActionsAcrossBatches, shouldAttemptHubspotBackfill, summarizeHubspotError, verifyHubspotSignature } from "./hubspot";

describe("HubSpot webhook verification", () => {
  it("never executes HubSpot work for a pilot batch", async () => {
    await expect(processPendingPilotHubspotActions("pilot-batch", 100)).resolves.toEqual({
      skipped: "pilot_simulation_only",
      processed: [],
    });
    await expect(processPendingPilotHubspotActionsAcrossBatches(100)).resolves.toEqual({
      skipped: "pilot_simulation_only",
      processed: [],
    });
  });

  it("validates a current v3 signature", () => {
    const input = {
      method: "POST",
      uri: "https://studio.limova.ai/api/webhooks/hubspot",
      body: '[{"subscriptionType":"ticket.propertyChange"}]',
      timestamp: "1788170400000",
      clientSecret: "hubspot-test-client-secret",
    };
    const signature = createHmac("sha256", input.clientSecret)
      .update(`${input.method}${input.uri}${input.body}${input.timestamp}`, "utf8").digest("base64");
    expect(verifyHubspotSignature({ ...input, signature, now: Number(input.timestamp) + 30_000 })).toBe(true);
  });

  it("rejects old requests and invalid signatures", () => {
    const timestamp = "1788170400000";
    expect(verifyHubspotSignature({
      method: "POST",
      uri: "https://studio.limova.ai/api/webhooks/hubspot",
      body: "[]",
      timestamp,
      signature: "invalid",
      clientSecret: "secret",
      now: Number(timestamp) + 6 * 60 * 1_000,
    })).toBe(false);
  });

  it("keeps HubSpot diagnostics actionable without persisting response messages", () => {
    expect(summarizeHubspotError(400, {
      category: "VALIDATION_ERROR",
      message: "Invalid owner 123 for client@example.com",
      errors: [{ code: "INVALID_OWNER_ID" }],
    })).toBe("HUBSPOT_HTTP_400:VALIDATION_ERROR:INVALID_OWNER_ID");
  });

  it("extracts only safe field and scope identifiers from HubSpot errors", () => {
    expect(summarizeHubspotError(403, {
      category: "MISSING_SCOPES",
      message: "Access refused for client@example.com",
      errors: [{ context: { requiredGranularScopes: ["crm.objects.emails.read"] } }],
    })).toBe("HUBSPOT_HTTP_403:MISSING_SCOPES:crm.objects.emails.read");
    expect(summarizeHubspotError(400, {
      category: "VALIDATION_ERROR",
      message: 'Property invalid: {"name":"hs_email_headers","error":"INVALID_JSON","value":"client@example.com"}',
    })).toBe("HUBSPOT_HTTP_400:VALIDATION_ERROR:hs_email_headers:INVALID_JSON");
  });

  it("classifies missing email-read access and rate-limits automatic backfill retries", () => {
    const error = "HUBSPOT_HTTP_403:MISSING_SCOPES:crm.schemas.emails.read:crm.objects.emails.read:sales-email-read";
    expect(isHubspotEmailReadScopeError(error)).toBe(true);
    expect(isHubspotEmailReadScopeError("HUBSPOT_HTTP_403:MISSING_SCOPES:crm.objects.contacts.read")).toBe(false);

    const now = Date.parse("2026-09-01T14:00:00.000Z");
    expect(shouldAttemptHubspotBackfill({ status: "blocked", lastError: error, updatedAt: new Date(now - 5 * 60_000) }, now)).toBe(false);
    expect(shouldAttemptHubspotBackfill({ status: "blocked", lastError: error, updatedAt: new Date(now - 31 * 60_000) }, now)).toBe(true);
    expect(shouldAttemptHubspotBackfill({ status: "failed", lastError: "HUBSPOT_HTTP_500", updatedAt: new Date(now) }, now)).toBe(true);
    expect(shouldAttemptHubspotBackfill({ status: "running", lastError: null, updatedAt: new Date(now - 5 * 60_000) }, now)).toBe(false);
    expect(shouldAttemptHubspotBackfill({ status: "running", lastError: null, updatedAt: new Date(now - 11 * 60_000) }, now)).toBe(true);
  });

  it("keeps HubSpot ticket transcripts useful without exhausting database storage", () => {
    const transcript = Array.from({ length: 200 }, (_, index) => ({
      id: `email-${index}`,
      hs_email_text: `Texte ${index} `.repeat(2_000),
      hs_email_html: `<p>${`HTML ${index} `.repeat(2_000)}</p>`,
      hs_email_subject: `Sujet ${index}`,
      hs_email_from_email: "client@example.com",
      hs_email_to_email: "contact@limova.ai",
      hs_timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      hs_email_direction: index % 2 ? "OUTGOING_EMAIL" : "INCOMING_EMAIL",
    }));
    const compacted = compactHubspotTicketTranscript(transcript);
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted.at(-1)?.id).toBe("email-199");
    expect(compacted.every((email) => email.hs_email_html === "")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ transcript: compacted }), "utf8"))
      .toBeLessThanOrEqual(HUBSPOT_TICKET_TRANSCRIPT_MAX_BYTES);
  });
});
