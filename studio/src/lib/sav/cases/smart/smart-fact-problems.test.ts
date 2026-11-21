import { describe, expect, it } from "vitest";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { smartBenchTurnCodes } from "./smart-bench-agent";
import { smartFactDiagnostics } from "./smart-checks";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * SAV-122 (bench 21/11 v8): `fact_source_invalid` at the second pass (expiree-01, autreoutil-06), `fact_sentence_missing` at the second pass
 * (expiree-05). Proven defect: the correction received `fact_source_invalid` with an EMPTY sentence, so it could not know which fact to fix.
 * The form that escaped is not provable offline (the bench stores no text): closed diagnostic codes now say it. Fictional texts only.
 */
const run = (script: SmartScript, input: SmartTurnInput) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-21" }).then(result => ({ result, calls: scripted.calls }));
};
const MAIL: SmartTurnInput = { subject: "Connexion impossible", body: "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas.", thread: [] };
const SENTENCE = "Si le code n'arrive pas, regardez dans le dossier des indésirables.";
// The rule: a Limova fact must say where it comes from (sourceKind « fiche » + cardId + version + excerpt, or « academy » + toolCallId + excerpt).
const UNSOURCED = { sentence: SENTENCE, needId: "n1", type: "fait_limova", sourceKind: "aucune", cardId: null, version: null, excerpt: null };

describe("fact_source_invalid : la correction sait maintenant QUEL fait réparer", () => {
  it("avant : problème { code, sentence: \"\" } ; maintenant la phrase du fait en cause", async () => {
    const bad = smartGoodDecision({ facts: [...smartGoodDecision().facts, UNSOURCED] });
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: bad }, verify: { output: SMART_CONFORME }, correct: { output: smartGoodDecision() },
      reverify: { output: SMART_CONFORME } }, MAIL);
    expect(result.checks.first).toEqual(["fact_source_invalid"]);
    const correction = calls.find(call => call.kind === "correct")!.payload as { problems: Array<{ code: string; sentence: string }> };
    expect(correction.problems).toEqual([{ code: "fact_source_invalid", sentence: SENTENCE }]);
    expect(result).toMatchObject({ outcome: "reply", corrected: true });
  });
  it("une faute sur une source (extrait absent de la fiche) est nommée aussi", async () => {
    const wrong = smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], excerpt: "un extrait qui n'est pas dans la fiche" }] });
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: wrong }, verify: { output: SMART_CONFORME }, correct: { output: smartGoodDecision() },
      reverify: { output: SMART_CONFORME } }, MAIL);
    const correction = calls.find(call => call.kind === "correct")!.payload as { problems: Array<{ code: string; sentence: string }> };
    expect(correction.problems).toEqual([{ code: "excerpt_not_found", sentence: "Utilisez l'adresse e-mail de votre invitation." }]);
  });
});

describe("diagnostic fermé de la forme du fait raté (jamais son texte)", () => {
  const decision = (reply: string, facts: unknown[]) => smartGoodDecision({ reply, facts }) as Parameters<typeof smartFactDiagnostics>[0];
  const fact = (sentence: string, extra: Record<string, unknown> = {}) => ({ sentence, needId: "n1", type: "conseil", sourceKind: "aucune", cardId: null, version: null, excerpt: null, ...extra });
  it("split : chaque morceau est dans la réponse, séparé ; reworded : la plupart des mots ; absent", () => {
    const reply = "Bonjour,\n1. Ouvrez Charly Max > Canaux > WhatsApp > « Relier un numéro »\n2. Scannez le QR code avec WhatsApp Business\nBelle journée.";
    expect(smartFactDiagnostics(decision(reply, [fact("Ouvrez Charly Max > Canaux > WhatsApp > « Relier un numéro », puis scannez le QR code avec WhatsApp Business.")]), ["n1"])).toEqual(["fact_sentence_form:split"]);
    expect(smartFactDiagnostics(decision(reply, [fact("Scannez ensuite le QR code depuis WhatsApp Business.")]), ["n1"])).toEqual(["fact_sentence_form:reworded"]);
    expect(smartFactDiagnostics(decision(reply, [fact("Le plan Pro vous est offert.")]), ["n1"])).toEqual(["fact_sentence_form:absent"]);
    expect(smartFactDiagnostics(decision(reply, [fact("Scannez le QR code avec WhatsApp Business.")]), ["n1"])).toEqual([]);
  });
  it("fact_shape : seul un fait qui casse la règle de fact_source_invalid est décrit", () => {
    const reply = `Bonjour. ${SENTENCE}`;
    expect(smartFactDiagnostics(decision(reply, [UNSOURCED]), ["n1"])).toEqual(["fact_shape:fait_limova:aucune:card_n:excerpt_n:need_known"]);
    expect(smartFactDiagnostics(decision(reply, [{ ...UNSOURCED, needId: "n2", type: "conseil" }]), ["n1"])).toEqual(["fact_shape:conseil:aucune:card_n:excerpt_n:need_unknown"]);
    expect(smartFactDiagnostics(decision(reply, [{ ...UNSOURCED, sourceKind: "fiche", cardId: "fiche-connexion", version: "v3", excerpt: "vérifiez le dossier des indésirables" }]), ["n1"])).toEqual([]);
  });
  it("le banc reçoit ces codes quand le serveur a refusé un fait, filtrés comme codes fermés", async () => {
    const bad = smartGoodDecision({ facts: [...smartGoodDecision().facts, UNSOURCED] });
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: bad }, verify: { output: SMART_CONFORME }, correct: { output: bad }, reverify: { output: SMART_CONFORME } }, MAIL);
    const codes = smartBenchTurnCodes(result);
    expect(codes).toEqual(expect.arrayContaining(["second:check:fact_source_invalid", "fact_shape:fait_limova:aucune:card_n:excerpt_n:need_known"]));
    expect(codes.every(code => /^[a-z0-9_:.>-]{1,80}$/.test(code))).toBe(true);
  });
});
