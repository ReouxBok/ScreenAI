import { describe, expect, it } from "vitest";
import { containsSensitiveMemory, deterministicCandidates, isForgetCommand, sanitizeMemoryCandidate } from "./policy";

describe("copilot memory policy", () => {
  it("extracts explicit useful preferences and goals", () => {
    expect(deterministicCandidates("Je préfère des réponses courtes. Mon objectif est d'automatiser LinkedIn.")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "preference" }),
      expect.objectContaining({ type: "project" }),
    ]));
  });

  it("retains an explicit previous-work handoff across new chats", () => {
    expect(deterministicCandidates("Le dernier truc qu'on a fait c'est connecter HubSpot.")).toEqual([
      expect.objectContaining({ type: "project", confidence: 0.98, statement: expect.stringContaining("connecter HubSpot") }),
    ]);
  });

  it("stores an explicit remember command without depending on model extraction", () => {
    expect(deterministicCandidates("Rappelle toi que j'aime le chocolat et que je vis à Nice.")).toEqual([
      expect.objectContaining({
        type: "preference",
        statement: "j'aime le chocolat et que je vis à Nice",
        confidence: 0.99,
        importance: 1,
      }),
    ]);
  });

  it("rejects secrets and precise addresses even in explicit remember commands", () => {
    expect(deterministicCandidates("Rappelle-toi que mon mot de passe est super-secret.")).toEqual([]);
    expect(deterministicCandidates("Rappelle-toi que j'habite 12 rue de Rivoli.")).toEqual([]);
  });

  it("rejects credentials, OTPs, emails and financial identifiers", () => {
    for (const value of [
      "Mon mot de passe est correct-horse-battery-staple",
      "Mon OTP est 123456",
      "Mon email est membre@example.com",
      "Mon IBAN est FR7612345678901234567890123",
    ]) {
      expect(containsSensitiveMemory(value)).toBe(true);
      expect(sanitizeMemoryCandidate({ type: "profile", statement: value, confidence: 1, importance: 1 })).toBeNull();
    }
  });

  it("recognizes natural-language corrections", () => {
    expect(isForgetCommand("Oublie ça, ce n'est plus mon objectif.")).toBe(true);
    expect(isForgetCommand("Continue ce parcours")).toBe(false);
  });
});
