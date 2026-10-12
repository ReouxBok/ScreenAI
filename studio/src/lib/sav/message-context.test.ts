import { describe, expect, it } from "vitest";
import { buildSavInboundContext, savActiveSubject, splitSavMessageText } from "./message-context";
const input = (body: string, subject = "Re: Résiliation") => ({ subject, body });
describe("SAV message segmentation without business classification", () => {
  it.each([
    "Merci !\n\nLe mardi, Charly a écrit :\nJe souhaite résilier mon abonnement.",
    "Merci !\r\n\r\nOn Tuesday, Support wrote:\r\nPlease cancel my subscription.",
    "Merci !\n\n-----Original Message-----\nAncienne demande de remboursement.",
    "Merci !\n\n---------- Forwarded message ---------\nAncienne demande.",
    "Merci !\n> Je souhaite résilier mon abonnement.\n> Mot de passe perdu.",
    "Merci !\nDe : Support <support@example.invalid>\nEnvoyé : mardi\nÀ : Client\nObjet : Résiliation\nJe souhaite résilier.",
  ])("retains historical text separately without mutating input: %s", body => {
    const source = input(body); const copy = structuredClone(source); const context = buildSavInboundContext(source);
    expect(context.currentText).toBe("Merci !"); expect(context.quotedText).not.toBe("");
    expect(context.parts.some(p => p.kind === "quoted")).toBe(true); expect(source).toEqual(copy);
  });
  it("keeps unquoted inline answers and exact section lines", () => {
    const context = buildSavInboundContext(input("> Combien d’accès ?\nIl nous faut 4 accès.\n> Quel créneau ?\nJe suis disponible mardi à 14h."));
    expect(context.currentText).toBe("Il nous faut 4 accès.\nJe suis disponible mardi à 14h.");
    expect(context.parts).toContainEqual({ kind: "current", startLine: 2, endLine: 2 });
  });
  it("separates signatures and inherited subjects", () => {
    const source = input("Comment retrouver mes factures ?\n-- \nAlice Exemple\nTéléphone : 0612345678");
    const context = buildSavInboundContext(source);
    expect(context.currentText).toBe("Comment retrouver mes factures ?"); expect(context.signatureText).toContain("0612345678");
    expect(context.subjectInherited).toBe(true); expect(savActiveSubject(source)).toBe("");
  });
  it("does not treat a From field alone as an Outlook history", () => {
    expect(splitSavMessageText("Erreur de mail\nFrom: exemple@example.invalid\nComment corriger ?").currentText).toContain("Comment corriger");
  });
  it("leaves semantic facts, language and intents to the understanding stage", () => {
    const context = buildSavInboundContext(input("Hello, I need 3 users. My invoice is missing.\nI am available Tuesday at 14:00.\nAccount email: account@example.invalid"));
    expect(context.language).toBe("unknown"); expect(context.intents).toEqual([]); expect(context.facts).toEqual([]);
    expect(context.currentText).toContain("account@example.invalid");
  });
  it("preserves a forwarded-only message as history", () => {
    const context = buildSavInboundContext(input("Begin forwarded message:\nPlease cancel my subscription."));
    expect(context.currentText).toBe(""); expect(context.quotedText).toContain("cancel");
  });
  it("bounds the snapshot and declares omissions", () => {
    const context = buildSavInboundContext(input("a".repeat(15000) + "\nOn Tuesday, Support wrote:\n" + "b".repeat(6000)));
    expect(context.currentText.length).toBe(12000); expect(context.quotedText.length).toBe(4000); expect(context.truncated).toBe(true);
  });
});
