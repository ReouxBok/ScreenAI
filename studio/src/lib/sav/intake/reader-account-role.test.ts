/** SAV-46 R1: a written, quoted address is located, never proven to be the customer's own Limova
 * account. Both readers through the REAL engine with a scripted model and a synthetic CRM: the
 * canonical analysis, the CRM reads and the plan the executor would receive. Synthetic only. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeContact, IntakePlan, MessageAnalysis, ReadResult } from "./engine-types";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import { createSavIntakeSimpleReaders, memoizeIntakeCrmReaders } from "./simple-readers";
import { encodeSimpleWireFixture } from "./simple-wire.fixture";
import type { SimpleWireReferences } from "./simple-wire";

const at = "2026-10-31T10:00:00.000Z";
const mid = "10000000-0000-4000-8000-000000000001", initialMid = "10000000-0000-4000-8000-000000000009", tid = "20000000-0000-4000-8000-000000000001";
const SENDER = "unknown@sender.test";
const resource = { resourceId: "synthetic-private-resource", revisionId: "fixture-v1", sha256: "0".repeat(64) };
const warning = "SYNTHETIC MULTIPLE OPEN TICKETS WARNING";
const read = <T>(data: T): ReadResult<T> => ({ status: "complete", data, observedAt: at, reconstructedAsOf: at });
const policy: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [{ typeId: 449, category: "HUBSPOT_DEFINED" }],
  resources: { identification: resource, registrationNotFound: resource, multiTicketWarning: { ...resource, text: warning, sha256: createHash("sha256").update(warning).digest("hex") } } };
const RESOURCE_CONTACT: IntakeContact = { id: "555", emails: ["resource@connector.test"] };
const ACCOUNT_CONTACT: IntakeContact = { id: "301", emails: ["account@customer.test"] };
const MAILBOX_CONTACT: IntakeContact = { id: "302", emails: ["mailbox@connector.test"] };
const SENDER_CONTACT: IntakeContact = { id: "101", emails: [SENDER] };

type Reader = "current" | "simple";
type Data = { citationCatalogue?: { id: string; sourceId: string }[]; outputReferences?: SimpleWireReferences; contacts?: { contactId: string }[] };
function bench(reader: Reader, text: string, contacts: IntakeContact[], lookup: (email: string) => ReadResult<IntakeContact[]> = email => read(contacts.filter(c => c.emails.includes(email)))) {
  const crmCalls: string[] = [], traces: IntakeModelTrace[] = [];
  const crm = {
    findContactsByEmail: async (email: string) => { crmCalls.push(`lookup:${email}`); return lookup(email); },
    directAssociations: async (id: string) => { crmCalls.push(`associations:${id}`); return read([]); },
    getContact: async (id: string) => { crmCalls.push(`contact:${id}`); return read(contacts.find(c => c.id === id)!); },
    ticketsForContact: async (id: string) => { crmCalls.push(`tickets:${id}`); return read([]); },
    ticketHistory: async (id: string) => { crmCalls.push(`history:${id}`); return read([]); },
  } satisfies Pick<IntakeAdapters, "findContactsByEmail" | "directAssociations" | "getContact" | "ticketsForContact" | "ticketHistory">;
  const input: EngineInput = { message: { id: mid, threadId: tid, fromEmail: SENDER, toEmails: ["support@example.test"], currentText: text, contentComplete: true, direction: "inbound", receivedAt: at },
    conversation: read([]), latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: "fixture-attempt" };
  let registration: string | undefined;
  const call: IntakeGeminiCall = async request => {
    const data = JSON.parse(request.body.contents[0].parts[0].text) as Data;
    const answer = reader === "current"
      ? { messageId: mid, requests: [{ id: "r1", kind: "support", currentMessageId: mid, quoteId: data.citationCatalogue!.find(a => a.sourceId === "current")!.id }],
        ticketSummary: { title: "Connexion de la boîte Outlook", description: "Le client demande comment connecter une boîte.", requestIds: ["r1"] },
        ...(registration ? { registration: { address: registration, sourceMessageId: mid, quoteId: data.citationCatalogue!.find(a => a.sourceId === "current")!.id } } : {}) }
      : encodeSimpleWireFixture({ messageId: mid, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Comment connecter une boîte.", sourceIds: ["current"] }],
        ticketTitle: "Connexion de la boîte Outlook", identity: { kind: data.contacts!.length === 1 ? "unique" : "unknown", contactIds: data.contacts!.length === 1 ? [data.contacts![0].contactId] : [], why: "Adresse de l'expéditeur." },
        tickets: [], missing: [], rationale: "Question d'utilisation.", ...(registration ? { registration: { address: registration, quote: text } } : {}) }, data.outputReferences!);
    return { json: answer, metadata: { inputTokens: 100, outputTokens: 20, thoughtTokens: 0, totalTokens: 120 } };
  };
  const shared = memoizeIntakeCrmReaders(crm);
  const semantic = reader === "current"
    ? createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) })
    : createSavIntakeSimpleReaders({ model: "gemini-fixture", call, crm: shared, policy, onTrace: t => traces.push(t) });
  const run = (declared?: string) => { registration = declared; return planSavIntake(input, { ...shared, ...semantic }, policy); };
  return { run, crmCalls, traces };
}
const ticketOn = (plan: IntakePlan) => plan.decision.disposition.kind === "ticket" ? plan.decision.disposition.target.contactId : null;

describe.each<Reader>(["current", "simple"])("R1 %s reader: a written address is not the customer's account by itself", reader => {
  it("unknown sender asks how to connect a resource that has a CRM contact: no registration, sender identification, support", async () => {
    const b = bench(reader, "Bonjour, comment connecter resource@connector.test à Outlook pour retrouver mes factures ?", [RESOURCE_CONTACT]);
    const plan = await b.run("resource@connector.test");
    expect(plan.decision.classification).toBe("support");
    expect(plan.decision.disposition).toMatchObject({ kind: "request_identification", reason: "sender_contact_absent", template: { variant: "initial_registration_request" } });
    expect(plan.steps.map(s => s.mutation)).toEqual(["send_identity_template"]);
    expect(b.crmCalls).not.toContain("lookup:resource@connector.test");
    expect(b.crmCalls.some(c => c.endsWith(":555"))).toBe(false);
    expect(b.traces.at(-1)).toMatchObject({ accepted: true, normalization: { discardedRegistrations: 1 } });
  });
  it("a resource equal to the sender is not a declaration by coincidence: the sender template, not the not-found variant", async () => {
    const plan = await bench(reader, `Comment connecter ${SENDER} à Outlook ?`, []).run(SENDER);
    expect(plan.decision.disposition).toMatchObject({ kind: "request_identification", reason: "sender_contact_absent", template: { variant: "initial_registration_request" } });
  });
  it.each([
    ["two resources", "Comment connecter resource@connector.test et mailbox@connector.test à Outlook ?", "mailbox@connector.test"],
    ["shared calendar", "Comment partager l'agenda de resource@connector.test avec mon compte ?", "resource@connector.test"],
    ["third party", "Mon collègue resource@connector.test doit accéder à mon compte.", "resource@connector.test"],
    ["negation", "Ce n'est pas mon compte Limova : resource@connector.test, je veux le connecter.", "resource@connector.test"],
    ["residual signature", "Merci pour votre aide.\nCordialement\nJean\nresource@connector.test", "resource@connector.test"],
    ["retracted after the address (FR)", "Mon compte Limova est resource@connector.test, mais ce n'est pas mon compte.", "resource@connector.test"],
    ["retracted after the address (EN)", "My Limova account is resource@connector.test, but this is not my account.", "resource@connector.test"],
    ["corrected to a colleague's account", "Mon compte Limova est resource@connector.test, non c'est le compte de mon collègue.", "resource@connector.test"],
    ["corrected to another address (FR)", "Mon compte Limova est resource@connector.test. Je me suis trompé, voici la bonne : account@customer.test.", "resource@connector.test"],
    ["corrected to another address (EN)", "My Limova account is resource@connector.test. My mistake, the correct one is account@customer.test.", "resource@connector.test"],
    ["two accounts in one message, the first chosen", "Mon compte Limova est resource@connector.test. Mon compte Limova est account@customer.test.", "resource@connector.test"],
    ["two accounts in one message, the second chosen", "My Limova account is resource@connector.test. My Limova account is account@customer.test.", "account@customer.test"],
    ["replaced by an explicit correction (FR)", "Mon compte Limova est resource@connector.test. Correction : account@customer.test est mon compte Limova.", "resource@connector.test"],
    ["replaced by another address (EN)", "My Limova account is resource@connector.test. Use account@customer.test instead.", "resource@connector.test"],
    ["the replacing address has no account statement of its own", "Mon compte Limova est resource@connector.test. Utilisez plutôt account@customer.test.", "account@customer.test"],
    ["the corrected address has no account statement of its own", "Mon compte Limova est resource@connector.test. Je me suis trompé, voici la bonne : account@customer.test.", "account@customer.test"],
  ])("%s: the address is never looked up as the account and no ticket lands on it", async (_, text, declared) => {
    const b = bench(reader, text, [RESOURCE_CONTACT, MAILBOX_CONTACT]);
    const plan = await b.run(declared);
    expect(b.crmCalls).not.toContain(`lookup:${declared}`);
    expect(plan.decision.disposition.kind).not.toBe("ticket");
    expect(plan.steps.every(s => s.mutation === "send_identity_template")).toBe(true);
  });
  it("a known sender asking to connect another mailbox keeps the sender's contact", async () => {
    const b = bench(reader, "Comment connecter mailbox@connector.test à Outlook ?", [SENDER_CONTACT, MAILBOX_CONTACT]);
    const plan = await b.run("mailbox@connector.test");
    expect(ticketOn(plan)).toBe("101");
    expect(plan.decision.disposition).toMatchObject({ identity: { addressOrigin: "sender" } });
    expect(b.crmCalls).not.toContain("lookup:mailbox@connector.test");
  });
  it("witness: an explicit Limova account different from the sender is still used", async () => {
    const b = bench(reader, "Mon compte Limova est account@customer.test. Comment connecter Outlook ?", [ACCOUNT_CONTACT]);
    const plan = await b.run("account@customer.test");
    expect(ticketOn(plan)).toBe("301");
    expect(plan.decision.disposition).toMatchObject({ identity: { addressOrigin: "customer_declared_registration", scope: "intake_only" } });
  });
  it.each([
    "Mon compte Limova est account@customer.test. Je ne connais pas mon identifiant.",
    "Mon compte Limova est account@customer.test. Mon collègue a un problème sur son compte.",
    "Mon compte Limova est account@customer.test, je ne connais pas mon identifiant.",
    "Mon compte Limova est account@customer.test. Je me suis trompé dans la configuration du calendrier.",
    "Mon compte Limova est account@customer.test. Erreur 500 sur la page des factures.",
    "Mon compte Limova est account@customer.test. Correction : le calendrier mailbox@connector.test doit être connecté.",
  ])("an independent later statement keeps the stated account: %s", async text => {
    const b = bench(reader, text, [ACCOUNT_CONTACT]);
    expect(ticketOn(await b.run("account@customer.test"))).toBe("301");
    expect(b.crmCalls).toContain("lookup:account@customer.test");
  });
  it("R7: a message admitting two accounts with no declaration from the reader is refused before any lookup, sender included", async () => {
    const b = bench(reader, "Mon compte Limova est resource@connector.test. Mon compte Limova est account@customer.test.", [SENDER_CONTACT, RESOURCE_CONTACT, ACCOUNT_CONTACT]);
    const plan = await b.run();
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["contact_lookup_incomplete"]) });
    // The simple reader reads the sender's context for its model before any decision (existing
    // design); the engine then refuses the identity: neither declared address is ever looked up.
    expect(b.crmCalls.filter(c => c.startsWith("lookup:"))).toEqual(reader === "simple" ? [`lookup:${SENDER}`] : []);
  });
  it("an explicitly restated account after a correction is used; the superseded one is never looked up", async () => {
    const b = bench(reader, "Mon compte Limova est resource@connector.test. Je me suis trompé, mon compte Limova est account@customer.test.", [RESOURCE_CONTACT, ACCOUNT_CONTACT]);
    expect(ticketOn(await b.run("account@customer.test"))).toBe("301");
    expect(b.crmCalls).not.toContain("lookup:resource@connector.test");
  });
  it("account and resource in the same sentence: the stated account is used, never the resource by neighbourhood", async () => {
    const text = "Mon compte Limova est account@customer.test et je veux connecter mailbox@connector.test à Outlook.";
    const good = bench(reader, text, [ACCOUNT_CONTACT, MAILBOX_CONTACT]);
    expect(ticketOn(await good.run("account@customer.test"))).toBe("301");
    const wrong = bench(reader, text, [ACCOUNT_CONTACT, MAILBOX_CONTACT]);
    const plan = await wrong.run("mailbox@connector.test");
    expect(wrong.crmCalls).not.toContain("lookup:mailbox@connector.test");
    expect(plan.steps).toEqual([]);
  });
});

/** Engine contract alone, whatever a reader (or an old cached analysis) returned. */
describe("R1 engine: the declared address must carry its account role", () => {
  function engine(text: string, registration: MessageAnalysis["registration"], contacts: IntakeContact[], options: { lookup?: ReadResult<IntakeContact[]>; continuation?: boolean; history?: string } = {}) {
    const calls: string[] = [];
    const initial = { id: initialMid, threadId: tid, fromEmail: SENDER, toEmails: ["support@example.test"], currentText: options.history ?? "Mon agenda ne se synchronise plus.", contentComplete: true, direction: "inbound" as const, receivedAt: "2026-10-30T10:00:00.000Z" };
    const message = { id: mid, threadId: tid, fromEmail: SENDER, toEmails: ["support@example.test"], currentText: text, contentComplete: true, direction: "inbound" as const, receivedAt: at };
    const input: EngineInput = { message, conversation: read(options.continuation || options.history ? [initial] : []), latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: "fixture-attempt",
      ...(options.continuation ? { identificationContinuation: { initialMessageId: initialMid, confirmedEffectId: "effect-1" }, previousIdentification: { messageId: initialMid, address: SENDER, state: "confirmed" as const } } : {}) };
    const analysis: MessageAnalysis = { messageId: mid, requests: [{ id: "r1", kind: "support", currentMessageId: mid, ...(options.continuation ? { originMessageId: initialMid } : {}) }],
      ticketSummary: { title: "Synchronisation de l'agenda", description: "Synthetic description", requestIds: ["r1"] }, ...(registration ? { registration } : {}) };
    const adapters: IntakeAdapters = {
      analyseMessage: async () => structuredClone(analysis),
      findContactsByEmail: async email => { calls.push(`lookup:${email}`); return options.lookup ?? read(contacts.filter(c => c.emails.includes(email))); },
      directAssociations: async () => read([]), getContact: async id => read(contacts.find(c => c.id === id)!),
      ticketsForContact: async () => read([]), ticketHistory: async () => read([]),
      assessIssues: async () => ({ investigationComplete: true, tickets: [] }),
    };
    return { run: () => planSavIntake(input, adapters, policy), calls };
  }
  it("a resource registration that reached the engine fails closed before any lookup of it", async () => {
    const text = "Comment connecter resource@connector.test à Outlook ?";
    const e = engine(text, { address: "resource@connector.test", sourceMessageId: mid, quote: text }, [RESOURCE_CONTACT]);
    expect((await e.run()).decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["contact_lookup_incomplete"]) });
    expect(e.calls).toEqual([]);
  });
  it("a server-verified continuation reply keeps the inherited request and the newly given address", async () => {
    const text = "Voici l'adresse : account@customer.test";
    const e = engine(text, { address: "account@customer.test", sourceMessageId: mid, quote: text }, [ACCOUNT_CONTACT], { continuation: true });
    const plan = await e.run();
    expect(ticketOn(plan)).toBe("301");
    expect(plan.decision.requests[0].evidenceIds).toContain("initial-request");
  });
  it("a statement retracted after the address fails closed before any lookup; another unretracted account stays usable", async () => {
    const retracted = "Mon compte Limova est resource@connector.test, mais ce n'est pas mon compte.";
    const e = engine(retracted, { address: "resource@connector.test", sourceMessageId: mid, quote: retracted }, [RESOURCE_CONTACT]);
    expect((await e.run()).decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["contact_lookup_incomplete"]) });
    expect(e.calls).toEqual([]);
    const both = "Mon compte Limova est account@customer.test et resource@connector.test n'est pas mon compte.";
    expect(ticketOn(await engine(both, { address: "account@customer.test", sourceMessageId: mid, quote: both }, [ACCOUNT_CONTACT, RESOURCE_CONTACT]).run())).toBe("301");
  });
  it("an address corrected right after it fails closed before any lookup; a mistake about something else keeps the account", async () => {
    const corrected = "Mon compte Limova est resource@connector.test. Je me suis trompé, voici la bonne : account@customer.test.";
    const e = engine(corrected, { address: "resource@connector.test", sourceMessageId: mid, quote: corrected }, [RESOURCE_CONTACT, ACCOUNT_CONTACT]);
    expect((await e.run()).decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["contact_lookup_incomplete"]) });
    expect(e.calls).toEqual([]);
    const unrelated = "Mon compte Limova est account@customer.test. Je me suis trompé dans la configuration du calendrier.";
    expect(ticketOn(await engine(unrelated, { address: "account@customer.test", sourceMessageId: mid, quote: unrelated }, [ACCOUNT_CONTACT]).run())).toBe("301");
  });
  it("an address explicitly replaced fails closed before any lookup; the replacing account with its own statement is used", async () => {
    const replaced = "Mon compte Limova est resource@connector.test. Utilisez plutôt account@customer.test.";
    const e = engine(replaced, { address: "resource@connector.test", sourceMessageId: mid, quote: replaced }, [RESOURCE_CONTACT, ACCOUNT_CONTACT]);
    expect((await e.run()).decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["contact_lookup_incomplete"]) });
    expect(e.calls).toEqual([]);
    const restated = "Mon compte Limova est resource@connector.test. Correction : account@customer.test est mon compte Limova.";
    const r = engine(restated, { address: "account@customer.test", sourceMessageId: mid, quote: restated }, [RESOURCE_CONTACT, ACCOUNT_CONTACT]);
    expect(ticketOn(await r.run())).toBe("301");
    expect(r.calls).not.toContain("lookup:resource@connector.test");
  });
  it("R7: a message admitting two accounts fails closed before any lookup, whichever the reader declared, none, or an earlier one", async () => {
    const text = "Mon compte Limova est resource@connector.test. Mon compte Limova est account@customer.test.", earlier = "Mon compte Limova est account@customer.test.";
    const refused = async (e: ReturnType<typeof engine>) => {
      expect((await e.run()).decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["contact_lookup_incomplete"]) });
      expect(e.calls).toEqual([]);
    };
    for (const address of ["resource@connector.test", "account@customer.test"])
      await refused(engine(text, { address, sourceMessageId: mid, quote: text }, [RESOURCE_CONTACT, ACCOUNT_CONTACT]));
    await refused(engine(text, undefined, [SENDER_CONTACT, RESOURCE_CONTACT, ACCOUNT_CONTACT]));
    await refused(engine(text, { address: "account@customer.test", sourceMessageId: initialMid, quote: earlier }, [ACCOUNT_CONTACT], { history: earlier }));
    // Witness: the same earlier declaration with an unambiguous current message is used.
    expect(ticketOn(await engine("Merci de votre aide.", { address: "account@customer.test", sourceMessageId: initialMid, quote: earlier }, [ACCOUNT_CONTACT], { history: earlier }).run())).toBe("301");
  });
  it("a negated continuation reply is not a current declaration", async () => {
    const text = "Ce n'est pas account@customer.test";
    const e = engine(text, { address: "account@customer.test", sourceMessageId: mid, quote: text }, [ACCOUNT_CONTACT], { continuation: true });
    expect((await e.run()).steps).toEqual([]);
    expect(e.calls).toEqual([]);
  });
  it.each([
    ["partial", { status: "partial", data: [ACCOUNT_CONTACT], observedAt: at, reconstructedAsOf: at } as ReadResult<IntakeContact[]>, "contact_lookup_incomplete"],
    ["failed", { status: "failed", data: null, observedAt: at } as unknown as ReadResult<IntakeContact[]>, "contact_lookup_failed"],
    ["ambiguous", read([ACCOUNT_CONTACT, { id: "303", emails: ["account@customer.test"] }]), "contact_ambiguous"],
  ])("a %s lookup of a stated account stays visible and writes nothing", async (_, lookup, reason) => {
    const text = "Mon compte Limova est account@customer.test.";
    const plan = await engine(text, { address: "account@customer.test", sourceMessageId: mid, quote: text }, [ACCOUNT_CONTACT], { lookup }).run();
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining([reason]) });
    expect(plan.steps).toEqual([]);
  });
});
