import { describe, expect, it } from "vitest";
import { buildSavInboundContext, savNonSupportIntent, splitSavMessageText } from "./message-context";
import { deterministicDecision, isSavCancellationRequest } from "./policy";

const input = (body: string, subject = "Re: Résiliation") => ({ from: "fiction@example.invalid", subject, body });

describe("SAV latest message derivation (no original mutation)", () => {
  it.each([
    "Merci !\n\nLe mardi, Charly a écrit :\nJe souhaite résilier mon abonnement.",
    "Merci !\r\n\r\nOn Tuesday, Support wrote:\r\nPlease cancel my subscription.",
    "Merci !\n\n-----Original Message-----\nAncienne demande de remboursement.",
    "Merci !\n\n---------- Forwarded message ---------\nAncienne demande.",
    "Merci !\n> Je souhaite résilier mon abonnement.\n> Mot de passe perdu.",
    "Merci !\nDe : Support <support@example.invalid>\nEnvoyé : mardi\nÀ : Client\nObjet : Résiliation\nJe souhaite résilier.",
  ])("does not reopen an old request in %s", body => {
    const original = input(body);
    const before = structuredClone(original);
    const context = buildSavInboundContext(original);
    expect(context.currentText).toBe("Merci !");
    expect(context.quotedText).not.toBe("");
    expect(context.parts.some(part => part.kind === "quoted")).toBe(true);
    expect(deterministicDecision(original)).toMatchObject({ kind: "no_ticket_needed", reasonCode: "simple_acknowledgement" });
    expect(isSavCancellationRequest(original)).toBe(false);
    expect(original).toEqual(before);
  });
  it("retains unquoted inline answers, their facts and exact line references", () => {
    const context = buildSavInboundContext(input("> Combien d’accès ?\nIl nous faut 4 accès.\n> Quel créneau ?\nJe suis disponible mardi à 14h.", "Re: Compte"));
    expect(context.currentText).toBe("Il nous faut 4 accès.\nJe suis disponible mardi à 14h.");
    expect(context.facts).toEqual([
      { kind: "access_count", excerpt: "Il nous faut 4 accès.", line: 2 },
      { kind: "callback_availability", excerpt: "Je suis disponible mardi à 14h.", line: 4 },
    ]);
  });
  it("separates a trailing signature but preserves its contact hints", () => {
    const context = buildSavInboundContext(input("Comment retrouver mes factures ?\n\nCordialement,\nAlice Exemple\nTéléphone : 0612345678", "Factures"));
    expect(context.currentText).toBe("Comment retrouver mes factures ?");
    expect(context.signatureText).toContain("0612345678");
    expect(context.quotedText).toBe("");
    expect(context.parts.at(-1)).toMatchObject({ kind: "signature", endLine: 5 });
  });
  it("does not discard another request after a sign-off", () => {
    const body = "Comment retrouver mes factures ?\nCordialement\nJe souhaite aussi résilier mon abonnement.";
    expect(splitSavMessageText(body).currentText).toContain("résilier");
    expect(isSavCancellationRequest(input(body, "Compte"))).toBe(true);
  });
  it("a footer keyword is not the current intention", () => {
    const body = "Comment retrouver mes factures ?\n-- \nAlice Exemple\nUnsubscribe";
    expect(isSavCancellationRequest(input(body, "Factures"))).toBe(false);
    expect(buildSavInboundContext(input(body, "Factures")).signatureText).toContain("Unsubscribe");
  });
  it("a From field alone is not treated as an Outlook history", () => {
    expect(splitSavMessageText("Erreur de mail\nFrom: exemple@example.invalid\nComment corriger ?").currentText).toContain("Comment corriger");
  });
  it("keeps several current issues and English declarations distinct from old French history", () => {
    const context = buildSavInboundContext(input("Hello, I need 3 users. My invoice is missing.\nI am available Tuesday at 14:00.\nAccount email: account@example.invalid\nCompany: Example\nOn Tuesday, Support wrote:\nBonjour, merci de confirmer votre compte.", "Re: Account"));
    expect(context.language).toBe("en");
    expect(context.intents).toEqual(expect.arrayContaining(["account", "billing", "callback"]));
    expect(context.facts.map(fact => fact.kind)).toEqual(["access_count", "callback_availability", "registration_email", "organization"]);
    expect(context.facts.every(fact => fact.line < 5)).toBe(true);
  });
  it.each(["Je veux mettre fin à mon abonnement", "Je ne souhaite plus payer mon abonnement", "Please stop my subscription", "I want to terminate my membership"])("keeps new cancellation human-only: %s", body => {
    expect(deterministicDecision(input(body, "Compte"))).toMatchObject({ reasonCode: "cancellation_human_only", requiresHumanApproval: true });
  });
  it("keeps a forwarded-only message for review, not as the third party's current request", () => {
    const message = input("Begin forwarded message:\nPlease cancel my subscription.");
    expect(buildSavInboundContext(message).currentText).toBe("");
    expect(savNonSupportIntent(message)).toBe("quoted_only");
    expect(deterministicDecision(message)).toMatchObject({ reasonCode: "quoted_only_review", requiresHumanApproval: true });
  });
  it.each([
    [{ from: "robot@mailinblack.com", subject: "Vérification", body: "Veuillez authentifier votre adresse expéditeur." }, "sender_verification"],
    [input("Nous vous proposons nos services de marketing et de prospection.", "Services"), "commercial_solicitation"],
    [input("Je souhaiterais discuter d’un partenariat avec Limova.", "Partenariat"), "partnership"],
    [input("Quels sont vos tarifs ?", "Tarifs"), "presales"],
  ])("qualifies non-support without identity confirmation: %s", (message, intent) => {
    expect(savNonSupportIntent(message)).toBe(intent);
    expect(deterministicDecision(message)).toMatchObject({ requiresHumanApproval: true, reasonCode: `${intent}_review` });
  });
  it.each([
    "Mon agent ne fonctionne plus avec mon partenaire, comment faire ?",
    "Je reçois une erreur Mailinblack dans mon compte, comment faire ?",
    "Pourquoi ma facture n’a pas vos tarifs affichés ?",
  ])("does not discard a real customer support issue: %s", body => {
    expect(savNonSupportIntent(input(body, "Aide"))).toBeNull();
  });
  it("bounds the snapshot and reports omissions instead of calling them complete", () => {
    const context = buildSavInboundContext(input("a".repeat(15_000) + "\nOn Tuesday, Support wrote:\n" + "b".repeat(6_000)));
    expect(context.currentText.length).toBe(12_000);
    expect(context.quotedText.length).toBe(4_000);
    expect(context.truncated).toBe(true);
  });
});
