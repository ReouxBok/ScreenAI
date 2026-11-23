// SAV-128: a customer's acknowledgement goes into the open ticket of its Gmail thread. Synthetic fixtures only (no customer content).
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { planSavIntake } from "./engine";
import { savIntakeDecisionSchema } from "./contract";
import { decideAckClosure } from "./ack-closure-rules";
import { savAckTicketConsoleReason, savAckTicketNote, savAckTicketSummary } from "./ack-ticket";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeContact, IntakePlan, IntakeTicket, MessageAnalysis, ReadResult } from "./engine-types";

const at = "2026-11-23T10:00:00.000Z";
const mid = "10000000-0000-4000-8000-0000000000a1";
const threadId = "20000000-0000-4000-8000-0000000000a1";
const resource = { resourceId: "synthetic-private-resource", revisionId: "fixture-v1", sha256: "0".repeat(64) };
const warning = "SYNTHETIC MULTIPLE OPEN TICKETS WARNING";
const read = <T>(data: T): ReadResult<T> => ({ status: "complete", data, observedAt: at, reconstructedAsOf: at });
const ticket = (id: string, properties: Partial<IntakeTicket> = {}): IntakeTicket => ({
  id, contactIds: ["101"], stage: "open", createdAt: "2026-11-01T00:00:00.000Z", ownerId: null, subject: "Synthetic request", content: "Synthetic content", ...properties,
});
const thanks = "J'ai trouvé l'option et j'ai supprimé le compte de test, désolé pour le dérangement.\nBonne journée";

function fixture(kinds: MessageAnalysis["requests"][number]["kind"][] = ["acknowledgement"], fact: EnginePolicy["acknowledgementTicket"] | null = { ticketId: "201" }) {
  const input: EngineInput = {
    message: { id: mid, threadId, fromEmail: "client@example.test", toEmails: ["support@example.test"], currentText: thanks, contentComplete: true, direction: "inbound", receivedAt: at },
    conversation: read([]), latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: "fixture-attempt",
  };
  const policy: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [{ typeId: 449, category: "HUBSPOT_DEFINED" }],
    resources: { identification: resource, registrationNotFound: resource, multiTicketWarning: { ...resource, text: warning, sha256: createHash("sha256").update(warning).digest("hex") } },
    ...(fact ? { acknowledgementTicket: fact } : {}) };
  const calls: string[] = [];
  const contacts: Record<string, IntakeContact> = { "101": { id: "101", emails: ["client@example.test"] } };
  const tickets: IntakeTicket[] = [ticket("201")];
  const analysis: MessageAnalysis = { messageId: mid, nature: "information", requests: kinds.map((kind, i) => ({ id: `r${i}`, kind, currentMessageId: mid })),
    ticketSummary: { title: "Synthetic request", description: "Synthetic description", requestIds: kinds.map((_, i) => `r${i}`) } };
  const adapters: IntakeAdapters = {
    analyseMessage: async () => { calls.push("analyse"); return analysis; },
    findContactsByEmail: async email => { calls.push(`lookup:${email}`); return read(Object.values(contacts).filter(c => c.emails.includes(email))); },
    directAssociations: async id => { calls.push(`associations:${id}`); return read([]); },
    getContact: async id => { calls.push(`contact:${id}`); return read(contacts[id]); },
    ticketsForContact: async id => { calls.push(`tickets:${id}`); return read(tickets.filter(t => t.contactIds.includes(id))); },
    ticketHistory: async id => { calls.push(`history:${id}`); return read([{ id: `note-${id}`, kind: "note", text: "Synthetic history", at }]); },
    assessIdentity: async () => { calls.push("identity"); throw Error("not expected"); },
    assessIssues: async ({ tickets: found, requests }) => { calls.push("assess"); return { investigationComplete: true, tickets: found.map(({ ticket: t }) => ({
      ticketId: t.id, relation: "same" as const, requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }; },
  };
  return { input, policy, calls, contacts, tickets, analysis, adapters, run: () => planSavIntake(input, adapters, policy) };
}
const linked = (plan: IntakePlan) => {
  const d = plan.decision.disposition;
  if (d.kind !== "ticket") throw Error(`expected a ticket, got ${d.kind}`);
  return d;
};
const acknowledgementOnly = (plan: IntakePlan, reason?: string) => {
  expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "acknowledgement_only", nextAction: "none" });
  expect(plan.decision.classification).toBe("acknowledgement");
  expect(plan.steps).toEqual([]);
  expect(plan.acknowledgementTicket).toEqual(reason ? { outcome: "not_attached", reason } : undefined);
};

describe("SAV-128 an acknowledgement goes into its thread's ticket", () => {
  it("open thread ticket: associate the mail, add the note, move the ticket back to New", async () => {
    const f = fixture();
    const plan = await f.run();
    const d = linked(plan);
    expect(plan.decision.classification).toBe("acknowledgement");
    expect(d.target).toMatchObject({ operation: "link", ticketId: "201", contactId: "101", alreadyNew: false });
    expect(plan.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"]);
    expect(plan.steps.every(s => s.ticketId === "201")).toBe(true);
    expect(d.note).toMatchObject({ kind: "acknowledgement_summary", version: 1, previousStage: "open", warningPrefix: null, sourceMessageId: mid });
    expect(plan.noteText).toBe("Le client remercie / confirme la résolution : « J'ai trouvé l'option et j'ai supprimé le compte de test, désolé pour le dérangement. »\n"
      + "Le ticket repasse en Nouveau : l'équipe confirme la résolution puis le ferme.");
    expect(d.learning).toBe("excluded");
    expect(plan.acknowledgementTicket).toEqual({ outcome: "attached", ticketId: "201" });
    // The thread's ticket is the target: no same-issue model call, no other model call.
    expect(f.calls).toEqual(["analyse", "lookup:client@example.test", "associations:101", "tickets:101", "history:201"]);
    expect(savIntakeDecisionSchema.safeParse(plan.decision).success).toBe(true);
  });
  it("thread ticket already New: associate + note, no stage write", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "new" });
    const plan = await f.run();
    expect(linked(plan).target).toMatchObject({ operation: "link", alreadyNew: true });
    expect(plan.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email", "append_ticket_note"]);
    expect(plan.noteText).toContain("Le ticket est en Nouveau");
  });
  it("other open tickets on the contact: the approved warning prefixes the note; only the thread ticket's history is read", async () => {
    const f = fixture(); f.tickets.push(ticket("202"), ticket("203", { stage: "closed", closedAt: "2026-11-02T00:00:00.000Z" }));
    const plan = await f.run();
    const d = linked(plan);
    expect(d.target).toMatchObject({ ticketId: "201" });
    expect(d.multiTicketNote.openTicketIdsOnTargetContact).toEqual(["201", "202"]);
    expect(d.note).toMatchObject({ kind: "acknowledgement_summary", warningPrefix: { placement: "before_summary" } });
    expect(plan.noteText?.startsWith(`${warning}\n\nLe client remercie`)).toBe(true);
    expect(f.calls.filter(c => c.startsWith("history:"))).toEqual(["history:201"]);
  });
  it("sensitive thread (cancellation earlier on it): same attachment, never a closure", async () => {
    const f = fixture();
    f.input.conversation = read([{ ...f.input.message, id: "10000000-0000-4000-8000-0000000000a0", currentText: "Je souhaite résilier mon abonnement.", receivedAt: "2026-11-22T10:00:00.000Z" }]);
    const plan = await f.run();
    expect(plan.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"]);
    expect(linked(plan).learning).toBe("excluded");
    // The autonomous closure reads only acknowledgement_only plans, and refuses a sensitive dossier anyway: the team confirms and closes.
    const closure = decideAckClosure({ v1Acknowledgement: false, customerMessageId: mid, previous: null, newerMessage: false, ticketId: "201", sensitiveDossier: true, v2Case: false, model: null });
    expect(closure).toEqual({ close: false, reason: "v1_not_acknowledgement" });
    expect(decideAckClosure({ v1Acknowledgement: true, customerMessageId: mid, previous: null, newerMessage: false, ticketId: "201", sensitiveDossier: true, v2Case: false, model: null }))
      .toEqual({ close: false, reason: "sensitive_dossier" });
  });
  it("no HubSpot contact: today's acknowledgement_only, never an identification email", async () => {
    const f = fixture(); delete f.contacts["101"];
    const plan = await f.run();
    acknowledgementOnly(plan, "contact_not_found");
    expect(plan.steps.some(s => s.mutation === "send_identity_template")).toBe(false);
  });
  it("several possible contacts: today's plan, no identity model call", async () => {
    const f = fixture(); f.contacts["102"] = { id: "102", emails: ["client@example.test"] };
    acknowledgementOnly(await f.run(), "contact_ambiguous");
    expect(f.calls).not.toContain("identity");
  });
  it("no ticket on the thread: nothing created, nothing read, reason visible", async () => {
    const f = fixture(["acknowledgement"], { ticketId: null });
    const plan = await f.run();
    acknowledgementOnly(plan, "no_thread_ticket");
    expect(f.calls).toEqual(["analyse"]);
    expect(savAckTicketConsoleReason(plan.acknowledgementTicket)).toContain("Non rattaché au ticket : aucun ticket lié au fil.");
  });
  it("thread ticket closed by the team: reopened in New, owner kept, mail + note attached", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "closed", closedAt: "2026-11-20T00:00:00.000Z", ownerId: "77" });
    const plan = await f.run();
    const d = linked(plan);
    expect(d.target).toMatchObject({ operation: "reopen", ticketId: "201", contactId: "101", preserveOwnerId: "77" });
    expect(plan.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"]);
    expect(plan.steps.every(s => s.ticketId === "201")).toBe(true);
    expect(d.note).toMatchObject({ kind: "acknowledgement_summary", previousStage: "closed", warningPrefix: null });
    expect(d.multiTicketNote.openTicketIdsOnTargetContact).toEqual([]);
    expect(plan.noteText).toBe("Le client remercie / confirme la résolution : « J'ai trouvé l'option et j'ai supprimé le compte de test, désolé pour le dérangement. »\n"
      + "Le ticket est rouvert et repasse en Nouveau : l'équipe confirme la résolution puis le referme.");
    expect(plan.acknowledgementTicket).toEqual({ outcome: "attached", ticketId: "201" });
    expect(f.calls).not.toContain("assess");
    expect(savIntakeDecisionSchema.safeParse(plan.decision).success).toBe(true);
  });
  it("closed long ago (beyond the support 15-day window): still the thread's ticket reopened, never a new ticket", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "closed", closedAt: "2026-06-01T00:00:00.000Z", ownerId: null });
    const plan = await f.run();
    expect(linked(plan).target).toMatchObject({ operation: "reopen", ticketId: "201", preserveOwnerId: null });
    expect(plan.newTicket).toBeUndefined();
    expect(plan.steps.some(s => s.mutation === "create_ticket")).toBe(false);
  });
  it("closed thread ticket while another ticket is open: the approved warning prefixes the note", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "closed", closedAt: "2026-11-20T00:00:00.000Z", ownerId: null }); f.tickets.push(ticket("202"));
    const plan = await f.run();
    const d = linked(plan);
    expect(d.target).toMatchObject({ operation: "reopen", ticketId: "201" });
    expect(d.multiTicketNote.openTicketIdsOnTargetContact).toEqual(["202"]);
    expect(plan.noteText?.startsWith(`${warning}\n\nLe client remercie`)).toBe(true);
  });
  it("closed thread ticket with an unreadable owner: no reopen (the owner must be kept), today's plan", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "closed", closedAt: "2026-11-20T00:00:00.000Z" }); delete f.tickets[0].ownerId;
    acknowledgementOnly(await f.run(), "thread_ticket_owner_unknown");
  });
  it.each([["closed after the mail", "2026-11-23T10:06:00.000Z"], ["closing date unknown", undefined]])("thread ticket %s: never reopened (re-analysis safe)", async (_name, closedAt) => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "closed", ownerId: null, ...(closedAt ? { closedAt } : {}) });
    acknowledgementOnly(await f.run(), "thread_ticket_closed_after_mail");
  });
  it("contract: a reopen carries the closed stage in its note", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { stage: "closed", closedAt: "2026-11-20T00:00:00.000Z", ownerId: null });
    const plan = await f.run(); const d = linked(plan);
    const parsed = savIntakeDecisionSchema.safeParse({ ...plan.decision, disposition: { ...d, note: { ...d.note!, previousStage: "open" } } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("SAV_INTAKE_ACKNOWLEDGEMENT_NOTE_INVALID");
    const noStage = savIntakeDecisionSchema.safeParse({ ...plan.decision, disposition: { ...d, requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note"] } });
    expect(noStage.success).toBe(false);
  });
  it("thread ticket not on the sender's contact: nothing attached, no other ticket chosen", async () => {
    const f = fixture(); f.tickets[0] = ticket("201", { contactIds: ["999"] }); f.tickets.push(ticket("202"));
    acknowledgementOnly(await f.run(), "thread_ticket_not_on_contact");
    expect(f.calls).not.toContain("assess");
  });
  it("an incomplete CRM read keeps today's plan instead of a team wait", async () => {
    const f = fixture(); f.adapters.ticketsForContact = async () => ({ ...read([]), status: "partial" });
    acknowledgementOnly(await f.run(), "crm_incomplete");
  });
  it("without the fact (SAV_ACK_CLOSE=on, V2 case, operator paths): exactly today's plan", async () => {
    const f = fixture(["acknowledgement"], null);
    const plan = await f.run();
    acknowledgementOnly(plan);
    expect(f.calls).toEqual(["analyse"]);
    expect(savAckTicketConsoleReason(plan.acknowledgementTicket)).toBe("Accusé de réception sans nouvelle demande ; aucun ticket fermé par ce classement.");
  });
  it("a verified automatic reply is never attached", async () => {
    const f = fixture();
    f.policy.automatedReply = { messageId: mid, sourceHash: "synthetic", signals: ["auto-submitted"] };
    const plan = await f.run();
    expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket", qualifiedInformation: "verified_automatic_reply" });
    expect(plan.acknowledgementTicket).toBeUndefined();
  });
  it.each([["support"], ["finance"], ["other"]] as const)("a %s mail is unchanged by the fact", async kind => {
    const withFact = fixture([kind]), without = fixture([kind], null);
    if (kind === "other") { withFact.policy.qualifiedOther = { resource, evidenceSource: "private_rule" }; without.policy.qualifiedOther = { resource, evidenceSource: "private_rule" }; }
    const a = await withFact.run(), b = await without.run();
    expect(a).toEqual(b);
    expect(withFact.calls).toEqual(without.calls);
  });
  it("an acknowledgement that also asks something still goes to the team (SAV-73 unchanged)", async () => {
    const f = fixture(); f.input.message.currentText = "Merci, mais pouvez-vous me rappeler ?";
    const plan = await f.run();
    expect(plan.decision.disposition.kind).toBe("collect_context");
    expect(plan.steps).toEqual([]);
  });
});

describe("SAV-128 contract", () => {
  it("only an acknowledgement linked to an open ticket may carry the acknowledgement note", async () => {
    const plan = await fixture().run();
    const d = linked(plan);
    const bad = (decision: unknown, code: string) => {
      const parsed = savIntakeDecisionSchema.safeParse(decision);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(code);
    };
    bad({ ...plan.decision, disposition: { ...d, requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note"] } }, "SAV_INTAKE_TICKET_PERMISSIONS_INVALID");
    bad({ ...plan.decision, disposition: { ...d, note: { ...d.note!, previousStage: "new" } } }, "SAV_INTAKE_ACKNOWLEDGEMENT_NOTE_INVALID");
    bad({ ...plan.decision, disposition: { ...d, note: null, requiredPermissions: ["link_ticket", "associate_email", "set_ticket_new"] } }, "SAV_INTAKE_TICKET_CLASSIFICATION_REQUIRED");
    bad({ ...plan.decision, disposition: { ...d, learning: "eligible_after_confirmed_effect" } }, "SAV_INTAKE_SENSITIVE_LEARNING_FORBIDDEN");
    // A support plan cannot borrow the acknowledgement note.
    const support = await fixture(["support"]).run();
    const s = linked(support);
    bad({ ...support.decision, disposition: { ...s, note: { ...d.note!, sourceMessageId: support.decision.messageId } } }, "SAV_INTAKE_ACKNOWLEDGEMENT_NOTE_INVALID");
  });
});

describe("SAV-128 note", () => {
  it("one line of the customer's words, cut at 200 characters", () => {
    expect(savAckTicketSummary("\n  Merci   beaucoup \nSignature")).toBe("Merci beaucoup");
    const long = savAckTicketSummary("a".repeat(500));
    expect(long).toHaveLength(200); expect(long.endsWith("…")).toBe(true);
    expect(savAckTicketNote("C'est réglé, merci", "new")).toBe("Le client remercie / confirme la résolution : « C'est réglé, merci »\nLe ticket est en Nouveau : l'équipe confirme la résolution puis le ferme.");
  });
});

describe("SAV-128 runtime fact", () => {
  const db = (rows: unknown[] | Error) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => { if (rows instanceof Error) throw rows; return rows; } }) }) }) });
  it("off when SAV_ACK_CLOSE=on, or a V2 case owns the thread/ticket, or the read fails; else the thread's ticket", async () => {
    const { intakeAcknowledgementTicketFact } = await import("./ack-ticket-store");
    const input = { threadId, threadTicketId: "201" };
    expect(await intakeAcknowledgementTicketFact(input, {}, db([]) as never)).toEqual({ ticketId: "201" });
    expect(await intakeAcknowledgementTicketFact({ threadId, threadTicketId: null }, {}, db([]) as never)).toEqual({ ticketId: null });
    expect(await intakeAcknowledgementTicketFact(input, { SAV_ACK_CLOSE: "on" }, db([]) as never)).toBeUndefined();
    expect(await intakeAcknowledgementTicketFact(input, { SAV_ACK_CLOSE: "off" }, db([]) as never)).toEqual({ ticketId: "201" });
    expect(await intakeAcknowledgementTicketFact(input, {}, db([{ id: "case" }]) as never)).toBeUndefined();
    expect(await intakeAcknowledgementTicketFact(input, {}, db(Error("down")) as never)).toBeUndefined();
  });
});
