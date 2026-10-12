import { describe, expect, it } from "vitest";
import { savTicketReturnPlan, sortSavTicketsNewestFirst, SAV_TICKET_RETURN_WINDOW_MS } from "./ticket-lifecycle";
import { selectSavTicketMatch } from "./ticket-routing";
const returnedAt = new Date("2026-10-12T08:00:00Z");
describe("supervised ticket return decisions", () => {
  it.each([null, "invalid", "2026-10-13T08:00:00Z"])("requires review for unavailable or later closure %s", closedAt => {
    expect(savTicketReturnPlan({ id: "1", status: "closed", stageId: "4", closedAt }, returnedAt).operation).toBe("review");
  });
  it.each([-1, 0, 1])("uses elapsed time at 15 days plus %s milliseconds", delta => {
    const closedAt = new Date(returnedAt.getTime() - SAV_TICKET_RETURN_WINDOW_MS - delta).toISOString();
    expect(savTicketReturnPlan({ id: "1", status: "closed", stageId: "4", closedAt }, returnedAt).operation).toBe(delta > 0 ? "create" : "reactivate");
  });
  it("does not infer an unknown stage", () => expect(savTicketReturnPlan({ id: "1", status: "open", stageId: "unknown" }, returnedAt).operation).toBe("review"));
  it("orders by actual creation, not last modification, and keeps unknown dates last without mutating input", () => {
    const tickets = [{ id: "1", createdAt: null }, { id: "2", createdAt: "2026-01-01", updatedAt: "2026-12-01" }, { id: "3", createdAt: "2026-10-01" }, { id: "4", createdAt: "invalid" }];
    expect(sortSavTicketsNewestFirst(tickets).map(t => t.id)).toEqual(["3", "2", "4", "1"]);
    expect(tickets.map(t => t.id)).toEqual(["1", "2", "3", "4"]);
  });
  it("requires a subject match even for an established thread link", () => {
    expect(selectSavTicketMatch({ subject: "Remboursement", currentTicketId: "1", includeClosed: true, candidates: [{ id: "1", subject: "Connexion impossible", status: "open" }] }).kind).toBe("new");
  });
  it("prefers the open match over a linked closed predecessor", () => {
    expect(selectSavTicketMatch({ subject: "Re: Connexion impossible", currentTicketId: "1", includeClosed: true, candidates: [{ id: "1", subject: "Connexion impossible", status: "closed", closedAt: "2026-10-01" }, { id: "2", subject: "Connexion impossible", status: "open" }] })).toMatchObject({ kind: "matched", ticket: { id: "2" } });
  });
  it("does not choose between ambiguous open matches", () => {
    expect(selectSavTicketMatch({ subject: "Connexion impossible", includeClosed: true, candidates: ["1", "2"].map(id => ({ id, subject: "Connexion impossible", status: "open" })) }).kind).toBe("ambiguous");
  });
});
