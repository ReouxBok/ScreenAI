import { expect, it } from "vitest";
import { savIntakeDeclaredAccount } from "./registration-declaration";
const address = "wrong@account.test";
it.each([
  `Mon compte Limova est ${address}, non c'est le compte de mon collègue.`,
  `Mon compte Limova est ${address}, mais ce n'est pas mon compte.`,
  `My Limova account is ${address}, but this is not my account.`,
])("REVIEW_R3 refuses a retracted account statement: %s", text => {
  expect(savIntakeDeclaredAccount(text, address, { continuation: false })).toBe(false);
});
it.each([
  `Mon compte Limova est ${address}.`,
  `My Limova account is ${address}.`,
])("REVIEW_R3 keeps a genuine unretracted account statement: %s", text => {
  expect(savIntakeDeclaredAccount(text, address, { continuation: false })).toBe(true);
});
