/** SAV-46 R1/R2: the deterministic account-role rule shared by both readers, the engine and the
 * comparison capture. Synthetic addresses only. */
import { describe, expect, it } from "vitest";
import type { EngineInput } from "./engine-types";
import { intakeRegistrationDiscardable, SAV_INTAKE_DECLARED_ADDRESS_CAP, savIntakeAccountConflict, savIntakeDeclaredAccount, savIntakeDeclaredAddressCandidates, savIntakeDeclaredAddressConflict } from "./registration-declaration";

const account = (text: string, address: string, continuation = false) => savIntakeDeclaredAccount(text, address, { continuation });

describe("declared account role", () => {
  it.each([
    ["Mon compte est client@entreprise.test", "client@entreprise.test"],
    ["Mon compte Limova est account@customer.test. Comment connecter Outlook ?", "account@customer.test"],
    ["Voici mon adresse d'inscription : account@customer.test.", "account@customer.test"],
    ["account@customer.test est l'adresse de mon compte.", "account@customer.test"],
    ["Je suis inscrit avec account@customer.test.", "account@customer.test"],
    ["My registration email is registered@example.test", "registered@example.test"],
    ["Je n'arrive pas à me connecter à mon compte account@customer.test.", "account@customer.test"],
    ["Mon compte Limova est ACCOUNT@customer.test et je veux connecter mailbox@connector.test à Outlook.", "account@customer.test"],
    ["Je veux connecter mailbox@connector.test à Outlook, mon compte Limova est account@customer.test.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test et resource@connector.test n'est pas mon compte.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test, je n'arrive pas à me connecter.", "account@customer.test"],
    ["My Limova account is account@customer.test. It is not working.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test, je ne connais pas mon identifiant.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test. Le problème ne vient pas de mon compte, mais de l'agent.", "account@customer.test"],
    ["My Limova account is account@customer.test. I did not receive the wrong address warning.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test. Je me suis trompé dans la configuration du calendrier.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test. Erreur 500 sur la page des factures.", "account@customer.test"],
    ["My Limova account is account@customer.test. My mistake was to share the calendar.", "account@customer.test"],
    ["Mon compte est resource@connector.test. Pardon, mon compte est account@customer.test.", "account@customer.test"],
    ["Mon compte Limova est resource@connector.test. Correction : account@customer.test est mon compte Limova.", "account@customer.test"],
    ["Mon compte Limova est account@customer.test. Correction : le calendrier calendar@resource.test doit être connecté.", "account@customer.test"],
    ["My Limova account is account@customer.test. Use mailbox@connector.test for the calendar sync.", "account@customer.test"],
  ])("proves: %s", (text, address) => expect(account(text, address)).toBe(true));
  it.each([
    ["Bonjour, comment connecter resource@connector.test à Outlook pour retrouver mes factures ?", "resource@connector.test"],
    ["Mon compte Limova est account@customer.test et je veux connecter mailbox@connector.test à Outlook.", "mailbox@connector.test"],
    ["Mon compte est resource@connector.test pour connecter Outlook.", "resource@connector.test"],
    ["Mon compte Google est resource@connector.test.", "resource@connector.test"],
    ["Comment partager l'agenda de resource@connector.test avec mon compte ?", "resource@connector.test"],
    ["Mon collègue resource@connector.test doit accéder à mon compte.", "resource@connector.test"],
    ["Je veux connecter resource@connector.test à mon compte.", "resource@connector.test"],
    ["Ce n'est pas mon compte Limova : resource@connector.test", "resource@connector.test"],
    ["Je ne suis pas inscrit avec resource@connector.test.", "resource@connector.test"],
    ["Merci.\nCordialement\nJean\nresource@connector.test", "resource@connector.test"],
    ["> Mon compte est resource@connector.test", "resource@connector.test"],
    ["Le 30 oct. Jean a écrit :\nMon compte est resource@connector.test", "resource@connector.test"],
    ["Mon compte est account@customer.test", "other@customer.test"],
    ["Mon compte est account@customer.test.extra", "account@customer.test"],
    ["Mon compte Limova est resource@connector.test, mais ce n'est pas mon compte.", "resource@connector.test"],
    ["My Limova account is resource@connector.test, but this is not my account.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test, non c'est le compte de mon collègue.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test. Non, ce n'est plus mon adresse d'inscription.", "resource@connector.test"],
    ["My account is resource@connector.test, sorry, wrong address.", "resource@connector.test"],
    ["Mon compte est resource@connector.test, non pardon, account@customer.test.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test et resource@connector.test n'est pas mon compte.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test. Ce n'est pas mon compte.", "resource@connector.test"],
    ["My Limova account is resource@connector.test. Sorry, that is not my account.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test, c'est le compte de mon collègue.", "resource@connector.test"],
    ["My Limova account is resource@connector.test, it's my colleague's account.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test. Je me suis trompé, voici la bonne : account@customer.test.", "resource@connector.test"],
    ["My Limova account is resource@connector.test. My mistake, the correct one is account@customer.test.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test, je me suis trompé d'adresse.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test. La bonne adresse est account@customer.test.", "resource@connector.test"],
    ["My Limova account is resource@connector.test. I mistyped it: account@customer.test.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test. Je me suis trompé, voici la bonne : account@customer.test.", "account@customer.test"],
    ["Mon compte Limova est resource@connector.test. Correction : account@customer.test est mon compte Limova.", "resource@connector.test"],
    ["My Limova account is resource@connector.test. Correction: account@customer.test is my Limova account.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test. Utilisez plutôt account@customer.test.", "resource@connector.test"],
    ["My Limova account is resource@connector.test. Use account@customer.test instead.", "resource@connector.test"],
    ["Mon compte Limova est resource@connector.test, ou plutôt account@customer.test.", "resource@connector.test"],
    ["Mon compte Limova est account@customer.test. Correction : le calendrier calendar@resource.test doit être connecté.", "calendar@resource.test"],
    ["Mon compte Limova est resource@connector.test. Utilisez plutôt account@customer.test.", "account@customer.test"],
  ])("does not prove: %s", (text, address) => expect(account(text, address)).toBe(false));
  it("a server-verified continuation reply proves the address without an account statement, never when negated or a resource", () => {
    expect(account("Voici l'adresse : account@customer.test", "account@customer.test", true)).toBe(true);
    expect(account("Je n'ai plus accès, voici account@customer.test", "account@customer.test", true)).toBe(true);
    expect(account("Voici l'adresse : account@customer.test", "account@customer.test", false)).toBe(false);
    expect(account("Ce n'est pas account@customer.test", "account@customer.test", true)).toBe(false);
    expect(account("Connectez account@customer.test à Outlook", "account@customer.test", true)).toBe(false);
    expect(account("Voici l'adresse : account@customer.test, mais ce n'est pas mon compte.", "account@customer.test", true)).toBe(false);
    expect(account("Voici l'adresse : account@customer.test ou resource@connector.test", "account@customer.test", true)).toBe(false);
    expect(account("Voici l'adresse : account@customer.test ou resource@connector.test", "resource@connector.test", true)).toBe(false);
  });
  it.each([
    ["Mon compte Limova est resource@connector.test. Mon compte Limova est account@customer.test.", false],
    ["My Limova account is resource@connector.test. My Limova account is account@customer.test.", false],
    ["Mon compte Limova est resource@connector.test. Correction, pour être précis, merci d'utiliser account@customer.test : c'est mon compte Limova.", false],
  ])("R7: one source admitting two distinct accounts is a conflict; neither proves the role: %s", (text, continuation) => {
    expect(savIntakeAccountConflict(text, { continuation })).toBe(true);
    expect(account(text, "resource@connector.test", continuation)).toBe(false);
    expect(account(text, "account@customer.test", continuation)).toBe(false);
    expect(intakeRegistrationDiscardable(text, "sender@example.test", false)).toBe(false);
  });
  it.each([
    "Mon compte Limova est account@customer.test et je veux connecter mailbox@connector.test à Outlook.",
    "Mon compte Limova est account@customer.test et resource@connector.test n'est pas mon compte.",
    "Mon compte Limova est resource@connector.test. Correction : account@customer.test est mon compte Limova.",
    "Mon compte est resource@connector.test. Pardon, mon compte est account@customer.test.",
    "Mon compte est account@customer.test. Mon compte est ACCOUNT@customer.test.",
  ])("R7 witness: one admitted account is no conflict and keeps proving it: %s", text => {
    expect(savIntakeAccountConflict(text, { continuation: false })).toBe(false);
    expect(account(text, "account@customer.test")).toBe(true);
  });
  it("an unproven declaration is discardable only when no other written address carries an account statement", () => {
    expect(intakeRegistrationDiscardable("Comment connecter resource@connector.test à Outlook ?", "sender@example.test", false)).toBe(true);
    expect(intakeRegistrationDiscardable("Mon compte est client@entreprise.test", "sender@example.test", false)).toBe(false);
    expect(intakeRegistrationDiscardable("Mon compte Limova est account@customer.test et je veux connecter mailbox@connector.test.", "sender@example.test", false)).toBe(false);
    expect(intakeRegistrationDiscardable("Mon compte est sender@example.test", "Sender@Example.test", false)).toBe(true);
    expect(intakeRegistrationDiscardable("Comment connecter resource@connector.test ?", "sender@example.test", true)).toBe(false);
    expect(intakeRegistrationDiscardable("Mon compte Limova est resource@connector.test. Je me suis trompé, voici la bonne : account@customer.test.", "sender@example.test", false)).toBe(false);
  });
});

describe("comparison capture candidates", () => {
  const input = (text: string, over: Partial<EngineInput> = {}): Pick<EngineInput, "message" | "conversation" | "identificationContinuation"> => ({
    message: { id: "10000000-0000-4000-8000-000000000001", threadId: "20000000-0000-4000-8000-000000000001", fromEmail: "Sender@Example.test", toEmails: [],
      currentText: text, contentComplete: true, direction: "inbound", receivedAt: "2026-10-31T10:00:00.000Z" },
    conversation: { status: "complete", data: [], observedAt: "2026-10-31T10:00:00.000Z" }, ...over });
  it("keeps only admissible declared addresses, normalized, sorted, without the sender", () => {
    expect(savIntakeDeclaredAddressCandidates(input("Mon compte Limova est Account@Customer.test et je veux connecter mailbox@connector.test à Outlook.")))
      .toEqual(["account@customer.test"]);
    expect(savIntakeDeclaredAddressCandidates(input("Mon compte est sender@example.test"))).toEqual([]);
    // R7: the sender's own address stated as the account is a second account, hence a conflict.
    const withSender = input("Mon compte Limova est Account@Customer.test et je veux connecter mailbox@connector.test à Outlook. Mon compte est sender@example.test");
    expect(savIntakeDeclaredAddressConflict(withSender)).toBe(true);
    expect(savIntakeDeclaredAddressCandidates(withSender)).toEqual([]);
    expect(savIntakeDeclaredAddressCandidates(input("Comment connecter resource@connector.test à Outlook ?"))).toEqual([]);
  });
  it("covers the sender's earlier inbound declaration and the continuation reply, never another author's", () => {
    const prior = (fromEmail: string, direction: "inbound" | "outbound" = "inbound") => ({ ...input("").message, id: "10000000-0000-4000-8000-000000000002", fromEmail, direction,
      currentText: "Mon compte est earlier@customer.test" });
    expect(savIntakeDeclaredAddressCandidates(input("Merci", { conversation: { status: "complete", data: [prior("sender@example.test")], observedAt: "x" } }))).toEqual(["earlier@customer.test"]);
    expect(savIntakeDeclaredAddressCandidates(input("Merci", { conversation: { status: "complete", data: [prior("third@example.test"), prior("sender@example.test", "outbound")], observedAt: "x" } }))).toEqual([]);
    expect(savIntakeDeclaredAddressCandidates(input("Voici : reply@customer.test", { identificationContinuation: { initialMessageId: "x", confirmedEffectId: "y" } }))).toEqual(["reply@customer.test"]);
    expect(savIntakeDeclaredAddressCandidates(input("Voici : reply@customer.test"))).toEqual([]);
  });
  it("the cap is explicit and counted on distinct addresses across distinct sources", () => {
    expect(SAV_INTAKE_DECLARED_ADDRESS_CAP).toBe(2);
    const earlier = (id: string, text: string) => ({ ...input("").message, id, currentText: text });
    const history = { conversation: { status: "complete" as const, data: [earlier("10000000-0000-4000-8000-000000000003", "Mon compte est b@customer.test"),
      earlier("10000000-0000-4000-8000-000000000004", "Mon compte est c@customer.test")], observedAt: "x" } };
    const many = input("Mon compte est a@customer.test. Mon compte est A@customer.test.", history);
    expect(savIntakeDeclaredAddressCandidates(many)).toEqual(["a@customer.test", "b@customer.test", "c@customer.test"]);
    expect(savIntakeDeclaredAddressConflict(many)).toBe(false);
  });
  it("R7: two accounts in the current message are a conflict for the capture and no candidate; distinct sources are not", () => {
    const both = input("Mon compte Limova est a@customer.test. Mon compte Limova est b@customer.test.");
    expect(savIntakeDeclaredAddressConflict(both)).toBe(true);
    expect(savIntakeDeclaredAddressCandidates(both)).toEqual([]);
    const prior = { ...input("").message, id: "10000000-0000-4000-8000-000000000002", currentText: "Mon compte Limova est a@customer.test" };
    const split = input("Mon compte Limova est b@customer.test.", { conversation: { status: "complete", data: [prior], observedAt: "x" } });
    expect(savIntakeDeclaredAddressConflict(split)).toBe(false);
    expect(savIntakeDeclaredAddressCandidates(split)).toEqual(["a@customer.test", "b@customer.test"]);
  });
});
