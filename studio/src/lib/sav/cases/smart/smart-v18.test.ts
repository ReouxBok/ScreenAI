import { describe, expect, it } from "vitest";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { smartDecisionSchema, type SmartDecision } from "./smart-contract";
import { smartAskedBefore, smartEmptyMemory, smartRepeatCodes, type SmartCaseMemory } from "./smart-memory";
import { smartLenientJson, smartWireResponse, type SmartModelPort } from "./smart-model";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * v18 (bench 22/11): no repeated question (the model is told which questions were already asked) and a lenient reading of a decide answer still
 * unreadable after its new attempt. The v18 server-side removal of refused passages was withdrawn in v19 (broken replies on the real-fiche bench).
 * Model doubles, fictional data only.
 */
const MAIL: SmartTurnInput = { subject: "Connexion", body: "Bonjour, je n'arrive pas à me connecter.", thread: [] };
const run = (script: SmartScript, input: SmartTurnInput = MAIL, wrap?: (model: SmartModelPort) => SmartModelPort) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: wrap ? wrap(scripted.model) : scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-22", recordOwn: true })
    .then(result => ({ result, calls: scripted.calls, kinds: scripted.calls.map(call => call.kind) }));
};
const decision = (extra: Record<string, unknown> = {}) => smartDecisionSchema.parse(smartGoodDecision(extra)) as SmartDecision;

describe("1. question déjà posée : donnée au modèle (askedBefore), aucun nouveau refus", () => {
  const asked: SmartCaseMemory = { ...smartEmptyMemory(1), questions: [{ needId: "n1", text: "Pouvez-vous m'envoyer l'URL de la conversation et une capture ?", turn: 1, answered: false }] };
  it("decide reçoit askedBefore quand la mémoire a des questions ; la relecture ne le reçoit pas", async () => {
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } }, { ...MAIL, memory: asked });
    expect(calls[1]!.payload).toMatchObject({ askedBefore: ["Pouvez-vous m'envoyer l'URL de la conversation et une capture ?"] });
    expect(calls[2]!.payload).not.toHaveProperty("askedBefore");
    expect(smartAskedBefore(asked)).toEqual(["Pouvez-vous m'envoyer l'URL de la conversation et une capture ?"]);
  });
  it("sans question en mémoire : pas de champ askedBefore", async () => {
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } });
    expect(calls[1]!.payload).not.toHaveProperty("askedBefore");
  });
  it("le contrôle serveur ne devient pas plus strict : une question restée sans réponse n'est pas un refus", () => {
    expect(smartRepeatCodes(asked, decision({ outcome: "ask", memory: { question: "Pouvez-vous m'envoyer l'URL de la conversation et une capture ?" } }))).toEqual([]);
  });
});

describe("2. décision illisible après la nouvelle tentative : lecture tolérante, jamais de texte non lu", () => {
  const step = { thinking: "", action: "final", calls: [], decision: smartGoodDecision() };
  const unbalanced = JSON.stringify(step).slice(0, -1);
  it("smartLenientJson : accolade finale manquante et virgule finale réparées ; texte coupé dans une chaîne ou rien d'objet : null", () => {
    expect(smartLenientJson(unbalanced)).toEqual(step);
    expect(smartLenientJson('{"a":[1,2,],"b":{"c":1,}')).toEqual({ a: [1, 2], b: { c: 1 } });
    expect(smartLenientJson('{"reply":"Bonjour, vous pou')).toBeNull();
    expect(smartLenientJson("pas de JSON")).toBeNull();
    expect(smartLenientJson('{"a":1} {"b":2}')).toBeNull();
    expect(smartLenientJson('{"a":[1}')).toBeNull();
  });
  it("smartWireResponse : le refus reste un refus, avec la lecture tolérante jointe ; plusieurs objets : rien de joint", () => {
    const envelope = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const cut = smartWireResponse(envelope(unbalanced));
    expect(cut).toMatchObject({ status: "failed", problem: "output_json_invalid:unbalanced", lenient: step });
    const multiple = smartWireResponse(envelope('{"verdict":"conforme"} {"verdict":"non_conforme"}'));
    expect(multiple.status).toBe("failed");
    expect(multiple).not.toHaveProperty("lenient");
  });
  const lenientDecide = (lenient: unknown) => (model: SmartModelPort): SmartModelPort => async call => call.kind === "decide"
    ? { status: "failed", problem: "output_json_invalid:unbalanced", uncertain: false, usage: null, inputBytes: 10, sent: true, lenient }
    : model(call);
  it("pareil-02 : deux réponses illisibles, la seconde lisible avec tolérance → décision lue et contrôlée, réponse envoyée", async () => {
    const { result, kinds } = await run({ understand: { output: smartReading() }, verify: { output: SMART_CONFORME } }, MAIL, lenientDecide(step));
    expect(kinds).toEqual(["understand", "verify"]);
    expect(result.calls.map(call => call.kind)).toEqual(["understand", "decide", "decide", "verify"]);
    expect(result.outcome).toBe("reply");
    expect(result.reasons).toEqual(expect.arrayContaining(["decide:json_retry", "decide:json_lenient"]));
  });
  it("lecture tolérante qui n'est pas une étape valide : arrêt technique comme avant, aucune réponse", async () => {
    const { result } = await run({ understand: { output: smartReading() } }, MAIL, lenientDecide({ thinking: "x" }));
    expect(result.outcome).toBe("failed");
    expect(result.replyWithFooter).toBeNull();
  });
});
