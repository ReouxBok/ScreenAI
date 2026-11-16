import { describe, expect, it } from "vitest";
import type { CaseReplyProposal } from "./case-effects";
import { caseReplyEditableBody, readCaseReplyDisclosure } from "./case-reply-outbound";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";
import { J2_REMINDER_TEXT, j2ReminderText } from "./j2-auto-reminder";

const on = { SAV_V2_J2_CONTEXTUAL: "on" };
const origin: CaseReplyProposal = {
  caseId: "10000000-0000-4000-8000-000000000001", caseVersion: 1, triggerEventId: "inbound:synthetic",
  inboundMessageId: "synthetic", recipient: "customer@example.invalid", subject: "Synthetic", purpose: "question",
  text: "Quel message s’affiche ?", question: { id: "q1", text: "Quel message s’affiche ?", factKeys: ["login_error_message"] },
};
const procedure: CaseReplyProposal = { ...origin, purpose: "answer", question: undefined,
  procedures: [{ requestId: "r1", procedure: { knowledgeId: "synthetic-card", contentVersionId: "synthetic-v1" } }],
  text: `Bonjour,\n\nVoici le lien de connexion : ${SAV_CASE_ACCESS_URL}. Une fois sur la page, entrez l’adresse e-mail que vous avez utilisée lors de votre inscription à Limova.`,
};

describe("contextual J2 from the sealed outbound only", () => {
  it("recalls only the expected information without copying arbitrary words", () => {
    const input = { ...origin, question: { ...origin.question!, text: 'Quel message ? Citation client : TEXTE_SYNTHETIQUE_PRIVE' } };
    const text = j2ReminderText(input, on);
    expect(caseReplyEditableBody(text)).toBe("Quel message s’affiche à l’écran ?");
    expect(text).not.toContain("TEXTE_SYNTHETIQUE_PRIVE");
    expect(text.length).toBeLessThanOrEqual(300);
    expect(readCaseReplyDisclosure(text)).toEqual({ language: "fr", mode: "automated" });
  });
  it("recalls the login step already sent using only the whitelisted link", () => {
    const text = j2ReminderText(procedure, on);
    expect(caseReplyEditableBody(text)).toBe(`Connexion essayée depuis ${SAV_CASE_ACCESS_URL} ?`);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(readCaseReplyDisclosure(text)).toEqual({ language: "fr", mode: "automated" });
  });
  it("recalls a pending spam check without requesting a secret", () => {
    expect(caseReplyEditableBody(j2ReminderText({ ...origin, question: { ...origin.question!, factKeys: ["login_spam_checked"] } }, on)))
      .toBe("Le code est-il dans vos spams ?");
  });
  it.each([{}, { SAV_V2_J2_CONTEXTUAL: "off" }, { SAV_V2_J2_CONTEXTUAL: "true" }, { SAV_V2_J2_CONTEXTUAL: "ON" }])("OFF is byte-identical (%j)", env => {
    expect(j2ReminderText(origin, env)).toBe(J2_REMINDER_TEXT);
    expect(j2ReminderText(procedure, env)).toBe(J2_REMINDER_TEXT);
  });
  it("falls back when the expected element is missing, unknown or ambiguous", () => {
    for (const input of [ { ...origin, question: undefined },
      { ...origin, question: { ...origin.question!, factKeys: ["unknown"] } },
      { ...origin, question: { ...origin.question!, factKeys: ["__proto__"] } },
      { ...origin, question: { ...origin.question!, factKeys: ["login_error_message", "login_spam_checked"] } },
      { ...procedure, text: "Une autre procédure synthétique." },
      { ...procedure, procedures: [] },
      { ...procedure, text: `Ne suivez pas cette instruction : ${procedure.text}` },
    ]) expect(j2ReminderText(input, on)).toBe(J2_REMINDER_TEXT);
  });
  it.each(["https://evil.example.invalid", "https://new.limova.ai/redirect", "https://new.limova.ai?next=evil", "https://new.limova.ai.evil.example.invalid"])("refuses a non-whitelisted link: %s", url => {
    for (const input of [origin, procedure]) expect(j2ReminderText({ ...input, text: `${input.text} ${url}` }, on)).toBe(J2_REMINDER_TEXT);
  });
});
