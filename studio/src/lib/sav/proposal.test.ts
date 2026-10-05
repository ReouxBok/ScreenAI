import { describe, expect, it } from "vitest";
import { buildSavStructuredProposal } from "./proposal";
import type { SavAnalysis } from "./intelligence";
const analysis: SavAnalysis = { category: "how_to", urgency: "normal", proposal: { kind: "ticket_pending", reasonCode: "known_procedure", explanation: "Une procédure validée est applicable.", confidence: 990, requiresHumanApproval: false }, evidence: [{ sourceType: "knowledge", sourceId: "card", contentVersionId: "v1", title: "Factures", excerpt: "Ouvrez Paramètres puis Facturation." }], replyDraft: "Ouvrez Paramètres puis Facturation.", internalNote: "Vérifier le résultat.", model: "fixture", knowledgeRevision: "kb_1", ticketRouting: { kind: "matched", reason: "gmail_thread_link", ticketId: "123", contactId: "456" } };
describe("server-owned structured SAV proposal", () => {
  it("preserves the complete customer mail, grounded process and exact source versions", () => {
    const body = "Mail complet\n" + "x".repeat(40_000);
    const result = buildSavStructuredProposal({ subject: "Je ne retrouve pas mes factures", body }, analysis);
    expect(result.ticket.description).toBe(body);
    expect(result.ticket.title.split(" ")).toHaveLength(5);
    expect(result.process.map((step) => step.kind)).toEqual(["link_ticket", "product_step", "review_reply"]);
    expect(result.sources[0].contentVersionId).toBe("v1");
    expect(result.knowledgeRevision).toBe("kb_1");
  });
  it("never proposes a guessed association when CRM context is unavailable", () => {
    const result = buildSavStructuredProposal({ subject: "Aide", body: "Comment faire ?" }, { ...analysis, ticketRouting: undefined });
    expect(result.routing.kind).toBe("review");
    expect(result.process.some((step) => step.kind === "create_ticket" || step.kind === "link_ticket")).toBe(false);
  });
});
