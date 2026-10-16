import { describe, expect, it } from "vitest";
import { understandingFixture } from "../../../test/sav-understanding-fixtures";
import type { SavDossierContext } from "./dossier-context";
import { compactSavModelContext, SAV_COMPACT_CONTEXT_LIMITS } from "./compact-model-context";

function input() {
  const understanding = understandingFixture({
    knownFacts: [{ id: "url", key: "site_url", text: "URL fournie : https://site.example.invalid/page", evidenceIds: ["evidence-1"] }],
    attemptedSteps: [{ id: "attempt", key: "diagnostic", text: "Contrôle fictif déjà tenté sans résultat", evidenceIds: ["evidence-1"] }],
    missingInformation: [{ id: "missing", key: "diagnostic_result", text: "Résultat exact manquant", requestIds: ["request-1"] }],
  });
  const dossier: SavDossierContext = { version: 1, messageId: "message-current", collectedAt: "2026-10-15T12:00:00Z",
    customerIdentity: { kind: "sender", email: "person@example.invalid" },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "contact-internal", identityCandidates: [],
      tickets: [{ id: "old-same-issue", subject: "Ancien incident fictif", description: "Description source", status: "closed", pipelineId: "0", stageId: "4", createdAt: "2025-01-01", closedAt: "2025-02-01", updatedAt: null }],
      routing: { kind: "matched", ticketId: "old-same-issue", reason: "same_issue", returnOperation: "create" } } },
    conversation: { threadId: "thread", currentMessageId: "message-current", hubspotTicketId: null, status: "new", aiPaused: false, senderMatchesCustomer: true,
      messages: [{ id: "prior-answer", direction: "inbound", from: "person@example.invalid", receivedAt: "2026-10-14T12:00:00Z", text: "J’ai déjà donné mon URL.", truncated: false }], olderSummary: [], historyTruncated: false, attachmentNotice: "Pièces jointes non lues." },
    conversationError: null, otherConversations: [], otherConversationsError: null };
  return { current: { messageId: "message-current", sourceId: "current_body", receivedAt: "2026-10-15T12:00:00Z", subject: "Demande fictive", text: "L’agent téléphone cesse de répondre." }, expectedCustomerEmail: "person@example.invalid", understanding, dossier };
}
describe("SAV72 compact model context", () => {
  it("preserves all current requests, facts, failed attempts, missing keys and exact provenance", () => {
    const source = input(), before = JSON.stringify(source);
    const result = compactSavModelContext(source);
    expect(result.status).toBe("ready");
    expect(result.payload?.understanding).toMatchObject({ requests: source.understanding.requests, knownFacts: source.understanding.knownFacts,
      attemptedSteps: source.understanding.attemptedSteps, missingInformation: source.understanding.missingInformation, evidence: source.understanding.evidence });
    expect(result.payload?.history[0]).toMatchObject({ sourceId: "message:prior-answer", receivedAt: "2026-10-14T12:00:00Z" });
    expect(result.payload?.crm.tickets[0].id).toBe("old-same-issue"); // Old closed same-issue tickets remain relevant.
    expect(JSON.stringify(source)).toBe(before);
  });
  it("does not inject arbitrary CRM/action fields or other conversation candidates", () => {
    const source = input();
    Object.assign(source.dossier.crm.data!, { secretContactProperties: "PRIVATE_EXTRA_FIELD", actionPayload: "PRIVATE_EXTRA_ACTION" });
    source.dossier.otherConversations.push({ id: "other", subject: "Autre sujet", relation: "same_sender", messages: [{ from: "p@example.invalid", direction: "inbound", text: "PRIVATE_OTHER_CONVERSATION", receivedAt: "2026-10-14" }] });
    const result = compactSavModelContext(source), serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_EXTRA"); expect(serialized).not.toContain("PRIVATE_OTHER");
    expect(result.limitations).toContain("other_conversation_candidates_not_injected");
  });
  it("keeps CRM failure compatible with a product clarification context", () => {
    const source = input(); source.dossier.crm = { status: "error", data: null, errorCode: "FIXTURE_CRM_UNAVAILABLE" };
    const result = compactSavModelContext(source);
    expect(result.status).toBe("limited"); expect(result.payload?.understanding.missingInformation).toHaveLength(1);
    expect(result.payload?.crm).toMatchObject({ status: "error", tickets: [] });
  });
  it.each(["identity", "message"])("refuses a stale %s dossier as CRM evidence", kind => {
    const source = input(); source.understanding.evidence[0].source = "crm";
    if (kind === "identity") source.dossier.customerIdentity.email = "colleague@example.invalid";
    else source.dossier.messageId = "previous-message";
    const result = compactSavModelContext(source);
    expect(result.status).toBe("blocked"); expect(result.payload).toBeNull();
  });
  it("does not inject a forwarding colleague's historical thread", () => {
    const source = input(); source.dossier.customerIdentity.kind = "forwarded";
    source.dossier.conversation!.messages[0].text = "FORWARDING_COLLEAGUE_HISTORY";
    const result = compactSavModelContext(source);
    expect(result.payload?.history).toEqual([]); expect(result.limitations).toContain("history_identity_unconfirmed");
    expect(JSON.stringify(result)).not.toContain("FORWARDING_COLLEAGUE_HISTORY");
  });
  it("reports optional truncation while keeping source IDs, dates and critical facts intact", () => {
    const source = input();
    source.dossier.crm.data!.tickets[0].description = "é".repeat(20_000);
    source.dossier.conversation!.messages = Array.from({ length: 20 }, (_, i) => ({ id: `history-${i}`, direction: "inbound", from: "person@example.invalid", receivedAt: "2026-10-14T12:00:00Z", text: "é".repeat(3_000), truncated: false }));
    const result = compactSavModelContext(source);
    expect(result.status).toBe("limited"); expect(result.limitations).toContain("history_incomplete");
    expect(result.payload?.crm.tickets[0].description.truncated).toBe(true);
    expect(result.payload?.history.length).toBeLessThanOrEqual(6);
    expect(result.payload?.understanding.requests).toEqual(source.understanding.requests);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(SAV_COMPACT_CONTEXT_LIMITS.bytes);
  });
  it("blocks oversized current input or critical proof rather than silently losing a request", () => {
    const source = input(); source.current.text = "é".repeat(10_000);
    expect(compactSavModelContext(source)).toMatchObject({ status: "blocked", payload: null, omittedRequestIds: ["request-1"] });
    source.current.text = "Message court";
    source.understanding.knownFacts = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, key: `key${i}`, text: "Fait prouvé ".repeat(100), evidenceIds: ["evidence-1"] }));
    expect(compactSavModelContext(source).limitations).toContain("critical_facts_or_evidence_over_budget");
  });
});
