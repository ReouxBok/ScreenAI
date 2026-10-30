import { describe, expect, it } from "vitest";
import { intakeTicketDescription, intakeUnreadAttachmentNotice, SAV_INTAKE_DESCRIPTION_MAX_BODY } from "./ticket-description";

// Synthetic texts only; no customer content.
describe("SAV-72 ticket description from the original email", () => {
  it("copies plain text exactly with accents and paragraphs, after the subject", () => {
    const text = "Bonjour,\r\n\r\nL'export de mes factures échoue depuis hier.\r\nJ'ai réessayé deux fois.\r\n\r\nPouvez-vous m'aider ?\r\n\r\nCordialement,\r\nClaire Exemple";
    expect(intakeTicketDescription({ subject: "Export en échec", text })).toBe(
      "Objet : Export en échec\n\nBonjour,\n\nL'export de mes factures échoue depuis hier.\nJ'ai réessayé deux fois.\n\nPouvez-vous m'aider ?\n\nCordialement,\nClaire Exemple");
  });
  it("keeps decomposed accents readable (NFC) and decodes HTML entities once", () => {
    const text = "Le réglage est cass&eacute; &amp; l&#8217;appli plante. Litt&eacute;ral : &amp;eacute;";
    expect(intakeTicketDescription({ subject: "Réglage", text })).toBe("Objet : Réglage\n\nLe réglage est cassé & l’appli plante. Littéral : &eacute;");
  });
  it("converts an HTML-only document to readable paragraphs", () => {
    const text = "<!doctype html><html><head><style>p{}</style></head><body><p>Bonjour,</p><p>Le num&eacute;ro ne sonne plus.<br>Depuis lundi.</p></body></html>";
    expect(intakeTicketDescription({ subject: "Téléphonie", text })).toBe("Objet : Téléphonie\n\nBonjour,\nLe numéro ne sonne plus.\nDepuis lundi.");
  });
  it("keeps the incoming part of an HTML reply and names, without copying, its quoted history", () => {
    const text = "<html><body><p>Toujours en panne.</p><div class=\"gmail_quote\">Le lun. 3 oct., Support a écrit :<blockquote>Avez-vous redémarré ?</blockquote></div></body></html>";
    const description = intakeTicketDescription({ subject: "Re: Panne", text });
    expect(description).toBe("Objet : Re: Panne\n\nToujours en panne.\n\n[Historique cité non recopié : il reste dans l'email associé au ticket.]");
    expect(description).not.toContain("redémarré");
  });
  it("separates the incoming text from a plain-text quoted reply", () => {
    const text = "Le problème continue.\n\nLe 3 oct. 2026 à 10:00, Support <support@example.invalid> a écrit :\n> Merci de réessayer.\n> Bonne journée";
    const description = intakeTicketDescription({ subject: "Re: Problème", text });
    expect(description).toContain("Le problème continue.");
    expect(description).not.toContain("Merci de réessayer");
    expect(description).toContain("[Historique cité non recopié");
  });
  it("subject without body says so and invents nothing", () => {
    expect(intakeTicketDescription({ subject: "Rappelez-moi svp", text: "" })).toBe("Objet : Rappelez-moi svp\n\n[Email sans texte dans le corps : seul l'objet a été reçu.]");
    expect(intakeTicketDescription({ subject: "Rappelez-moi svp", text: " \n\n " })).toContain("seul l'objet a été reçu");
  });
  it("an unclosed HTML document is shown as received and flagged incomplete, never completed", () => {
    const description = intakeTicketDescription({ subject: "Coupé", text: "<html><body><p>Début du message" });
    expect(description).toBe("Objet : Coupé\n\nDébut du message\n\n[Source reçue incomplète : le texte ci-dessus n'a pas été complété.]");
  });
  it("cuts an oversized body at the exact bound with an explicit notice", () => {
    const body = "a".repeat(SAV_INTAKE_DESCRIPTION_MAX_BODY + 10);
    const description = intakeTicketDescription({ subject: "Long", text: body });
    expect(description.startsWith(`Objet : Long\n\n${"a".repeat(SAV_INTAKE_DESCRIPTION_MAX_BODY)}\n\n[Message coupé à ${SAV_INTAKE_DESCRIPTION_MAX_BODY} caractères sur ${SAV_INTAKE_DESCRIPTION_MAX_BODY + 10}`)).toBe(true);
    expect(intakeTicketDescription({ subject: "Long", text: "a".repeat(SAV_INTAKE_DESCRIPTION_MAX_BODY) })).not.toContain("coupé");
  });
  it("keeps the planner's unread-attachment notice but never its summary", () => {
    expect(intakeUnreadAttachmentNotice("Résumé généré.\n\n2 pièces jointes non lues par l'agent, à vérifier.")).toBe("2 pièces jointes non lues par l'agent, à vérifier.");
    expect(intakeUnreadAttachmentNotice("Résumé généré sans pièce.")).toBeNull();
    const description = intakeTicketDescription({ subject: "PJ", text: "Voir la capture.", unreadAttachmentNotice: "1 pièce jointe non lue par l'agent, à vérifier." });
    expect(description).toBe("Objet : PJ\n\nVoir la capture.\n\n1 pièce jointe non lue par l'agent, à vérifier.");
  });
  it("is deterministic for the same source", () => {
    const input = { subject: "Même", text: "Texte identique.\n\nDeuxième paragraphe." };
    expect(intakeTicketDescription(input)).toBe(intakeTicketDescription({ ...input }));
  });
});
