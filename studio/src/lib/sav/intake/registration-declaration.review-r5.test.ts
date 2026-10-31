import { expect, it } from "vitest";
import { savIntakeDeclaredAccount } from "./registration-declaration";
const wrong = "wrong@account.test", correct = "correct@account.test";
it.each([
  `Mon compte Limova est ${wrong}. Je me suis trompé, voici la bonne : ${correct}.`,
  `My Limova account is ${wrong}. My mistake, the correct one is ${correct}.`,
  `Mon compte Limova est ${wrong}. Je me suis trompé, mon compte Limova est ${correct}.`,
])("REVIEW_R5 refuses the superseded account: %s", text => {
  expect(savIntakeDeclaredAccount(text, wrong, { continuation: false })).toBe(false);
});
it.each([
  `Mon compte Limova est ${correct}. Erreur 500 lors de ma connexion.`,
  `Mon compte Limova est ${correct}. Je me suis trompé dans la configuration Outlook.`,
  `My Limova account is ${correct}. My mistake was in the calendar configuration.`,
])("REVIEW_R5 keeps an account when the mistake concerns a separate configuration: %s", text => {
  expect(savIntakeDeclaredAccount(text, correct, { continuation: false })).toBe(true);
});
it("REVIEW_R5 preserves a separately explicit corrected declaration", () => {
  const text = `Mon compte Limova est ${wrong}. Je me suis trompé, mon compte Limova est ${correct}.`;
  expect(savIntakeDeclaredAccount(text, correct, { continuation: false })).toBe(true);
});
