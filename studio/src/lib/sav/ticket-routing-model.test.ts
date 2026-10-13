import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";
import { matchSavTicketsByContent, selectSavAssessedTicket, validateSavTicketAssessments } from "./ticket-routing-model";
import { savTicketReturnPlan } from "./ticket-lifecycle";

const input = { subject: "Re: Re : Suite à votre demande - Urgent", body: "L'agent ne redémarre plus et le test ne se lance pas.\nLe lundi, Support a écrit :\n> Nous suivons le problème de votre agent téléphonique.",
  tickets: [{ id: "401", subject: "Incident du téléphone IA", description: "Le client revient sur la panne de son agent téléphonique.", status: "open" as const, stageId: "2", ownerId: "71" }] };
const assessment = (ticketId = "401", relation: "same_issue" | "different_issue" | "uncertain" = "same_issue") => ({ ticketId, relation, messageExcerpt: "L'agent ne redémarre plus", historyExcerpt: "problème de votre agent téléphonique", ticketExcerpt: "panne de son agent téléphonique", explanation: "Le problème technique suivi dans le fil est toujours présent." });
const data = { currentMessage: input.body.split("\n")[0], history: input.body.split("\n").slice(1).join("\n"), tickets: input.tickets.map(t => ({ id: t.id, text: `${t.subject}\n${t.description}` })),
  limitations: { historyTruncated: false, subjectTruncated: false, descriptionTruncatedTicketIds: [], subjectTruncatedTicketIds: [] } };
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("supervised ticket content matching", () => {
  it("matches a generic inherited subject using the current message, history and CRM description", async () => {
    const network = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(JSON.parse(request.contents[0].parts[0].text)).toEqual(data);
      return geminiFixture({ assessments: [assessment()] });
    });
    const result = await matchSavTicketsByContent(input, { apiKey: "fixture", fetch: network });
    expect(result.selection).toMatchObject({ kind: "matched", ticket: { id: "401" }, reason: "semantic_same_issue" });
    expect(savTicketReturnPlan(input.tickets[0], "2026-10-13")).toMatchObject({ operation: "reactivate" });
    expect(result.matching).toMatchObject({ errorCode: null, assessments: [assessment()] });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("does not infer a match merely from the customer, product or a single candidate", async () => {
    const result = await matchSavTicketsByContent(input, { apiKey: "fixture", fetch: async () => geminiFixture({ assessments: [assessment("401", "different_issue")] }) });
    expect(result.selection).toEqual({ kind: "new", reason: "semantic_distinct_issue" });
  });
  it.each(["same_issue", "different_issue"] as const)("requires exact current and ticket evidence for %s", relation => {
    for (const changed of [{ messageExcerpt: "invented request" }, { ticketExcerpt: "invented CRM fact" }, { historyExcerpt: "invented history" }, { messageExcerpt: "" }, { ticketExcerpt: "" }])
      expect(() => validateSavTicketAssessments({ assessments: [{ ...assessment("401", relation), ...changed }] }, data)).toThrow();
  });
  it("rejects missing, duplicate and foreign ticket IDs", () => {
    for (const assessments of [[], [assessment("999")], [assessment(), assessment()]])
      expect(() => validateSavTicketAssessments({ assessments }, data)).toThrow();
  });
  it("retains uncertainty without forcing a match", async () => {
    const result = await matchSavTicketsByContent(input, { apiKey: "fixture", fetch: async () => geminiFixture({ assessments: [{ ...assessment("401", "uncertain"), messageExcerpt: "", ticketExcerpt: "" }] }) });
    expect(result.selection).toMatchObject({ kind: "ambiguous", reason: "semantic_issue_ambiguous" });
  });
  it.each([402, 500])("never proposes absence or a duplicate when the model returns HTTP %s", async status => {
    const network = vi.fn<typeof fetch>(async () => new Response("provider failure", { status }));
    const result = await matchSavTicketsByContent(input, { apiKey: "fixture", fetch: network });
    expect(result.selection).toMatchObject({ kind: "ambiguous", reason: "ticket_semantic_match_unavailable" });
    expect(result.matching.errorCode).toBe(`SAV_AI_HTTP_${status}`);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("fails conservatively on invented provider citations", async () => {
    const result = await matchSavTicketsByContent(input, { apiKey: "fixture", fetch: async () => geminiFixture({ assessments: [{ ...assessment(), ticketExcerpt: "not in CRM" }] }) });
    expect(result.selection.kind).toBe("ambiguous");
  });
  it("does not call the model without current content, with oversized context or when disabled", async () => {
    const network = vi.fn<typeof fetch>(() => { throw new Error("Unexpected network"); });
    for (const body of ["", "x".repeat(13000)]) expect((await matchSavTicketsByContent({ ...input, body }, { apiKey: "fixture", fetch: network })).selection.kind).toBe("ambiguous");
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    expect((await matchSavTicketsByContent(input, { apiKey: "fixture", fetch: network })).selection.kind).toBe("ambiguous");
    expect(network).not.toHaveBeenCalled();
  });
  it("abstains without a key and bounds a stalled provider request", async () => {
    const unused = vi.fn<typeof fetch>();
    expect((await matchSavTicketsByContent(input, { apiKey: "", fetch: unused })).selection.kind).toBe("ambiguous");
    expect(unused).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const stalled = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = matchSavTicketsByContent(input, { apiKey: "fixture", fetch: stalled });
    await vi.advanceTimersByTimeAsync(12001);
    const result = await pending;
    expect(result.selection.kind).toBe("ambiguous"); expect(result.matching.errorCode).toBe("SAV_AI_TIMEOUT");
    expect(stalled).toHaveBeenCalledTimes(1);
  });
  it("does not call a model when HubSpot has no associated ticket", async () => {
    const network = vi.fn<typeof fetch>();
    expect((await matchSavTicketsByContent({ ...input, tickets: [] }, { fetch: network })).selection.kind).toBe("new");
    expect(network).not.toHaveBeenCalled();
  });
  it("preserves the operation for a ticket already New", () => {
    const ticket = { ...input.tickets[0], stageId: "1" };
    expect(selectSavAssessedTicket([ticket], [assessment()]).kind).toBe("matched");
    expect(savTicketReturnPlan(ticket, "2026-10-13").operation).toBe("keep");
  });
  it("prefers the same active issue over closed history but abstains between active possibilities", () => {
    const older = { ...input.tickets[0], id: "400", status: "closed" as const, closedAt: "2026-10-01" };
    const same = validateSavTicketAssessments({ assessments: [assessment(), assessment("400")] }, { ...data, tickets: [...data.tickets, { id: "400", text: older.description }] });
    expect(selectSavAssessedTicket([input.tickets[0], older], same)).toMatchObject({ kind: "matched", ticket: { id: "401" } });
    expect(selectSavAssessedTicket([input.tickets[0], { ...older, status: "open" }], same).kind).toBe("ambiguous");
  });
  it("keeps closed-ticket lifecycle decisions based on the actual closure and return dates", () => {
    for (const [closedAt, operation] of [["2026-10-10", "reactivate"], ["2026-09-01", "create"]]) {
      const ticket = { ...input.tickets[0], status: "closed" as const, closedAt };
      expect(selectSavAssessedTicket([ticket], validateSavTicketAssessments({ assessments: [assessment()] }, data)).kind).toBe("matched");
      expect(savTicketReturnPlan(ticket, "2026-10-13").operation).toBe(operation);
    }
  });
  it("abstains between tied closures and when another active ticket remains uncertain", () => {
    const tickets = [input.tickets[0], { ...input.tickets[0], id: "400" }];
    expect(selectSavAssessedTicket(tickets, [assessment(), assessment("400", "uncertain")]).kind).toBe("ambiguous");
    const closed = tickets.map((t, i) => ({ ...t, status: "closed" as const, closedAt: i ? "2026-10-01T02:00:00+02:00" : "2026-10-01T00:00:00Z" }));
    expect(selectSavAssessedTicket(closed, [assessment(), assessment("400")]).kind).toBe("ambiguous");
  });
  it.each(["same_issue", "different_issue"] as const)("never trusts a %s assessment from a truncated CRM description", relation => {
    const partial = { ...input.tickets[0], descriptionTruncated: true };
    expect(selectSavAssessedTicket([partial], [assessment("401", relation)]).kind).toBe("ambiguous");
  });
  it("does not infer a distinct issue from a truncated subject or a complete match from a partial CRM title", () => {
    expect(selectSavAssessedTicket(input.tickets, [assessment("401", "different_issue")], { historyTruncated: false, subjectTruncated: true }).kind).toBe("ambiguous");
    expect(selectSavAssessedTicket([{ ...input.tickets[0], subjectTruncated: true }], [assessment()]).kind).toBe("ambiguous");
  });
  it("does not conclude a distinct issue from truncated history, but preserves a supported active match", async () => {
    const partial = { ...input, body: `${input.body}\n> ${"ancien échange ".repeat(400)}` };
    const distinct = await matchSavTicketsByContent(partial, { apiKey: "fixture", fetch: async () => geminiFixture({ assessments: [assessment("401", "different_issue")] }) });
    expect(distinct.matching.limitations.historyTruncated).toBe(true);
    expect(distinct.selection.kind).toBe("ambiguous");
    const same = await matchSavTicketsByContent(partial, { apiKey: "fixture", fetch: async () => geminiFixture({ assessments: [assessment()] }) });
    expect(same.selection.kind).toBe("matched");
  });
});
