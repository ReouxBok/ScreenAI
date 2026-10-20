import { describe, expect, it, vi } from "vitest";
import { createSavIntakeHubspotReaders, isSavIntakeHubspotRead } from "./hubspot-readers";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import { prepareSavIntakeMessage } from "./message";
import { evaluateSavIntakeReadOnly, type EvaluationCase, type EvaluationGrant } from "./evaluation";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy } from "./engine-types";

const at = "2026-10-20T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001", thread = "20000000-0000-4000-8000-000000000001";
const signal = () => new AbortController().signal;
const msg = { id: mid, threadId: thread, receivedAt: at, fromEmail: "sender@example.test", toEmails: ["support@example.test"], direction: "inbound" as const, currentText: "Please investigate my upload", contentComplete: true };
const row = (id = "101", email = "sender@example.test", aliases: string | null = null) => ({ id, properties: { email, hs_additional_emails: aliases } });
const pipeline = { id: "0", stages: ["1", "2", "3", "4"].map(id => ({ id, metadata: { isClosed: id === "4" ? "true" : "false" } })) };
const edge = (id = "102", typeId = 449, category = "HUBSPOT_DEFINED") => ({ toObjectId: id, associationTypes: [{ typeId, category, label: null }] });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function crm(handler?: (url: URL, body: Record<string, unknown> | null) => unknown) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null; redirect?: RequestRedirect }[] = [];
  const network = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body, redirect: init?.redirect });
    const custom = handler?.(url, body); if (custom instanceof Response) return custom;
    if (custom !== undefined) return response(custom);
    if (url.pathname.endsWith("/contacts/search")) return response({ results: [row()], total: 1 });
    if (url.pathname.endsWith("/pipelines/tickets/0")) return response(pipeline);
    if (url.pathname.endsWith("/batch/read")) return response({ status: "COMPLETE", results: [] });
    return response({ results: [] });
  }) as typeof fetch;
  return { network, calls, readers: createSavIntakeHubspotReaders({ network, now: () => new Date(at) }) };
}
const analysis = () => ({ messageId: mid, requests: [{ id: "r0", kind: "support", currentMessageId: mid, quote: msg.currentText }],
  ticketSummary: { title: "Upload issue", description: msg.currentText, requestIds: ["r0"] } });
const call = (json: unknown): IntakeGeminiCall => async () => ({ json, metadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
const input = (): EngineInput => ({ message: msg, latestInboundMessageId: mid, conversation: { status: "complete", data: [], observedAt: at }, now: at, mode: "current", identificationAttemptId: "attempt" });
const policy: EnginePolicy = { relationRevision: "fixture-policy", admittedRelations: [{ typeId: 449, category: "HUBSPOT_DEFINED" }], resources: {} };

describe("isolated real-reader protocol with synthetic HTTP", () => {
  it.each(["PATCH", "PUT", "DELETE", "POST"])("rejects %s to a contact and never dispatches it", method => {
    expect(isSavIntakeHubspotRead("/crm/v3/objects/contacts/101", method)).toBe(method === "GET");
  });
  it.each(["//evil.test/crm/v3/objects/contacts/101", "/crm/v3/objects/contacts/101?redirect=evil", "/crm/v3/objects/contacts/%2e%2e", "/crm/v3/objects/tickets", "/crm/v4/objects/tickets/101/associations/default/contacts/102"])("rejects an unapproved endpoint %s", path => {
    expect(isSavIntakeHubspotRead(path, "GET")).toBe(false); expect(isSavIntakeHubspotRead(path, "POST")).toBe(false);
  });
  it("reads both primary and secondary searches and confirms exact alias membership", async () => {
    const f = crm(() => ({ results: [row("101", "primary@example.test", "unrelated@example.test;sender@example.test"), row("102", "prefixsender@example.test")], total: 2 }));
    expect(await f.readers.findContactsByEmail("sender@example.test", signal())).toMatchObject({ status: "complete", data: [{ id: "101", emails: ["primary@example.test", "sender@example.test", "unrelated@example.test"] }] });
    expect(f.calls).toHaveLength(2); expect(f.calls[1].body?.query).toBe("sender@example.test"); expect(f.calls.every(c => c.redirect === "error")).toBe(true);
  });
  it("follows all contact search pages rather than concluding absence after page one", async () => {
    const f = crm((_, body) => body?.after ? { results: [row()], total: 1 } : { results: [], paging: { next: { after: "next" } } });
    expect((await f.readers.findContactsByEmail("sender@example.test", signal())).status).toBe("complete"); expect(f.calls).toHaveLength(4);
  });
  it("returns partial on missing pagination or repeated cursors", async () => {
    for (const data of [{ results: [], total: 1 }, { results: [], paging: { next: { after: "same" } } }]) {
      const f = crm(() => data); expect((await f.readers.findContactsByEmail("sender@example.test", signal())).status).toBe("partial");
    }
  });
  it("does not turn a permission error, malformed response or cancellation into absence", async () => {
    for (const value of [response({}, 403), { unexpected: true }]) {
      const f = crm(() => value); expect((await f.readers.findContactsByEmail("sender@example.test", signal())).status).toBe("failed");
    }
    const f = crm(), controller = new AbortController(); controller.abort();
    expect((await f.readers.findContactsByEmail("sender@example.test", controller.signal)).status).toBe("failed"); expect(f.calls).toHaveLength(0);
  });
  it("retries a transient 429 under the existing transport and keeps the read-only method", async () => {
    let attempts = 0; const f = crm(() => ++attempts === 1 ? response({}, 429) : { results: [], total: 0 });
    expect((await f.readers.findContactsByEmail("sender@example.test", signal())).status).toBe("complete"); expect(f.calls).toHaveLength(3);
    expect(f.calls.every(c => c.method === "POST" && c.path.endsWith("/contacts/search"))).toBe(true);
  });
  it("preserves association direction, type and category without walking another contact", async () => {
    const f = crm(() => ({ results: [edge("102"), edge("103", 17, "USER_DEFINED")] }));
    expect((await f.readers.directAssociations("101", signal())).data).toEqual([
      { fromContactId: "101", toContactId: "102", typeId: 449, category: "HUBSPOT_DEFINED" },
      { fromContactId: "101", toContactId: "103", typeId: 17, category: "USER_DEFINED" },
    ]); expect(f.calls).toHaveLength(1);
  });
  it("reads ticket membership separately and retains an explicitly unassigned owner", async () => {
    const f = crm(url => {
      if (url.pathname === "/crm/v4/objects/contacts/101/associations/tickets") return { results: [edge("201")] };
      if (url.pathname === "/crm/v4/objects/tickets/201/associations/contacts") return { results: [edge("101"), edge("102")] };
      if (url.pathname.endsWith("/tickets/batch/read")) return { status: "COMPLETE", results: [{ id: "201", properties: { subject: "Upload", content: "Full content", createdate: at, hs_pipeline: "0", hs_pipeline_stage: "1", hubspot_owner_id: null } }] };
    });
    expect(await f.readers.ticketsForContact("101", signal())).toMatchObject({ status: "complete", data: [{ id: "201", contactIds: ["101", "102"], stage: "new", ownerId: null }] });
  });
  it("marks a missing batch item or membership as partial", async () => {
    const f = crm(url => url.pathname.includes("associations/tickets") ? { results: [edge("201")] } : undefined);
    expect((await f.readers.ticketsForContact("101", signal())).status).toBe("partial");
  });
  it("does not attest historical reconstruction from a current CRM response", async () => {
    const f = crm(); expect((await f.readers.findContactsByEmail("sender@example.test", signal())).reconstructedAsOf).toBeUndefined();
  });
  it("bounds internal network requests even when the caller has another engine allowance", async () => {
    const f = crm(), readers = createSavIntakeHubspotReaders({ network: f.network, maxNetworkRequests: 1 });
    expect((await readers.findContactsByEmail("sender@example.test", signal())).status).not.toBe("complete"); expect(f.calls).toHaveLength(1);
  });
  it("requires nonempty known date/body source fields in every history batch", async () => {
    const f = crm(url => url.pathname.endsWith("/associations/notes") ? { results: [edge("301")] }
      : url.pathname.endsWith("/notes/batch/read") ? { status: "COMPLETE", results: [{ id: "301", properties: { hs_timestamp: at } }] } : undefined);
    expect((await f.readers.ticketHistory("201", signal())).status).toBe("partial");
  });
});

describe("semantic adapter grounding and message provenance", () => {
  it("keeps quotes and signatures out of the current authored request", () => {
    const p = prepareSavIntakeMessage({ ...msg, subject: "Re: old refund", body: "Thanks, it works\n--\nBilling Person\nOn Tuesday wrote:\nRefund please", bodyComplete: true, unresolvedAttachments: false });
    expect(p.message.currentText).toBe("Thanks, it works"); expect(p.provenance.subjectInherited).toBe(true); expect(p.provenance.quotedText).toContain("Refund please");
    expect(prepareSavIntakeMessage({ ...msg, subject: "Upload", body: msg.currentText, bodyComplete: true, unresolvedAttachments: true }).message.contentComplete).toBe(false);
  });
  it("rejects a request quoted only from old history or another participant", async () => {
    const raw = analysis(); raw.requests[0].quote = "Refund please";
    await expect(createSavIntakeSemanticReaders({ model: "gemini-configured", call: call(raw) }).analyseMessage({ message: msg, conversation: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
  });
  it("accepts only the configured model, no tools or retry, and a grounded structured request", async () => {
    const observed: Parameters<IntakeGeminiCall>[0][] = [];
    const model = createSavIntakeSemanticReaders({ model: "gemini-configured", call: async arg => { observed.push(arg); return call(analysis())(arg); } });
    expect((await model.analyseMessage({ message: msg, conversation: [] }, signal())).requests).toEqual([{ id: "r0", kind: "support", currentMessageId: mid }]);
    expect(observed[0].model).toBe("gemini-configured"); expect(observed[0].allowRetry).toBe(false); expect(observed[0].body).not.toHaveProperty("tools");
  });
  it("does not manufacture an acknowledgement when the provider refuses or returns invalid JSON", async () => {
    const f = crm(), models = createSavIntakeSemanticReaders({ model: "gemini-configured", call: call({ refusal: true }) });
    const p = await planSavIntake(input(), { ...f.readers, ...models }, policy);
    expect(p.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["classification_incomplete"]) }); expect(p.steps).toEqual([]);
  });
  it("requires grounded ticket/history excerpts, not just valid evidence identifiers", async () => {
    const model = createSavIntakeSemanticReaders({ model: "gemini-configured", call: call({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"], evidenceIds: ["current", "ticket-201", "history-201"], rationale: "same", grounding: [{ sourceId: "current", quote: msg.currentText }] }] }) });
    await expect(model.assessIssues({ message: msg, requests: [], tickets: [{ ticket: { id: "201", contactIds: ["101"], stage: "new", subject: "Upload", content: "Full content" }, history: [{ id: "note", kind: "note", at, text: "Already investigated" }] }], evidence: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
  });
  it("does not call the provider for a cancelled or oversized context", async () => {
    const fn = vi.fn(call(analysis())), model = createSavIntakeSemanticReaders({ model: "gemini-configured", call: fn });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(model.analyseMessage({ message: msg, conversation: [] }, cancelled.signal)).rejects.toThrow("CANCELLED");
    await expect(model.analyseMessage({ message: { ...msg, currentText: "x".repeat(50_000) }, conversation: [] }, signal())).rejects.toThrow("CONTEXT_LIMIT"); expect(fn).not.toHaveBeenCalled();
  });
  it("uses an explicit live read clock without backdating source observations", async () => {
    const later = "2026-10-20T10:00:01.000Z", f = crm();
    const readers = createSavIntakeHubspotReaders({ network: f.network, now: () => new Date(later) });
    const models = createSavIntakeSemanticReaders({ model: "gemini-configured", call: call(analysis()) });
    const p = await planSavIntake(input(), { ...readers, ...models }, policy, {}, () => new Date(later));
    expect(p.decision.disposition.kind).toBe("ticket"); expect(p.decision.evidence.find(e => e.id === "email-lookup")?.observedAt).toBe(later);
  });
});

describe("bounded evaluation, with no operational writer", () => {
  const item = (): EvaluationCase => ({ caseId: "SYN-1", clientGroup: "synthetic-client", input: input(), policy,
    reference: { classification: "support", contactId: "101", action: "create", sourceState: "current", qualifiedDimensions: ["classification", "contact", "action"] } });
  const grant: EvaluationGrant = { corpusManifestSha256: "a".repeat(64), referenceManifestSha256: "b".repeat(64), model: "gemini-configured", existingApprovalReference: "fixture-only", remainingNanoUsd: 10, maxReservedNanoUsdPerCall: 1, maxCases: 40, maxCallsPerCase: 6 };
  const options = () => ({ cases: [item()], corpusManifestSha256: grant.corpusManifestSha256, referenceManifestSha256: grant.referenceManifestSha256,
    configuredModel: grant.model, grant, network: crm().network, call: call(analysis()), withExistingAiBudget: async <T>(work: () => Promise<T>) => work(), now: () => new Date(at) });
  it("fails admission before network/model when existing total budget or access is missing", async () => {
    const f = options(), network = vi.fn(f.network), model = vi.fn(f.call);
    expect((await evaluateSavIntakeReadOnly({ ...f, grant: null, network, call: model })).stopReason).toBe("MODEL_ACCESS_OR_EXISTING_TOTAL_BUDGET_MISSING"); expect(network).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  });
  it("refuses a mismatched reference manifest or provider configuration", async () => {
    expect((await evaluateSavIntakeReadOnly({ ...options(), configuredModel: "gemini-other" })).stopReason).toBe("CONFIGURATION_OR_REFERENCE_MISMATCH");
  });
  it("runs an injected pure decision and scores only independently qualified dimensions", async () => {
    const result = await evaluateSavIntakeReadOnly(options());
    expect(result.stopReason).toBeNull(); expect(result.modelCalls).toBe(1); expect(result.effects).toBe("none");
    expect(result.records[0].dimensions).toEqual({ classification: true, contact: true, action: true }); expect(result.records[0].dimensions).not.toHaveProperty("ticket");
  });
  it("stops after the three-case pilot on a reference disagreement", async () => {
    const f = options(); f.cases = Array.from({ length: 4 }, (_, i) => ({ ...item(), caseId: `SYN-${i}`, reference: { ...item().reference, classification: "finance" } }));
    const result = await evaluateSavIntakeReadOnly(f); expect(result.records).toHaveLength(3); expect(result.stopReason).toBe("PILOT_REQUIRES_REVIEW"); expect(result.independentClientGroups).toBe(1);
  });
  it("keeps unknown usage reserved and blocks the next case at the existing ceiling", async () => {
    const f = options(); f.grant = { ...grant, remainingNanoUsd: 1 }; f.cases.push({ ...item(), caseId: "SYN-2" });
    const result = await evaluateSavIntakeReadOnly(f); expect(result.modelCalls).toBe(1); expect(result.reservedNanoUsd).toBe(1); expect(result.records[1].traces[0].errorCode).toBe("SAV_INTAKE_EVALUATION_BUDGET_EXHAUSTED");
    expect(result.stopReason).toBe("EXISTING_TOTAL_BUDGET_EXHAUSTED");
  });
});
