import { describe, expect, it, vi } from "vitest";
import { readSavTicketHistory } from "./ticket-history";

describe("bounded HubSpot investigation history", () => {
  it("reads associated notes and emails only, with a snapshot bound and visible truncation", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const read = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, method: init?.method ?? "GET" });
      if (path.includes("/associations/")) return { results: [{ toObjectId: 10 }, { toObjectId: 11 }], paging: { next: {} } } as T;
      return { status: "COMPLETE", results: [{ id: "10", updatedAt: "2026-10-15T09:00:00Z", properties: { hs_timestamp: "2026-10-15T09:00:00Z", hs_note_body: "<p>Version 3.0 déjà confirmée</p>", hs_email_text: "Un contrôle a déjà été essayé" } },
        { id: "11", updatedAt: "2026-10-18T09:00:00Z", properties: { hs_timestamp: "2026-10-18T09:00:00Z", hs_note_body: "Future note", hs_email_text: "Future email" } },
        { id: "999", properties: { hs_timestamp: "2026-10-15T09:00:00Z", hs_note_body: "Unassociated" } }] } as T;
    };
    const result = await readSavTicketHistory(["99"], new Date("2026-10-16T10:00:00Z"), read);
    expect(result.events).toHaveLength(2);
    expect(result.events).toContainEqual(expect.objectContaining({ kind: "note", ticketId: "99", text: "Version 3.0 déjà confirmée" }));
    expect(result.limitations).toContain("notes_outside_snapshot"); expect(result.limitations).toContain("notes_unassociated_record");
    expect(result.limitations).toContain("notes_association_limit");
    expect(calls).toHaveLength(4);
    expect(calls.every(c => c.method === "GET" || c.method === "POST" && c.path.endsWith("/batch/read"))).toBe(true);
    expect(result.relevantTicketId).toBeNull();
  });
  it("bounds tickets, events and text and keeps missing scopes partial", async () => {
    const read = async <T>(path: string): Promise<T> => {
      if (path.includes("emails")) throw new Error("HUBSPOT_HTTP_403");
      if (path.includes("/associations/")) return { results: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1) })) } as T;
      return { status: "COMPLETE", results: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), properties: { hs_timestamp: "2026-10-15T10:00:00Z", hs_note_body: "a".repeat(4000) } })) } as T;
    };
    const result = await readSavTicketHistory(["1", "2", "3"], new Date("2026-10-16"), read);
    expect(result.ticketIds).toEqual(["1", "2"]); expect(result.events.length).toBeLessThanOrEqual(12);
    expect(result.events.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(6000);
    expect(result.limitations).toContain("history_ticket_limit"); expect(result.limitations).toContain("emails_unavailable");
  });
});
