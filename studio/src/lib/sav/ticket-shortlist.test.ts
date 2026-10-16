import { describe, expect, it } from "vitest";
import { shortlistSavTickets, savSubsetMatchIsComplete } from "./ticket-shortlist";
describe("bounded retrieval never establishes an absent issue", () => {
  const closed = (id: string, day = "01") => ({ id, subject: "Sujet", description: "Téléphone", status: "closed" as const, closedAt: `2026-10-${day}T00:00:00Z` });
  it("keeps an explicitly linked record among more than one hundred records", () => {
    const records = Array.from({ length: 150 }, (_, i) => closed(String(i)));
    const result = shortlistSavTickets(records, "Sujet téléphone", "149");
    expect(result.selected).toHaveLength(12); expect(result.selected[0].id).toBe("149"); expect(result.limits.omittedClosed).toBe(138);
    expect(savSubsetMatchIsComplete({ kind: "new" }, result.omitted)).toBe(false);
  });
  it("allows a unique open match only when no active candidate was omitted", () => {
    const ticket = { ...closed("open"), status: "open" as const };
    expect(savSubsetMatchIsComplete({ kind: "matched", ticket }, [closed("old")])).toBe(true);
    expect(savSubsetMatchIsComplete({ kind: "matched", ticket }, [{ ...ticket, id: "unseen" }])).toBe(false);
  });
  it("keeps old closed tickets as signals and refuses uncertain closure priority", () => {
    const match = closed("match", "10");
    expect(savSubsetMatchIsComplete({ kind: "matched", ticket: match }, [closed("old", "01")])).toBe(true);
    expect(savSubsetMatchIsComplete({ kind: "matched", ticket: match }, [closed("recent", "11")])).toBe(false);
    expect(savSubsetMatchIsComplete({ kind: "matched", ticket: match }, [{ ...closed("unknown"), closedAt: null }])).toBe(false);
  });
});
