import { describe, expect, it, vi } from "vitest";
import { intakeEvidenceCatalogue, IntakeEvidenceError } from "./model-evidence";
import { normalizeSavEvidenceText } from "../evidence-text";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import { planSavIntake } from "./engine";
import type { IntakeAdapters } from "./engine-types";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";

const at = "2026-10-21T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001", tid = "20000000-0000-4000-8000-000000000001";
const message = { id: mid, threadId: tid, receivedAt: at, fromEmail: "sender@example.test", toEmails: ["support@example.test"],
  direction: "inbound" as const, currentText: "Mon intégration déjà configurée ne synchronise plus.", contentComplete: true };
const signal = () => new AbortController().signal;
type Data = { citationCatalogue: { id: string; sourceId: string; text: string }[] };
const data = (arg: Parameters<IntakeGeminiCall>[0]) => JSON.parse(arg.body.contents[0].parts[0].text) as Data;
const anchor = (arg: Parameters<IntakeGeminiCall>[0], source = "current") => data(arg).citationCatalogue.find(a => a.sourceId === source)!.id;
const result = (json: unknown) => ({ json, metadata: { inputTokens: 10, outputTokens: 10, thoughtTokens: 0, totalTokens: 20 } });
const request = (arg: Parameters<IntakeGeminiCall>[0], kind = "support") => ({ messageId: mid,
  requests: [{ id: "r0", kind, currentMessageId: mid, quoteId: anchor(arg) }],
  ticketSummary: { title: "Synchronisation interrompue", description: data(arg).citationCatalogue.filter(a => a.sourceId === "current").map(a => a.text).join(" "), requestIds: ["r0"] } });
const ticket = { id: "201", contactIds: ["101"], stage: "new" as const, createdAt: at, ownerId: null, subject: "Synchronisation", content: "Une erreur bloque la synchronisation." };
const history = [{ id: "note-301", kind: "note" as const, at, text: "La configuration a été vérifiée." }];
const issueInput = { message, requests: [{ id: "r0", kind: "support" as const, currentMessageId: mid }], tickets: [{ ticket, history }],
  evidence: ["current", "ticket-201", "history-201"].map(id => ({ id, sourceId: id, observedAt: at, contentHash: "a".repeat(43), source: "crm_ticket" as const })) };

describe("source-bound citation producer; existing containment stays authoritative", () => {
  it("preserves the entire text, including facts at the end, without summarizing", () => {
    const text = Array.from({ length: 180 }, (_, i) => `Fait ${i} : valeur exacte ${i}.`).join("\n\n");
    const c = intakeEvidenceCatalogue(new Map([["current", text]]));
    expect(c.entries.length).toBeGreaterThan(1);
    expect(normalizeSavEvidenceText(c.entries.map(e => e.text).join(" "))).toBe(normalizeSavEvidenceText(text));
    expect(c.entries.at(-1)!.text).toContain("Fait 179");
    expect(c.entries.every(e => e.text.length <= 1800)).toBe(true);
  });
  it("rejects unrepresentable context instead of silently truncating a source", () => {
    expect(() => intakeEvidenceCatalogue(new Map([["current", "x".repeat(2001)]]))).toThrow("CONTEXT_LIMIT");
  });
  it.each(["unbroken", "too_many_spans", "missing_current"])("traces catalogue %s before any provider call without leaking source content", async failure => {
    const traces: IntakeModelTrace[] = [], call = vi.fn<IntakeGeminiCall>();
    const text = failure === "unbroken" ? "private".repeat(300) : failure === "too_many_spans" ? "private ".repeat(60_000) : " ";
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) });
    await expect(model.analyseMessage({ message: { ...message, currentText: text },
      conversation: failure === "missing_current" ? [{ ...message, id: tid }] : [] }, signal())).rejects.toThrow("CONTEXT_LIMIT");
    expect(call).not.toHaveBeenCalled();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ phase: "understanding", accepted: false, errorCode: "SAV_INTAKE_MODEL_CONTEXT_LIMIT",
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), contextLimit: { stage: "catalogue", bytes: expect.any(Number) } });
    expect(JSON.stringify(traces)).not.toContain("private");
  });
  it("never turns a foreign or unknown anchor into a valid current quote", () => {
    const c = intakeEvidenceCatalogue(new Map([["current", "Un problème actuel."], ["other", "Une ancienne demande."]]));
    for (const quoteId of ["unknown", c.entries[1].id]) {
      expect(() => c.decodeAnalysis({ requests: [{ quoteId }] }, mid)).toThrow(IntakeEvidenceError);
    }
  });
  it("rejects ambiguous quote+quoteId output and never overwrites a provider quote", () => {
    const c = intakeEvidenceCatalogue(new Map([["current", message.currentText]]));
    expect(() => c.decodeAnalysis({ requests: [{ quoteId: "q1", quote: "invented" }] }, mid)).toThrow("CITATION_REJECTED");
  });
  it("accepts a selected literal span and constrains source/message identifiers in the generated schema", async () => {
    let observed: Parameters<IntakeGeminiCall>[0] | undefined;
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", call: async arg => { observed = arg; return result(request(arg)); } });
    expect(await model.analyseMessage({ message, conversation: [] }, signal())).toMatchObject({ messageId: mid, requests: [{ currentMessageId: mid, kind: "support" }] });
    const schema = observed!.body.generationConfig.responseSchema as { properties: Record<string, unknown> };
    expect(schema.properties.messageId).toMatchObject({ enum: [mid] });
    expect(JSON.stringify(schema)).toContain('"quoteId"');
    expect(observed!.allowRetry).toBe(false); expect(observed!.body).not.toHaveProperty("tools");
  });
  it("still rejects a false UUID despite a valid anchor, with a bounded private diagnostic", async () => {
    const traces: IntakeModelTrace[] = [];
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", onTrace: t => traces.push(t),
      call: async arg => result({ ...request(arg), messageId: tid }) });
    await expect(model.analyseMessage({ message, conversation: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
    expect(traces[0].validationFailure).toEqual({ reason: "message_id_mismatch", path: "messageId" });
  });
  it("keeps legacy literal validation and rejects paraphrases without echoing client text", async () => {
    const traces: IntakeModelTrace[] = [];
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", onTrace: t => traces.push(t), call: async () => result({ messageId: mid,
      requests: [{ id: "r0", kind: "support", currentMessageId: mid, quote: "Le client demande un dépannage confidentiel." }] }) });
    await expect(model.analyseMessage({ message, conversation: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
    expect(traces[0].validationFailure).toMatchObject({ reason: "excerpt_not_in_source", path: "requests.0.quote", excerptHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(traces)).not.toContain("confidentiel"); expect(JSON.stringify(traces)).not.toContain(message.currentText);
  });
  it("requires all ticket and nonempty history sources even when anchor syntax is valid", async () => {
    const traces: IntakeModelTrace[] = [];
    const make = (includeHistory: boolean): IntakeGeminiCall => async arg => result({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"],
      evidenceIds: ["current", "ticket-201", "history-201"], rationale: "Sources concordantes", grounding: ["current", "ticket-201", ...(includeHistory ? ["history-201"] : [])].map(s => ({ quoteId: anchor(arg, s) })) }] });
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", onTrace: t => traces.push(t), call: make(false) });
    await expect(model.assessIssues(issueInput, signal())).rejects.toThrow("CITATION_REJECTED");
    expect(traces[0].validationFailure?.reason).toBe("required_source_missing");
    await expect(createSavIntakeSemanticReaders({ model: "gemini-fixture", call: make(true) }).assessIssues(issueInput, signal())).resolves.toMatchObject({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same" }] });
  });
  it("rejects a claimed source different from the anchor's own source", async () => {
    const traces: IntakeModelTrace[] = [];
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", onTrace: t => traces.push(t), call: async arg => result({ investigationComplete: true,
      tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"], evidenceIds: ["current"], rationale: "Untrusted", grounding: [{ quoteId: anchor(arg), sourceId: "ticket-201" }] }] }) });
    await expect(model.assessIssues(issueInput, signal())).rejects.toThrow("CITATION_REJECTED");
    expect(traces[0].validationFailure?.reason).toBe("wrong_anchor_source");
  });
  it("retains every candidate in comparative identity grounding", async () => {
    const candidates = ["101", "102"].map(id => ({ contact: { id, emails: [message.fromEmail] }, tickets: [{ ticket: { ...ticket, id: `2${id}`, contactIds: [id] }, history }] }));
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", call: async arg => result({ kind: "unique", investigationComplete: true, contactIds: ["101"],
      evidenceIds: ["current"], rationale: "Comparaison", grounding: data(arg).citationCatalogue.filter(a => a.sourceId !== "contact-102").map(a => ({ quoteId: a.id })) }) });
    await expect(model.assessIdentity!({ message, address: message.fromEmail, candidates, evidence: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
  });
  it("keeps registration attributed to the current sender and the actual declared address", async () => {
    const other = { ...message, id: tid, direction: "outbound" as const, currentText: "L'adresse d'inscription est other@example.test." };
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", call: async arg => result({ ...request(arg),
      registration: { address: "other@example.test", sourceMessageId: other.id, quoteId: anchor(arg, `message-${other.id}`) } }) });
    await expect(model.analyseMessage({ message, conversation: [other] }, signal())).rejects.toThrow("CITATION_REJECTED");
  });
  it("does not call or retry the provider after cancellation", async () => {
    const provider = vi.fn<IntakeGeminiCall>(async arg => result(request(arg)));
    const controller = new AbortController(); controller.abort();
    await expect(createSavIntakeSemanticReaders({ model: "gemini-fixture", call: provider }).analyseMessage({ message, conversation: [] }, controller.signal)).rejects.toThrow("CANCELLED");
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("complete long histories within the bounded intake envelope", () => {
  const answer: IntakeGeminiCall = async arg => result({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"],
    evidenceIds: ["current", "ticket-201", "history-201"], rationale: "Sources concordantes", grounding: ["current", "ticket-201", "history-201"].map(s => ({ quoteId: anchor(arg, s) })) }] });
  const withHistory = (text: string) => ({ ...issueInput, tickets: [{ ticket, history: [{ ...history[0], text }] }] });
  it("delivers every history span beyond the former 40 KB ceiling, including the final fact", async () => {
    const text = Array.from({ length: 1200 }, (_, i) => `Fait ${i} : configuration vérifiée, résultat exact ${i}.`).join("\n");
    let sent: Parameters<IntakeGeminiCall>[0] | undefined;
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", call: async arg => { sent = arg; return answer(arg); } });
    await expect(model.assessIssues(withHistory(text), signal())).resolves.toMatchObject({ tickets: [{ relation: "same" }] });
    expect(Buffer.byteLength(sent!.body.contents[0].parts[0].text)).toBeGreaterThan(40_000);
    const complete = data(sent!).citationCatalogue.filter(a => a.sourceId === "history-201").map(a => a.text).join(" ");
    expect(normalizeSavEvidenceText(complete)).toBe(normalizeSavEvidenceText(`[note-301 ${at} note] ${text}`));
    expect(complete).toContain("résultat exact 1199");
  });
  // Size the actual JSON envelope, including UTF-8, escaping and catalogue IDs.
  function bytesFor(text: string) {
    const { currentText, ...metadata } = message; void currentText;
    const { subject, content, ...ticketFields } = ticket;
    return Buffer.byteLength(JSON.stringify({ message: { ...metadata, textSourceId: "current" }, requests: issueInput.requests,
      tickets: [{ ticket: { ...ticketFields, textSourceId: "ticket-201", historySourceId: "history-201" }, historyEntries: 1 }], evidence: issueInput.evidence,
      citationCatalogue: intakeEvidenceCatalogue(new Map([["current", message.currentText], ["ticket-201", `${subject}\n${content}`], ["history-201", `[note-301 ${at} note] ${text}`]])).entries }));
  }
  const prefix = 'é😀 "citation" \\ chemin\n';
  function atSize(target: number) {
    let size = 90_000;
    for (let i = 0; i < 10; i++) {
      const text = prefix + "x ".repeat(Math.floor((size - 2) / 2)) + (size % 2 ? "xxx" : "xx");
      const delta = target - bytesFor(text);
      if (!delta) return text;
      size += delta;
    }
    throw Error("FIXTURE_EXACT_SIZE_REQUIRED");
  }
  it.each([-1, 0, 1])("enforces the 96 KiB data boundary %+d before dispatch", async delta => {
    const traces: IntakeModelTrace[] = [], call = vi.fn<IntakeGeminiCall>(answer);
    const text = atSize(SAV_INTAKE_MODEL_LIMITS.dataBytes + delta);
    const model = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) });
    if (delta <= 0) {
      await expect(model.assessIssues(withHistory(text), signal())).resolves.toMatchObject({ tickets: [{ relation: "same" }] });
      expect(call).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(call.mock.calls[0][0].body.contents[0].parts[0].text)).toBe(SAV_INTAKE_MODEL_LIMITS.dataBytes + delta);
    } else {
      await expect(model.assessIssues(withHistory(text), signal())).rejects.toThrow("CONTEXT_LIMIT");
      expect(call).not.toHaveBeenCalled();
      expect(traces[0].contextLimit).toEqual({ stage: "data", bytes: SAV_INTAKE_MODEL_LIMITS.dataBytes + 1, limitBytes: SAV_INTAKE_MODEL_LIMITS.dataBytes });
      expect(JSON.stringify(traces)).not.toContain("citation");
    }
  });
});

describe("commercial/support prompt contract and inert routing with a synthetic provider", () => {
  const readers: Pick<IntakeAdapters, "findContactsByEmail" | "getContact" | "directAssociations" | "ticketsForContact" | "ticketHistory"> = {
    findContactsByEmail: async () => ({ status: "complete", data: [{ id: "101", emails: [message.fromEmail] }], observedAt: at }),
    getContact: async () => ({ status: "complete", data: { id: "101", emails: [message.fromEmail] }, observedAt: at }),
    directAssociations: async () => ({ status: "complete", data: [], observedAt: at }), ticketsForContact: async () => ({ status: "complete", data: [], observedAt: at }),
    ticketHistory: async () => ({ status: "complete", data: [], observedAt: at }),
  };
  it.each([
    ["Votre outil pourrait-il fonctionner avec mon logiciel métier avant mon inscription ?", "commercial", "no_ticket"],
    ["Mon intégration déjà configurée ne synchronise plus.", "support", "ticket"],
    ["Comment ajouter des crédits téléphoniques dans mon espace ?", "support", "ticket"],
    ["Je demande le remboursement de ma facture.", "finance", "ticket"],
  ])("keeps declared %s routing supervised/inert (%s)", async (text, kind, disposition) => {
    let instruction = "";
    const models = createSavIntakeSemanticReaders({ model: "gemini-fixture", call: async arg => { instruction = arg.body.systemInstruction.parts[0].text; return result(request(arg, kind)); } });
    const plan = await planSavIntake({ message: { ...message, currentText: text }, latestInboundMessageId: mid, conversation: { status: "complete", data: [], observedAt: at }, now: at, mode: "current", identificationAttemptId: "synthetic" },
      { ...readers, ...models }, { relationRevision: "synthetic", admittedRelations: [], resources: { commercial: { resourceId: "fixture-commercial", revisionId: "fixture-v1", sha256: "a".repeat(64) } } });
    expect(plan.decision.classification).toBe(kind); expect(plan.decision.disposition.kind).toBe(disposition);
    expect(plan.effects).toBe("not_connected"); expect(plan.steps.every(s => s.status === "not_dispatched")).toBe(true);
    if (kind === "commercial") expect(plan.steps).toEqual([]);
    expect(instruction).toContain("pre-use or purchase/compatibility inquiry");
    expect(instruction).toContain("a contact record alone does not prove active usage");
    expect(instruction).toContain("Neither the word compatible nor a CRM status alone determines");
    expect(instruction).toContain("language of the current authored message");
  });
});
