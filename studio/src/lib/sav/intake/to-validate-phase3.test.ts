// SAV-139 phase 3: technical « À valider » (refused citations, long threads) and « quel ticket ? ». Each switch off = today. Fictional data only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeContact, IntakeMessage, IntakeTicket, MessageAnalysis } from "./engine-types";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import { createSavIntakeSimpleReaders } from "./simple-readers";
import { intakeRuntimeConfigurationHash } from "./runtime-contract";
import { savIntakeBoundConversation, savIntakeCitationRepairText, savIntakeDecideTicketChoice } from "./to-validate-rules";

const THREAD = "80000000-0000-4000-8000-000000000001", MID = "80000000-0000-4000-8000-000000000002", at = "2026-11-25T10:00:00.000Z";
const message: IntakeMessage = { id: MID, threadId: THREAD, fromEmail: "client@exemple.invalid", toEmails: ["contact@exemple.invalid"],
  currentText: "Bonjour, la synchronisation de mon agenda échoue depuis hier.", contentComplete: true, direction: "inbound", receivedAt: at };
const meta = { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 };
const prompt = (body: Parameters<IntakeGeminiCall>[0]["body"]) => body.systemInstruction.parts[0]!.text;

describe("citation repair: the repair line names the refused check", () => {
  it("text for citation refusals only, with a cleaned path", () => {
    expect(savIntakeCitationRepairText({ reason: "wrong_anchor_source", path: "requests.0.sourceIds" })).toMatch(/CITATION REPAIR v1: .*wrong_anchor_source at requests\.0\.sourceIds.*CURRENT message/);
    expect(savIntakeCitationRepairText({ reason: "registration_source_invalid", path: "registration" })).toMatch(/omit `registration`/);
    expect(savIntakeCitationRepairText({ reason: "output_schema_invalid", path: "x" })).toBeNull();
    expect(savIntakeCitationRepairText(undefined)).toBeNull();
    expect(savIntakeCitationRepairText({ reason: "unknown_source", path: "a\"b<script>" })).toContain("at abscript");
  });
});

describe("current pipeline: a refused citation", () => {
  // First answer: a request anchored to an origin message without a continuation (wrong_anchor_source). Second answer: chosen by the test.
  function reader(citationRepair: boolean | undefined, second: "valid" | "same") {
    const bodies: Parameters<IntakeGeminiCall>[0]["body"][] = [];
    const call: IntakeGeminiCall = async request => {
      bodies.push(request.body);
      const data = JSON.parse(request.body.contents[0].parts[0].text) as { citationCatalogue: { id: string; sourceId: string }[] };
      const quote = data.citationCatalogue.find(e => e.sourceId === "current")!.id;
      const wrong = bodies.length === 1 || second === "same";
      return { json: { messageId: MID, nature: "request", requests: [{ id: "r1", kind: "support", currentMessageId: MID, quoteId: quote, ...(wrong ? { originMessageId: THREAD } : {}) }],
        ticketSummary: { title: "Agenda non synchronisé", description: "Échec.", requestIds: ["r1"] } }, metadata: meta };
    };
    const readers = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, ...(citationRepair === undefined ? {} : { citationRepair }) });
    return { bodies, run: () => readers.analyseMessage({ message, conversation: [message] }, new AbortController().signal) };
  }
  it("off: never repaired (today): one call, refused", async () => {
    const r = reader(undefined, "valid");
    await expect(r.run()).rejects.toThrow("SAV_INTAKE_MODEL_CITATION_REJECTED");
    expect(r.bodies).toHaveLength(1);
  });
  it("on: one repair call naming the check; a valid answer is accepted", async () => {
    const r = reader(true, "valid");
    const result = await r.run();
    expect(r.bodies).toHaveLength(2);
    expect(prompt(r.bodies[0]!)).not.toContain("CITATION REPAIR");
    expect(prompt(r.bodies[1]!)).toContain("CITATION REPAIR v1: the server refused your previous answer (wrong_anchor_source at requests.0.originMessageId)");
    expect(result.requests).toEqual([{ id: "r1", kind: "support", currentMessageId: MID }]);
  });
  it("on: the same refused answer is still refused (no second repair, nothing accepted)", async () => {
    const r = reader(true, "same");
    await expect(r.run()).rejects.toThrow("SAV_INTAKE_MODEL_CITATION_REJECTED");
    expect(r.bodies).toHaveLength(2);
  });
});

describe("current pipeline: the registration quote is normalised like every quote, never invented", () => {
  const declared: IntakeMessage = { ...message, currentText: "Bonjour,  mon compte Limova est  compte@exemple.invalid  et l’agenda ne se synchronise plus." };
  function reader(citationRepair: boolean, quote: string) {
    const call: IntakeGeminiCall = async request => {
      const data = JSON.parse(request.body.contents[0].parts[0].text) as { citationCatalogue: { id: string; sourceId: string }[] };
      const current = data.citationCatalogue.find(e => e.sourceId === "current")!.id;
      return { json: { messageId: MID, nature: "request", requests: [{ id: "r1", kind: "support", currentMessageId: MID, quoteId: current }],
        registration: { address: "compte@exemple.invalid", sourceMessageId: MID, quote },
        ticketSummary: { title: "Agenda non synchronisé", description: "Échec.", requestIds: ["r1"] } }, metadata: meta };
    };
    return createSavIntakeSemanticReaders({ model: "gemini-fixture", call, citationRepair }).analyseMessage({ message: declared, conversation: [declared] }, new AbortController().signal);
  }
  it("off: a quote whose spaces differ is refused (today)", async () => {
    await expect(reader(false, "mon compte Limova est compte@exemple.invalid")).rejects.toThrow();
  });
  it("on: the same quote is accepted; a quote absent from the mail is still refused", async () => {
    expect((await reader(true, "mon compte Limova est compte@exemple.invalid")).registration).toMatchObject({ address: "compte@exemple.invalid" });
    await expect(reader(true, "mon compte Limova principal est compte@exemple.invalid")).rejects.toThrow();
  });
});

describe("simple pipeline: repair line and bounded thread", () => {
  const crm = { findContactsByEmail: async () => ({ status: "complete" as const, data: [], observedAt: at }),
    directAssociations: async () => ({ status: "complete" as const, data: [], observedAt: at }),
    getContact: async () => ({ status: "failed" as const, data: null, observedAt: at }),
    ticketsForContact: async () => ({ status: "complete" as const, data: [], observedAt: at }),
    ticketHistory: async () => ({ status: "complete" as const, data: [], observedAt: at }) } as never;
  const history = Array.from({ length: 15 }, (_, i): IntakeMessage => ({ ...message, id: `80000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    direction: i % 2 ? "outbound" : "inbound", currentText: `Message ${i}.`, receivedAt: `2026-11-${String(10 + i).padStart(2, "0")}T09:00:00.000Z` }));
  function simple(options: { citationRepair?: boolean; boundedConversation?: boolean }, conversation: IntakeMessage[]) {
    const bodies: Parameters<IntakeGeminiCall>[0]["body"][] = [];
    const call: IntakeGeminiCall = async request => {
      bodies.push(request.body);
      const data = JSON.parse(request.body.contents[0].parts[0].text) as { outputReferences: { snapshot: string; sources: Record<string, string> } };
      const sources = Object.entries(data.outputReferences.sources);
      const current = sources.find(([, v]) => v === "current")![0], older = sources.find(([, v]) => v.startsWith("message-"))?.[0];
      // First answer cites an older message only (wrong_anchor_source), the repair cites the current mail.
      return { json: { v: data.outputReferences.snapshot, n: "request", r: [{ id: "r1", k: "support", s: "Agenda.", e: [bodies.length === 1 && older ? older : current] }],
        i: { k: "unknown", c: [], w: "Aucun contact." }, j: [], x: [], w: "Support." }, metadata: meta };
    };
    const readers = createSavIntakeSimpleReaders({ model: "gemini-fixture", call, crm, policy: { relationRevision: "r", admittedRelations: [], resources: {} } as never, ...options });
    return { bodies, run: () => readers.analyseMessage({ message, conversation }, new AbortController().signal) };
  }
  it("a refused anchor: today's generic repair off, the named check on", async () => {
    const off = simple({}, [history[0]!, message]); await off.run();
    expect(off.bodies).toHaveLength(2); expect(prompt(off.bodies[1]!)).not.toContain("CITATION REPAIR");
    const on = simple({ citationRepair: true }, [history[0]!, message]); await on.run();
    expect(prompt(on.bodies[1]!)).toContain("CITATION REPAIR v1: the server refused your previous answer (wrong_anchor_source at requests.0.sourceIds)");
  });
  it("a long thread: whole off, the newest 12 messages and a notice on", async () => {
    const sent = (o: { boundedConversation?: boolean }) => { const s = simple({ ...o, citationRepair: false }, [...history, message]); return s.run().then(() => JSON.parse(s.bodies.at(-1)!.contents[0].parts[0].text)); };
    const off = await sent({}), on = await sent({ boundedConversation: true });
    expect(off.conversation).toHaveLength(16); expect(off.conversationNotice).toBeUndefined();
    expect(on.conversation).toHaveLength(12);
    expect(on.conversation.at(-1).sourceId).toBe(`message-${MID}`);
    expect(on.conversationNotice).toBe("4 older messages of this thread are not shown; decide on the messages shown.");
  });
  it("bound helper keeps a continuation's first message", () => {
    const all = [...history, message];
    expect(savIntakeBoundConversation(all, [history[0]!.id]).messages.map(m => m.id)).toEqual([history[0]!.id, ...all.slice(-12).map(m => m.id)]);
    expect(savIntakeBoundConversation(all.slice(0, 5), []).omitted).toBe(0);
  });
});

describe("launch hash", () => {
  const pins = { mailboxId: "30000000-0000-4000-8000-000000000001", createdAfter: at, receivedAfter: at, expiresAt: "2026-11-26T10:00:00.000Z",
    codeRevision: "a".repeat(40), resourcesHash: "b".repeat(64), policyHash: "c".repeat(64), maxNanoUsd: 1000, maxCalls: 10 };
  it("the two prompt switches change it, the ticket switch does not", () => {
    const hash = (env: Record<string, string>) => intakeRuntimeConfigurationHash(pins, env);
    expect(hash({ SAV_INTAKE_CITATION_REPAIR: "on" })).not.toBe(hash({}));
    expect(hash({ SAV_INTAKE_BOUNDED_CONVERSATION: "on" })).not.toBe(hash({}));
    expect(hash({ SAV_INTAKE_TICKET_DECIDE: "on", SAV_INTAKE_CITATION_REPAIR: "true" })).toBe(hash({}));
  });
});

// ---------- « quel ticket ? » (SAV_INTAKE_TICKET_DECIDE) ----------
const contact: IntakeContact = { id: "101", emails: [message.fromEmail] };
const ticket = (id: string, stage: IntakeTicket["stage"] = "open", createdAt = "2026-11-20T09:00:00.000Z"): IntakeTicket => ({ id, contactIds: ["101"], stage, createdAt, subject: `Sujet ${id}`, content: "Contenu fictif.", ownerId: null,
  ...(stage === "closed" ? { closedAt: "2026-11-21T09:00:00.000Z" } : {}) });
const warning = "Plusieurs tickets ouverts pour ce contact.";
function plan(kind: string, tickets: IntakeTicket[], relations: Record<string, string>, complete: boolean, policy: Partial<EnginePolicy> = {}) {
  const analysis: MessageAnalysis = { messageId: MID, nature: "request", requests: [{ id: "r0", kind: kind as never, currentMessageId: MID }],
    ticketSummary: { title: "Demande client", description: "Description fictive.", requestIds: ["r0"] } };
  const ok = <T>(data: T) => ({ status: "complete" as const, data, observedAt: at });
  const adapters: IntakeAdapters = { analyseMessage: async () => structuredClone(analysis), findContactsByEmail: async () => ok([contact]), directAssociations: async () => ok([]),
    getContact: async () => ok(contact), ticketsForContact: async () => ok(tickets), ticketHistory: async () => ok([]),
    assessIssues: async () => ({ investigationComplete: complete, tickets: tickets.map(t => ({ ticketId: t.id, relation: relations[t.id] as never,
      requestIds: relations[t.id] === "different" ? [] : ["r0"], evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }) };
  const input: EngineInput = { message, latestInboundMessageId: MID, conversation: { status: "complete", data: [message], observedAt: at }, now: at, mode: "current", identificationAttemptId: "a-239" };
  return planSavIntake(input, adapters, { relationRevision: "f", admittedRelations: [], resources: {
    multiTicketWarning: { resourceId: "w", revisionId: "r1", sha256: createHash("sha256").update(warning).digest("hex"), text: warning } }, ...policy });
}
const decide = { toValidate: { ticketDecide: true as const } };

describe("« quel ticket ? » decided by the model's own judgement", () => {
  it("exactly one open ticket the same (another partial): off asks the team, on links it", async () => {
    const tickets = [ticket("301"), ticket("302")], relations = { "301": "same", "302": "partial" };
    expect((await plan("support", tickets, relations, true)).decision.disposition.kind).toBe("collect_context");
    expect((await plan("support", tickets, relations, true, decide)).decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "link", ticketId: "301" } });
  });
  it("every ticket different but the comparison left incomplete: off waits, on creates a new ticket", async () => {
    const tickets = [ticket("301"), ticket("302")], relations = { "301": "different", "302": "different" };
    expect((await plan("support", tickets, relations, false)).decision.disposition.kind).toBe("collect_context");
    expect((await plan("support", tickets, relations, false, decide)).decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "create" } });
  });
  it("several plausible candidates stay for the team", async () => {
    const twoSame = await plan("support", [ticket("301"), ticket("302")], { "301": "same", "302": "same" }, true, decide);
    expect(twoSame.progress).toMatchObject({ kind: "human_choice", questionCode: "equivalent_ticket_choice" });
    const twoPartial = await plan("support", [ticket("301"), ticket("302")], { "301": "partial", "302": "partial" }, true, decide);
    expect(twoPartial.progress).toMatchObject({ kind: "human_choice", questionCode: "equivalent_ticket_choice" });
  });
  it.each(["finance", "cancellation"])("%s: unchanged by the switch", async kind => {
    const tickets = [ticket("301"), ticket("302")], relations = { "301": "same", "302": "partial" };
    expect((await plan(kind, tickets, relations, true, decide)).decision).toEqual((await plan(kind, tickets, relations, true)).decision);
  });
  it("helper: a closed ticket judged the same never counts as the open one", () => {
    const a = { investigationComplete: false, tickets: [{ ticketId: "1", relation: "same" }, { ticketId: "2", relation: "partial" }] };
    expect(savIntakeDecideTicketChoice(a, () => "closed")).toBe(false);
    expect(a.tickets[1]!.relation).toBe("partial");
  });
});
