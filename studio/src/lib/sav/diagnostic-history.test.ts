import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savAgentRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { encryptSavPayload } from "./crypto";
import { loadSavConversation } from "./conversation";
import { buildSavStructuredProposal } from "./proposal";
import { savUnderstandingSources } from "./understanding-model";
import { validateSavUnderstanding } from "./understanding";
import { understandingContent, understandingFixture } from "../../../test/sav-understanding-fixtures";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let f: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-diagnostic-history-key-only"); f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); vi.unstubAllEnvs(); });
it("carries only a control actually found in a sent message, and requires customer evidence for its result", async () => {
  const instruction = "Ouvrir le panneau de diagnostic fictif.";
  const body = "J’ai réalisé le contrôle précédent et le résultat attendu n’apparaît pas.";
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  const [thread] = await f.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "synthetic-history", customerEmail: "fixture@example.invalid", subject: "Diagnostic fictif" }).returning();
  const message = async (minute: number, direction: "inbound" | "outbound", text: string) => (await f.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id,
    direction, fromEmail: direction === "inbound" ? "fixture@example.invalid" : "contact@limova.ai", bodyCiphertext: encryptSavPayload({ text }),
    receivedAt: new Date(`2026-10-16T10:0${minute}:00Z`), createdAt: new Date(`2026-10-16T10:0${minute}:01Z`) }).returning())[0];
  const first = await message(0, "inbound", "Le diagnostic fictif ne fonctionne pas.");
  const sent = await message(1, "outbound", instruction);
  const current = await message(2, "inbound", body);
  const proposal = buildSavStructuredProposal({ subject: "Diagnostic", body: "Demande fictive" }, { category: "technical", urgency: "normal", proposal: { kind: "ticket_pending", reasonCode: "fixture", explanation: "Procédure fictive à relire.", confidence: 900, requiresHumanApproval: true }, evidence: [], replyDraft: instruction, internalNote: null, model: "fixture", replyAssessment: { kind: "contextualized", coverage: [], errorCode: null,
    harness: { revision: "fixture", playbookVersionId: "book-1", playbookCharacters: 10, retrievalRevision: "kb-1", plans: [{ requestId: "r1", domain: "seo", mode: "solution", card: { id: "card", versionId: "v1" }, missingFacts: [], nextCheck: { id: "open", instruction, expectedResult: "Diagnostic visible.", sourceId: "card" }, repeatAllowed: false, limits: [] }] } } });
  await f.db.insert(savAgentRuns).values({ messageId: first.id, scope: "sav_ticket_analysis", runtime: "legacy_gemini", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) });
  const conversation = await loadSavConversation(current.id);
  expect(conversation.diagnosticChecks).toEqual([{ id: "open", versionId: "v1", instruction, expectedResult: "Diagnostic visible.", messageId: sent.id }]);
  const sources = savUnderstandingSources({ subject: "Diagnostic", body, conversation }).sources;
  const content = understandingContent(understandingFixture({ evidence: [{ id: "evidence-1", source: "current_message", sourceId: "current_body", excerpt: body }],
    attemptedSteps: [{ id: "attempt", key: "open", checkId: "open", checkVersionId: "v1", outcome: "not_expected", text: body, evidenceIds: ["evidence-1"] }] }));
  expect(validateSavUnderstanding(content, sources).attemptedSteps[0].outcome).toBe("not_expected");
  expect(() => validateSavUnderstanding({ ...content, attemptedSteps: [{ ...content.attemptedSteps[0], checkVersionId: "invented" }] }, sources)).toThrow();
  await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "Message sans procédure proposée." }) }).where(eq(savMessages.id, sent.id));
  expect((await loadSavConversation(current.id)).diagnosticChecks).toBeUndefined();
});
