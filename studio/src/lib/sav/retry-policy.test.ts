import { describe, expect, it } from "vitest";
import { savActionFailurePlan } from "./retry-policy";

describe("SAV external action retry policy", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  it("backs off transient failures and stops after five attempts", () => {
    expect(savActionFailurePlan("GMAIL_HTTP_503", 1, now)).toMatchObject({ status: "pending", terminal: false, scheduledAt: new Date("2026-09-09T12:01:00Z") });
    expect(savActionFailurePlan("HUBSPOT_HTTP_429", 4, now)).toMatchObject({ status: "pending", scheduledAt: new Date("2026-09-09T12:08:00Z") });
    expect(savActionFailurePlan("HUBSPOT_HTTP_503", 5, now)).toMatchObject({ status: "failed", terminal: true });
  });
  it("does not retry invalid, ambiguous or obsolete operations", () => {
    expect(savActionFailurePlan("SAV_TICKET_MATCH_AMBIGUOUS:1,2", 1, now).status).toBe("failed");
    expect(savActionFailurePlan("SAV_REPLY_OBSOLETE", 1, now).status).toBe("cancelled");
    expect(savActionFailurePlan("GMAIL_HTTP_400", 1, now).status).toBe("failed");
  });
});
