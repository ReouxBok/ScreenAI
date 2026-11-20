import { describe, expect, it } from "vitest";
import { parseSmartOutput, smartDecisionSchema, smartReadingSchema, smartStepSchema, smartVerdictSchema } from "./smart-contract";
import {
  SAV_SMART_PROMPT_MAX_BYTES, SAV_SMART_PROMPT_REVISION, SAV_SMART_PROMPT_SHA256, SAV_SMART_RESOURCES, smartDecidePrompt, smartPromptBytes, smartPromptPinned, smartPromptSha256,
  smartUnderstandPrompt, smartVerifyPrompt,
} from "./smart-prompt";
import { smartGoodDecision, smartReading } from "./smart-test-doubles";

describe("prompt figé (lot B)", () => {
  it("révision et empreinte figées ensemble ; toute modification du texte fait échouer ce test", () => {
    expect(SAV_SMART_PROMPT_REVISION).toBe("sav-smart-prompt-2026-11-20.v5");
    expect(smartPromptSha256()).toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptPinned()).toBe(true);
  });
  it("le prompt de décision reste sous 9 000 octets ; les trois prompts sont mesurés", () => {
    const bytes = smartPromptBytes();
    expect(bytes.decide).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
    expect(bytes.correct).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
    expect(bytes).toEqual({ decide: 8642, understand: 3154, verify: 2077, correct: 8995 });
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
  it("v5 (N2) : aucune famille sensible ne disparaît ; énervement et menace jugés par le modèle ; simples mentions ; enquête ; relecture", () => {
    const decide = smartDecidePrompt(), understand = smartUnderstandPrompt(), verify = smartVerifyPrompt();
    for (const family of ["résiliation", "abonnement", "paiement", "facture", "remboursement", "droits sur ses données", "identité ou titulaire du compte", "piratage"]) {
      expect(decide, family).toContain(family);
      expect(understand, family).toContain(family);
    }
    expect(decide).toContain("Même en une ligne, même en PS : tout le mail va à l'équipe");
    expect(understand).toContain("CLIENT TRÈS ÉNERVÉ OU MENAÇANT");
    expect(understand).toContain("Mets alors upset à true");
    expect(understand).toContain("C'est toi qui en juges, pas un mot");
    expect(decide).toContain("s'il est très énervé ou menace (résilier, mauvais avis, avocat, « c'est inadmissible, 3e relance » : raison upset)");
    expect(decide).toContain("« où trouver ma facture ? » ou « le prix d'une intégration » : une simple mention");
    expect(decide).toContain("demande l'URL de la conversation (barre d'adresse) et des captures ; insiste si besoin.");
    expect(decide).toContain("la tâche marche-t-elle en direct dans le chat ?");
    expect(decide).toContain("Charly Max : demande le numéro de téléphone du client.");
    expect(decide).toContain("un jeton (token API)");
    expect(verify).toContain("11. sensitive_commitment");
    expect(verify).toContain("(une simple mention ne compte pas)");
    expect(SAV_SMART_RESOURCES[0]!.whenToOffer).toContain("Ne jamais proposer de rendez-vous individuel");
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
  it("v2 : une étape « final » porte une décision ; « tools » porte 1 à 3 appels ; une décision écrite à plat est lue comme étape finale (v4)", () => {
    expect(parseSmartOutput(smartStepSchema, { thinking: "ok", action: "final", calls: [], decision: smartGoodDecision() }).ok).toBe(true);
    expect(parseSmartOutput(smartStepSchema, { action: "final", calls: [] }).ok).toBe(false);
    expect(parseSmartOutput(smartStepSchema, { action: "tools", calls: [] }).ok).toBe(false);
    // v4 (20/11): a decision written flat is read as a final step (it still goes through every check); a bare string is still refused.
    expect(parseSmartOutput(smartStepSchema, smartGoodDecision())).toMatchObject({ ok: true, value: { action: "final", calls: [] } });
    expect(parseSmartOutput(smartStepSchema, "final").ok).toBe(false);
    const call = (id: string) => ({ id, tool: "chercher_fiches", needId: "n1", args: { recherche: "connexion" } });
    // v4 (20/11): a 4th call is dropped (the runner ran 3 per pass anyway); repeated ids are renumbered t1..tn instead of failing the turn.
    const four = parseSmartOutput(smartStepSchema, { action: "tools", calls: [call("t1"), call("t2"), call("t3"), call("t4")] });
    expect(four.ok && four.value.calls.map(row => row.id)).toEqual(["t1", "t2", "t3"]);
    const twice = parseSmartOutput(smartStepSchema, { action: "tools", calls: [call("t1"), call("t1")] });
    expect(twice.ok && twice.value.calls.map(row => row.id)).toEqual(["t1", "t2"]);
  });
  it("v2 : la note d'équipe est un objet ; une note texte du modèle devient le besoin (jamais perdue)", () => {
    const parsed = parseSmartOutput(smartDecisionSchema, smartGoodDecision({ outcome: "handoff", teamNote: "Le client ne reçoit plus ses mails." }));
    expect(parsed).toMatchObject({ ok: true, value: { teamNote: { besoin: "Le client ne reçoit plus ses mails.", raison: "other", verifie: [] } } });
  });
});
