import { describe, expect, it } from "vitest";
import { resolveSavCustomerIdentity, resolveSavCustomerMessage } from "./forwarded-identity";

const colleague = "colleague@limova.ai";
const resolve = (body: string, fromEmail = colleague) => resolveSavCustomerMessage({ fromEmail, subject: "À traiter pour Alice", body });

describe("explicit forwarded customer identity", () => {
  it.each([
    "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>\nDate: Mon, 12 Oct 2026\nSubject: Connexion impossible\nTo: Support <contact@limova.ai>\n\nJe ne peux pas me connecter.",
    "De : Alice <alice@example.com>\nEnvoyé : lundi 12 octobre 2026\nÀ : Support <contact@limova.ai>\nObjet : Connexion impossible\n\nJe ne peux pas me connecter.",
    "Begin forwarded message:\n\nFrom: Alice\n <alice@example.com>\nSubject: Connexion impossible\n\nJe ne peux pas me connecter.",
  ])("uses only an original explicit From/De and its subject/body", body => {
    expect(resolve(body)).toEqual({ kind: "forwarded", email: "alice@example.com", subject: "Connexion impossible", body: "Je ne peux pas me connecter." });
    expect(resolveSavCustomerIdentity({ fromEmail: colleague, body })).toEqual({ kind: "forwarded", email: "alice@example.com" });
  });
  it.each([
    "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>\nFrom: Bob <bob@example.com>\nSubject: Support\n\nDemande",
    "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>\nDe: Alice <alice@example.com>\n\nDemande",
    "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>,\n Bob <bob@example.com>\nSubject: Support\n\nDemande",
    "From: Alice <alice@example.com>\nUne mention dans le corps, pas des en-têtes.\nDate: Monday\nSubject: Support\n\nDemande",
    "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>, Bob <bob@example.com>\n\nDemande",
    "---------- Forwarded message ---------\nFrom: colleague@limova.ai\n\nDemande",
    "Voici la demande, contactez alice@example.com.",
    "---------- Forwarded message ---------\nFrom: alice@example.com\nSubject: Support\n\nDemande\n---------- Forwarded message ---------\nFrom: bob@example.com\n\nAutre demande",
  ])("fails closed on missing or ambiguous forwarding headers", body => {
    expect(resolve(body)).toMatchObject({ kind: "unresolved_forward", email: null });
  });
  it("never changes the envelope of a direct external sender", () => {
    const body = "---------- Forwarded message ---------\nFrom: alice@example.com\n\nDemande";
    expect(resolve(body, "external@example.com")).toEqual({ kind: "sender", email: "external@example.com", subject: "À traiter pour Alice", body });
    expect(resolve(body, "colleague@limova.ai.example.com").kind).toBe("sender");
  });
});
