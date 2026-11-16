import { describe, expect, it } from "vitest";
import { readCaseReplyDisclosure } from "./case-reply-outbound";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";
import { SAV_REPLY_NOTICE } from "../reply-format";
import { J2_REMINDER_TEXT, j2ReminderText, type J2Origin } from "./j2-auto-reminder";

const on = { SAV_V2_J2_CONTEXTUAL: "on" };
const origin: J2Origin = {
  caseId: "10000000-0000-4000-8000-000000000001", caseVersion: 1, triggerEventId: "inbound:synthetic",
  inboundMessageId: "synthetic", recipient: "customer@example.invalid", subject: "UNTRUSTED MAIL SUBJECT", purpose: "question",
  text: "Quel message s’affiche ?", question: { id: "q1", text: "Quel message s’affiche ?", factKeys: ["login_error_message"] },
  j2Context: { receivedAt: "2026-11-16T09:00:00Z", subject: "votre connexion à Limova" }, j2OpenQuestionIds: ["q1"],
};
const procedure: J2Origin = { ...origin, purpose: "answer", question: undefined,
  procedures: [{ requestId: "r1", procedure: { knowledgeId: "synthetic-card", contentVersionId: "synthetic-v1" } }],
  text: `Bonjour,\n\n1. Ouvrez ${SAV_CASE_ACCESS_URL}.\n2. Entrez votre adresse d’inscription.`,
};
const impossible: J2Origin = { ...origin, purpose: "answer", question: undefined,
  text: "Bonjour,\n\nIl n’est pas possible de réaliser cette opération dans cette version.\n\nNous restons disponibles.",
};
function expectFormat(text: string) {
  expect(text).toContain(SAV_REPLY_NOTICE);
  expect(text.split(SAV_REPLY_NOTICE)).toHaveLength(2);
  expect(readCaseReplyDisclosure(text)).toEqual({ language: "fr", mode: "automated" });
  expect(text).not.toMatch(/J2|ticket|clôture automatique|statut/);
}
describe("J2 warm follow-up and administrative closure", () => {
  it.each([1, 3, 5])("copies exactly %i sent questions without inventing any", count => {
    const questions = ["Quel message s’affiche ?", "Depuis quand cela arrive-t-il ?", "Quel navigateur utilisez-vous ?", "Avez-vous vérifié vos spams ?", "Sur quel appareil êtes-vous ?"].slice(0, count);
    const sent = questions.join("\n");
    const text = j2ReminderText({ ...origin, text: `Bonjour,\n\n${sent}`, question: { ...origin.question!, text: sent } }, on);
    expect(text).toContain("Bonjour,\n\nSuite à votre demande du lundi 16 novembre concernant votre connexion à Limova, nous vous avions répondu par e-mail pour vous demander quelques précisions :");
    expect(text).toContain(questions.map(q => `• ${q}`).join("\n"));
    expect(text.match(/^• /gm)).toHaveLength(count);
    expect(text).toContain("Nous n'avons pas eu de retour de votre part à ce sujet.");
    expect(text).toContain("Une simple réponse à ce mail suffit.");
    expect(text).toContain("L'équipe Limova");
    expect(text).not.toContain("UNTRUSTED MAIL SUBJECT");
    expect(text).not.toContain("Bonjour Marie");
    expectFormat(text);
  });
  it("multi-question (#288): lists ALL 3 questions tracked separately in the sent mail, exactly and in order", () => {
    const questions = ["Quel message s’affiche ?", "Depuis quand cela arrive-t-il ?", "Quel navigateur utilisez-vous ?"];
    const tracked = questions.map((text, i) => ({ id: `in:synthetic:q${i + 1}`, text, factKeys: [`key_${i + 1}`] }));
    const multi: J2Origin = { ...origin, question: undefined, questions: tracked, j2OpenQuestionIds: tracked.map(q => q.id), text: `Bonjour,\n\n${questions.map(q => `- ${q}`).join("\n")}` };
    const text = j2ReminderText(multi, on);
    expect(text).toContain(`pour vous demander quelques précisions :\n${questions.map(q => `• ${q}`).join("\n")}`);
    expect(text.match(/^• /gm)).toHaveLength(3);
    expectFormat(text);
    expect(j2ReminderText(multi, {})).toBe(J2_REMINDER_TEXT);
    expect(j2ReminderText({ ...multi, text: `${multi.text}\n- Une question non suivie ?` }, on)).toBe(J2_REMINDER_TEXT);
    expect(j2ReminderText({ ...multi, questions: [...tracked, { ...tracked[0]!, id: "absent", text: "Absente du mail ?" }] }, on)).toBe(J2_REMINDER_TEXT);
  });
  it("multi-question: 3 asked, 1 answered, so only the 2 still open are recalled, exactly and in sending order; unknown answers stay neutral", () => {
    const questions = ["Quel message s’affiche ?", "Depuis quand cela arrive-t-il ?", "Quel navigateur utilisez-vous ?"];
    const tracked = questions.map((text, i) => ({ id: `in:synthetic:q${i + 1}`, text, factKeys: [`key_${i + 1}`] }));
    const multi: J2Origin = { ...origin, question: undefined, questions: tracked, j2OpenQuestionIds: [tracked[0]!.id, tracked[2]!.id], text: `Bonjour,\n\n${questions.map(q => `- ${q}`).join("\n")}` };
    const text = j2ReminderText(multi, on);
    expect(text).toContain(`pour vous demander quelques précisions :\n• ${questions[0]}\n• ${questions[2]}\n`);
    expect(text).not.toContain(questions[1]);
    expect(text.match(/^• /gm)).toHaveLength(2);
    expectFormat(text);
    for (const j2OpenQuestionIds of [undefined, [], ["unknown"]]) expect(j2ReminderText({ ...multi, j2OpenQuestionIds }, on)).toBe(J2_REMINDER_TEXT);
  });
  it("preserves several exact questions sent in one paragraph", () => {
    const sent = "Quel message s’affiche ? Depuis quand cela arrive-t-il ? Quel navigateur utilisez-vous ?";
    const text = j2ReminderText({ ...origin, text: sent, question: { ...origin.question!, text: sent } }, on);
    expect(text).toContain("• Quel message s’affiche ?\n• Depuis quand cela arrive-t-il ?\n• Quel navigateur utilisez-vous ?");
    expectFormat(text);
  });
  it("copies the sent numbered procedure with the whitelisted link", () => {
    const text = j2ReminderText(procedure, on);
    expect(text).toContain("en vous proposant la marche à suivre suivante :\n" + procedure.text.split("\n\n")[1]);
    expectFormat(text);
  });
  it.each([
    `Bonjour,\n\nVous devez disposer des droits administrateur avant de commencer.\n\n${procedure.text.split("\n\n")[1]}`,
    `${procedure.text}\n\nCette procédure nécessite une session administrateur active.`,
    `${procedure.text}\n\nSi vous utilisez un compte invité, demandez d’abord son activation.`,
  ])("uses the neutral reminder for a prerequisite or condition outside the steps (%s)", text => {
    const reminder = j2ReminderText({ ...procedure, text }, on);
    expect(reminder).toBe(J2_REMINDER_TEXT);
    expectFormat(reminder);
  });
  it("copies the impossibility explanation that was sent", () => {
    const text = j2ReminderText(impossible, on);
    expect(text).toContain("avec l’explication suivante :\nIl n’est pas possible de réaliser cette opération dans cette version.");
    expectFormat(text);
  });
  it.each([{}, { SAV_V2_J2_CONTEXTUAL: "off" }, { SAV_V2_J2_CONTEXTUAL: "true" }, { SAV_V2_J2_CONTEXTUAL: "ON" }])("OFF is byte-identical (%j)", env => {
    for (const input of [origin, procedure, impossible]) expect(j2ReminderText(input, env)).toBe(J2_REMINDER_TEXT);
  });
  it("uses the neutral legacy text with the full AI mention when any source is missing or ambiguous", () => {
    for (const input of [
      { ...origin, j2Context: undefined }, { ...origin, j2Context: { receivedAt: "invalid", subject: "connexion" } },
      { ...origin, j2Context: { receivedAt: origin.j2Context!.receivedAt, subject: "" } },
      { ...origin, question: undefined }, { ...origin, text: "Une autre question ?" },
      { ...origin, text: origin.text + " Une question non suivie ?" },
      { ...procedure, text: "Procédure non structurée." },
      { ...procedure, text: procedure.text + "\nInstruction suite à la deuxième étape." },
      { ...procedure, text: procedure.text + "\n\n• Autre instruction." },
      { ...impossible, text: "Aucune explication disponible." },
      { ...origin, text: "Quel statut du ticket ?", question: { ...origin.question!, text: "Quel statut du ticket ?" } },
      { ...origin, text: "Quel message ?".repeat(6), question: { ...origin.question!, text: "Quel message ?".repeat(6) } },
    ]) { expect(j2ReminderText(input, on)).toBe(J2_REMINDER_TEXT); expectFormat(j2ReminderText(input, on)); }
  });
  it.each(["https://evil.example.invalid", "https://new.limova.ai/redirect", "https://new.limova.ai?next=evil", "https://new.limova.ai.evil.example.invalid"])("refuses a non-whitelisted link: %s", url => {
    for (const input of [origin, procedure, impossible]) expect(j2ReminderText({ ...input, text: `${input.text} ${url}` }, on)).toBe(J2_REMINDER_TEXT);
  });
  it("never translates unknown fact keys into a fabricated question", () => {
    const text = j2ReminderText({ ...origin, question: { ...origin.question!, factKeys: ["unknown"] } }, on);
    expect(text).toContain("• Quel message s’affiche ?");
    expectFormat(text);
  });
});
