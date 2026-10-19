import { describe, expect, it } from "vitest";
import { understandingFixture } from "../../../test/sav-understanding-fixtures";
import { buildSavRegistrationClarification, savRegistrationIdentityStatus, savSuppliedRegistrationEmail } from "./registration-identity";
import { savUnderstandingSchema } from "./understanding";
import type { SavDossierContext } from "./dossier-context";

const absent = { status: "ready", errorCode: null, data: { contactFound: false, errorCode: null, identityCandidates: [], tickets: [], routing: { kind: "new", reason: "none" } } } as SavDossierContext["crm"];
describe("registration identity prerequisite", () => {
  it("distinguishes absent, failed, incomplete and found contacts with failed tickets", () => {
    expect(savRegistrationIdentityStatus(absent)).toBe("not_found");
    expect(savRegistrationIdentityStatus({ ...absent, status: "partial" })).toBe("unavailable");
    expect(savRegistrationIdentityStatus({ ...absent, errorCode: "403" })).toBe("unavailable");
    expect(savRegistrationIdentityStatus({ ...absent, data: null })).toBe("unavailable");
    expect(savRegistrationIdentityStatus({ ...absent, data: { ...absent.data!, contactFound: true } })).toBe("unavailable");
    expect(savRegistrationIdentityStatus({ status: "partial", errorCode: "tickets_unavailable", data: { ...absent.data!, contactFound: true, contactId: "42", errorCode: "tickets_unavailable" } })).toBe("identified");
  });
  it.each(["fr", "en"] as const)("builds a courteous %s clarification with every request and no product instruction", language => {
    const u = understandingFixture({ language });
    u.requests.push({ ...u.requests[0], id: "secondary", summary: "La configuration ne se termine pas." });
    const snapshot = structuredClone(u);
    const reply = buildSavRegistrationClarification(u, "not_found", { email: null, ambiguous: false });
    expect(reply.replyDraft).toMatch(language === "fr" ? /^Bonjour,/ : /^Hello,/);
    expect(reply.replyDraft).toContain(language === "fr" ? "inscription à Limova" : "register with Limova");
    expect(reply.replyDraft).toMatch(language === "fr" ? /Bien à vous,$/ : /Kind regards,$/);
    expect(reply.coverage.map(c => c.requestId)).toEqual(u.requests.map(r => r.id));
    expect(reply.understanding.requests).toEqual(u.requests); expect(reply.understanding.knownFacts).toEqual(u.knownFacts);
    expect(reply.understanding.attemptedSteps).toEqual(u.attemptedSteps); expect(u).toEqual(snapshot);
    expect(reply.coverage.some(c => c.kind === "solution" || c.sourceIds.length)).toBe(false);
    expect(savUnderstandingSchema.safeParse(reply.understanding).success).toBe(true);
  });
  it("does not claim absence or ask for an address when lookup is unavailable", () => {
    const reply = buildSavRegistrationClarification(understandingFixture(), "unavailable", { email: null, ambiguous: false });
    expect(reply.replyDraft).not.toMatch(/retrouv|aucun|inscription|\?/);
    expect(reply.understanding.missingInformation).toEqual([]);
    expect(reply.responseKind).toBe("acknowledgement");
  });
  it("does not ask again for an already supplied registration address", () => {
    const reply = buildSavRegistrationClarification(understandingFixture(), "not_found", { email: "account@example.invalid", ambiguous: false });
    expect(reply.replyDraft).toContain("vérifier l’adresse d’inscription indiquée");
    expect(reply.replyDraft).not.toContain("préciser l’adresse email utilisée");
  });
  it("only extracts the single explicitly evidenced registration address", () => {
    const u = understandingFixture();
    const text = "Mon email d’inscription est compte@example.invalid";
    u.evidence[0].excerpt = text;
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "compte@example.invalid", evidenceIds: [u.evidence[0].id] }];
    const sources = [{ source: "current_message" as const, sourceId: "current_body", text }];
    expect(savSuppliedRegistrationEmail(u, sources)).toEqual({ email: "compte@example.invalid", ambiguous: false });
    expect(savSuppliedRegistrationEmail(u, [])).toEqual({ email: null, ambiguous: false });
    expect(savSuppliedRegistrationEmail(u, [{ ...sources[0], text: "Autre contenu" }]).email).toBeNull();
    u.evidence[0].excerpt = "L’email d’inscription du collègue est compte@example.invalid";
    expect(savSuppliedRegistrationEmail(u, [{ ...sources[0], text: u.evidence[0].excerpt }]).email).toBeNull();
  });
  it("keeps a conflict between registration addresses unresolved", () => {
    const u = understandingFixture();
    const texts = ["Mon email d’inscription est un@example.invalid", "Mon email d’inscription est deux@example.invalid"];
    u.evidence = texts.map((excerpt, i) => ({ id: `e${i}`, source: "current_message", sourceId: "current_body", excerpt }));
    u.knownFacts = texts.map((text, i) => ({ id: `f${i}`, key: "registration_email", text, evidenceIds: [`e${i}`] }));
    expect(savSuppliedRegistrationEmail(u, [{ source: "current_message", sourceId: "current_body", text: texts.join("\n") }])).toEqual({ email: null, ambiguous: true });
  });
  it("recognizes an evidenced short email reply without requiring the customer to repeat registration wording", () => {
    const u = understandingFixture(); u.evidence[0].excerpt = "compte@example.invalid";
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "compte@example.invalid", evidenceIds: [u.evidence[0].id] }];
    expect(savSuppliedRegistrationEmail(u, [{ source: "current_message", sourceId: "current_body", text: "compte@example.invalid" }])).toEqual({ email: "compte@example.invalid", ambiguous: false });
    const reply = buildSavRegistrationClarification(u, "confirmation_required", { email: "compte@example.invalid", ambiguous: false });
    expect(reply.replyDraft).toContain("Merci pour l’adresse email d’inscription indiquée");
    expect(reply.replyDraft).not.toContain("?");
  });
  it("reserves a unique question id and stays bounded with fifteen long requests", () => {
    const u = understandingFixture(); u.knownFacts = [{ id: "registration_identity_question", key: "version", text: "v2", evidenceIds: [u.evidence[0].id] }];
    u.requests = Array.from({ length: 15 }, (_, i) => ({ ...u.requests[0], id: `r${i}`, summary: "x".repeat(600) })); u.primaryRequestId = "r0";
    const reply = buildSavRegistrationClarification(u, "not_found", { email: null, ambiguous: false });
    expect(reply.replyDraft.length).toBeLessThan(8000);
    expect(reply.coverage).toHaveLength(15);
    expect(reply.understanding.missingInformation[0].id).not.toBe("registration_identity_question");
  });
});
