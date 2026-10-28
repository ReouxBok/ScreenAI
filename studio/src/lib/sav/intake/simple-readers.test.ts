/** Bench of the single-call reader through the REAL engine: synthetic CRM and a
 * scripted model, asserting the final plan the unchanged executor would receive. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeAssociation, IntakeContact, IntakePlan, IntakeTicket, ReadResult } from "./engine-types";
import { intakeResponseSchema, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import { createSavIntakeSimpleReaders, memoizeIntakeCrmReaders, SAV_INTAKE_SIMPLE_REVISION } from "./simple-readers";

const at = "2026-10-20T10:00:00.000Z";
const mid = "10000000-0000-4000-8000-000000000001";
const initialMid = "10000000-0000-4000-8000-000000000009";
const resource = { resourceId: "synthetic-private-resource", revisionId: "fixture-v1", sha256: "0".repeat(64) };
const warning = "SYNTHETIC MULTIPLE OPEN TICKETS WARNING";
const read = <T>(data: T): ReadResult<T> => ({ status: "complete", data, observedAt: at, reconstructedAsOf: at });
const days = (n: number) => new Date(Date.parse(at) - n * 86_400_000).toISOString();
type Data = { current: string; contacts: { contactId: string }[]; tickets: { ticketId: string }[]; decidedRequests?: unknown[]; identificationContinuation?: unknown };
type Answer = Record<string, unknown>;

function bench(options: { text?: string; subject?: string; contacts?: IntakeContact[]; tickets?: IntakeTicket[]; edges?: IntakeAssociation[];
  newsletterRule?: boolean; conversation?: EngineInput["message"][]; continuation?: EngineInput["identificationContinuation"]; unread?: EngineInput["message"]["unreadAttachments"] } = {}) {
  const contacts = options.contacts ?? [{ id: "101", emails: ["sender@example.test"] }];
  const tickets = options.tickets ?? [];
  const crmCalls: string[] = [];
  const crm = {
    findContactsByEmail: async (email: string) => { crmCalls.push(`lookup:${email}`); return read(contacts.filter(c => c.emails.includes(email))); },
    directAssociations: async (id: string) => { crmCalls.push(`associations:${id}`); return read((options.edges ?? []).filter(e => e.fromContactId === id)); },
    getContact: async (id: string) => { crmCalls.push(`contact:${id}`); return read(contacts.find(c => c.id === id)!); },
    ticketsForContact: async (id: string) => { crmCalls.push(`tickets:${id}`); return read(tickets.filter(t => t.contactIds.includes(id))); },
    ticketHistory: async (id: string) => { crmCalls.push(`history:${id}`); return read([{ id: `note-${id}`, kind: "note" as const, text: `Historique du ticket ${id}`, at: days(1) }]); },
  } satisfies Pick<IntakeAdapters, "findContactsByEmail" | "directAssociations" | "getContact" | "ticketsForContact" | "ticketHistory">;
  const input: EngineInput = {
    message: { id: mid, threadId: "20000000-0000-4000-8000-000000000001", fromEmail: "sender@example.test", toEmails: ["support@example.test"],
      currentText: options.text ?? "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", contentComplete: true, direction: "inbound", receivedAt: at, ...(options.unread ? { unreadAttachments: options.unread } : {}) },
    conversation: read(options.conversation ?? []), latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: "fixture-attempt",
    ...(options.continuation ? { identificationContinuation: options.continuation, previousIdentification: { messageId: options.continuation.initialMessageId, address: "sender@example.test", state: "confirmed" as const } } : {}),
  };
  const policy: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [{ typeId: 449, category: "HUBSPOT_DEFINED" }],
    resources: { identification: resource, registrationNotFound: resource, partnership: resource, commercial: resource, investor: resource,
      multiTicketWarning: { ...resource, text: warning, sha256: createHash("sha256").update(warning).digest("hex") } },
    ...(options.newsletterRule ? { qualifiedOther: { family: "authenticated_newsletter" as const, resource, evidenceSource: "private_rule" as const } } : {}) };
  const seen: Data[] = [], phases: string[] = [], systems: string[] = [], traces: IntakeModelTrace[] = [];
  const judgements: { tickets: { ticketId: string }[] }[] = [];
  let script: (data: Data, n: number) => Answer = () => ({});
  const call: IntakeGeminiCall = async request => {
    const data = JSON.parse(request.body.contents[0].parts[0].text) as Data;
    seen.push(data); phases.push(request.phase); systems.push(request.body.systemInstruction.parts[0].text);
    expect(request.promptRevision).toBe(SAV_INTAKE_SIMPLE_REVISION);
    return { json: script(data, seen.length), metadata: { inputTokens: 100, outputTokens: 20, thoughtTokens: 0, totalTokens: 120 } };
  };
  const shared = memoizeIntakeCrmReaders(crm);
  const provenance = new Map([[mid, { subject: options.subject ?? "Synchronisation agenda" } as never]]);
  const semantic = createSavIntakeSimpleReaders({ model: "gemini-fixture", call, crm: shared, policy, provenance, onTrace: t => traces.push(t), onJudgement: judgement => judgements.push(judgement) });
  const run = (answer: (data: Data, n: number) => Answer) => { script = answer; return planSavIntake(input, { ...shared, ...semantic }, policy); };
  const resumeIssues = async () => {
    script = d => judgement(d);
    return semantic.assessIssues!({message:input.message,requests:[{id:"r1",kind:"support",currentMessageId:mid}],tickets:[{ticket:ticket("201"),history:[]}],evidence:[{id:"current"},{id:"ticket-201"},{id:"history-201"}]} as never,new AbortController().signal);
  };
  return { run, seen, phases, systems, traces, judgements, crmCalls, resumeIssues };
}
/** A complete, valid judgement; tests override only what they exercise. */
const judgement = (data: Data, over: Answer = {}): Answer => ({
  messageId: mid, nature: "request",
  requests: [{ id: "r1", kind: "support", summary: "La synchronisation de l'agenda échoue.", sourceIds: ["current"] }],
  ticketTitle: "Échec de synchronisation de l'agenda", ticketDescription: "Le client signale une erreur 500 lors de la synchronisation de son agenda.",
  identity: { kind: data.contacts.length === 1 ? "unique" : "unknown", contactIds: data.contacts.length === 1 ? [data.contacts[0].contactId] : [], why: "Adresse de l'expéditeur." },
  tickets: data.tickets.map(t => ({ ticketId: t.ticketId, relation: "different", why: "Autre sujet.", sourceIds: ["current", `ticket-${t.ticketId}`] })),
  missing: [], rationale: "Demande support unique.", ...over });
const same = (data: Data, ids: string[]) => data.tickets.map(t => ({ ticketId: t.ticketId, relation: ids.includes(t.ticketId) ? "same" : "different", why: "Même problème de synchronisation.", sourceIds: ["current", `ticket-${t.ticketId}`, `history-${t.ticketId}`] }));
const ticket = (id: string, over: Partial<IntakeTicket> = {}): IntakeTicket => ({ id, contactIds: ["101"], stage: "open", createdAt: days(5), ownerId: null,
  subject: `Ticket ${id}`, content: "Contenu synthétique", ...over });
function disposition(plan: IntakePlan) { if (plan.decision.disposition.kind !== "ticket") throw Error(`expected ticket, got ${JSON.stringify(plan.decision.disposition)}`); return plan.decision.disposition; }
const reasons = (plan: IntakePlan) => plan.decision.disposition.kind === "collect_context" ? plan.decision.disposition.reasons : [];

describe("single call, plan unchanged for the executor", () => {
  it("creates a ticket without owner in one model call and reads each CRM record once", async () => {
    const b = bench();
    const plan = await b.run(d => judgement(d));
    expect(b.seen).toHaveLength(1);
    const d = disposition(plan);
    expect(d.target.operation).toBe("create");
    expect(plan.newTicket).toMatchObject({ title: "Échec de synchronisation de l'agenda", owner: "leave_unassigned", stage: "new", contactId: "101" });
    expect(plan.steps.map(s => s.mutation)).toContain("create_ticket");
    expect(new Set(b.crmCalls).size).toBe(b.crmCalls.length);
  });
  it("links the relevant open ticket while another ticket of the same contact concerns another problem", async () => {
    const b = bench({ tickets: [ticket("201", { subject: "Facture" }), ticket("202", { subject: "Synchronisation agenda" })] });
    const d = disposition(await b.run(data => judgement(data, { tickets: same(data, ["202"]) })));
    expect(d.target).toMatchObject({ operation: "link", ticketId: "202" });
    expect(b.seen).toHaveLength(1);
  });
  it("chooses the most recent of two relevant open tickets", async () => {
    const b = bench({ tickets: [ticket("201", { createdAt: days(9) }), ticket("202", { createdAt: days(2) })] });
    const d = disposition(await b.run(data => judgement(data, { tickets: same(data, ["201", "202"]) })));
    expect(d.target).toMatchObject({ operation: "link", ticketId: "202" });
  });
  it.each([[14, "reopen"], [15, "reopen"], [16, "create"]] as const)("a relevant ticket closed %i days ago gives %s; the owner is kept on reopen", async (age, operation) => {
    const b = bench({ tickets: [ticket("201", { stage: "closed", createdAt: days(40), closedAt: days(age), ownerId: "777" })] });
    const plan = await b.run(data => judgement(data, { tickets: same(data, ["201"]) }));
    const d = disposition(plan);
    expect(d.target.operation).toBe(operation);
    if (d.target.operation === "reopen") expect(d.target.preserveOwnerId).toBe("777");
    if (d.target.operation === "create") { expect(d.target.predecessor).toMatchObject({ ticketId: "201" }); expect(plan.newTicket?.owner).toBe("leave_unassigned"); }
  });
  it("an unknown closure date is a human decision, never an automatic reopening", async () => {
    const b = bench({ tickets: [ticket("201", { stage: "closed", createdAt: days(40), closedAt: undefined })] });
    expect(reasons(await b.run(data => judgement(data, { tickets: same(data, ["201"]) })))).toContain("ticket_closure_date_unknown");
  });
  it("an unclear ticket goes to the team with its cause, without any write", async () => {
    const b = bench({ tickets: [ticket("201")] });
    const plan = await b.run(data => judgement(data, { tickets: [{ ticketId: "201", relation: "unclear", why: "Sujet proche mais non confirmé.", sourceIds: ["current", "ticket-201"] }] }));
    expect(reasons(plan)).toContain("same_issue_unresolved");
    expect(plan.steps).toEqual([]);
  });
  it("finance and cancellation keep ticket creation and linking", async () => {
    const b = bench({ text: "Bonjour, je souhaite une copie de ma dernière facture." });
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "finance", summary: "Copie de facture.", sourceIds: ["current"] }], ticketTitle: "Demande de copie de facture" }));
    expect(plan.decision.classification).toBe("finance");
    expect(disposition(plan).target.operation).toBe("create");
    const c = bench({ text: "Je veux résilier mon abonnement.", tickets: [ticket("201")] });
    const cancel = await c.run(data => judgement(data, { requests: [{ id: "r1", kind: "cancellation", summary: "Résiliation.", sourceIds: ["current"] }], tickets: same(data, ["201"]) }));
    expect(cancel.decision.classification).toBe("cancellation");
    expect(disposition(cancel).target).toMatchObject({ operation: "link", ticketId: "201" });
  });
  it("a ticket of an admitted linked contact is linked", async () => {
    const b = bench({ contacts: [{ id: "101", emails: ["sender@example.test"] }, { id: "102", emails: ["collegue@example.test"] }],
      edges: [{ fromContactId: "101", toContactId: "102", typeId: 449, category: "HUBSPOT_DEFINED" }], tickets: [ticket("301", { contactIds: ["102"] })] });
    const d = disposition(await b.run(data => judgement(data, { identity: { kind: "unique", contactIds: ["101"], why: "Expéditeur." }, tickets: same(data, ["301"]) })));
    expect(d.target).toMatchObject({ operation: "link", ticketId: "301" });
    expect(b.seen).toHaveLength(1);
  });
});

describe("no needless immobilisation", () => {
  it("a newsletter without any request goes to Other under the qualified rule", async () => {
    const b = bench({ text: "Découvrez nos nouveautés du mois.", newsletterRule: true });
    const plan = await b.run(d => judgement(d, { nature: "newsletter", requests: [], ticketTitle: undefined, ticketDescription: undefined }));
    expect(plan.decision.classification).toBe("other");
  });
  it("without a qualified rule, a newsletter is never hidden in Other", async () => {
    const b = bench({ text: "Découvrez nos nouveautés du mois." });
    const plan = await b.run(d => judgement(d, { nature: "newsletter", requests: [], ticketTitle: undefined, ticketDescription: undefined }));
    expect(plan.decision.classification).not.toBe("other");
    expect(plan.steps).toEqual([]);
  });
  it("« Ça ne fonctionne pas » in the subject alone stays a Support request", async () => {
    const b = bench({ subject: "Re: Ça ne fonctionne pas", text: "Merci de regarder." });
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "acknowledgement", summary: "Remerciement.", sourceIds: ["current"] }], ticketTitle: undefined }));
    expect(plan.decision.classification).toBe("support");
    expect(disposition(plan).target.operation).toBe("create");
    expect(plan.newTicket?.title.split(/\s+/).length).toBeLessThanOrEqual(6);
  });
  it("an off-format title is replaced by the qualified deterministic title, without another model call", async () => {
    const b = bench();
    const plan = await b.run(d => judgement(d, { ticketTitle: "Bonjour, le client nous explique que la synchronisation ne marche plus depuis hier soir" }));
    expect(b.seen).toHaveLength(1);
    expect(plan.newTicket?.title).toBe("Dysfonctionnement du produit à examiner");
    expect(disposition(plan).target.operation).toBe("create");
  });
  it("a malformed answer gets exactly one distinct format repair, then the same plan as a valid answer", async () => {
    const b = bench({ tickets: [ticket("201")] });
    const plan = await b.run((d, n) => n === 1 ? judgement(d, { tickets: [] }) : judgement(d, { tickets: same(d, ["201"]) }));
    expect(b.seen).toHaveLength(2);
    expect(b.systems[0]).not.toContain("FORMAT REPAIR"); expect(b.systems[1]).toContain("FORMAT REPAIR");
    expect(disposition(plan).target).toMatchObject({ operation: "link", ticketId: "201" });
    expect(b.traces.map(t => t.accepted)).toEqual([false, true]);
    expect(b.traces[0].validationFailure).toMatchObject({ reason: "ticket_not_judged" });
  });
  it("a persistently malformed answer stops after the repair with an explicit cause and no write", async () => {
    const b = bench();
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "support", summary: "x", sourceIds: ["ticket-999"] }] }));
    expect(b.seen).toHaveLength(2);
    expect(reasons(plan)).toContain("classification_incomplete");
    expect(plan.steps).toEqual([]);
  });
});

describe("identity", () => {
  it("an unknown sender receives the identification template", async () => {
    const b = bench({ contacts: [] });
    const plan = await b.run(d => judgement(d, { identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." } }));
    expect(plan.decision.disposition).toMatchObject({ kind: "request_identification" });
  });
  it("several contacts resolved to one by the documented evidence proceed without a person", async () => {
    const contacts = [{ id: "101", emails: ["sender@example.test"] }, { id: "102", emails: ["sender@example.test", "alias@example.test"] }];
    const b = bench({ contacts, tickets: [ticket("201", { contactIds: ["102"] })] });
    const plan = await b.run(data => judgement(data, { identity: { kind: "unique", contactIds: ["102"], why: "Le ticket existant désigne cette fiche." }, tickets: same(data, ["201"]) }));
    expect(disposition(plan).target).toMatchObject({ operation: "link", ticketId: "201" });
    expect(b.seen).toHaveLength(1);
  });
  it("truly equivalent contacts ask a person to choose", async () => {
    const contacts = [{ id: "101", emails: ["sender@example.test"] }, { id: "102", emails: ["sender@example.test"] }];
    const b = bench({ contacts });
    const plan = await b.run(data => judgement(data, { identity: { kind: "equivalent", contactIds: ["101", "102"], why: "Deux fiches identiques." } }));
    expect(plan.progress).toMatchObject({ kind: "human_choice", questionCode: "equivalent_contact_choice" });
  });
  it("a declared registration address is judged by one explicit second call over exactly its records", async () => {
    const initial = { id: initialMid, threadId: "20000000-0000-4000-8000-000000000001", fromEmail: "sender@example.test", toEmails: ["support@example.test"],
      currentText: "Mon agenda ne se synchronise plus.", contentComplete: true, direction: "inbound" as const, receivedAt: days(1) };
    const b = bench({ text: "Mon compte est client@entreprise.test", conversation: [initial], continuation: { initialMessageId: initialMid, confirmedEffectId: "effect-1" },
      contacts: [{ id: "101", emails: ["sender@example.test"] }, { id: "401", emails: ["client@entreprise.test"] }], tickets: [ticket("501", { contactIds: ["401"] })] });
    const plan = await b.run((data, n) => n === 1
      ? judgement(data, { requests: [{ id: "r1", kind: "support", summary: "Agenda non synchronisé.", sourceIds: [`message-${initialMid}`] }],
        registration: { address: "client@entreprise.test", quote: "Mon compte est client@entreprise.test" } })
      : judgement(data, { requests: [], identity: { kind: "unique", contactIds: ["401"], why: "Adresse déclarée." }, tickets: same(data, ["501"]) }));
    expect(b.seen).toHaveLength(2);
    expect(b.phases).toEqual(["understanding", "ticket_matching"]);
    expect(b.seen[1].decidedRequests).toHaveLength(1);
    expect(disposition(plan).target).toMatchObject({ operation: "link", ticketId: "501" });
  });
});


describe("independent review counterexamples", () => {
  it("does not act when the model reports indispensable missing history", async () => {
    const b = bench({ tickets: [ticket("201")] });
    const plan = await b.run(d => judgement(d, { missing: [{kind:"history",why:"Historique indispensable absent pour déterminer si ce ticket concerne la même panne."}], tickets: same(d,["201"]) }));
    expect(plan.steps).toEqual([]);
    expect(plan.decision.disposition.kind).toBe("collect_context");
  });
  it("does not promote a historical request into a new cancellation without identification continuation", async () => {
    const prior = {id:initialMid,threadId:"20000000-0000-4000-8000-000000000001",fromEmail:"sender@example.test",toEmails:["support@example.test"],currentText:"Je souhaite résilier.",contentComplete:true,direction:"inbound" as const,receivedAt:days(1)};
    const b = bench({text:"Merci, bonne journée.",conversation:[prior]});
    const plan = await b.run(d => judgement(d, {requests:[{id:"r1",kind:"cancellation",summary:"Ancienne demande de résiliation.",sourceIds:[`message-${initialMid}`]}]}));
    expect(plan.steps).toEqual([]);
    expect(plan.decision.classification).not.toBe("cancellation");
  });
});

it("independent: read continuation passes the already accepted requests to a fresh reader", async () => {
  const b=bench();
  await b.resumeIssues();
  expect(b.seen[0].decidedRequests).toMatchObject([{id:"r1",kind:"support"}]);
});

describe("indispensable evidence and request anchoring (review P1)", () => {
  it.each(["image", "history", "contact", "other"] as const)("a missing indispensable %s never produces a write; the cause is kept for the team", async kind => {
    const b = bench({ tickets: [ticket("201")] });
    const plan = await b.run(d => judgement(d, { missing: [{ kind, why: `Élément ${kind} indispensable absent.` }], tickets: same(d, ["201"]) }));
    expect(plan.steps).toEqual([]);
    expect(plan.decision.disposition.kind).toBe("collect_context");
  });
  it("without any candidate ticket, a missing indispensable element never creates a ticket", async () => {
    const b = bench();
    const plan = await b.run(d => judgement(d, { missing: [{ kind: "image", why: "La capture citée est illisible." }] }));
    expect(plan.steps).toEqual([]);
    expect(plan.newTicket).toBeUndefined();
  });
  it("nothing reported missing: the same dossier proceeds (accessory elements never block)", async () => {
    const b = bench({ tickets: [ticket("201")] });
    expect(disposition(await b.run(d => judgement(d, { missing: [], tickets: same(d, ["201"]) }))).target).toMatchObject({ operation: "link", ticketId: "201" });
  });
  it("during an identification continuation, a request anchored on another old message is still refused", async () => {
    const initial = { id: initialMid, threadId: "20000000-0000-4000-8000-000000000001", fromEmail: "sender@example.test", toEmails: ["support@example.test"],
      currentText: "Mon agenda ne se synchronise plus.", contentComplete: true, direction: "inbound" as const, receivedAt: days(2) };
    const other = { ...initial, id: "10000000-0000-4000-8000-000000000008", currentText: "Je souhaite résilier.", receivedAt: days(3) };
    const b = bench({ text: "Mon compte est sender@example.test", conversation: [other, initial], continuation: { initialMessageId: initialMid, confirmedEffectId: "effect-1" } });
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "cancellation", summary: "Résiliation.", sourceIds: [`message-${other.id}`] }],
      registration: { address: "sender@example.test", quote: "Mon compte est sender@example.test" } }));
    expect(plan.steps).toEqual([]);
    expect(plan.decision.classification).not.toBe("cancellation");
    expect(b.traces.some(t => t.validationFailure?.reason === "wrong_anchor_source")).toBe(true);
  });
});

describe("non-regression of the existing routes (lot 3)", () => {
  it.each([["partnership", "supervised_partnership"], ["commercial", "supervised_commercial"], ["investor", "supervised_investor"]] as const)(
    "%s requests stay supervised, never a ticket", async (kind, action) => {
      const b = bench({ text: "Nous souhaitons discuter d'une collaboration." });
      const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind, summary: "Demande hors support.", sourceIds: ["current"] }] }));
      expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket" });
      expect(plan.progress).toMatchObject({ kind: "supervised_action", action });
      expect(plan.steps).toEqual([]);
    });
  it("a pure acknowledgement creates nothing", async () => {
    const b = bench({ text: "Merci beaucoup, tout fonctionne maintenant.", subject: "Re: Merci" });
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "acknowledgement", summary: "Remerciement.", sourceIds: ["current"] }] }));
    expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket" });
    expect(plan.steps).toEqual([]);
  });
  it("Other with requests is never hidden without the qualified rule", async () => {
    const b = bench({ text: "Information générale." });
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "other", summary: "Information.", sourceIds: ["current"] }] }));
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["private_resource_unavailable"]) });
  });
  it("a mixed support and finance message keeps both requests in one ticket decision", async () => {
    const b = bench({ text: "Ma synchronisation échoue et je veux aussi ma facture." });
    const plan = await b.run(d => judgement(d, { requests: [{ id: "r1", kind: "support", summary: "Synchronisation.", sourceIds: ["current"] }, { id: "r2", kind: "finance", summary: "Facture.", sourceIds: ["current"] }] }));
    expect(plan.decision.classification).toBe("finance");
    expect(plan.newTicket?.requestIds).toEqual(["r1", "r2"]);
  });
});

describe("SAV-42 A: optional registration declaration through the real engine", () => {
  const text = "Je souhaite annuler mon essai gratuit. Mon compte est associé à l'adresse e-mail depuis laquelle je vous écris.";
  const cancel = { requests: [{ id: "r1", kind: "cancellation", summary: "Annulation de l'essai.", sourceIds: ["current"] }], ticketTitle: "Annulation de l'essai gratuit" };
  it("the sender's unique record is used when the sending address is not written literally", async () => {
    const b = bench({ text });
    const plan = await b.run(d => judgement(d, { ...cancel, registration: { address: "sender@example.test", quote: "Mon compte est associé à l'adresse e-mail depuis laquelle je vous écris." } }));
    expect(plan.decision.classification).toBe("cancellation");
    expect(disposition(plan).target.operation).toBe("create");
    expect(plan.newTicket).toMatchObject({ contactId: "101", owner: "leave_unassigned" });
    expect(b.crmCalls).toContain("lookup:sender@example.test");
    expect(b.traces.at(-1)).toMatchObject({ accepted: true, normalization: { discardedRegistrations: 1 } });
  });
  it("an invented alternative address is never looked up nor adopted", async () => {
    const b = bench({ text, contacts: [{ id: "101", emails: ["sender@example.test"] }, { id: "401", emails: ["invented@example.test"] }] });
    const plan = await b.run(d => judgement(d, { ...cancel, registration: { address: "invented@example.test", quote: "Mon compte est associé à l'adresse e-mail" } }));
    expect(b.crmCalls).not.toContain("lookup:invented@example.test");
    expect(plan.newTicket?.contactId).toBe("101");
  });
  it("no record for the sender keeps the existing identification template path, without contact creation", async () => {
    const b = bench({ text, contacts: [] });
    const plan = await b.run(d => judgement(d, { ...cancel, registration: { address: "sender@example.test", quote: "depuis laquelle je vous écris" } }));
    expect(plan.decision.disposition).toMatchObject({ kind: "request_identification", reason: "sender_contact_absent" });
    expect(plan.steps.map(s => s.mutation)).not.toContain("create_contact");
  });
  it("an explicit other address in the current text keeps the strict check: no write on an unproven declaration", async () => {
    const b = bench({ text: "Je souhaite annuler. Mon compte est client@entreprise.test merci." , contacts: [{ id: "101", emails: ["sender@example.test"] }, { id: "401", emails: ["client@entreprise.test"] }] });
    const plan = await b.run(d => judgement(d, { ...cancel, registration: { address: "autre@entreprise.test", quote: "Mon compte est" } }));
    expect(plan.steps).toEqual([]);
    expect(b.traces.some(t => t.validationFailure?.reason === "registration_source_invalid")).toBe(true);
  });
  it("several records for the sender still ask a person to choose", async () => {
    const b = bench({ text, contacts: [{ id: "101", emails: ["sender@example.test"] }, { id: "102", emails: ["sender@example.test"] }] });
    const plan = await b.run(d => judgement(d, { ...cancel, identity: { kind: "equivalent", contactIds: ["101", "102"], why: "Deux fiches." },
      registration: { address: "sender@example.test", quote: "depuis laquelle je vous écris" } }));
    expect(plan.progress).toMatchObject({ kind: "human_choice", questionCode: "equivalent_contact_choice" });
  });
});

describe("SAV-42 B: unread attachments through the single-call reader and the real engine", () => {
  const unread = [{ sourceId: "attachment:pdf-1", reason: "unsupported_type" as const }];
  const text = "Je souhaite mettre fin au contrat et ne pas le renouveler.";
  const cancel = { requests: [{ id: "r1", kind: "cancellation", summary: "Fin de contrat.", sourceIds: ["current"] }], ticketTitle: "Fin de contrat sans renouvellement" };
  it("an accessory unread file lets the written request be handled; the file is listed, never read", async () => {
    const b = bench({ text, unread });
    const plan = await b.run(d => judgement(d, { ...cancel, unreadAttachmentRequirements: [{ sourceId: "attachment:pdf-1", role: "accessory", textQuote: text }] }));
    expect(JSON.stringify(b.seen[0])).toContain("unreadAttachments");
    expect(plan.decision.classification).toBe("cancellation");
    expect(disposition(plan).target.operation).toBe("create");
  });
  it("a required unread file produces no write", async () => {
    const b = bench({ text, unread });
    const plan = await b.run(d => judgement(d, { ...cancel, unreadAttachmentRequirements: [{ sourceId: "attachment:pdf-1", role: "required" }] }));
    expect(plan.steps).toEqual([]);
    expect(reasons(plan)).toContain("history_incomplete");
  });
});

it("keeps the existing reader schema unchanged while simple opts into REST array bounds", () => {
  const schema = z.object({ values: z.array(z.string().max(5)).min(1).max(20) });
  expect(intakeResponseSchema(schema)).toEqual({type:"OBJECT",properties:{values:{type:"ARRAY",items:{type:"STRING"}}},required:["values"]});
  expect(intakeResponseSchema(schema, {arrayBounds:true})).toEqual({type:"OBJECT",properties:{values:{type:"ARRAY",minItems:"1",maxItems:"20",items:{type:"STRING"}}},required:["values"]});
});
it("retains all twenty ticket verdicts and all current requests with concise instructions", async () => {
  const tickets = Array.from({length:20}, (_, index) => ticket(String(201 + index)));
  const b = bench({ tickets, text: "Mon agenda échoue et je souhaite ma facture." });
  const plan = await b.run(d => judgement(d, { requests: [
    {id:"r1",kind:"support",summary:"Agenda en panne.",sourceIds:["current"]},
    {id:"r2",kind:"finance",summary:"Copie de facture.",sourceIds:["current"]},
  ] }));
  expect(b.seen).toHaveLength(1); expect(b.seen[0].tickets).toHaveLength(20);
  expect(b.systems[0]).toContain("exactly one verdict for EVERY supplied ticket");
  expect(b.systems[0]).toContain("without omitting any request");
  expect(plan.newTicket?.requestIds).toEqual(["r1", "r2"]);
  expect(b.judgements[0].tickets.map(ticket => ticket.ticketId)).toEqual(tickets.map(ticket => ticket.id));
});
