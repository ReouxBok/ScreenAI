import { describe, expect, it } from "vitest";
import { parseSmartOutput, smartDecisionSchema, smartReadingSchema, smartVerdictSchema } from "./smart-contract";
import {
  SAV_SMART_PROMPT_MAX_BYTES, SAV_SMART_PROMPT_REVISION, SAV_SMART_PROMPT_SHA256, SAV_SMART_RESOURCES, smartDecidePrompt, smartPromptBytes, smartPromptPinned, smartPromptSha256,
  smartUnderstandPrompt, smartVerifyPrompt,
} from "./smart-prompt";
import { smartGoodDecision, smartReading } from "./smart-test-doubles";

describe("prompt figé (lot B)", () => {
  it("révision et empreinte figées ensemble ; toute modification du texte fait échouer ce test", () => {
    expect(SAV_SMART_PROMPT_REVISION).toBe("sav-smart-prompt-2026-11-20.v1");
    expect(smartPromptSha256()).toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptPinned()).toBe(true);
  });
  it("le prompt de décision reste sous 9 000 octets ; les trois prompts sont mesurés", () => {
    const bytes = smartPromptBytes();
    expect(bytes.decide).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
    expect(bytes.correct).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
    expect(bytes).toEqual({ decide: 5623, understand: 1620, verify: 1767, correct: 5882 });
  });
  it("porte les grandes règles d'Ugo (section 4)", () => {
    const decide = smartDecidePrompt();
    for (const rule of ["même sans lien, même si le client l'a nommée", "Tu ne demandes jamais un mot de passe", "Tu ne promets rien", "Même en une ligne, même en PS : tout le mail va à l'équipe",
      "la signature et la mention IA sont ajoutées après toi", "Tu as le droit de réfléchir librement", "vient d'une fiche fournie POUR CE BESOIN", "jamais « agent »", "Aucun."])
      expect(decide).toContain(rule);
    expect(smartUnderstandPrompt()).toContain("Dans le doute, c'est sensible.");
    expect(smartVerifyPrompt()).toContain("Tu ne connais pas son raisonnement");
    expect(SAV_SMART_RESOURCES.map(row => row.url)).toEqual(["https://bienvenue.limova.ai/webinaires", "https://chromewebstore.google.com/detail/limova-ai-assistant-onboa/fpkgfhhomlijmhbgcpbpjnfafdedfccj"]);
  });
  it("aucun outil, aucun web, aucune Academy en ligne dans ce périmètre", () => {
    expect(smartDecidePrompt()).not.toMatch(/doc_officielle|chercher_fiches|mcp/i);
  });
});

describe("contrat (lot A)", () => {
  it("lecture, décision et verdict valides ; champs inconnus retirés", () => {
    expect(parseSmartOutput(smartReadingSchema, { ...smartReading(), extra: 1 })).toMatchObject({ ok: true, value: { needs: [{ id: "n1" }] } });
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision()).ok).toBe(true);
    expect(parseSmartOutput(smartVerdictSchema, { verdict: "conforme" })).toEqual({ ok: true, value: { verdict: "conforme", problems: [] } });
  });
  it("invalides : identifiant de besoin hors format ou dupliqué, issue inconnue, non conforme sans problème, type de fait inconnu", () => {
    expect(parseSmartOutput(smartReadingSchema, smartReading({ needs: [{ id: "x", ask: "a" }] })).ok).toBe(false);
    expect(parseSmartOutput(smartReadingSchema, smartReading({ needs: [{ id: "n1", ask: "a" }, { id: "n1", ask: "b" }] })).ok).toBe(false);
    expect(parseSmartOutput(smartReadingSchema, smartReading({ sensitive: "peut-être" })).ok).toBe(false);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ outcome: "send" })).ok).toBe(false);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], type: "web" }] })).ok).toBe(false);
    expect(parseSmartOutput(smartVerdictSchema, { verdict: "non_conforme", problems: [] }).ok).toBe(false);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ reply: "x".repeat(6_001) })).ok).toBe(false);
  });
});
