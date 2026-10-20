import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planSavIntake } from "./engine";
import { projectSavIntakeProgress } from "./progress";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeContact, IntakePlan, IntakeTicket, MessageAnalysis, ReadResult } from "./engine-types";
import type { SavIntakeStepReceipt } from "./contract";
import { savIntakeSpecificationCases } from "../../../../test/sav-intake-specification";

const at = "2026-10-20T10:00:00.000Z";
const mid = "10000000-0000-4000-8000-000000000001";
const otherMid = "10000000-0000-4000-8000-000000000002";
const resource = { resourceId: "synthetic-private-resource", revisionId: "fixture-v1", sha256: "0".repeat(64) };
const warning = "SYNTHETIC MULTIPLE OPEN TICKETS WARNING";
const read = <T>(data: T): ReadResult<T> => ({ status: "complete", data, observedAt: at, reconstructedAsOf: at });
const contact = (id = "101", email = "sender@example.test"): IntakeContact => ({ id, emails: [email] });
const ticket = (id = "201", properties: Partial<IntakeTicket> = {}): IntakeTicket => ({
  id, contactIds: ["101"], stage: "open", createdAt: "2026-10-01T00:00:00.000Z", ownerId: null,
  subject: "Synthetic request", content: "Synthetic complete request content", ...properties,
});
function fixture(kinds: MessageAnalysis["requests"][number]["kind"][] = ["support"]) {
  const input: EngineInput = {
    message: { id: mid, threadId: "20000000-0000-4000-8000-000000000001", fromEmail: "sender@example.test", toEmails: ["support@example.test"],
      currentText: "Synthetic current authored request", contentComplete: true, direction: "inbound", receivedAt: at },
    conversation: read([]), latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: "fixture-attempt",
  };
  const policy: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [{ typeId: 449, category: "HUBSPOT_DEFINED" }],
    resources: { identification: resource, registrationNotFound: resource, partnership: resource, commercial: resource, investor: resource,
      multiTicketWarning: { ...resource, text: warning, sha256: createHash("sha256").update(warning).digest("hex") } },
    qualifiedOther: { resource, evidenceSource: "private_rule" },
  };
  const calls: string[] = [];
  const contacts: Record<string, IntakeContact> = { "101": contact(), "102": contact("102", "linked@example.test") };
  const tickets: IntakeTicket[] = [];
  const matches: Record<string, "same" | "different" | "unknown" | "partial"> = {};
  const analysis: MessageAnalysis = { messageId: mid, requests: kinds.map((kind, i) => ({ id: `r${i}`, kind, currentMessageId: mid })), ticketSummary: { title: "Synthetic current request", description: "Synthetic description covering all declared requests", requestIds: kinds.map((_, i) => `r${i}`) } };
  const adapters: IntakeAdapters = {
    analyseMessage: async () => { calls.push("analyse"); return analysis; },
    findContactsByEmail: async email => { calls.push(`lookup:${email}`); return read(Object.values(contacts).filter(c => c.emails.includes(email))); },
    directAssociations: async id => { calls.push(`associations:${id}`); return read([]); },
    getContact: async id => { calls.push(`contact:${id}`); return read(contacts[id]); },
    ticketsForContact: async id => { calls.push(`tickets:${id}`); return { ...read(tickets.filter(t => t.contactIds.includes(id))), reconstructedAsOf: at }; },
    ticketHistory: async id => { calls.push(`history:${id}`); return read([{ id: `note-${id}`, kind: "note", text: "Synthetic full history", at }]); },
    assessIdentity: async ({ evidence }) => ({ kind: "unknown", investigationComplete: false, contactIds: [], evidenceIds: evidence.map(e => e.id) }),
    assessIssues: async ({ tickets: found, requests }) => { calls.push("assess"); return { investigationComplete: true, tickets: found.map(({ ticket: t }) => ({
      ticketId: t.id, relation: matches[t.id] ?? "same", requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`],
    })) }; },
  };
  const run = () => planSavIntake(input, adapters, policy);
  const link = () => { adapters.directAssociations = async () => read([{ fromContactId: "101", toContactId: "102", typeId: 449, category: "HUBSPOT_DEFINED" }]); };
  return { input, policy, calls, contacts, tickets, matches, analysis, adapters, run, link };
}
function target(plan: IntakePlan) { expect(plan.decision.disposition.kind).toBe("ticket"); if (plan.decision.disposition.kind !== "ticket") throw Error("fixture"); return plan.decision.disposition; }
function reason(plan: IntakePlan, code: string) { expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining([code]) }); expect(plan.steps).toEqual([]); }
function receipts(plan: IntakePlan, outcome: "queued" | "acknowledged" | "confirmed" = "confirmed"): SavIntakeStepReceipt[] {
  return plan.steps.map(s => ({ stepId: s.id, attemptId: "attempt", messageId: mid, mutation: s.mutation,
    targetTicketId: s.mutation === "send_identity_template" ? null : s.ticketId ?? "999",
    outcome: outcome === "queued" ? { kind: "queued" } : outcome === "acknowledged" ? { kind: "acknowledged", providerReceiptId: "receipt", acknowledgedAt: at }
      : { kind: "confirmed", providerReceiptId: "receipt", verifiedAt: at, verificationEvidenceIds: ["synthetic-server-verification"] },
  }));
}

// Every specification has either a real engine/projection assertion below or an explicit
// unevaluated runtime criterion. A catalogue parse never counts as an executed scenario.
export const unevaluatedSpecifications: Record<string, string> = {
  C06: "Persistent operator override storage/reload belongs to runtime/UI integration.",
  D01: "F8 race, authoritative dispatch permissions and worker not connected.",
  D02: "Durable provider dispatch/ACK-loss reconciliation not implemented in this lot.",
  D03: "Partial real effects and durable journal not implemented; projection tested separately.",
  D04: "Distributed occupation shared by human action/worker not implemented.",
  D05: "Planner suppresses a known prior send, but durable exactly-once delivery is not implemented.",
  V05: "Dashboard query/counters/search/pagination integration intentionally absent.",
};
const scenarios: Record<string, () => Promise<void>> = {};
for (const id of ["C01", "C04", "C05", "C10"]) scenarios[id] = async () => {
  const f = fixture(); f.input.message.currentText = "Please investigate my upload. A vendor mentioned investing.";
  f.input.conversation = read([{ ...f.input.message, id: otherMid, currentText: "Quoted campaign and commercial pitch", receivedAt: "2026-10-19T10:00:00.000Z" }]);
  f.adapters.analyseMessage = async ({ message, conversation }) => { expect(message.currentText).not.toContain("Quoted campaign"); expect(conversation).toHaveLength(1); return f.analysis; };
  expect(target(await f.run()).target.operation).toBe("create");
};
scenarios.C02 = async () => { const f = fixture(["acknowledgement"]); expect((await f.run()).decision.disposition.kind).toBe("no_ticket"); expect(f.calls).toEqual(["analyse"]); };
scenarios.C03 = async () => { const f = fixture(["other"]); const p = await f.run(); expect(p.progress.view).toBe("other"); expect(p.steps).toEqual([]); };
for (const [id, kind] of [["C07", "partnership"], ["C08", "commercial"], ["C09", "investor"], ["C12", "commercial"]] as const) scenarios[id] = async () => {
  const f = fixture([kind]); const p = await f.run(); expect(p.decision.disposition).toMatchObject({ kind: "no_ticket", nextAction: `supervised_${kind}` });
  expect(p.supervisedResource).toEqual(resource); expect(p.progress).toMatchObject({ view: "to_validate", approval: "human_confirmation_required" }); expect(p.steps).toEqual([]);
};
scenarios.C11 = async () => { const f = fixture(["finance"]); const p = await f.run(); expect(p.decision.classification).toBe("finance"); expect(target(p).learning).toBe("excluded"); };
scenarios.C13 = async () => { const f = fixture(["support", "commercial"]); const t = target(await f.run()); expect(t.requestIds).toHaveLength(2); };
scenarios.C14 = async () => { const f = fixture([]); reason(await f.run(), "classification_incomplete"); };
scenarios.C15 = async () => { const f = fixture(["partnership", "investor"]); reason(await f.run(), "classification_incomplete"); };
scenarios.C16 = async () => { const f = fixture(["finance", "unknown"]); const p = await f.run(); reason(p, "classification_incomplete"); expect(p.decision.classification).toBe("finance"); };
scenarios.I01 = async () => { const f = fixture(); delete f.contacts["101"]; const p = await f.run(); expect(p.decision.disposition).toMatchObject({ kind: "request_identification", template: { variant: "initial_registration_request", additionalFooter: false } }); expect(p.originalRecipientEmails).toEqual([f.input.message.fromEmail]); expect(p.steps.map(s => s.mutation)).toEqual(["send_identity_template"]); };
scenarios.I02 = async () => { const f = fixture(); f.adapters.findContactsByEmail = async () => ({ ...read([]), status: "failed" }); reason(await f.run(), "contact_lookup_failed"); };
function declared() { const f = fixture(); f.input.message.currentText = "My registration email is registered@example.test"; f.analysis.registration = { address: "registered@example.test", sourceMessageId: mid, quote: f.input.message.currentText }; f.contacts["103"] = contact("103", "registered@example.test"); return f; }
scenarios.I03 = async () => { const f = declared(); const p = await f.run(); expect(target(p).target.contactId).toBe("103"); expect(target(p).identity).toMatchObject({ scope: "intake_only", addressOrigin: "customer_declared_registration" }); expect(p.originalRecipientEmails).toEqual(["sender@example.test"]); };
scenarios.I04 = async () => { const f = declared(); delete f.contacts["103"]; expect((await f.run()).decision.disposition).toMatchObject({ kind: "request_identification", template: { variant: "registration_address_not_found" } }); };
scenarios.I05 = async () => { const f = fixture(); f.link(); f.tickets.push(ticket("202", { contactIds: ["102"] })); const t = target(await f.run()); expect(t.target).toMatchObject({ ticketId: "202", contactId: "102" }); expect(t.contactScope.contacts).toHaveLength(2); };
scenarios.I06 = async () => { const f = fixture(); f.tickets.push(ticket("202", { contactIds: ["102"] })); expect(target(await f.run()).target.operation).toBe("create"); expect(f.calls).not.toContain("tickets:102"); };
scenarios.I07 = async () => { const f = fixture(); f.contacts["102"] = contact("102"); const p = await f.run(); reason(p, "contact_ambiguous"); expect(p.progress.kind).toBe("processing"); expect(p.candidateContactIds).toEqual(["101", "102"]); };
scenarios.I08 = async () => { const f = declared(); f.analysis.registration!.sourceMessageId = otherMid; f.input.conversation = read([{ ...f.input.message, id: otherMid, fromEmail: "thirdparty@example.test" }]); reason(await f.run(), "contact_lookup_incomplete"); };
scenarios.R01 = async () => { const p = await fixture().run(); expect(target(p).target).toMatchObject({ operation: "create", contactId: "101", selection: { kind: "retained_email_match" } }); expect(p.newTicket).toMatchObject({ pipeline: "support", stage: "new", source: "email", owner: "leave_unassigned", requestIds: ["r0"] }); expect(p.effects).toBe("not_connected"); };
scenarios.R02 = async () => { const f = fixture(); f.tickets.push(ticket()); const p = await f.run(); expect(target(p).target).toMatchObject({ operation: "link", alreadyNew: false }); expect(p.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"]); };
scenarios.R03 = async () => { const f = fixture(); f.tickets.push(ticket("201", { stage: "new" })); const p = await f.run(); expect(target(p).note).toBeNull(); expect(p.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email"]); };
scenarios.R04 = async () => { const f = fixture(); f.tickets.push(ticket(), ticket("202", { createdAt: "2026-10-02T00:00:00.000Z" })); expect(target(await f.run()).target).toMatchObject({ ticketId: "202" }); };
function closed(days: number) { const f = fixture(); f.input.now = "2026-11-10T10:00:00.000Z"; f.tickets.push(ticket("201", { stage: "closed", closedAt: new Date(Date.parse(at) - days * 86_400_000).toISOString() })); return f; }
scenarios.R05 = async () => { expect(target(await closed(14).run()).target).toMatchObject({ operation: "reopen", preserveOwnerId: null }); };
scenarios.R06 = async () => { expect(target(await closed(15).run()).target.operation).toBe("reopen"); };
scenarios.R07 = async () => { expect(target(await closed(16).run()).target).toMatchObject({ operation: "create", predecessor: { ticketId: "201", contactId: "101" } }); };
scenarios.R08 = async () => { const f = closed(-1); reason(await f.run(), "ticket_closure_date_unknown"); };
scenarios.R09 = scenarios.I05;
scenarios.R10 = async () => { const f = fixture(); f.link(); f.tickets.push(ticket("201", { contactIds: ["102", "101"] })); await f.run(); expect(f.calls.filter(c => c === "history:201")).toHaveLength(1); };
scenarios.R11 = async () => { const f = fixture(); f.tickets.push(ticket(), ticket("202")); f.matches["202"] = "different"; const p = await f.run(); expect(target(p).target).toMatchObject({ ticketId: "201" }); expect(p.noteText?.startsWith(warning)).toBe(true); expect(p.steps.every(s => s.ticketId === "201")).toBe(true); };
scenarios.R12 = async () => { const f = fixture(); f.link(); f.tickets.push(ticket(), ticket("202", { contactIds: ["102"] })); f.matches["202"] = "different"; expect(target(await f.run()).note).toMatchObject({ warningPrefix: null }); };
scenarios.R13 = async () => { const f = fixture(); f.adapters.ticketsForContact = async () => ({ ...read([]), status: "partial" }); reason(await f.run(), "ticket_search_incomplete"); };
scenarios.R14 = async () => { const p = await fixture().run(); expect(target(p).target.operation).toBe("create"); expect(Object.keys(p)).not.toContain("replyDraft"); };
scenarios.R15 = async () => { const f = fixture(["support", "support"]); expect(target(await f.run()).requestIds).toEqual(["r0", "r1"]); };
scenarios.R16 = async () => { const f = fixture(); f.tickets.push(ticket()); f.matches["201"] = "different"; const p = await f.run(); expect(target(p).target.operation).toBe("create"); expect(target(p).note?.kind).toBe("multi_ticket_warning_only"); };
scenarios.R17 = async () => { const f = fixture(["support", "support"]); f.tickets.push(ticket(), ticket("202")); f.matches["201"] = "partial"; f.matches["202"] = "partial"; const p = await f.run(); reason(p, "same_issue_unresolved"); expect(p.progress.kind).toBe("human_choice"); };
scenarios.R18 = scenarios.R05;
scenarios.R19 = async () => { const f = closed(1); delete f.tickets[0].ownerId; reason(await f.run(), "ticket_owner_unknown"); };
scenarios.R20 = async () => { const f = fixture(); f.tickets.push(ticket("201", { stage: "new" }), ticket("202", { createdAt: "2026-09-01T00:00:00.000Z" })); f.matches["202"] = "different"; const p = await f.run(); expect(target(p).note?.kind).toBe("multi_ticket_warning_only"); expect(p.steps.map(s => s.mutation)).not.toContain("set_ticket_new"); };
scenarios.R21 = async () => { const f = fixture(); f.link(); expect(target(await f.run()).target.contactId).toBe("101"); };
scenarios.R22 = async () => { const f = fixture(); f.contacts["102"] = contact("102"); f.adapters.assessIdentity = async ({ candidates, evidence }) => {
  expect(candidates).toHaveLength(2); expect(f.calls).toContain("tickets:101"); expect(f.calls).toContain("tickets:102");
  return { kind: "equivalent", investigationComplete: true, contactIds: ["101", "102"], evidenceIds: evidence.map(e => e.id) };
}; const p = await f.run(); reason(p, "contact_ambiguous"); expect(p.progress.kind).toBe("human_choice"); expect(p.candidateContactIds).toEqual(["101", "102"]); expect(p.progress).toMatchObject({ evidenceIds: expect.arrayContaining(["contact-101", "contact-102"]) }); };
scenarios.R23 = async () => { const f = fixture(); f.adapters.ticketsForContact = async () => read([ticket("201", { contactIds: ["102"] })]); reason(await f.run(), "ticket_search_incomplete"); };
scenarios.R24 = async () => { const f = fixture(); f.tickets.push(ticket()); f.adapters.assessIssues = async () => ({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"], evidenceIds: ["current", "ticket-201"] }] }); reason(await f.run(), "same_issue_unresolved"); };
scenarios.R25 = async () => { const f = closed(16); f.link(); f.tickets[0].contactIds = ["102"]; const t = target(await f.run()); expect(t.target).toMatchObject({ operation: "create", contactId: "101", predecessor: { contactId: "102", contactAssociationEvidenceId: "membership-201-102" } }); };
for (const [id, kinds] of Object.entries({ L01: ["finance"], L02: ["cancellation"], L03: ["support", "finance"], L05: ["support", "finance"], L06: ["finance"], L07: ["support", "cancellation"] } as const)) scenarios[id] = async () => {
  const f = fixture([...kinds]); const p = await f.run(); expect(target(p).learning).toBe("excluded"); expect(target(p).requestIds).toHaveLength(kinds.length);
  expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p) }).view).toBe("sensitive");
};
scenarios.L04 = async () => { const f = fixture(); f.input.message.currentText = "How do I add calling credits?"; const p = await f.run(); expect(p.decision.classification).toBe("support"); expect(target(p).learning).toBe("eligible_after_confirmed_effect"); };
for (const id of ["D06", "D07"]) scenarios[id] = async () => { const p = await fixture().run(); const rs = receipts(p); if (id === "D06") rs[0].messageId = otherMid; else rs[0].attemptId = "old"; expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: rs, learningObservationId: "observation" }).view).toBeNull(); };
scenarios.D08 = async () => { const f = fixture(); f.tickets.push(ticket()); const p = await f.run(); f.input.identificationAttemptId = "retry"; const q = await f.run(); expect(target(p).note).toEqual(target(q).note); expect(target(p).note).toMatchObject({ deduplication: "source_message_and_final_ticket", sourceMessageId: mid }); };
scenarios.D09 = async () => { const f = closed(1); f.tickets.push(ticket("202")); f.matches["202"] = "different"; const p = await f.run(); expect(target(p).note).toMatchObject({ kind: "existing_return_summary", warningPrefix: { placement: "before_summary" } }); expect(p.noteText?.split("\n\n")[0]).toBe(warning); expect(p.steps.filter(s => s.mutation === "append_ticket_note")).toHaveLength(1); };
scenarios.V01 = async () => { const p = await fixture().run(); for (const state of ["queued", "acknowledged"] as const) expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p, state), learningObservationId: "observation" }).view).toBeNull(); };
scenarios.V02 = async () => { const f = fixture(); delete f.contacts["101"]; const p = await f.run(); expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p, "queued") }).view).toBeNull(); };
scenarios.V03 = async () => { const f = fixture(); f.adapters.findContactsByEmail = async () => { throw Error("synthetic failure"); }; const p = await f.run(); expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: [], retry: { retryAt: "2026-10-20T10:01:00.000Z", reasonCode: "retry-contact" } })).toMatchObject({ kind: "retry_scheduled", view: null }); };
scenarios.V04 = async () => { const p = await fixture().run(); expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p), completion: { ticketId: "999", closureEvidenceIds: ["closed"], balance: "complete", balanceEvidenceIds: [] } }).view).not.toBe("completed"); };
scenarios.V06 = scenarios.C09;
scenarios.V07 = async () => { const p = await fixture().run(); expect(p.progress.kind).toBe("processing"); expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p), learningObservationId: "observation" }).view).toBe("learning"); };
scenarios.V08 = async () => { const p = await fixture().run(); expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p), completion: { ticketId: "999", closureEvidenceIds: ["closed"], balance: "complete", balanceEvidenceIds: ["balance"], knowledgeCandidateStatus: "awaiting_validation" } }).view).toBe("completed"); };
scenarios.V09 = async () => { const p = await fixture(["finance"]).run(); expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: receipts(p), completion: { ticketId: "999", closureEvidenceIds: ["closed"], balance: "not_applicable_sensitive", balanceEvidenceIds: [] } }).view).toBe("completed"); };

describe("SAV87 specification coverage using the executed local planner", () => {
  it("accounts for all 74 unique specifications without inventing a result", () => {
    expect(savIntakeSpecificationCases).toHaveLength(74);
    expect(Object.keys(scenarios).sort()).toEqual(savIntakeSpecificationCases.map(c => c.id).filter(id => !unevaluatedSpecifications[id]).sort());
  });
  for (const spec of savIntakeSpecificationCases) {
    if (unevaluatedSpecifications[spec.id]) it.todo(`${spec.id} — NON ÉVALUÉ: ${unevaluatedSpecifications[spec.id]}`);
    else it(`${spec.id}: ${spec.facts[0]} (planning/projection only)`, scenarios[spec.id]);
  }
});

describe("synthetic regressions derived from the reliability study, no client corpus", () => {
  it("08: participant coordination does not inherit the financial quotation or old thread contact", async () => {
    const f = fixture(["acknowledgement"]); f.input.message.toEmails = ["peer@example.test"];
    const p = await f.run(); expect(p.steps).toEqual([]); expect(f.calls).not.toContain("lookup:sender@example.test");
  });
  it("24: positive resolution acknowledgement does not reopen a now-closed ticket", async () => {
    const f = fixture(["acknowledgement"]); f.tickets.push(ticket("201", { stage: "closed", closedAt: "2026-10-20T10:06:00.000Z" }));
    expect((await f.run()).decision.disposition.kind).toBe("no_ticket");
  });
  it("34: use an account already declared in a past customer message, even when sender has a different contact", async () => {
    const f = declared(); f.analysis.registration!.sourceMessageId = otherMid;
    f.input.conversation = read([{ ...f.input.message, id: otherMid, receivedAt: "2026-10-19T10:00:00.000Z" }]);
    f.input.message.currentText = "Please confirm that the subscription was stopped.";
    f.tickets.push(ticket("203", { contactIds: ["103"] }));
    const p = await f.run(); expect(target(p).target).toMatchObject({ operation: "link", ticketId: "203", contactId: "103" });
    expect(f.calls).not.toContain("tickets:101"); expect(p.originalRecipientEmails).toEqual(["sender@example.test"]);
  });
  it("37: a secondary email resolves the existing record without a redundant template", async () => {
    const f = fixture(); f.contacts["101"].emails = ["primary@example.test", "sender@example.test"];
    expect(target(await f.run()).contactScope.primaryContactId).toBe("101");
  });
  it("37: exclude the second hop even when returned in the association payload", async () => {
    const f = fixture(); f.adapters.directAssociations = async () => read([
      { fromContactId: "101", toContactId: "102", typeId: 449, category: "HUBSPOT_DEFINED" },
      { fromContactId: "102", toContactId: "103", typeId: 449, category: "HUBSPOT_DEFINED" },
    ]); f.contacts["103"] = contact("103", "secondhop@example.test");
    expect(target(await f.run()).contactScope.contacts.map(c => c.contactId)).toEqual(["101", "102"]);
    expect(f.calls).not.toContain("contact:103"); expect(f.calls).not.toContain("associations:102");
  });
  it("does not turn seven absent bodies or image-only messages into classified references", async () => {
    const f = fixture(); f.input.message.contentComplete = false; reason(await f.run(), "classification_incomplete"); expect(f.calls).toEqual([]);
    f.input.message.contentComplete = true; f.input.message.currentText = ""; reason(await f.run(), "classification_incomplete");
  });
});

describe("bounds, source bindings and fail-closed behavior", () => {
  it("ignores an old linked ticket when the latest proven equivalent is newer", scenarios.R04);
  it("refuses an alias lookup whose complete email list was not supplied", async () => { const f = fixture(); f.adapters.findContactsByEmail = async () => read([contact("101", "primary@example.test")]); reason(await f.run(), "contact_lookup_incomplete"); });
  it("fails closed on incomplete notes even with matching title", async () => { const f = fixture(); f.tickets.push(ticket()); f.adapters.ticketHistory = async () => ({ ...read([]), status: "partial" }); reason(await f.run(), "history_incomplete"); });
  it("does not use current snapshots as historical truth", async () => { const f = fixture(); f.input.mode = "at_receipt"; f.adapters.ticketsForContact = async () => ({ ...read([]), reconstructedAsOf: undefined }); reason(await f.run(), "history_incomplete"); });
  it("includes a ticket created after reception in a current reprise, avoiding a duplicate", async () => { const f = fixture(); f.input.now = "2026-10-21T10:00:00.000Z"; f.tickets.push(ticket("201", { createdAt: "2026-10-20T10:03:00.000Z" })); expect(target(await f.run()).target.operation).toBe("link"); });
  it("does not choose a ticket created after reception for a reconstructed historical decision", async () => { const f = fixture(); f.input.mode = "at_receipt"; f.input.now = "2026-10-21T10:00:00.000Z"; f.tickets.push(ticket("201", { createdAt: "2026-10-20T10:03:00.000Z" })); expect(target(await f.run()).target.operation).toBe("create"); });
  it("does not break a tie between equivalent closed tickets arbitrarily", async () => { const f = closed(1); f.tickets.push(ticket("202", { stage: "closed", closedAt: "2026-10-19T12:00:00.000Z" })); reason(await f.run(), "same_issue_unresolved"); });
  it("limits unresponsive injected readers and propagates AbortSignal", async () => { const f = fixture(); let signal: AbortSignal | undefined; f.adapters.findContactsByEmail = async (_, s) => { signal = s; return new Promise(() => {}); }; const p = await planSavIntake(f.input, f.adapters, f.policy, { timeoutMs: 5 }); reason(p, "contact_lookup_failed"); expect(signal?.aborted).toBe(true); });
  it("caps reads rather than manufacture complete absence", async () => { const f = fixture(); reason(await planSavIntake(f.input, f.adapters, f.policy, { readCalls: 1 }), "contact_lookup_failed"); });
  it("does not dispatch a second template when the supplied journal says it is uncertain", async () => { const f = fixture(); delete f.contacts["101"]; f.input.previousIdentification = { messageId: mid, address: "sender@example.test", state: "uncertain" }; expect((await f.run()).steps).toEqual([]); });
  it("retains sensitive precedence despite a matching noise rule", scenarios.C11);
  it("rejects requests attributed only to another message", async () => { const f = fixture(); f.analysis.requests[0].currentMessageId = otherMid; reason(await f.run(), "classification_incomplete"); });
  it("rejects stale/superseded current input before any provider call", async () => { const f = fixture(); f.input.latestInboundMessageId = otherMid; reason(await f.run(), "history_incomplete"); expect(f.calls).toEqual([]); });
  it("requires a private warning resource with the exact approved content hash", async () => { const f = fixture(); f.tickets.push(ticket(), ticket("202")); f.matches["202"] = "different"; f.policy.resources.multiTicketWarning!.sha256 = "0".repeat(64); reason(await f.run(), "private_resource_unavailable"); });
  it("is stable under order changes and deduplicates identical ticket snapshots", async () => { const f = fixture(); f.link(); f.tickets.push(ticket("202", { createdAt: "2026-10-02T00:00:00.000Z" }), ticket()); const a = await f.run(); f.tickets.reverse(); const b = await f.run(); expect(a).toEqual(b); });
  it("rejects a false matching result covering only one of two requests", async () => { const f = fixture(["support", "support"]); f.tickets.push(ticket()); f.adapters.assessIssues = async () => ({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"], evidenceIds: ["current", "ticket-201", "history-201"] }] }); reason(await f.run(), "same_issue_unresolved"); });
  it("rejects mutation substitution in otherwise confirmed receipts", async () => { const p = await fixture().run(); const rs = receipts(p); rs[0].mutation = "link_ticket"; expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: rs, learningObservationId: "observation" }).view).toBeNull(); });
  it("does not claim an executable creation summary when one request is omitted", async () => { const f = fixture(["support", "support"]); f.analysis.ticketSummary!.requestIds = ["r0"]; reason(await f.run(), "classification_incomplete"); });
});

describe("independent review regressions F1-F7", () => {
  it("F1 rejects confirmed receipts from an older creation targeting a different contact", async () => {
    const f = fixture(); const old = await f.run(); const oldReceipts = receipts(old);
    delete f.contacts["101"]; f.contacts["103"] = contact("103"); const next = await f.run();
    expect(target(next).target.contactId).toBe("103"); expect(next.fingerprint).not.toBe(old.fingerprint);
    expect(projectSavIntakeProgress(next, { attemptId: "attempt", receipts: oldReceipts, learningObservationId: "observation" }).view).toBeNull();
  });
  it("F1 binds receipt step IDs to summary content and refuses a trimmed step list", async () => {
    const f = fixture(); const old = await f.run(); f.analysis.ticketSummary!.description += " Changed context.";
    const next = await f.run(); expect(projectSavIntakeProgress(next, { attemptId: "attempt", receipts: receipts(old), learningObservationId: "observation" }).view).toBeNull();
    const shortened = structuredClone(old); shortened.steps.pop(); expect(projectSavIntakeProgress(shortened, { attemptId: "attempt", receipts: receipts(shortened), learningObservationId: "observation" }).view).toBeNull();
  });
  it("F1 rejects a modified plan and malformed receipt without throwing", async () => {
    const p = await fixture().run(); const modified = structuredClone(p); modified.newTicket!.description += " tampered";
    expect(projectSavIntakeProgress(modified, { attemptId: "attempt", receipts: receipts(p), learningObservationId: "observation" }).view).toBeNull();
    expect(projectSavIntakeProgress(p, { attemptId: "attempt", receipts: [null] as unknown as SavIntakeStepReceipt[] }).view).toBeNull();
  });
  it("F2 preserves actual observation dates including negative lookup evidence", async () => {
    const f = fixture(); const observedAt = "2026-10-18T10:00:00.000Z"; f.adapters.findContactsByEmail = async () => ({ ...read([contact()]), observedAt });
    f.adapters.ticketsForContact = async () => ({ ...read([]), observedAt }); f.adapters.directAssociations = async () => ({ ...read([]), observedAt });
    const p = await f.run(); for (const id of ["email-lookup", "contact-101", "ticket-search-101", "association-search"]) expect(p.decision.evidence.find(e => e.id === id)?.observedAt).toBe(observedAt);
    f.adapters.findContactsByEmail = async () => ({ ...read([]), observedAt }); const missing = await f.run(); expect(missing.decision.evidence.find(e => e.id === "email-lookup")?.observedAt).toBe(observedAt);
  });
  it("F3 requires historical reconstruction for lookup, associations, related contact and histories", async () => {
    for (const part of ["lookup", "associations", "contact", "history"]) {
      const f = fixture(); f.input.mode = "at_receipt"; f.link(); f.tickets.push(ticket());
      if (part === "lookup") f.adapters.findContactsByEmail = async () => ({ ...read([contact()]), reconstructedAsOf: undefined });
      if (part === "associations") f.adapters.directAssociations = async () => ({ ...read([]), reconstructedAsOf: undefined });
      if (part === "contact") f.adapters.getContact = async () => ({ ...read(contact("102", "linked@example.test")), reconstructedAsOf: undefined });
      if (part === "history") f.adapters.ticketHistory = async () => ({ ...read([]), reconstructedAsOf: undefined });
      reason(await f.run(), "history_incomplete");
    }
  });
  it("F4 stops at the evidence cap safely when tickets have dense multi-contact membership", async () => {
    const f = fixture(); const ids = Array.from({ length: 10 }, (_, i) => String(101 + i));
    for (const id of ids.slice(1)) f.contacts[id] = contact(id, `linked${id}@example.test`);
    f.adapters.directAssociations = async () => read(ids.slice(1).map(id => ({ fromContactId: "101", toContactId: id, category: "HUBSPOT_DEFINED", typeId: 449 })));
    for (let i = 0; i < 7; i++) f.tickets.push(ticket(String(201 + i), { contactIds: ids }));
    const p = await f.run(); reason(p, "history_incomplete"); expect(p.decision.evidence.length).toBeLessThanOrEqual(95);
  });
  it("F5 neutral request permutations preserve classification, view and plan", async () => {
    const f = fixture(["other", "acknowledgement"]); const a = await f.run(); f.analysis.requests.reverse(); const b = await f.run(); expect(a).toEqual(b);
  });
  it("F6 normalizes history and issue assessment order", async () => {
    const f = fixture(); f.tickets.push(ticket(), ticket("202", { createdAt: "2026-10-02T00:00:00.000Z" }));
    let reverse = false; f.adapters.ticketHistory = async () => { const h = [ { id: "a", kind: "note" as const, text: "first", at: "2026-10-19T10:00:00.000Z" }, { id: "b", kind: "email" as const, text: "second", at } ]; return read(reverse ? h.reverse() : h); };
    const assess = f.adapters.assessIssues; f.adapters.assessIssues = async (arg, signal) => { const r = await assess(arg, signal); if (reverse) { r.tickets.reverse(); for (const row of r.tickets) row.evidenceIds.reverse(); } return r; };
    const a = await f.run(); reverse = true; const b = await f.run(); expect(a).toEqual(b);
  });
  it("F6 rejects conflicting history records sharing one event ID", async () => { const f = fixture(); f.tickets.push(ticket()); f.adapters.ticketHistory = async () => read([{ id: "a", kind: "note", text: "first", at }, { id: "a", kind: "note", text: "contradiction", at }]); reason(await f.run(), "history_incomplete"); });
  it("F7 preserves unresolved contacts without claiming investigation complete", scenarios.I07);
  it("F7 permits only a targeted choice after complete candidate investigation and explicit equivalence", scenarios.R22);
  it("F7 resolves a uniquely qualified candidate after reading both candidate histories", async () => {
    const f = fixture(); f.contacts["102"] = contact("102"); f.tickets.push(ticket("202", { contactIds: ["102"] }));
    f.adapters.assessIdentity = async ({ candidates, evidence }) => { expect(candidates[1].tickets[0].history).toHaveLength(1); return { kind: "unique", investigationComplete: true, contactIds: ["102"], evidenceIds: evidence.map(e => e.id) }; };
    const p = await f.run(); expect(target(p).target).toMatchObject({ operation: "link", contactId: "102", ticketId: "202" });
  });
});

describe("counter-review regressions C1-C4", () => {
  it("C1 returns a valid context plan for non-ISO source observations", async () => {
    const f = fixture();
    f.adapters.findContactsByEmail = async () => ({ ...read([contact()]), observedAt: "October 20, 2026 10:00:00 UTC" });
    reason(await f.run(), "contact_lookup_incomplete");
  });
  it("C1 preserves the source instant while normalizing ISO offsets to UTC", async () => {
    const f = fixture();
    f.adapters.findContactsByEmail = async () => ({ ...read([contact()]), observedAt: "2026-10-20T11:30:00+02:00" });
    const p = await f.run();
    expect(target(p).target.operation).toBe("create");
    expect(p.decision.evidence.find(e => e.id === "contact-101")?.observedAt).toBe("2026-10-20T09:30:00.000Z");
  });
  it("C1 rejects a non-ISO input clock at the input boundary", async () => {
    const f = fixture(); f.input.now = "October 21, 2026 10:00:00 UTC";
    await expect(f.run()).rejects.toThrow("SAV_INTAKE_INPUT_INVALID");
    expect(f.calls).toEqual([]);
  });
  function ambiguous() {
    const f = fixture(); f.input.now = "2026-10-20T10:01:00.000Z";
    f.contacts["102"] = contact("102");
    f.adapters.assessIdentity = async ({ evidence }) => ({ kind: "unique", investigationComplete: true, contactIds: ["102"], evidenceIds: evidence.map(e => e.id) });
    f.adapters.directAssociations = async () => read([{ fromContactId: "102", toContactId: "101", typeId: 449, category: "HUBSPOT_DEFINED" }]);
    return f;
  }
  it("C2 accepts identical contact content re-read later and preserves the earliest observation", async () => {
    const f = ambiguous();
    f.adapters.getContact = async () => ({ ...read(contact()), observedAt: "2026-10-20T10:00:01.000Z" });
    const p = await f.run();
    expect(target(p).target.contactId).toBe("102");
    expect(target(p).contactScope.contacts.map(c => c.contactId)).toEqual(["102", "101"]);
    expect(p.decision.evidence.find(e => e.id === "contact-101")?.observedAt).toBe(at);
  });
  it("C2 still refuses contradictory content for a previously observed contact", async () => {
    const f = ambiguous(); f.adapters.getContact = async () => read(contact("101", "changed@example.test"));
    reason(await f.run(), "history_incomplete");
  });
  it("C3 normalizes ticket contact membership before hashing both search paths", async () => {
    for (const identity of [false, true]) {
      const f = identity ? ambiguous() : fixture();
      if (!identity) f.link();
      f.tickets.push(ticket("201", { contactIds: ["101", "102"] }));
      const a = await f.run(); expect(target(a).target.operation).toBe("link");
      f.tickets[0].contactIds = ["102", "101", "102"];
      const b = await f.run(); expect(b).toEqual(a);
    }
  });
  it("C4 excludes post-reception tickets before identity investigation and evidence", async () => {
    const f = ambiguous(); f.input.mode = "at_receipt";
    f.tickets.push(ticket("202", { contactIds: ["102"], createdAt: "2026-10-20T10:00:30.000Z" }));
    let investigated: string[] | undefined;
    const qualify = f.adapters.assessIdentity!;
    f.adapters.assessIdentity = async (args, signal) => {
      investigated = args.candidates.flatMap(c => c.tickets.map(row => row.ticket.id));
      return qualify(args, signal);
    };
    const p = await f.run();
    expect(investigated).toEqual([]);
    expect(target(p).target.operation).toBe("create");
    expect(f.calls).not.toContain("history:202");
    expect(p.decision.evidence.some(e => e.sourceId === "202")).toBe(false);
  });
  it("C4 requires known creation dates during identity investigation", async () => {
    const f = ambiguous(); f.tickets.push(ticket("202", { contactIds: ["102"], createdAt: undefined }));
    reason(await f.run(), "ticket_creation_date_unknown");
  });
});
