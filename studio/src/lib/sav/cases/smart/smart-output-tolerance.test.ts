import { describe, expect, it } from "vitest";
import { runSmartTurn } from "./smart-agent";
import { parseSmartOutput, smartDecisionSchema, smartReadingSchema, smartStepSchema, smartVerdictSchema } from "./smart-contract";
import { SMART_DECIDE_VARIANTS, SMART_READING_VARIANTS } from "./smart-output-variants.fixture";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge } from "./smart-test-doubles";

/*
 * Shadow diagnosis (20/11): the SHAPE of a well-behaved model answer never fails the turn (contract v4), and what must stay refused stays
 * refused. Every variant here was `output_invalid` (or a `team_sensitive` for `sensible_preuve_null`) under contract v3. Fictional data only.
 */

describe("contrat v4 : une forme plausible du modèle n'est plus « output_invalid »", () => {
  it.each(Object.entries(SMART_DECIDE_VARIANTS))("étape de décision : %s", (_name, output) => {
    expect(parseSmartOutput(smartStepSchema, output).ok).toBe(true);
  });
  it.each(Object.entries(SMART_READING_VARIANTS))("lecture : %s (et « sensible » reste lisible)", (_name, output) => {
    const parsed = parseSmartOutput(smartReadingSchema, output);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.sensible).toEqual({ famille: "aucune", preuve: expect.any(String) });
  });
  it("les textes internes sont coupés à leur borne, jamais refusés ; la réponse au client, elle, n'est jamais coupée", () => {
    const step = parseSmartOutput(smartStepSchema, SMART_DECIDE_VARIANTS.team_note_long_fields);
    expect(step.ok && step.value.decision?.teamNote?.compris.length).toBe(800);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ reply: "x".repeat(6_001) })).ok).toBe(false);
  });
  it("un tools à 4 appels garde les 3 premiers ; des ids libres deviennent t1..t3 ; la décision fictive d'un tools est ignorée", () => {
    const four = parseSmartOutput(smartStepSchema, SMART_DECIDE_VARIANTS.tools_four_calls);
    expect(four.ok && four.value.calls.map(call => call.args.recherche)).toEqual(["imap", "smtp", "port"]);
    const free = parseSmartOutput(smartStepSchema, SMART_DECIDE_VARIANTS.tools_free_call_ids);
    expect(free.ok && free.value.calls.map(call => call.id)).toEqual(["t1"]);
    const placeholder = parseSmartOutput(smartStepSchema, SMART_DECIDE_VARIANTS.tools_with_placeholder_decision);
    expect(placeholder.ok && placeholder.value.decision).toBeNull();
  });
  it("une raison de passage libre devient « other » ; une note sans « besoin » le prend de « compris »", () => {
    const free = parseSmartOutput(smartStepSchema, SMART_DECIDE_VARIANTS.handoff_reason_free_word);
    expect(free.ok && free.value.decision?.handoffReason).toBe("other");
    const note = parseSmartOutput(smartStepSchema, SMART_DECIDE_VARIANTS.team_note_without_besoin);
    expect(note.ok && note.value.decision?.teamNote?.besoin).toBe("Le client veut relier sa boîte IMAP.");
  });
});

describe("contrat v4 : ce qui doit rester refusé reste refusé (sécurité inchangée)", () => {
  it("issue, type de fait ou source inconnus, besoin hors format, plus de 4 besoins, champs de lecture obligatoires absents", () => {
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ outcome: "send" })).ok).toBe(false);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], type: "web" }] })).ok).toBe(false);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], sourceKind: "internet" }] })).ok).toBe(false);
    expect(parseSmartOutput(smartDecisionSchema, smartGoodDecision({ coverage: [{ needId: "x1", status: "answered" }] })).ok).toBe(false);
    const need = (id: string) => ({ id, ask: "a" });
    expect(parseSmartOutput(smartReadingSchema, smartReading({ needs: ["n1", "n2", "n3", "n4", "n5"].map(need) })).ok).toBe(false);
    expect(parseSmartOutput(smartReadingSchema, smartReading({ wantsHuman: undefined })).ok).toBe(false);
    expect(parseSmartOutput(smartReadingSchema, smartReading({ sensitive: null })).ok).toBe(false);
  });
  it("une famille sensible inconnue n'est jamais lue comme « rien de sensible » ; une famille accentuée ou inconnue de « sensible » arrête le mail (équipe)", () => {
    expect(parseSmartOutput(smartReadingSchema, smartReading({ sensitiveFamilies: ["facturation"] })).ok).toBe(false);
    expect(parseSmartOutput(smartReadingSchema, smartReading({ sensitiveFamilies: ["aucune", "Finance"] }))).toMatchObject({ ok: true, value: { sensitiveFamilies: ["finance"] } });
    for (const famille of ["résiliation", "facture", "inconnue"])
      expect(parseSmartOutput(smartReadingSchema, smartReading({ sensible: { famille, preuve: "x" } }))).toMatchObject({ ok: true, value: { sensible: null } });
    expect(parseSmartOutput(smartReadingSchema, smartReading({ sensible: { famille: " Resiliation ", preuve: null } }))).toMatchObject({ ok: true, value: { sensible: { famille: "resiliation", preuve: "" } } });
  });
  it("relecture : un code hors liste refuse quand même (lu « unlisted_claim »), « non_conforme » sans problème reste invalide", () => {
    expect(parseSmartOutput(smartVerdictSchema, { verdict: "non_conforme", problems: [{ code: "tone", sentence: "x" }] }))
      .toMatchObject({ ok: true, value: { verdict: "non_conforme", problems: [{ code: "unlisted_claim" }] } });
    expect(parseSmartOutput(smartVerdictSchema, { verdict: "non_conforme", problems: null }).ok).toBe(false);
    expect(parseSmartOutput(smartVerdictSchema, { verdict: "Conforme", problems: null })).toEqual({ ok: true, value: { verdict: "conforme", problems: [] } });
  });
  it("une chaîne qui n'est pas du JSON reste invalide ; un tableau de deux objets aussi", () => {
    expect(parseSmartOutput(smartStepSchema, "Voici ma réponse : bonjour").ok).toBe(false);
    expect(parseSmartOutput(smartStepSchema, [SMART_DECIDE_VARIANTS.calls_null_on_final, SMART_DECIDE_VARIANTS.calls_null_on_final]).ok).toBe(false);
  });
});

describe("tour complet : un mail IMAP/SMTP ordinaire avec des sorties « à la Gemini »", () => {
  const MAIL = { subject: "Connexion boîte mail", body: "Bonjour,\nJe n'arrive pas à me connecter, j'ai demandé un nouveau code mais rien.\nMerci", thread: [] };
  it("v3 : failed:decide:output_invalid ; v4 : réponse, avec les mêmes contrôles serveur et la même relecture", async () => {
    const gemini = { thinking: "x".repeat(1_400), action: "final", calls: null, decision: smartGoodDecision({ handoffReason: "none", memory: null }) };
    const scripted = smartScriptedModel({ understand: { output: [smartReading({ sensible: { famille: "aucune", preuve: null }, sensitiveFamilies: null })] },
      decide: { output: gemini }, verify: { output: SMART_CONFORME } });
    const result = await runSmartTurn(MAIL, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-20" });
    expect(result.outcome).toBe("reply");
    expect(result.checks.first).toEqual([]);
    expect(scripted.calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
  });
  it("la correction accepte aussi une étape enveloppée dans un tableau", async () => {
    const bad = smartGoodDecision({ reply: "Bonjour, c'est fait, je l'ai activé.", facts: [] });
    const scripted = smartScriptedModel({ understand: { output: smartReading() }, decide: { output: { thinking: "", action: "final", calls: [], decision: bad } },
      verify: { output: SMART_CONFORME }, correct: { output: [{ thinking: "", action: "final", calls: [], decision: smartGoodDecision() }] }, reverify: { output: SMART_CONFORME } });
    const result = await runSmartTurn(MAIL, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-20" });
    expect(result.checks.first).toContain("account_action_claimed");
    expect(result).toMatchObject({ outcome: "reply", corrected: true });
  });
});
