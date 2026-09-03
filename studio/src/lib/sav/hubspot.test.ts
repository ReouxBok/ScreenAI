import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isHubspotEmailReadScopeError, processPendingPilotHubspotActions, processPendingPilotHubspotActionsAcrossBatches, shouldAttemptHubspotBackfill, summarizeHubspotError, verifyHubspotSignature } from "./hubspot";

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
  });
});
