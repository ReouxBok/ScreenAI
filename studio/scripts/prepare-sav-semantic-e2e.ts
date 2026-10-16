import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { savAgentRuns, savDecisions, savMailboxes, savMessages, savSyncState, savThreads } from "../src/db/schema";
import { SAV_SEMANTIC_E2E_BODY, SAV_SEMANTIC_E2E_KEY, SAV_SEMANTIC_E2E_THREAD, savSemanticE2eProposal } from "../test/sav-semantic-e2e-fixture";

const target = path.resolve(process.env.STUDIO_E2E_DB_DIR ?? ".e2e-db");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV_SEMANTIC_E2E_KEY) throw new Error("LOCAL_SYNTHETIC_E2E_CONFIGURATION_REQUIRED");
// Mirrors the existing v1 payload format without loading a server-only module in the seed process.
function encryptFixture(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SAV_SEMANTIC_E2E_KEY, "utf8").digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
const client = new PGlite(`file://${target}`, { extensions: { vector } });
const db = drizzle(client);
try {
  const [mailbox] = await db.insert(savMailboxes).values({ email: "fixture-mailbox@example.invalid", active: true }).returning();
  await db.insert(savSyncState).values({ key: "sav-v0-cutover", status: "active", cursor: JSON.stringify({ receivedAfter: "2026-10-01T00:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" }) });
  const proposal = savSemanticE2eProposal();
  const [thread] = await db.insert(savThreads).values({ id: SAV_SEMANTIC_E2E_THREAD, mailboxId: mailbox.id, gmailThreadId: "synthetic-sav44-thread", subject: "E2E — export PDF fictif", customerEmail: "fixture-customer@example.invalid", lastMessageAt: new Date("2026-10-02T12:00:00Z") }).returning();
  const messageId = randomUUID();
  // This scenario isolates dossier/draft verdict independence with a complete
  // local CRM snapshot. The V0 inbox scenario covers unavailable CRM instead.
  // No provider is called; preview preparation still requires its own preflight.
  const supportContext = { version: 1, messageId, collectedAt: "2026-10-02T12:00:00Z", customerIdentity: { kind: "sender", email: thread.customerEmail },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "999001", identityCandidates: [], tickets: [
      { id: "999101", subject: "Connexion VPN fictive", description: "Cas synthétique", status: "open", stageId: "2", pipelineId: "0", ownerName: "Support fixture", ownerId: "999201", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z" },
      { id: "999102", subject: "Facture fictive", description: "Cas synthétique", status: "open", stageId: "1", pipelineId: "0", ownerName: "Comptabilité fixture", ownerId: "999202", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z" },
      { id: "999103", subject: "Export PDF fictif fermé", description: "Cas synthétique", status: "closed", stageId: "4", pipelineId: "0", ownerName: "Support fixture", ownerId: "999201", createdAt: "2026-09-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" },
    ], routing: { kind: "new", reason: "no_open_ticket", candidateIds: [] } } },
    conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
  const [message] = await db.insert(savMessages).values({ id: messageId, mailboxId: mailbox.id, threadId: thread.id, gmailMessageId: "synthetic-sav44-message", direction: "inbound", fromEmail: thread.customerEmail, toEmails: [mailbox.email], subject: thread.subject, bodyCiphertext: encryptFixture({ text: SAV_SEMANTIC_E2E_BODY, supportContext }), receivedAt: new Date("2026-10-02T12:00:00Z"), analysisStatus: "done", processedAt: new Date("2026-10-02T12:00:01Z") }).returning();
  const [run] = await db.insert(savAgentRuns).values({ messageId: message.id, runtime: "synthetic_fixture", mode: "off", status: "succeeded", model: "synthetic-e2e-model", promptRevision: "synthetic-e2e-prompt", codeRevision: "a".repeat(40), dataOrigin: "test", inputHash: "synthetic-input", proposalCiphertext: encryptFixture(proposal), completedAt: new Date("2026-10-02T12:00:01Z") }).returning();
  await db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "human_review_required", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 0, model: "synthetic-e2e-model" });
  console.log("SAV semantic E2E fixture ready (synthetic local data only).");
} finally { await client.close(); }
