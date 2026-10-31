import { expect, it } from "vitest";
import { savIntakeDeclaredAccount } from "./registration-declaration";
const address = "real@account.test";
it.each([
  `Mon compte Limova est ${address}. Je ne connais pas mon identifiant.`,
  `Mon compte Limova est ${address}. Mon collègue a un problème sur son compte.`,
  `My Limova account is ${address}. My colleague has a problem with his account.`,
])("REVIEW_R4 preserves account role across an unrelated subsequent statement: %s", text => {
  expect(savIntakeDeclaredAccount(text, address, { continuation: false })).toBe(true);
});
it.each([
  `Mon compte Limova est ${address}, mais ce n'est pas mon compte.`,
  `My Limova account is ${address}, but this is not my account.`,
])("REVIEW_R4 still rejects a directly retracted account: %s", text => {
  expect(savIntakeDeclaredAccount(text, address, { continuation: false })).toBe(false);
});
