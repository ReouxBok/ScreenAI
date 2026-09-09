import { describe, expect, it } from "vitest";
import { normalizeTicketSubject, selectSavTicketMatch } from "./ticket-routing";

const open = (id: string, subject: string) => ({ id, subject, status: "open" as const });
describe("SAV ticket routing", () => {
  it("normalizes reply prefixes without losing the actual topic", () => expect(normalizeTicketSubject("Re: TR: Connexion impossible !")).toBe("connexion impossible"));
  it("prioritizes the Gmail thread's established ticket", () => expect(selectSavTicketMatch({ subject: "Autre titre", currentTicketId: "42", candidates: [open("42", "Incident initial")] })).toMatchObject({ kind: "matched", reason: "gmail_thread_link" }));
  it("uses an explicit associated ticket reference", () => expect(selectSavTicketMatch({ subject: "Re: dossier #12345", candidates: [open("12345", "Connexion")] })).toMatchObject({ kind: "matched", reason: "explicit_ticket_reference" }));
  it("abstains when two open tickets are equally plausible", () => expect(selectSavTicketMatch({ subject: "Connexion impossible", candidates: [open("1", "Connexion impossible"), open("2", "Re: Connexion impossible")] })).toMatchObject({ kind: "ambiguous", reason: "multiple_exact_subjects" }));
  it("never reopens a closed ticket automatically", () => expect(selectSavTicketMatch({ subject: "Connexion impossible", currentTicketId: "1", candidates: [{ id: "1", subject: "Connexion impossible", status: "closed" }] })).toMatchObject({ kind: "new" }));
  it("does not attach a different request from the same customer", () => expect(selectSavTicketMatch({ subject: "Changer mon logo", candidates: [open("1", "Connexion impossible")] })).toMatchObject({ kind: "new", reason: "no_reliable_match" }));
});
