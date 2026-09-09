import { describe, expect, it } from "vitest";
import { extractSavLearningResolution, isHubspotOutboundDirection, redactSavLearningText } from "./learning-extraction";

describe("SAV learning extraction", () => {
  it("never mistakes an incoming email for a human resolution", () => {
    expect(isHubspotOutboundDirection("INCOMING_EMAIL")).toBe(false);
    expect(isHubspotOutboundDirection("EMAIL")).toBe(true);
  });
  it("records human provenance and a later customer confirmation", () => {
    const result = extractSavLearningResolution("", [
      { id: "in", direction: "INCOMING_EMAIL", text: "Cela ne marche pas" },
      { id: "out", direction: "EMAIL", text: "Activez le réglage X.", aiAuthored: false },
      { id: "confirm", direction: "INCOMING_EMAIL", text: "Merci, ça marche maintenant." },
    ]);
    expect(result).toMatchObject({ resolution: "Activez le réglage X.", provenance: "human_resolution", customerConfirmed: true, sourceMessageId: "out" });
  });
  it("distinguishes an AI-authored response from a human resolution", () => expect(extractSavLearningResolution("", [
    { direction: "EMAIL", text: "Procédure IA", aiAuthored: true },
  ])).toMatchObject({ provenance: "ai_resolution", customerConfirmed: false }));
  it("redacts direct identifiers and likely secrets before proposing reusable knowledge", () => {
    expect(redactSavLearningText("Écrire à client@example.com ou 06 12 34 56 78 avec token_abcdefghijklmnop")).toBe("Écrire à [email masqué] ou [téléphone masqué] avec [secret masqué]");
  });
});
