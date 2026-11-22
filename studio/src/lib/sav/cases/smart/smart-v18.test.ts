import { describe, expect, it } from "vitest";
import { runSmartTurn, SAV_SMART_MAX_MODEL_CALLS, type SmartTurnInput } from "./smart-agent";
import { smartDropPassages } from "./smart-checks";
import { smartDecisionSchema, type SmartDecision } from "./smart-contract";
import { smartAskedBefore, smartEmptyMemory, smartRepeatCodes, type SmartCaseMemory } from "./smart-memory";
import { smartLenientJson, smartWireResponse, type SmartModelPort } from "./smart-model";
import { SMART_CONFORME, SMART_GOOD_REPLY, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * v18 (bench 22/11): no repeated question (the model is told which questions were already asked), fewer handoffs after a counter-read that refused
 * only a few unsupported passages, and a lenient reading of a decide answer still unreadable after its new attempt. Model doubles, fictional data only.
 */
const MAIL: SmartTurnInput = { subject: "Connexion", body: "Bonjour, je n'arrive pas à me connecter.", thread: [] };
const run = (script: SmartScript, input: SmartTurnInput = MAIL, wrap?: (model: SmartModelPort) => SmartModelPort) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: wrap ? wrap(scripted.model) : scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-22", recordOwn: true })
    .then(result => ({ result, calls: scripted.calls, kinds: scripted.calls.map(call => call.kind) }));
};
const decision = (extra: Record<string, unknown> = {}) => smartDecisionSchema.parse(smartGoodDecision(extra)) as SmartDecision;
const INDESIRABLES = "Si le code n'arrive pas, regardez dans le dossier des indésirables.";
const refuse = (sentence: string, code = "unlisted_claim") => ({ verdict: "non_conforme", problems: [{ code, sentence }] });
const TOOLS = { thinking: "", action: "tools", calls: [{ id: "t1", tool: "chercher_fiches", needId: "n1", args: { query: "connexion" } }], decision: null };

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

describe("2. relecture qui refuse seulement des passages sans source : on les retire et on envoie le reste", () => {
  it("smartDropPassages retire la phrase entière, garde le fait de la fiche et renumérote les étapes", () => {
    const reply = "Bonjour,\n\n1. Ouvrez la page de connexion.\n2. Cliquez sur Paramètres avancés.\n3. Utilisez l'adresse e-mail de votre invitation.\n\nBelle journée.";
    const dropped = smartDropPassages(decision({ reply }), ["Cliquez sur Paramètres avancés"]);
    expect(dropped?.reply).toBe("Bonjour,\n\n1. Ouvrez la page de connexion.\n2. Utilisez l'adresse e-mail de votre invitation.\n\nBelle journée.");
    expect(dropped?.facts).toHaveLength(1);
  });
  it("refusé (null) : passage introuvable, passage qui porte le seul fait de la fiche, plus de la moitié du texte, ou pas une réponse", () => {
    expect(smartDropPassages(decision(), ["Le service est en panne."])).toBeNull();
    expect(smartDropPassages(decision(), ["Utilisez l'adresse e-mail de votre invitation."])).toBeNull();
    expect(smartDropPassages(decision({ reply: "Bonjour. Cliquez ici. Puis là." }), ["Cliquez ici.", "Puis là."])).toBeNull();
    expect(smartDropPassages(decision({ outcome: "ask" }), [INDESIRABLES])).toBeNull();
  });
  it("revue PR #341 : un besoin « asked » garde une phrase en « ? » ; sinon null (chemin existant)", () => {
    const reply = "Bonjour,\n\nUtilisez l'adresse e-mail de votre invitation. Cliquez sur Paramètres avancés.\n\nQuel message s'affiche ?\n\nBelle journée.";
    const asked = [{ needId: "n1", status: "answered" }, { needId: "n2", status: "asked" }];
    expect(smartDropPassages(decision({ reply, coverage: asked }), ["Quel message s'affiche ?"])).toBeNull();
    expect(smartDropPassages(decision({ reply, coverage: asked }), ["Cliquez sur Paramètres avancés."])?.reply).toContain("Quel message s'affiche ?");
    expect(smartDropPassages(decision({ reply }), ["Quel message s'affiche ?"])).not.toBeNull();
  });
  it("revue PR #341 : une introduction « … : » laissée sans étape ni liste après elle → null ; suivie d'une étape restante → retrait accepté", () => {
    const orphan = "Bonjour,\n\nUtilisez l'adresse e-mail de votre invitation. Voici la suite :\n1. Cliquez sur Paramètres avancés.\n\nBelle journée.";
    expect(smartDropPassages(decision({ reply: orphan }), ["Cliquez sur Paramètres avancés."])).toBeNull();
    const kept = "Bonjour,\n\nVoici les étapes :\n1. Cliquez sur Paramètres avancés.\n2. Utilisez l'adresse e-mail de votre invitation.\n\nBelle journée.";
    expect(smartDropPassages(decision({ reply: kept }), ["Cliquez sur Paramètres avancés."])?.reply).toBe("Bonjour,\n\nVoici les étapes :\n1. Utilisez l'adresse e-mail de votre invitation.\n\nBelle journée.");
  });
  it("1re relecture : unlisted_claim sur une phrase → réponse envoyée sans elle, 3 appels, pas de correction", async () => {
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: refuse(INDESIRABLES) } });
    expect(kinds).toEqual(["understand", "decide", "verify"]);
    expect(result.outcome).toBe("reply");
    expect(result.reasons).toContain("correction:passages_dropped");
    expect(result.replyWithFooter).toContain("Utilisez l'adresse e-mail de votre invitation.");
    expect(result.replyWithFooter).not.toContain("indésirables");
  });
  it("sujet-05 / pareil-06 / linkedin-03 : une passe d'outil, la relecture refuse encore une phrase, plus de place pour le resserrement → réponse, pas de passage de main", async () => {
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: [{ output: TOOLS }, { output: smartGoodDecision() }],
      verify: { output: refuse("Le service est en panne.") }, correct: { output: smartGoodDecision() }, reverify: { output: refuse(INDESIRABLES) } });
    expect(kinds).toEqual(["understand", "decide", "decide", "verify", "correct", "reverify"]);
    expect(kinds.length).toBeLessThanOrEqual(SAV_SMART_MAX_MODEL_CALLS);
    expect(result.outcome).toBe("reply");
    expect(result.reasons).toContain("correction:passages_dropped");
    expect(result.reasons).not.toContain("refused_after_correction");
  });
  it("un problème de sécurité (other_platform) ou un code inconnu n'est jamais retiré : passage de main comme avant", async () => {
    for (const verdict of [refuse(INDESIRABLES, "other_platform"), refuse(INDESIRABLES, "tone")]) {
      const { result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: verdict },
        correct: { output: smartGoodDecision() }, reverify: { output: verdict } });
      expect(result.outcome).toBe("handoff");
      expect(result.reasons).not.toContain("correction:passages_dropped");
    }
  });
  it("un contrôle serveur encore en échec après retrait (lien non autorisé) : pas d'envoi", async () => {
    const linked = smartGoodDecision({ reply: `${SMART_GOOD_REPLY}\n\nVoir https://exemple.invalid/aide.` });
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: linked }, verify: { output: refuse(INDESIRABLES) },
      correct: { output: linked }, reverify: { output: refuse(INDESIRABLES) } });
    expect(result.outcome).toBe("handoff");
    expect(result.reasons).not.toContain("correction:passages_dropped");
  });
});

describe("3. décision illisible après la nouvelle tentative : lecture tolérante, jamais de texte non lu", () => {
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
