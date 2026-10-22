import path from "node:path";
import { writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { savMailboxes, savThreads, savMessages, savSyncState, savAgentRuns, savDecisions } from "../src/db/schema";
import { encryptSavPayload } from "../src/lib/sav/crypto";
import { SAV83_E2E_KEY, SAV83_THREAD, SAV83_MESSAGE, SAV83_ATTACHMENTS, SAV83_UNREAD_THREAD, SAV83_UNREAD_MESSAGE, sav83Read } from "../test/sav83-e2e-fixture";
const target = path.resolve(".e2e-sav83-db");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV83_E2E_KEY) throw new Error("SAV83_SYNTHETIC_TARGET_REQUIRED");
const client = new PGlite(target, { extensions: { vector } }), db = drizzle(client);
try {
  const [mailbox] = await db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await db.insert(savSyncState).values({ key: "sav-v0-cutover", status: "active", cursor: JSON.stringify({ receivedAfter: "2026-10-18T00:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: mailbox.email, deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" }) });
  await db.insert(savThreads).values({ id: SAV83_THREAD, mailboxId: mailbox.id, gmailThreadId: "sav83-synthetic-thread", subject: "Capture et erreur de démonstration", customerEmail: "fixture@example.invalid", status: "human_requested", aiPaused: true, lastMessageAt: new Date("2026-10-19T08:00:00Z") });
  const supportContext = { version: 1, messageId: SAV83_MESSAGE, collectedAt: new Date().toISOString(), customerIdentity: { kind: "sender", email: "fixture@example.invalid" }, crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: false, tickets: [], routing: { kind: "new", reason: "fixture", candidateIds: [] } } }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
  await db.insert(savMessages).values({ id: SAV83_MESSAGE, mailboxId: mailbox.id, threadId: SAV83_THREAD, gmailMessageId: "sav83-synthetic-message", direction: "inbound", fromEmail: "fixture@example.invalid", subject: "Capture et erreur de démonstration",
    bodyCiphertext: encryptSavPayload({ text: "Mon connecteur ne fonctionne plus. Une capture est jointe.", attachments: SAV83_ATTACHMENTS, attachmentInventory: { complete: false, limits: ["depth_limit"] }, attachmentRead: sav83Read(mailbox.id), supportContext }), receivedAt: new Date("2026-10-19T08:00:00Z"), analysisStatus: "done", processedAt: new Date() });
  const proposal = { schemaVersion: 1, category: "technical", urgency: "normal", decision: { kind: "human_review_required", reasonCode: "fixture", explanation: "Dossier entièrement synthétique à vérifier.", confidence: 0 }, routing: { kind: "review", reason: "fixture", candidateIds: [] }, ticket: { title: "Capture et erreur de démonstration", description: "Données fictives." }, process: [{ kind: "human_review", label: "Vérifier la capture synthétique.", sourceIds: [] }], internalNote: "Aucun fournisseur réel.", replyDraft: null, sources: [], knowledgeRevision: "not_consulted", model: "synthetic-only" };
  const [run] = await db.insert(savAgentRuns).values({ messageId: SAV83_MESSAGE, runtime: "synthetic_fixture", mode: "off", status: "succeeded", model: "synthetic-only", promptRevision: "synthetic-only", dataOrigin: "test", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
  await db.insert(savDecisions).values({ messageId: SAV83_MESSAGE, agentRunId: run.id, kind: "human_review_required", reasonCode: "fixture", explanation: "Vérifier les observations fictives.", confidence: 0 });
  await db.insert(savThreads).values({ id: SAV83_UNREAD_THREAD, mailboxId: mailbox.id, gmailThreadId: "sav83-unread-thread", subject: "Capture non lue de démonstration", customerEmail: "fixture@example.invalid", status: "human_requested", aiPaused: true, lastMessageAt: new Date("2026-10-19T08:01:00Z") });
  await db.insert(savMessages).values({ id: SAV83_UNREAD_MESSAGE, mailboxId: mailbox.id, threadId: SAV83_UNREAD_THREAD, gmailMessageId: "sav83-unread-message", direction: "inbound", fromEmail: "fixture@example.invalid", subject: "Capture non lue de démonstration",
    bodyCiphertext: encryptSavPayload({ text: "Capture fictive à ne pas lire à l’ouverture.", supportContext: { ...supportContext, messageId: SAV83_UNREAD_MESSAGE }, attachments: [{ ...SAV83_ATTACHMENTS[0], reference: { version: 1, mailboxEmail: mailbox.email, gmailMessageId: "sav83-unread-message", gmailThreadId: "sav83-unread-thread", partId: "1", attachmentId: "sav83-unread-file", contentId: null, disposition: "attachment" } }] }),
    receivedAt: new Date("2026-10-19T08:01:00Z"), analysisStatus: "processing", analysisStartedAt: new Date(), processedAt: null });
  writeFileSync(path.resolve(".e2e-sav83-network.log"), "");
} finally { await client.close(); }
