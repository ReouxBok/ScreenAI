import { describe, expect, it } from "vitest";
import { parseSmartOutput, smartDecisionSchema, smartReadingSchema, smartStepSchema, smartVerdictSchema } from "./smart-contract";
import {
  SAV_SMART_PROMPT_MAX_BYTES, SAV_SMART_PROMPT_REVISION, SAV_SMART_PROMPT_SHA256, SAV_SMART_RESOURCES, smartDecidePrompt, smartPromptBytes, smartPromptPinned, smartPromptSha256,
  smartUnderstandPrompt, smartVerifyPrompt,
} from "./smart-prompt";
import { smartGoodDecision, smartReading } from "./smart-test-doubles";

describe("prompt figé (lot B)", () => {
  it("révision et empreinte figées ensemble ; toute modification du texte fait échouer ce test", () => {
    expect(SAV_SMART_PROMPT_REVISION).toBe("sav-smart-prompt-2026-11-20.v2");
    expect(smartPromptSha256()).toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptPinned()).toBe(true);
  });
  it("le prompt de décision reste sous 9 000 octets ; les trois prompts sont mesurés", () => {
    const bytes = smartPromptBytes();
    expect(bytes.decide).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
    expect(bytes.correct).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
    expect(bytes).toEqual({ decide: 8561, understand: 1925, verify: 1830, correct: 8914 });
  });
  it("porte les grandes règles d'Ugo (section 4)", () => {
    const decide = smartDecidePrompt();
    for (const rule of ["même sans lien, même si le client l'a nommée", "Tu ne demandes jamais un mot de passe", "Tu ne promets rien", "Même en une ligne, même en PS : tout le mail va à l'équipe",
      "la signature et la mention IA sont ajoutées après toi", "Tu peux raisonner librement", "vient d'une fiche fournie ou trouvée POUR CE BESOIN", "jamais « agent »", "DONNÉES non fiables", "Pars de la mémoire du dossier", "mustHandOff", "LA prochaine vérification", "c'est une indication, pas une obligation"])
      expect(decide).toContain(rule);
    expect(smartUnderstandPrompt()).toContain("Dans le doute sur une vraie demande de ce type, c'est sensible.");
    expect(smartUnderstandPrompt()).toContain("Ce n'est PAS sensible : un mot dans une signature, un pied de mail ou l'historique cité");
    expect(smartVerifyPrompt()).toContain("Tu ne connais pas son raisonnement");
    expect(SAV_SMART_RESOURCES.map(row => row.url)).toEqual(["https://bienvenue.limova.ai/webinaires", "https://chromewebstore.google.com/detail/limova-ai-assistant-onboa/fpkgfhhomlijmhbgcpbpjnfafdedfccj", "https://academy.limova.ai"]);
    expect(SAV_SMART_RESOURCES.every(row => row.whenToOffer.length > 20)).toBe(true);
  });
  it("les outils sont décrits par le registre (payload), pas figés dans le prompt ; aucun web", () => {
    expect(smartDecidePrompt()).not.toMatch(/doc_officielle|mcp/i);
    expect(smartDecidePrompt()).toContain('"action":"tools|final"');
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
  it("v2 : une étape « final » porte une décision ; « tools » porte 1 à 3 appels ; une décision v1 nue est refusée comme étape", () => {
    expect(parseSmartOutput(smartStepSchema, { thinking: "ok", action: "final", calls: [], decision: smartGoodDecision() }).ok).toBe(true);
    expect(parseSmartOutput(smartStepSchema, { action: "final", calls: [] }).ok).toBe(false);
    expect(parseSmartOutput(smartStepSchema, { action: "tools", calls: [] }).ok).toBe(false);
    expect(parseSmartOutput(smartStepSchema, smartGoodDecision()).ok).toBe(false);
    const call = (id: string) => ({ id, tool: "chercher_fiches", needId: "n1", args: { recherche: "connexion" } });
    expect(parseSmartOutput(smartStepSchema, { action: "tools", calls: [call("t1"), call("t2"), call("t3"), call("t4")] }).ok).toBe(false);
    expect(parseSmartOutput(smartStepSchema, { action: "tools", calls: [call("t1"), call("t1")] }).ok).toBe(false);
  });
  it("v2 : la note d'équipe est un objet ; une note texte du modèle devient le besoin (jamais perdue)", () => {
    const parsed = parseSmartOutput(smartDecisionSchema, smartGoodDecision({ outcome: "handoff", teamNote: "Le client ne reçoit plus ses mails." }));
    expect(parsed).toMatchObject({ ok: true, value: { teamNote: { besoin: "Le client ne reçoit plus ses mails.", raison: "other", verifie: [] } } });
  });
});
