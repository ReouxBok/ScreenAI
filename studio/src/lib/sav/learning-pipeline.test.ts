import { describe, expect, it } from "vitest";
import { savLearningProofHash } from "./learning-pipeline";

const proof = {
  sourceRef: "sav-observation:synthetic-cycle", cycleStartedAt: "2026-10-14T12:00:00.000Z", evidenceRef: "hubspot-message:synthetic-human-reply",
  sourceMessageId: "hubspot-message:synthetic-human-reply", resolution: "Ouvrir Paramètres puis relancer la connexion.", customerConfirmed: false,
};

describe("SAV proof identity", () => {
  it("ignores case, punctuation, and whitespace changes so cosmetic refreshes cannot revive a rejection", () => {
    expect(savLearningProofHash(proof)).toBe(savLearningProofHash({ ...proof, resolution: "  OUVRIR paramètres, puis relancer la connexion ! " }));
  });
  it("treats a new evidence message, cycle, or customer confirmation as a new proof", () => {
    expect(savLearningProofHash(proof)).not.toBe(savLearningProofHash({ ...proof, evidenceRef: "hubspot-message:another-human-reply", sourceMessageId: "hubspot-message:another-human-reply" }));
    expect(savLearningProofHash(proof)).not.toBe(savLearningProofHash({ ...proof, cycleStartedAt: "2026-10-15T12:00:00.000Z" }));
    expect(savLearningProofHash(proof)).not.toBe(savLearningProofHash({ ...proof, customerConfirmed: true }));
  });
});
