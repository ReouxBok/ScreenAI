import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot } from "../case-types";
import { buildCaseDecisionContext } from "../decision-context";
import { validateCaseDecision } from "../decision-validator";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import { smartCaseDecisionProvider } from "./smart-case-provider";
import {
  SAV_SMART_NO_REPEAT_PROMPT_SHA256, SAV_SMART_REPEAT_MIN_NEW_WORDS, SAV_SMART_REPEAT_MIN_REPLY_WORDS, SAV_SMART_REPEAT_QUESTION_THRESHOLD, SAV_SMART_REPEAT_REPLY_THRESHOLD, smartCardGuidanceLines, smartNoRepeatContext, smartNoRepeatOn,
  smartNoRepeatPromptSha256, smartRepeatedReply, smartTurnPrompts, smartWithCardGuidance,
} from "./smart-no-repeat";
import { smartCorrectionPrompt, smartDecidePrompt, smartPromptSha256, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";
import { SMART_CONFORME, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * Incident 26/11 replayed with FICTIONAL texts: turn 1 answered and asked « un agent de standard téléphonique ou un chatbot ? », the customer answered
 * « oui, les agents que j'avais créés ! », turn 2 sent back the same text and the same question. `SAV_V2_SMART_NO_REPEAT=on`: the repetitive draft is
 * refused, corrected once, and never sent as is. Off: the previous behaviour, byte for byte (prompts, payloads, outcome).
 */

const TURN1 = "Bonjour,\n\nDans Limova 3, vous échangez avec Charly, qui regroupe désormais les capacités de vos anciens assistants. Vos conversations restent accessibles depuis l'historique.\n\nSi vous cherchiez en particulier un agent de standard téléphonique ou un chatbot que vous aviez créé, indiquez-le-moi.\n\nBelle journée.";
const TURN2_QUESTION = "Cherchez-vous un assistant en particulier, comme un agent de standard téléphonique ou un chatbot ?";
const TURN2 = `Bonjour,\n\nDans Limova 3, vous échangez avec Charly, qui regroupe les capacités de vos anciens assistants. Vos conversations restent accessibles depuis l'historique.\n\n${TURN2_QUESTION}\n\nBelle journée.`;
const FIRST_MAIL = "Depuis la mise en ligne de Limova 3.0 nous ne retrouvons plus nos agents créés. Comment faire ?";
const ANSWER = "Oui, c'est ce que je recherche, les agents que j'avais créés !";
const ESCALATION = "S'il cherche un agent téléphonique ou un chatbot existant : transmettre à un conseiller.";
const CARD: SmartSource = {
  cardId: "fiche-charly", version: "v2", title: "Je n'ai plus que Charly : où sont passés mes autres assistants ?",
  content: "Dans Limova 3, vous échangez avec Charly, qui regroupe les capacités de vos anciens assistants.\nCherchez-vous un assistant en particulier, par exemple l'agent téléphonique ou l'agent chatbot ?",
  steps: [], needIds: ["n1"], validUntil: null,
};
const reading = { needs: [{ id: "n1", ask: "retrouver les agents créés avant Limova 3", alreadyDone: [], theme: "limova 3", search: "retrouver agents limova 3" }],
  sensitive: "no", sensitiveFamilies: [], wantsHuman: false, upset: false, instructionInMail: false, sensible: { famille: "aucune", preuve: "" } };
const fact = { sentence: "Dans Limova 3, vous échangez avec Charly.", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-charly", version: "v2",
  excerpt: "Dans Limova 3, vous échangez avec Charly" };
const repetitiveAsk = { outcome: "ask", reply: TURN2, teamNote: null, handoffReason: null, coverage: [{ needId: "n1", status: "asked" }], facts: [fact],
  memory: { newFacts: [], hypotheses: [], trials: [], trialResults: [], question: TURN2_QUESTION } };
const handoff = { outcome: "handoff", reply: "Bonjour,\n\nMerci pour votre réponse. Je transmets votre demande à un conseiller, qui reviendra vers vous pour retrouver votre agent.\n\nBelle journée.",
  teamNote: { raison: "unsure", besoin: "Retrouver un agent téléphonique ou un chatbot créé avant Limova 3.", compris: "Le client confirme chercher les agents qu'il avait créés.", prochaineVerification: "Vérifier l'agent existant du compte." },
  handoffReason: "unsure", coverage: [{ needId: "n1", status: "handed" }], facts: [], memory: null };
const input = (extra: Partial<SmartTurnInput> = {}): SmartTurnInput => ({ subject: "Re: Mes agents", body: ANSWER,
  thread: [{ from: "customer", at: "2026-11-26T10:34:00Z", text: FIRST_MAIL }], ...extra });
const ports = (script: SmartScript, sent: boolean) => {
  const brain = smartScriptedModel(script);
  return { brain, ports: { model: brain.model, knowledge: smartStaticKnowledge([CARD]), maxInputBytes: 200_000, today: "2026-11-26", recordOwn: true,
    ...(sent ? { noRepeat: { sent: [{ at: "2026-11-26T10:49:00Z", text: TURN1 }] } } : {}) } };
};

describe("garde-fou de répétition (similarité, seuils)", () => {
  it("the switch is SAV_V2_SMART_NO_REPEAT=on, nothing else", () => {
    expect(smartNoRepeatOn({ SAV_V2_SMART_NO_REPEAT: "on" })).toBe(true);
    for (const value of [undefined, "", "ON", "true", "1", "shadow"]) expect(smartNoRepeatOn({ SAV_V2_SMART_NO_REPEAT: value })).toBe(false);
  });

  it("the incident: the same question reworded, or the same text, is refused; the thresholds are the documented constants", () => {
    expect(SAV_SMART_REPEAT_REPLY_THRESHOLD).toBe(0.8);
    expect(SAV_SMART_REPEAT_QUESTION_THRESHOLD).toBe(0.7);
    expect(SAV_SMART_REPEAT_MIN_NEW_WORDS).toBe(4);
    expect(SAV_SMART_REPEAT_MIN_REPLY_WORDS).toBe(16);
    expect(smartRepeatedReply({ outcome: "ask", reply: TURN2, memory: repetitiveAsk.memory }, [TURN1])).toEqual({ code: "repeated_reply", sentence: expect.stringContaining("Dans Limova 3") });
    // A question already sent AS a question, asked again with nothing new around it: caught on the question.
    const asked = "Bonjour,\n\nCherchez-vous un assistant en particulier, par exemple un agent de standard téléphonique ou un chatbot ?\n\nBelle journée.";
    expect(smartRepeatedReply({ outcome: "ask", reply: `Bonjour,\n\n${TURN2_QUESTION}\n\nBelle journée.`, memory: { ...repetitiveAsk.memory, question: null } }, [asked]))
      .toEqual({ code: "repeated_reply", sentence: TURN2_QUESTION });
  });

  it("review 26/11, measured false positives, all accepted", () => {
    const none = { ...repetitiveAsk.memory, question: null };
    // « dites-moi si cela fonctionne » after a NEW procedure.
    const before = "Bonjour,\n\nOuvrez les Paramètres, puis l'onglet Intégrations, et cliquez sur Reconnecter Google.\n\nDites-moi si cela fonctionne.";
    const next = "Bonjour,\n\nMerci pour votre retour. Essayez maintenant depuis le navigateur Chrome : videz le cache, déconnectez-vous puis reconnectez votre compte Outlook dans Comptes connectés.\n\nDites-moi si cela fonctionne.";
    expect(smartRepeatedReply({ outcome: "reply", reply: next, memory: none }, [before])).toBeNull();
    // « capture » against « message d'erreur ».
    expect(smartRepeatedReply({ outcome: "ask", reply: "Bonjour,\n\nPouvez-vous m'envoyer une capture de l'écran qui s'affiche ?", memory: none },
      ["Bonjour,\n\nPouvez-vous m'envoyer le message d'erreur exact qui s'affiche à l'écran ?"])).toBeNull();
    // « email » against « entreprise ».
    expect(smartRepeatedReply({ outcome: "ask", reply: "Bonjour,\n\nQuel est le nom de l'entreprise utilisée pour vous connecter ?", memory: none },
      ["Bonjour,\n\nQuelle est l'adresse email utilisée pour vous connecter ?"])).toBeNull();
    // A short courtesy reply resembles every other one.
    expect(smartRepeatedReply({ outcome: "reply", reply: "Bonjour,\n\nAvec plaisir, belle journée à vous !", memory: none }, ["Bonjour,\n\nAvec plaisir, très belle journée à vous."])).toBeNull();
  });

  it("a reply that moves on, a follow-up check, a handoff or a first turn are accepted", () => {
    const moveOn = "Bonjour,\n\nMerci, c'est noté : vous cherchez l'agent téléphonique que vous aviez configuré. Ouvrez le menu Agents puis l'onglet Téléphonie pour le retrouver.\n\nBelle journée.";
    expect(smartRepeatedReply({ outcome: "reply", reply: moveOn, memory: { ...repetitiveAsk.memory, question: null } }, [TURN1])).toBeNull();
    const followUp = "Bonjour,\n\nAvez-vous pu ouvrir les paramètres de votre agent téléphonique ?";
    expect(smartRepeatedReply({ outcome: "ask", reply: followUp, memory: { ...repetitiveAsk.memory, question: null } }, ["Bonjour,\n\nOuvrez les paramètres de votre agent téléphonique depuis le menu."])).toBeNull();
    expect(smartRepeatedReply({ outcome: "handoff", reply: TURN1, memory: repetitiveAsk.memory }, [TURN1])).toBeNull();
    expect(smartRepeatedReply({ outcome: "ask", reply: TURN2, memory: repetitiveAsk.memory }, [])).toBeNull();
  });

  it("the view pairs each sent reply with the customer's answer and the card passages it already used (the diagnostic question shown as asked)", () => {
    const context = smartNoRepeatContext({ sent: [{ at: "2026-11-26T10:49:00Z", text: TURN1 }] }, input().thread, ANSWER);
    expect(context.view).toEqual([{ envoyeLe: "2026-11-26T10:49:00Z", texte: TURN1, reponseDuClient: ANSWER }]);
    expect(context.viewWithCards([CARD])[0]).toMatchObject({ passagesDejaUtilises: expect.arrayContaining([{ cardId: "fiche-charly", passage: expect.stringContaining("Cherchez-vous un assistant") }]) });
    // A support message of the thread (threadless cases) is counted once, even when the port also has it; a later customer mail answers it.
    const twice = smartNoRepeatContext({ sent: [{ at: "2026-11-26T10:49:00Z", text: TURN1 }] },
      [...input().thread, { from: "support", at: "2026-11-26T10:49:00Z", text: TURN1 }, { from: "customer", at: "2026-11-26T10:50:00Z", text: "Oui, l'agent téléphonique." }], ANSWER);
    expect(twice.view).toEqual([{ envoyeLe: "2026-11-26T10:49:00Z", texte: TURN1, reponseDuClient: "Oui, l'agent téléphonique." }]);
  });

  it("the card's structured escalation and exceptions are given, labelled, only when its text lacks them", () => {
    const resolution = { steps: [], escalation: ESCALATION, exceptions: ["Agent téléphonique ou chatbot existant introuvable : transmettre à un conseiller."],
      delivery: { groups: [{ escalation: ESCALATION, exceptions: [] }], steps: [] } };
    expect(smartCardGuidanceLines(resolution)).toEqual([`Escalade : ${ESCALATION}`, "Exception : Agent téléphonique ou chatbot existant introuvable : transmettre à un conseiller."]);
    expect(smartWithCardGuidance(CARD, resolution).content).toBe(`${CARD.content}\n\nConsignes de la fiche :\nEscalade : ${ESCALATION}\nException : Agent téléphonique ou chatbot existant introuvable : transmettre à un conseiller.`);
    expect(smartWithCardGuidance({ ...CARD, content: `${CARD.content}\n${ESCALATION}` }, { steps: [], escalation: ESCALATION })).toEqual({ ...CARD, content: `${CARD.content}\n${ESCALATION}` });
    expect(smartWithCardGuidance(CARD, null)).toBe(CARD);
  });

  it("off: the prompts are the pinned ones (eb8f8f00…); on: each one followed by its no-repeat part, pinned separately", () => {
    expect(smartPromptSha256()).toBe("eb8f8f0057c1208dc24255bec44553250f2d0acbefcd8993a85930fcdeb0ece8");
    expect(smartTurnPrompts(false)).toEqual({ understand: smartUnderstandPrompt(), decide: smartDecidePrompt(), correct: smartCorrectionPrompt(), verify: smartVerifyPrompt() });
    const on = smartTurnPrompts(true);
    expect(on.decide.startsWith(`${smartDecidePrompt()}\n\nDÉJÀ ENVOYÉ`)).toBe(true);
    expect(on.verify).toContain("13. repeated_reply");
    expect(on.correct).toContain("repeated_reply :");
    expect(smartNoRepeatPromptSha256()).toBe(SAV_SMART_NO_REPEAT_PROMPT_SHA256);
  });
});

describe("incident 26/11 de bout en bout (fictif)", () => {
  const script = (correct: unknown): SmartScript => ({ understand: { output: reading }, decide: { output: repetitiveAsk }, verify: { output: SMART_CONFORME },
    correct: { output: correct }, reverify: { output: SMART_CONFORME } });

  it("on: the repetitive draft is refused even though the counter-read says « conforme »; the correction repeats again: the team, with the reason", async () => {
    const { brain, ports: p } = ports(script(repetitiveAsk), true);
    const result = await runSmartTurn(input(), p);
    expect(result).toMatchObject({ outcome: "handoff", replyWithFooter: null, corrected: true, checks: { first: ["repeated_reply"], second: ["repeated_reply"] } });
    expect(result.reasons).toEqual(expect.arrayContaining(["no_repeat:on", "refused_after_correction", "check:repeated_reply"]));
    const decide = brain.calls.find(call => call.kind === "decide")!;
    expect(decide.payload).toMatchObject({ alreadySent: [{ envoyeLe: "2026-11-26T10:49:00Z", texte: TURN1, reponseDuClient: ANSWER }] });
    expect(decide.system).toBe(smartTurnPrompts(true).decide);
    expect(brain.calls.find(call => call.kind === "understand")!.payload).toMatchObject({ alreadySent: [{ reponseDuClient: ANSWER }] });
    expect(brain.calls.find(call => call.kind === "verify")!.payload).toMatchObject({ alreadySent: [{ texte: TURN1 }] });
    expect((brain.calls.find(call => call.kind === "correct")!.payload as { problems: unknown[] }).problems).toEqual(expect.arrayContaining([{ code: "repeated_reply", sentence: expect.any(String) }]));
  });

  it("on: a correction that hands over (what the card's escalation says) is accepted", async () => {
    const { ports: p } = ports(script(handoff), true);
    const result = await runSmartTurn(input(), p);
    expect(result).toMatchObject({ outcome: "handoff", corrected: true, checks: { first: ["repeated_reply"], second: [] } });
    expect(result.replyWithFooter).toContain("Je transmets votre demande à un conseiller");
  });

  it("on: the counter-read's own repeated_reply also refuses (no narrowing correction: it is not a grounding problem)", async () => {
    const moveOn = { ...repetitiveAsk, outcome: "reply", reply: "Bonjour,\n\nDans Limova 3, vous échangez avec Charly. Ouvrez le menu Agents pour retrouver votre agent.\n\nBelle journée.", memory: null, coverage: [{ needId: "n1", status: "answered" }] };
    const refused = { verdict: "non_conforme", problems: [{ code: "repeated_reply", sentence: "Ouvrez le menu Agents" }] };
    const { brain, ports: p } = ports({ understand: { output: reading }, decide: { output: moveOn }, verify: { output: refused }, correct: { output: moveOn }, reverify: { output: refused } }, true);
    const result = await runSmartTurn(input(), p);
    expect(result).toMatchObject({ outcome: "handoff", replyWithFooter: null });
    expect(result.reasons).toEqual(expect.arrayContaining(["verify:repeated_reply"]));
    expect(brain.calls.filter(call => call.kind === "correct")).toHaveLength(1);
  });

  it("off: the previous behaviour, the same ask is sent (prompts and payloads without any no-repeat part)", async () => {
    const { brain, ports: p } = ports(script(repetitiveAsk), false);
    const result = await runSmartTurn(input(), p);
    expect(result).toMatchObject({ outcome: "ask", corrected: false, checks: { first: [] } });
    expect(result.replyWithFooter).toContain(TURN2_QUESTION);
    expect(result.reasons).not.toContain("no_repeat:on");
    for (const call of brain.calls) expect(JSON.stringify(call.payload)).not.toContain("alreadySent");
    expect(brain.calls.map(call => call.system)).toEqual([smartUnderstandPrompt(), smartDecidePrompt(), smartVerifyPrompt()]);
  });
});

describe("incident 26/11 par le fournisseur du circuit (fictif)", () => {
  const card = { id: "fiche-charly", contentVersionId: "v2", title: CARD.title, source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore: null, content: CARD.content,
    resolution: { steps: [], escalation: ESCALATION, exceptions: [] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
  const event = (id: string, version: number, at: string): CaseEvent => ({ id, caseId: "case-1", kind: "inbound_confirmed", dedupeKey: `inbound:${id}`, caseVersion: version, direction: "customer_inbound",
    occurredAt: at, sourceRef: { type: "email", id }, detail: null, createdAt: at });
  const request = (): CaseInvestigationModelRequest => ({
    purpose: "decision", caseId: "case-1", caseVersion: 6, inputKey: "in:m2", call: 1, subjectKey: "s", callKey: "s:call1", caseBudgetKey: "sav-case:case-1",
    snapshot: { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "t-1", threadIds: ["th-1"], version: 6, owner: "agent", phase: "queued", sensitivity: "none",
      createdAt: "2026-11-26T10:34:00Z", updatedAt: "2026-11-26T10:50:00Z", admissionInputVersion: 1, admission: { admission: "smart_support" },
      body: { ...emptyCaseBody(), openRequests: [{ id: "r1", family: "other", status: "open", openedAt: "2026-11-26T10:34:00Z" }],
        questions: [{ id: "procedure:e1", text: "Suivi de la réponse envoyée.", factKeys: [], askedAt: "2026-11-26T10:49:00Z", askedInEffect: "e1" }] } as unknown as CaseBody } as unknown as CaseSnapshot,
    events: [event("m1", 1, "2026-11-26T10:34:00Z"), event("m2", 5, "2026-11-26T10:50:00Z")], knowledge: [card], coverage: null, feedback: [], closure: [],
    customerContext: { latestMessage: { at: "2026-11-26T10:50:00Z", from: "customer", text: ANSWER, truncated: false, subject: "Re: Mes agents", instructionLikeText: false },
      thread: [{ at: "2026-11-26T10:34:00Z", from: "customer", text: FIRST_MAIL, truncated: false }] } as unknown as CaseInvestigationModelRequest["customerContext"],
  });
  const run = (env: Record<string, string>, correct: unknown) => {
    const brain = smartScriptedModel({ understand: { output: reading }, decide: { output: repetitiveAsk }, verify: { output: SMART_CONFORME }, correct: { output: correct }, reverify: { output: SMART_CONFORME } });
    const sentReplies = vi.fn(async () => [{ at: "2026-11-26T10:49:00Z", text: TURN1 }]);
    const provider = smartCaseDecisionProvider({ model: brain.model, env: () => ({ SAV_V2_ENTRY_SMART: "on", ...env }), now: () => new Date("2026-11-26T10:55:00Z"), maxInputBytes: () => 200_000, sentReplies });
    return { brain, sentReplies, out: provider(request()) };
  };

  it("on: the sent reply is read, the card's escalation and the answered follow-up are given, the repetitive ask becomes a handoff (never an ask)", async () => {
    const { brain, sentReplies, out } = run({ SAV_V2_SMART_NO_REPEAT: "on" }, repetitiveAsk);
    const result = await out;
    expect(sentReplies).toHaveBeenCalledWith("case-1");
    expect(result.result).toMatchObject({ status: "ok", output: { nextAction: { kind: "handoff" } } });
    const payload = brain.calls.find(call => call.kind === "decide")!.payload as { cards: Array<{ content: string }>; memory: { questions: Array<{ answered: boolean }> }; alreadySent: unknown };
    expect(payload.cards[0]!.content).toContain(`Consignes de la fiche :\nEscalade : ${ESCALATION}`);
    expect(payload.memory.questions).toEqual([{ text: "Suivi de la réponse envoyée.", answered: true }]);
    expect(payload.alreadySent).toMatchObject([{ texte: TURN1, reponseDuClient: ANSWER }]);
  });

  it("off: the sent replies are never read and the same ask goes out, as before", async () => {
    const { brain, sentReplies, out } = run({}, repetitiveAsk);
    const result = await out;
    expect(sentReplies).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ status: "ok", output: { nextAction: { kind: "ask" } } });
    const payload = brain.calls.find(call => call.kind === "decide")!.payload as { cards: Array<{ content: string }>; memory: { questions: Array<{ answered: boolean }> } };
    expect(payload.cards[0]!.content).toBe(CARD.content);
    expect(payload.memory.questions).toEqual([{ text: "Suivi de la réponse envoyée.", answered: false }]);
  });

  it("on: a failed read of the sent replies never stops the turn (the thread's own messages only)", async () => {
    const brain = smartScriptedModel({ understand: { output: reading }, decide: { output: repetitiveAsk }, verify: { output: SMART_CONFORME } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const provider = smartCaseDecisionProvider({ model: brain.model, env: () => ({ SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_NO_REPEAT: "on" }), now: () => new Date("2026-11-26T10:55:00Z"),
      maxInputBytes: () => 200_000, sentReplies: async () => { throw new Error("SAV_TEST_READ_FAILED"); } });
    const result = await provider(request());
    expect(result.result).toMatchObject({ status: "ok", output: { nextAction: { kind: "ask" } } });
    expect(warn).toHaveBeenCalledWith("sav_smart_sent_replies_unavailable", { caseId: "case-1", code: "SAV_TEST_READ_FAILED" });
    warn.mockRestore();
  });
});

describe("incident 26/11 du fournisseur au validateur, relance avant transfert allumée (fictif)", () => {
  const card = { id: "fiche-charly", contentVersionId: "v2", title: CARD.title, source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore: null, content: CARD.content,
    resolution: { steps: [], escalation: ESCALATION, exceptions: [] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
  const ev = (seq: number, kind: CaseEvent["kind"], direction: CaseEvent["direction"], id: string, at: string): CaseEvent =>
    ({ id: `e${seq}`, caseId: "case-1", kind, dedupeKey: `${kind}:${seq}`, caseVersion: seq, direction, occurredAt: at, sourceRef: { type: "email", id }, detail: null, createdAt: at });
  const events = [ev(1, "inbound_confirmed", "customer_inbound", "m1", "2026-11-26T10:34:00Z"), ev(2, "outbound_observed", "agent_outbound", "a1", "2026-11-26T10:49:00Z"),
    ev(3, "inbound_confirmed", "customer_inbound", "m2", "2026-11-26T10:50:00Z")];
  const body = { ...emptyCaseBody(), openRequests: [{ id: "r1", summary: "Retrouver les agents créés avant Limova 3.", family: "other", status: "open", openedAt: "2026-11-26T10:34:00Z" }],
    trials: [{ id: "t1", requestId: "r1", procedure: { knowledgeId: "fiche-charly", contentVersionId: "v2" }, askedAt: "2026-11-26T10:49:00Z", outcome: "pending", resultAt: null }],
    questions: [{ id: "procedure:e1", text: "Suivi de la réponse envoyée.", factKeys: [], askedAt: "2026-11-26T10:49:00Z", askedInEffect: "e1" },
      { id: "in:e2:q1", text: "Si vous cherchiez en particulier un agent de standard téléphonique ou un chatbot que vous aviez créé, indiquez-le-moi.", factKeys: [], askedAt: "2026-11-26T10:49:00Z", askedInEffect: "e1" }] } as unknown as CaseBody;
  const snapshot = { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "t-1", threadIds: ["th-1"], version: 3, owner: "agent", phase: "queued", sensitivity: "none",
    createdAt: "2026-11-26T10:34:00Z", updatedAt: "2026-11-26T10:50:00Z", admissionInputVersion: 1, admission: { target: "agent", admission: "smart_support", qualification: { requests: [], identity: { status: "unknown" }, crmContext: "complete", teamSignals: [] } },
    body } as unknown as CaseSnapshot;
  const request = (): CaseInvestigationModelRequest => ({ purpose: "decision", caseId: "case-1", caseVersion: 3, inputKey: "in:m2", call: 1, subjectKey: "s", callKey: "s:call1",
    caseBudgetKey: "sav-case:case-1", snapshot, events, knowledge: [card], coverage: null, feedback: [], closure: [],
    customerContext: { latestMessage: { at: "2026-11-26T10:50:00Z", from: "customer", text: ANSWER, truncated: false, subject: "Re: Mes agents", instructionLikeText: false },
      thread: [{ at: "2026-11-26T10:34:00Z", from: "customer", text: FIRST_MAIL, truncated: false }] } as unknown as CaseInvestigationModelRequest["customerContext"] });
  const validate = (proposal: unknown) => {
    const built = buildCaseDecisionContext({ snapshot, events, knowledge: [card], locale: "fr-FR", audience: "support", admission: { admitted: true },
      customerTexts: { "email:m1": FIRST_MAIL, "email:m2": ANSWER } });
    if (!built.ok) throw new Error(built.problem);
    return { context: built.context, validation: validateCaseDecision(proposal, built.context, new Date("2026-11-26T10:56:00Z")) };
  };
  const signals = (validation: ReturnType<typeof validate>["validation"]) => validation.outcome === "accepted" ? validation.signals : [];
  afterEach(() => vi.unstubAllEnvs());

  it("on: the repeated_reply hand-over reaches the team as a hand-over, never a re-ask of the answered question", async () => {
    vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", "on");
    vi.stubEnv("SAV_V2_SMART_NO_REPEAT", "on");
    const brain = smartScriptedModel({ understand: { output: reading }, decide: { output: repetitiveAsk }, verify: { output: SMART_CONFORME }, correct: { output: repetitiveAsk }, reverify: { output: SMART_CONFORME } });
    const out = await smartCaseDecisionProvider({ model: brain.model, env: () => ({ SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_NO_REPEAT: "on" }), now: () => new Date("2026-11-26T10:55:00Z"),
      maxInputBytes: () => 200_000, sentReplies: async () => [{ at: "2026-11-26T10:49:00Z", text: TURN1 }] })(request());
    if (out.result.status !== "ok") throw new Error(out.result.status);
    expect(out.result.output).toMatchObject({ nextAction: { kind: "handoff", reason: "diagnosis_out_of_tools" } });
    const { context, validation } = validate(out.result.output);
    expect(context.smartNoRepeat).toBe(true);
    expect(validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "handoff" } } });
    expect(signals(validation)).not.toContain("handoff_reask_composed");
  });

  it("smart switch off: the context keeps main's shape and the same hand-over is still turned into the re-ask, as before", () => {
    vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", "on");
    const proposal = { caseVersion: 3, understanding: { requests: [{ id: "r1", summary: "Retrouver les agents créés avant Limova 3.", family: "other", status: "open" }], newFacts: [] },
      nextAction: { kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: ["r1"], report: { need: "Retrouver les agents.", expected: null, observed: null, trialIds: [], hypotheses: [],
        missingInformation: [], expectedIntervention: "Vérifier côté équipe.", knowledge: [] } } };
    const { context, validation } = validate(proposal);
    expect("smartNoRepeat" in context).toBe(false);
    expect(signals(validation)).toContain("handoff_reask_composed");
  });
});
