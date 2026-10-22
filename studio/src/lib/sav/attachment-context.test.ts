import { afterEach, expect, it, vi } from "vitest";
import { attachmentMessageId, observedAttachment } from "../../../test/sav-attachments";
import { geminiFixture, understandingContent, understandingFixture } from "../../../test/sav-understanding-fixtures";
import { savUnderstandingSources, understandSavMessage } from "./understanding-model";
import { validateSavUnderstanding } from "./understanding";
import { planSavRequests } from "./request-planner";
import { defaultSavPlaybook } from "./playbook-contract";
import { compactSavModelContext } from "./compact-model-context";
import { savAttachmentContext } from "./attachment-context";
import { savAttachmentDisplayRead } from "./attachment-contract";
import type { SavDossierContext } from "./dossier-context";
const dossier: SavDossierContext = { version: 1, messageId: attachmentMessageId, collectedAt: new Date(0).toISOString(), customerIdentity: { kind: "sender", email: "fixture@example.invalid" }, crm: { status: "error", data: null, errorCode: "fixture" }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
function input() { return { subject: "Téléphone", body: "L’agent téléphone cesse de répondre.", dossierContext: dossier, attachmentRead: observedAttachment() }; }
function candidate() {
  const value = understandingContent(), observation = observedAttachment().observations[0];
  value.evidence.push({ id: "image-proof", source: "current_attachment", sourceId: observation.sourceId, excerpt: "Erreur E42." });
  value.knownFacts.push({ id: "image-fact", key: "error_message", requestIds: ["request-1"], text: "Erreur E42.", evidenceIds: ["image-proof"] });
  return value;
}
afterEach(() => vi.unstubAllEnvs());
it("projects expired or invalid claims as uncertain without a mutation or owner identifiers", () => {
  const read = observedAttachment(); read.state = "reading";
  expect(savAttachmentDisplayRead(read, 1)?.observations[0].reason).toBe("in_progress");
  const expired = savAttachmentDisplayRead(read, 120_000)!;
  expect(expired.observations[0]).toMatchObject({ reason: "outcome_uncertain", status: "not_read", text: "" });
  expect(expired).not.toHaveProperty("claimId"); expect(expired).not.toHaveProperty("gmailMessageId");
  expect(read.observations[0].text).toContain("E42");
  read.startedAt = "invalid";
  expect(savAttachmentDisplayRead(read, 1)?.observations[0].reason).toBe("outcome_uncertain");
});
it("uses the error absent from the mail with explicit image provenance and avoids asking it again", async () => {
  const network = vi.fn<typeof fetch>(async () => geminiFixture(candidate()));
  const result = await understandSavMessage(input(), { apiKey: "fixture", fetch: network });
  expect(result.knownFacts).toContainEqual(expect.objectContaining({ key: "error_message", text: "Erreur E42." }));
  const sources = savUnderstandingSources(input()).sources;
  expect(sources.find(s => s.sourceId === "current_body")!.text).not.toContain("E42");
  expect(sources.find(s => s.source === "current_attachment")!.text).toContain("E42");
  const book = { versionId: "fixture-book", version: 1, document: { ...defaultSavPlaybook, facts: defaultSavPlaybook.facts.map(f => f.key === "error_message" ? { ...f, question: "Quel message d’erreur apparaît ?" } : f) } };
  const plans = planSavRequests(result, { contractRevision: "fixture", revision: "fixture", sources: [], alerts: [], requests: [{ requestId: "request-1", status: "no_source", candidateKeys: [], limitations: [] }], metrics: { attempts: 1, queryCount: 1, embeddingBatchesUpperBound: 1, serializedBytes: 0, contextTextTokensUpperBound: 0 } }, book);
  expect(plans[0].missingFacts.some(f => f.key === "error_message")).toBe(false);
});
it("keeps the same visual observations in a citation repair without performing another image call", async () => {
  const bad = candidate(); bad.evidence[1].excerpt = "Erreur reformulée non visible";
  const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(bad)).mockResolvedValueOnce(geminiFixture(candidate()));
  const result = await understandSavMessage(input(), { apiKey: "fixture", fetch: network });
  expect(result.trace.validationRepair?.succeeded).toBe(true); expect(network).toHaveBeenCalledTimes(2);
  for (const call of network.mock.calls) {
    const body = JSON.parse(String(call[1]!.body));
    expect(body.contents[0].parts).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toContain("current_attachment");
    expect(body.contents[0].parts[0].text).toContain("Erreur E42.");
  }
});
it("cannot manufacture a current request or customer relationship from a screenshot alone", () => {
  const value = candidate(), sources = savUnderstandingSources(input()).sources;
  value.requests[0].evidenceIds = ["image-proof"];
  expect(() => validateSavUnderstanding(value, sources)).toThrow();
  value.requests[0].evidenceIds = ["evidence-1"];
  value.customerRelationship = { kind: "existing_customer", evidenceIds: ["image-proof"] };
  expect(() => validateSavUnderstanding(value, sources)).toThrow();
});
it("does not turn an observed screen into a customer attempt, while preserving visual facts", () => {
  const value = candidate();
  const attempt = { id: "image-attempt", key: "reconnect", text: "Le client a tenté de reconnecter le service.", requestIds: ["request-1"], evidenceIds: ["image-proof"], checkId: null, checkCardId: null, checkVersionId: null, outcome: "unknown" as const };
  value.attemptedSteps = [attempt];
  expect(() => validateSavUnderstanding(value, savUnderstandingSources(input()).sources)).toThrow();
  const customer = { ...input(), body: input().body + " J’ai essayé de reconnecter le service." };
  value.evidence.push({ id: "customer-attempt", source: "current_message", sourceId: "current_body", excerpt: "J’ai essayé de reconnecter le service." });
  value.attemptedSteps = [{ ...attempt, evidenceIds: ["customer-attempt"] }];
  const validated = validateSavUnderstanding(value, savUnderstandingSources(customer).sources);
  expect(validated.attemptedSteps).toHaveLength(1);
  expect(validated.knownFacts.some(fact => fact.evidenceIds.includes("image-proof"))).toBe(true);
});
it("excludes unreadable, stale-owner or in-progress observations and preserves the mail", () => {
  const value = input(); value.attachmentRead.observations[0].status = "unreadable";
  expect(savUnderstandingSources(value).sources.some(s => s.source === "current_attachment")).toBe(false);
  expect(savUnderstandingSources(value).sources[0].text).toBe(value.body);
  expect(savAttachmentContext(observedAttachment(), "different-message").sources).toEqual([]);
  value.attachmentRead.state = "reading";
  expect(savUnderstandingSources(value).sources.some(s => s.source === "current_attachment")).toBe(false);
});
it("preserves referenced visual evidence in compact context and blocks a missing source", () => {
  const understanding = understandingFixture(candidate());
  const current = { messageId: attachmentMessageId, sourceId: "current_body", receivedAt: new Date(0).toISOString(), text: input().body };
  const result = compactSavModelContext({ current, expectedCustomerEmail: "fixture@example.invalid", understanding, dossier, attachmentRead: observedAttachment() });
  expect(result.status).not.toBe("blocked"); expect(result.payload?.understanding.evidence.some(e => e.source === "current_attachment")).toBe(true);
  expect(compactSavModelContext({ current, expectedCustomerEmail: "fixture@example.invalid", understanding, dossier }).limitations).toContain("attachment_source_unavailable");
});

it("preserves incomplete inventory in understanding and compact context even with no acquired image", () => {
  const inventory = { complete: false, limits: ["node_limit"] as ["node_limit"] };
  const value = { ...input(), attachmentRead: null, attachmentInventory: inventory };
  const sources = savUnderstandingSources(value);
  expect(sources.attachments.inventory).toEqual(inventory);
  expect(sources.attachments.notice).toContain("Inventaire incomplet");
  expect(sources.truncated).toBe(true);
  expect(sources.sources.some(source => source.source === "current_attachment")).toBe(false);
  const result = compactSavModelContext({ current: { messageId: attachmentMessageId, sourceId: "current_body", receivedAt: new Date(0).toISOString(), text: value.body }, expectedCustomerEmail: "fixture@example.invalid", understanding: understandingFixture(), dossier, attachmentInventory: inventory });
  expect(result.payload?.attachments?.inventory).toEqual(inventory);
  expect(result.payload?.attachments?.notice).toContain("nombre et leur contenu restent inconnus");
});
