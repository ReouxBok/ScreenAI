import { createCipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { auditLogs, savActions, savAgentRuns, savDecisions, savDraftVerdicts, savLearningCandidates, savMailboxes, savMessages, savObservationCycles, savProposalReviews, savResolutionObservations, savThreads } from "../src/db/schema";
import { SAV55_E2E_KEY, SAV55_SUBJECTS, SAV55_THREADS, sav55Proposal } from "../test/sav55-e2e-fixture";

const target = path.resolve(process.env.STUDIO_E2E_DB_DIR ?? ".e2e-db-sav55");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV55_E2E_KEY || process.env.SAV_WRITES_DISABLED !== "true") throw new Error("LOCAL_SYNTHETIC_E2E_CONFIGURATION_REQUIRED");
function encrypt(value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SAV55_E2E_KEY).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
const client = new PGlite(`file://${target}`, { extensions: { vector } });
const db = drizzle(client);
try {
  const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.email, "contact@limova.ai"));
  if (!mailbox) throw new Error("SAV53_SYNTHETIC_FIXTURE_REQUIRED_FIRST");
  for (const [kind, threadId] of Object.entries(SAV55_THREADS) as Array<[keyof typeof SAV55_THREADS, string]>) {
    const index = Object.keys(SAV55_THREADS).indexOf(kind), receivedAt = new Date(Date.parse("2026-10-14T09:00:00Z") + index * 60_000);
    const messageId = threadId.replace("-8000-", "-9000-"), email = `sav55-${kind.toLowerCase()}@example.invalid`, subject = SAV55_SUBJECTS[kind];
    const confirmed = ["qualification", "ticketConfirmed"].includes(kind), approved = !["unopened", "unreadReturn", "review"].includes(kind);
    const [thread] = await db.insert(savThreads).values({ id: threadId, mailboxId: mailbox.id, gmailThreadId: `synthetic-sav55-${kind}`, customerEmail: email, subject, hubspotTicketId: confirmed ? `9955${index}` : null, lastMessageAt: receivedAt }).returning();
    const proposal = sav55Proposal(kind);
    await db.insert(savMessages).values({ id: messageId, mailboxId: mailbox.id, threadId, gmailMessageId: `synthetic-sav55-${kind}-latest`, direction: "inbound", fromEmail: email, toEmails: [mailbox.email], subject,
      bodyCiphertext: encrypt({ text: "Nouvelle demande fictive à vérifier. Aucun client réel.", headers: { "message-id": `<synthetic-sav55-${kind}@example.invalid>` } }), receivedAt, analysisStatus: "done", processedAt: receivedAt, studioOpenedAt: ["unopened", "unreadReturn"].includes(kind) ? null : receivedAt }).returning();
    if (kind === "unreadReturn") await db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "synthetic-sav55-old", direction: "inbound", fromEmail: email, toEmails: [mailbox.email], subject, bodyCiphertext: encrypt({ text: "Demande précédente fictive, déjà ouverte." }), receivedAt: new Date("2026-10-12T10:00:00Z"), analysisStatus: "done", studioOpenedAt: new Date("2026-10-12T10:30:00Z") });
    const [run] = await db.insert(savAgentRuns).values({ messageId, runtime: "synthetic_fixture", mode: "off", status: "succeeded", model: "synthetic-sav55", promptRevision: "synthetic-sav55", inputHash: "synthetic", proposalCiphertext: encrypt(proposal) }).returning();
    const [decision] = await db.insert(savDecisions).values({ messageId, agentRunId: run.id, kind: proposal.decision.kind, reasonCode: "synthetic_sav55", explanation: "Recette synthétique locale SAV55", confidence: 0 }).returning();
    if (approved) await db.insert(savProposalReviews).values({ messageId, decisionId: decision.id, agentRunId: run.id, reviewScope: "legacy_global", revision: 1, status: "approved", verdict: "correct", dimensions: {}, beforeCiphertext: encrypt(proposal), afterCiphertext: encrypt(proposal), commentCiphertext: encrypt({ text: "Revue de fixture uniquement." }), reviewedBy: "ugo@limova.ai" });
    if (confirmed || kind === "ticketPending") await db.insert(savActions).values({ threadId, messageId, kind: "create_ticket", status: confirmed ? "succeeded" : "pending", actorType: "human", idempotencyKey: `synthetic-sav55:${kind}`, payload: confirmed ? { hubspotTicketId: thread.hubspotTicketId } : {} });
    if (kind === "qualification" || kind === "candidate") {
      const [verdict] = await db.insert(savDraftVerdicts).values({ threadId, messageId, decisionId: decision.id, agentRunId: run.id, sourceHash: "fixture-only", status: "rejected", snapshotCiphertext: encrypt({ body: "Brouillon fictif refusé", proposal }), reasonCiphertext: encrypt({ text: "Recette synthétique d’observation" }), reviewedBy: "ugo@limova.ai" }).returning();
      const [observation] = await db.insert(savResolutionObservations).values({ threadId, messageId, verdictId: verdict.id, state: kind === "candidate" ? "candidate_ready" : "closed_to_analyze", hubspotTicketId: thread.hubspotTicketId, closed: true, closedCatchupUntil: new Date("2026-10-12"), lastSyncAt: new Date("2026-10-13") }).returning();
      const [candidate] = kind === "candidate" ? await db.insert(savLearningCandidates).values({ threadId, sourceRef: `synthetic-sav55:${observation.id}`, sourceContentHash: "fixture-only", proposedPatch: {}, explanation: "Candidat fictif à examiner", status: "pending" }).returning() : [];
      await db.insert(savObservationCycles).values({ observationId: observation.id, cycle: 1, status: "closed", sourceHash: "fixture-only", summaryCiphertext: encrypt({ subject, events: [], humanEvidence: [], customerConfirmation: [], sourceErrors: [], outcome: "human_evidence_to_qualify", coverage: "Fixture locale uniquement." }), qualification: candidate ? "resolved" : null, qualifiedAt: candidate ? new Date("2026-10-13") : null, qualifiedBy: candidate ? "ugo@limova.ai" : null, candidateId: candidate?.id });
    }
  }
  for (const reopened of [false, true]) {
    const threadId = reopened ? "62000000-0000-4000-8000-000000000002" : "62000000-0000-4000-8000-000000000001";
    const subject = reopened ? "SAV62 nouvelle réponse après traitement externe" : "SAV62 traité hors Studio";
    const [thread] = await db.insert(savThreads).values({ id: threadId, mailboxId: mailbox.id, gmailThreadId: `synthetic-sav62-${reopened}`, customerEmail: "sav62@example.invalid", subject }).returning();
    const [message] = await db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, direction: "inbound", fromEmail: thread.customerEmail, subject, bodyCiphertext: encrypt({ text: "Cas entièrement synthétique déjà traité en dehors du Studio." }), receivedAt: new Date("2026-10-14T16:04:00Z"), analysisStatus: "done" }).returning();
    await db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_dossier_completed_externally", entityType: "sav_message", entityId: message.id, technicalMetadata: { version: 1, threadId: thread.id, batchId: "62000000-0000-4000-8000-000000000062", receivedBefore: "2026-10-14T16:05:00Z", reason: "processed_outside_studio" } });
    if (reopened) await db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, direction: "inbound", fromEmail: thread.customerEmail, subject, bodyCiphertext: encrypt({ text: "Nouvelle demande fictive après le classement." }), receivedAt: new Date("2026-10-14T16:06:00Z"), analysisStatus: "done" });
  }
  console.log("SAV-55/SAV-62 synthetic local fixtures ready.");
} finally { await client.close(); }
