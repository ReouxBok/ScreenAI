import { eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "../src/db/schema";
import { activateSavV0Cutover, getSavV0Cutover } from "../src/lib/sav/cutover";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "../src/lib/sav/crypto";
import type { SavMessageBody } from "../src/lib/sav/service";
import { savStructuredProposalSchema } from "../src/lib/sav/proposal";

if (process.env.NODE_ENV === "production" || !process.env.DATABASE_URL?.startsWith("pglite:") || !process.env.DATABASE_URL.endsWith("/sav-preview-db")) throw new Error("ISOLATED_SAV_PREVIEW_DATABASE_REQUIRED");
if (process.env.HUBSPOT_ACCESS_TOKEN || process.env.GMAIL_REFRESH_TOKEN || process.env.SAV_GEMINI_API_KEY || process.env.GEMINI_API_KEY) throw new Error("EXTERNAL_PREVIEW_CREDENTIALS_FORBIDDEN");
const db = requireDb();
try {
  await db.insert(savMailboxes).values({ email: "contact@limova.ai" }).onConflictDoNothing();
  const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.email, "contact@limova.ai"));
  const boundary = await getSavV0Cutover() ?? await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const cases = [
    { key: "factures", subject: "Démo — retrouver mes factures", body: "Bonjour, je ne trouve pas mes factures. Où puis-je les consulter ?\nCas entièrement fictif.", kind: "ticket_pending", email: "client-fictif@example.invalid" },
    { key: "identite", subject: "Démo — email non reconnu", body: "Bonjour, je souhaite retrouver mon compte.\nNom : Camille Exemple\nTéléphone : 0612345678\nCas entièrement fictif.", kind: "human_review_required", email: "autre-email@example.invalid" },
    { key: "erreur", subject: "Démo — analyse en erreur", body: "Demande fictive conservée malgré un échec technique.", kind: "error", email: "test-erreur@example.invalid" },
    { key: "auto", subject: "Démo — réponse automatique", body: "Réponse automatique fictive : retour lundi.", kind: "automatic_reply", email: "auto-fictif@example.invalid" },
    { key: "historique", subject: "Démo — ancien email exclu", body: "Ce cas est stocké avant l’activation et ne doit jamais entrer dans la file V0.", kind: "history", email: "ancien-fictif@example.invalid" },
  ];
  for (const [index, item] of cases.entries()) {
    const gmailMessageId = `sav-preview-v0-${item.key}`;
    const [existing] = await db.select().from(savMessages).where(eq(savMessages.gmailMessageId, gmailMessageId));
    if (existing) continue;
    await db.transaction(async (tx) => {
      const receivedAt = new Date(Date.parse(boundary.receivedAfter) + (item.kind === "history" ? -60_000 : (index + 1) * 60_000));
      const [thread] = await tx.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: gmailMessageId, subject: item.subject, customerEmail: item.email, lastMessageAt: receivedAt }).returning();
      const [message] = await tx.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, gmailMessageId, direction: "inbound", fromEmail: item.email, toEmails: ["contact@limova.ai"], subject: item.subject, preview: item.body.slice(0, 150), receivedAt,
        analysisStatus: item.kind === "error" ? "failed" : item.kind === "history" ? "pending" : "done", analysisAttempts: item.kind === "error" ? 3 : 1, analysisErrorCode: item.kind === "error" ? "DEMO_CONFIGURATION_INCOMPLETE" : null, processedAt: ["error", "history"].includes(item.kind) ? null : new Date(),
        bodyCiphertext: encryptSavPayload({ text: item.body, attachments: item.key === "factures" ? [{ filename: "capture-fictive.png", mimeType: "image/png", size: 1000 }] : [] }),
      }).returning();
      if (["error", "history"].includes(item.kind)) return;
      const proposal = savStructuredProposalSchema.parse({ schemaVersion: 1, category: item.key === "factures" ? "billing" : "account", urgency: "normal", decision: { kind: item.kind, reasonCode: "demo_fictive", explanation: "Proposition simulée pour tester la revue locale. Aucun parcours n’est validé en production.", confidence: 750 },
        routing: item.key === "identite" ? { kind: "review", reason: "customer_identity_unverified", candidateIds: [] } : item.kind === "automatic_reply" ? { kind: "none", reason: "automatic_reply" } : { kind: "new", reason: "demo_contact_simule", contactId: "100" },
        ticket: { title: item.subject, description: item.body }, process: item.key === "factures" ? [{ kind: "human_review", label: "Vérifier cette démo et les résultats attendus", sourceIds: [] }, { kind: "product_step", label: "Ouvrir Paramètres en bas à gauche, puis Facturation, puis Factures — parcours fictif à vérifier.", sourceIds: [] }] : [{ kind: "human_review", label: "Vérifier l’identité et la qualification avant toute action", sourceIds: [] }],
        internalNote: "Fixture locale uniquement", replyDraft: item.key === "identite" ? "Quelle adresse email avez-vous utilisée pour votre inscription Limova ? Cela permettra de vérifier le bon compte." : item.key === "factures" ? "Dans cette démo, ouvrez Paramètres en bas à gauche, puis Facturation, puis Factures. Faites vérifier ce parcours avant de l’utiliser." : null,
        sources: [], knowledgeRevision: "not_consulted", model: "fixture-locale-sans-IA", identityCandidates: item.key === "identite" ? [{ contactId: "200", name: "Camille Exemple", email: "compte-fictif@example.invalid", phoneHint: "…5678", matchedBy: "phone", confirmed: false }] : [],
      });
      const [run] = await tx.insert(savAgentRuns).values({ messageId: message.id, runtime: "local_fixture", dataOrigin: "simulation", mode: "off", status: "succeeded", model: proposal.model, promptRevision: "demo-v0-lot3", inputHash: savContentHash(item.body), outputHash: savContentHash(proposal), knowledgeRevision: proposal.knowledgeRevision, proposalCiphertext: encryptSavPayload(proposal), completedAt: new Date() }).returning();
      await tx.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: item.kind as "ticket_pending" | "human_review_required" | "automatic_reply", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: proposal.decision.confidence, model: proposal.model });
    });
  }
  // Read-only conversation UX fixtures: no extra inbound eligible for analysis,
  // no new run/action, and the invoice proposal/review stays on its existing mail.
  const [invoice] = await db.select().from(savMessages).where(eq(savMessages.gmailMessageId, "sav-preview-v0-factures"));
  if (invoice) {
    const originalId = "sav-preview-v0-factures-origin";
    const [existingOriginal] = await db.select().from(savMessages).where(eq(savMessages.gmailMessageId, originalId));
    if (!existingOriginal) {
      const receivedAt = new Date(Date.parse(boundary.receivedAfter) - 120_000);
      const subject = "Démo — conversation d’origine (factures)";
      await db.transaction(async (tx) => {
        const [thread] = await tx.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: originalId, subject, customerEmail: invoice.fromEmail, lastMessageAt: receivedAt }).returning();
        await tx.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, gmailMessageId: originalId, direction: "inbound", fromEmail: invoice.fromEmail, toEmails: [mailbox.email], subject, receivedAt,
          preview: "Premier échange fictif au sujet des factures.", bodyCiphertext: encryptSavPayload({ text: "Premier échange fictif au sujet des factures. Cette conversation historique sert uniquement de contexte ; aucun retraitement.", headers: { "message-id": "<sav-preview-origin@example.invalid>" } }),
        });
      });
    }
    const supportId = "sav-preview-v0-factures-support";
    const [existingSupport] = await db.select().from(savMessages).where(eq(savMessages.gmailMessageId, supportId));
    if (!existingSupport) await db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: invoice.threadId, gmailMessageId: supportId, direction: "outbound", fromEmail: mailbox.email, toEmails: [invoice.fromEmail], subject: invoice.subject,
      receivedAt: new Date(invoice.receivedAt.getTime() - 30_000), processedAt: new Date(), analysisStatus: "done", preview: "Échange fictif : pouvez-vous préciser votre demande ?",
      bodyCiphertext: encryptSavPayload({ text: "Échange fictif : pouvez-vous préciser ce que vous cherchez dans votre facturation ? Aucun email réel n’a été envoyé.", headers: { "message-id": "<sav-preview-support@example.invalid>", "in-reply-to": "<sav-preview-origin@example.invalid>", references: "<sav-preview-origin@example.invalid>" } }),
    });
    const body = decryptSavPayload<SavMessageBody>(invoice.bodyCiphertext);
    await db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...body, headers: { ...body.headers, "message-id": "<sav-preview-invoice@example.invalid>", "in-reply-to": "<sav-preview-support@example.invalid>", references: "<sav-preview-origin@example.invalid> <sav-preview-support@example.invalid>" } }) }).where(eq(savMessages.id, invoice.id));
  }
  console.log("Inbox fictive prête : factures avec historique et conversation liée, identité, erreur, exclusion technique ; anciens emails hors file. Aucun accès externe.");
} finally { await closeDb(); }
