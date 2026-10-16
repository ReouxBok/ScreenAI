import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSavTicketPreview, assertSavTicketPreview, readSavTicketPreviewToken } from "./manual-ticket-preview";
import { encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import type { SavDossierContext } from "./dossier-context";

const input = { threadId: "10000000-0000-4000-8000-000000000001", reviewId: "10000000-0000-4000-8000-000000000002", ticketId: "401", distinctIssueReason: "" };
function data() {
  const ticket = { id: "401", subject: "Téléphonie à configurer", description: "La configuration téléphonie échoue.", status: "open" as const, stageId: "2", pipelineId: "0", ownerId: "71", ownerName: "Alex Support", createdAt: "2026-10-01T12:00:00Z", closedAt: null, updatedAt: null };
  return { threadId: input.threadId, reviewId: input.reviewId, linkedTicketId: null, messageId: "10000000-0000-4000-8000-000000000003", receivedAt: new Date("2026-10-14T12:00:00Z"), fromEmail: "client@example.invalid", subject: "Aide téléphonie", text: "La configuration téléphonie échoue.",
    proposal: savStructuredProposalSchema.parse({ schemaVersion: 1, category: "technical", urgency: "normal", decision: { kind: "ticket_pending", reasonCode: "fixture", explanation: "Revoir cette demande", confidence: 800 }, routing: { kind: "new", reason: "fixture", contactId: "21" }, ticket: { title: ticket.subject, description: ticket.description }, process: [{ kind: "human_review", label: "Vérifier la demande", sourceIds: [] }], internalNote: null, replyDraft: null, sources: [], knowledgeRevision: "not_consulted", model: "fixture" }),
    context: { version: 1, messageId: "10000000-0000-4000-8000-000000000003", collectedAt: new Date().toISOString(), customerIdentity: { kind: "sender", email: "client@example.invalid", forwardedBy: null }, crm: { status: "ready", errorCode: null, data: { contactId: "21", contactName: "Camille Exemple", contactFound: true, tickets: [ticket], routing: { kind: "matched", ticketId: "401", reason: "semantic_same_issue", returnOperation: "reactivate" }, identityCandidates: [], errorCode: null } }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null } as SavDossierContext };
}
function signed(d = data()) {
  const value = buildSavTicketPreview(input, d);
  const token = encryptSavPayload({ purpose: "sav_ticket_preview_v1", actorEmail: "ugo@limova.ai", expiresAt: Date.now() + 900000, hash: value.hash, command: value.command });
  return { ...value, token };
}
beforeEach(() => vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "only-tests-key-123456789012345678901234567890"));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("SAV55 ticket action preview", () => {
  it("shows the exact generic note, target and preserved owner", () => {
    const p = signed();
    expect(p.details).toMatchObject({ targetId: "401", ownerId: "71", ownerName: "Alex Support", contactId: "21", contactName: "Camille Exemple", note: "Le client a renvoyé un email sur ce sujet. Le ticket repasse en Nouveau." });
    expect(p.details.note).not.toContain(data().text);
    expect(() => assertSavTicketPreview(p.token, "ugo@limova.ai", p.command, data())).not.toThrow();
  });
  it.each(["stage", "owner", "owner_name", "contact_name", "subject", "message", "review", "contact", "linked", "proposal"])("rejects changed %s after preview", kind => {
    const p = signed(), changed = data();
    if (kind === "stage") changed.context.crm.data!.tickets[0].stageId = "3";
    if (kind === "owner") changed.context.crm.data!.tickets[0].ownerId = "72";
    if (kind === "owner_name") changed.context.crm.data!.tickets[0].ownerName = "Autre propriétaire";
    if (kind === "contact_name") changed.context.crm.data!.contactName = "Autre nom de fiche";
    if (kind === "subject") changed.context.crm.data!.tickets[0].subject = "Autre sujet";
    if (kind === "message") changed.text += " Nouvelle demande.";
    if (kind === "review") changed.reviewId = "10000000-0000-4000-8000-000000000009";
    if (kind === "contact") changed.context.crm.data!.contactId = "22";
    if (kind === "linked") changed.linkedTicketId = "401" as never;
    if (kind === "proposal") changed.proposal.ticket.description += " Autre procédure.";
    expect(() => assertSavTicketPreview(p.token, "ugo@limova.ai", p.command, changed)).toThrow();
  });
  it("does not allow selection to bypass semantic ambiguity or another pipeline", () => {
    const d = data();
    d.context.crm.data!.routing = { kind: "ambiguous", reason: "fixture", candidateIds: ["401"] };
    expect(() => buildSavTicketPreview(input, d)).toThrow("SAV_TICKET_SELECTION_UNVERIFIED");
    const other = data(); other.context.crm.data!.tickets[0].pipelineId = "other";
    expect(() => buildSavTicketPreview(input, other)).toThrow("SAV_TICKET_SELECTION_UNVERIFIED");
  });
  it("binds actor, expiration, command and integrity", () => {
    const p = signed();
    expect(() => readSavTicketPreviewToken(p.token, "contact@limova.ai")).toThrow("SAV_TICKET_PREVIEW_EXPIRED");
    expect(() => readSavTicketPreviewToken(p.token.slice(0, -8), "ugo@limova.ai")).toThrow("SAV_TICKET_PREVIEW_EXPIRED");
    expect(() => assertSavTicketPreview(p.token, "ugo@limova.ai", { ...p.command, kind: "create_ticket" }, data())).toThrow();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 900001);
    expect(() => readSavTicketPreviewToken(p.token, "ugo@limova.ai")).toThrow("SAV_TICKET_PREVIEW_EXPIRED");
  });
  it("keeps the exact 15-day boundary and creates a successor beyond it", () => {
    const d = data(), ticket = d.context.crm.data!.tickets[0]; ticket.status = "closed"; ticket.stageId = "4"; ticket.closedAt = new Date(d.receivedAt.getTime() - 15 * 86400000).toISOString();
    expect(buildSavTicketPreview(input, d).details.note).toBe("Le client a renvoyé un email sur ce sujet. Le ticket est rouvert et repasse en Nouveau.");
    ticket.closedAt = new Date(d.receivedAt.getTime() - 15 * 86400000 - 1).toISOString();
    expect(buildSavTicketPreview(input, d).command).toMatchObject({ kind: "create_ticket", returnOperation: "create" });
  });
  it("already-new previews have neither note nor CRM status write", () => {
    const d = data(); d.context.crm.data!.tickets[0].stageId = "1";
    const p = buildSavTicketPreview(input, d); expect(p.command.returnOperation).toBe("keep"); expect(p.details.note).toBeNull();
  });
  it("uses the mapped creation title and enforces the distinct-issue reason", () => {
    const d = data(); d.context.crm.data!.routing = { kind: "new", reason: "semantic_distinct_issue", candidateIds: [] };
    d.proposal.ticket.title = "Demande de configuration de notre nouvel agent téléphonique";
    const { ticketId: _ignored, ...newInput } = input; void _ignored;
    expect(() => buildSavTicketPreview(newInput, d)).toThrow("SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED");
    const p = buildSavTicketPreview({ ...newInput, distinctIssueReason: "Cette nouvelle demande porte sur un autre incident." }, d);
    expect(p.details.title).toBe("Demande de configuration de notre");
  });
});
