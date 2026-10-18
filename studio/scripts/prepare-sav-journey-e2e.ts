import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { savAgentRuns, savDecisions, savMailboxes, savMessages, savSyncState, savThreads } from "../src/db/schema";
import { savSemanticE2eProposal, SAV_SEMANTIC_E2E_BODY } from "../test/sav-semantic-e2e-fixture";
import { JOURNEY_KEY, JOURNEY_CASES, journeyId } from "../test/sav-journey-fixture";
const target = path.resolve(".e2e-journey-db");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== JOURNEY_KEY) throw new Error("JOURNEY_SYNTHETIC_TARGET_REQUIRED");
function encrypted(value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(JOURNEY_KEY).digest(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
const client = new PGlite(`file://${target}`, { extensions: { vector } }), db = drizzle(client);
const remote: { cases: Record<string, unknown>; tickets: Record<string, unknown>; notes: Record<string, unknown>; events: unknown[] } = { cases: {}, tickets: {}, notes: {}, events: [] };
try {
  const [mailbox] = await db.insert(savMailboxes).values({ email: "contact@limova.ai", active: true }).returning();
  await db.insert(savSyncState).values({ key: "sav-v0-cutover", status: "active", cursor: JSON.stringify({ receivedAfter: "2026-10-01T00:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: mailbox.email, deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" }) });
  for (const [index, key] of JOURNEY_CASES.entries()) {
    const receivedAt = "2026-10-02T12:00:00Z", email = `journey-${key}@example.invalid`, contactId = String(990001 + index), ticketId = String(991001 + index);
    const stage = key === "link" ? "1" : ["reopen", "successor"].includes(key) ? "4" : "2";
    const closedAt = stage === "4" ? key === "successor" ? "2026-09-01T00:00:00Z" : "2026-09-30T00:00:00Z" : null;
    const ticket = { id: ticketId, subject: "Échec export PDF fictif", description: "Export PDF fictif en panne", status: stage === "4" ? "closed" : "open", stageId: stage, pipelineId: "0", ownerId: "999201", ownerName: "Support Fictif", createdAt: "2026-09-01T00:00:00Z", closedAt, updatedAt: null };
    remote.cases[key] = { email, contactId, ticketId, receivedAt, fault: key === "retry" ? "403" : key === "uncertain" ? "timeout" : null };
    if (key !== "create") remote.tickets[ticketId] = { id: ticketId, properties: { subject: ticket.subject, content: ticket.description, hs_pipeline: "0", hs_pipeline_stage: stage, hubspot_owner_id: "999201", hs_last_closed_date: closedAt, createdate: ticket.createdAt }, associations: { contacts: { results: [{ id: contactId }] } } };
    const proposal = savSemanticE2eProposal();
    if (key !== "create") proposal.routing = { kind: "matched", ticketId, reason: "fixture_same_issue", contactId };
    const messageId = randomUUID(), threadId = journeyId(key);
    const context = { version: 1, messageId, collectedAt: receivedAt, customerIdentity: { kind: "sender", email }, crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId, identityCandidates: [], tickets: key === "create" ? [] : [ticket], routing: key === "create" ? { kind: "new", reason: "fixture", candidateIds: [] } : { kind: "matched", ticketId, reason: "fixture_same_issue", returnOperation: "reactivate" } } }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
    await db.insert(savThreads).values({ id: threadId, mailboxId: mailbox.id, gmailThreadId: `journey-${key}`, subject: `Recette ${key} export PDF`, customerEmail: email, hubspotTicketId: ["create", "link"].includes(key) ? null : ticketId, lastMessageAt: new Date(receivedAt) });
    await db.insert(savMessages).values({ id: messageId, mailboxId: mailbox.id, threadId, gmailMessageId: `journey-message-${key}`, direction: "inbound", fromEmail: email, toEmails: [mailbox.email], subject: `Recette ${key} export PDF`, bodyCiphertext: encrypted({ text: SAV_SEMANTIC_E2E_BODY, headers: { "message-id": `<journey-${key}@example.invalid>` }, supportContext: context }), receivedAt: new Date(receivedAt), analysisStatus: "done", processedAt: new Date(receivedAt) });
    const [run] = await db.insert(savAgentRuns).values({ messageId, runtime: "synthetic_fixture", mode: "off", status: "succeeded", model: "synthetic-only", promptRevision: "synthetic-only", dataOrigin: "test", inputHash: "fixture", proposalCiphertext: encrypted(proposal), completedAt: new Date(receivedAt) }).returning();
    await db.insert(savDecisions).values({ messageId, agentRunId: run.id, kind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 0 });
  }
  writeFileSync(path.resolve(".e2e-journey-provider.json"), JSON.stringify(remote));
  writeFileSync(path.resolve(".e2e-journey-blocked.log"), "");
} finally { await client.close(); }
