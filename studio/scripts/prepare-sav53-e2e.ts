import { createCipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { savAgentRuns, savDecisions, savMailboxes, savMessages, savSyncState, savThreads } from "../src/db/schema";
import { SAV53_BODY, SAV53_CURRENT, SAV53_E2E_KEY, SAV53_PARTNERSHIP, SAV53_RECEIVED_AT, SAV53_SUBJECT, SAV53_THREADS, SAV53_TICKET_TITLE, sav53Proposal } from "../test/sav53-e2e-fixture";

const target = path.resolve(process.env.STUDIO_E2E_DB_DIR ?? ".e2e-db");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV53_E2E_KEY || process.env.SAV_WRITES_DISABLED !== "true") throw new Error("LOCAL_SYNTHETIC_E2E_CONFIGURATION_REQUIRED");
function encrypt(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SAV53_E2E_KEY).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
const client = new PGlite(`file://${target}`, { extensions: { vector } });
const db = drizzle(client);
try {
  const [mailbox] = await db.insert(savMailboxes).values({ email: "contact@limova.ai", active: true }).returning();
  await db.insert(savSyncState).values({ key: "sav-v0-cutover", status: "active", cursor: JSON.stringify({ receivedAfter: "2026-10-01T00:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: mailbox.email, deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" }) });
  for (const [kind, threadId] of Object.entries(SAV53_THREADS)) {
    const partnership = kind === "partnership";
    const subject = partnership ? "Proposition de partenariat fictive" : kind === "failed" ? "Re: Re: Assistance téléphonie fictive" : SAV53_SUBJECT;
    const email = `${kind}@example.invalid`;
    const [thread] = await db.insert(savThreads).values({ id: threadId, mailboxId: mailbox.id, gmailThreadId: `synthetic-sav53-${kind}`, subject, customerEmail: email, lastMessageAt: new Date(SAV53_RECEIVED_AT) }).returning();
    const messageId = threadId.replace("-8000-", "-9000-");
    const stage = kind === "waiting" ? "2" : kind === "alreadyNew" ? "1" : "4";
    const hasTicket = ["reopen", "waiting", "successor", "alreadyNew"].includes(kind);
    const ticket = { id: `9953${Object.keys(SAV53_THREADS).indexOf(kind)}`, subject: SAV53_TICKET_TITLE, description: "Ticket fictif de recette", pipelineId: "0", stageId: stage, ownerId: "995300", status: stage === "4" ? "closed" : "open", createdAt: "2026-09-01T12:00:00Z", closedAt: kind === "successor" ? "2026-09-16T12:00:00Z" : kind === "reopen" ? "2026-09-17T12:00:00Z" : null, updatedAt: "2026-09-30T12:00:00Z" };
    const body = partnership ? SAV53_PARTNERSHIP : ["conversation", "singleQuoted"].includes(kind) ? SAV53_BODY : SAV53_CURRENT;
    const supportContext = { version: 1, messageId, collectedAt: SAV53_RECEIVED_AT, customerIdentity: { kind: "sender", email },
      crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "995301", identityCandidates: [], tickets: hasTicket ? [ticket] : [], routing: hasTicket ? { kind: "matched", ticketId: ticket.id, reason: "exact_subject" } : { kind: "new", reason: "no_open_ticket", candidateIds: [] } } },
      conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
    const [message] = await db.insert(savMessages).values({ id: messageId, mailboxId: mailbox.id, threadId: thread.id, gmailMessageId: `synthetic-sav53-${kind}-latest`, direction: "inbound", fromEmail: email, toEmails: [mailbox.email], subject,
      bodyCiphertext: encrypt({ text: body, headers: { "message-id": `<synthetic-sav53-${kind}@example.invalid>` }, supportContext, ...(kind === "conversation" ? { attachments: [{ filename: "capture-fictive.txt", mimeType: "text/plain", size: 10 }] } : {}) }),
      receivedAt: new Date(SAV53_RECEIVED_AT), analysisStatus: kind === "failed" ? "failed" : "done", analysisErrorCode: kind === "failed" ? "SAV_AI_TIMEOUT" : null, processedAt: kind === "failed" ? null : new Date("2026-10-02T12:00:01Z") }).returning();
    if (kind === "conversation") {
      await db.insert(savMessages).values([
        { mailboxId: mailbox.id, threadId, gmailMessageId: "synthetic-sav53-old-inbound", direction: "inbound", fromEmail: email, toEmails: [mailbox.email], subject, bodyCiphertext: encrypt({ text: "Ancien email entrant conservé intégralement." }), receivedAt: new Date("2026-10-02T10:00:00Z"), analysisStatus: "done" },
        { mailboxId: mailbox.id, threadId, gmailMessageId: "synthetic-sav53-newer-outbound", direction: "outbound", fromEmail: mailbox.email, toEmails: [email], subject, bodyCiphertext: encrypt({ text: "Réponse sortante plus récente, masquée au départ." }), receivedAt: new Date("2026-10-02T13:00:00Z"), analysisStatus: "done" },
      ]);
    }
    if (kind === "failed") continue;
    const proposal = sav53Proposal(partnership);
    const [run] = await db.insert(savAgentRuns).values({ messageId: message.id, runtime: "synthetic_fixture", mode: "off", status: "succeeded", model: "synthetic-sav53-model", promptRevision: "synthetic-sav53-prompt", codeRevision: "a".repeat(40), dataOrigin: "test", inputHash: "synthetic-sav53-input", proposalCiphertext: encrypt(proposal), completedAt: new Date("2026-10-02T12:00:01Z") }).returning();
    await db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "human_review_required", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 0, model: "synthetic-sav53-model" });
  }
  console.log("SAV-53 fixture ready: nine synthetic local dossiers, no provider access.");
} finally { await client.close(); }
