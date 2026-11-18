// SAV-95: the model decides (stubbed here), the code only checks system limits and coherence. Owner's three examples and natural variants as fixtures. Synthetic.
import { describe, expect, it } from "vitest";
import { decideAckClosure, savAckClosureEnabled, type AckClosureFacts, type SavAckClosureAnalysis } from "./ack-closure-rules";
import { SAV_ACK_CLOSURE_EXAMPLES, savAckClosureGuideline } from "./ack-closure-guidelines";

const OUT = "30000000-0000-4000-8000-000000000001", MID = "30000000-0000-4000-8000-000000000002";
const model = (over: Partial<SavAckClosureAnalysis> = {}): SavAckClosureAnalysis => ({ decision: "close", confidence: "high", lastOutboundMessageId: OUT,
  lastOutboundState: "conclusive", customerMessage: "pure_ack", justification: "Réponse conclusive, simple remerciement.", evidenceQuote: "C'est corrigé", ...over });
const facts = (over: Partial<AckClosureFacts> = {}): AckClosureFacts => ({ v1Acknowledgement: true, customerMessageId: MID, previous: { messageId: OUT, direction: "outbound" },
  newerMessage: false, ticketId: "9001", sensitiveDossier: false, v2Case: false, model: model(), ...over });

describe("guideline", () => {
  it("contains the principles and the owner's three examples, both outcomes", () => {
    const text = savAckClosureGuideline();
    expect(text).toContain("ACK CLOSURE GUIDELINE");
    expect(text).toMatch(/conclusive/); expect(text).toMatch(/unsure/);
    expect(text).toContain("« C'est corrigé, vous pouvez de nouveau utiliser la fonctionnalité. » / Customer: « Ok merci » → close");
    expect(text).toContain("« Non, cette fonctionnalité n'existe pas dans Limova. » / Customer: « Ok merci » → close");
    expect(text).toContain("« C'est transmis à l'équipe technique. » / Customer: « Ok merci » → keep_open");
    expect(SAV_ACK_CLOSURE_EXAMPLES.filter(e => e.decision === "close").length).toBeGreaterThanOrEqual(5);
    expect(SAV_ACK_CLOSURE_EXAMPLES.filter(e => e.decision === "keep_open").length).toBeGreaterThanOrEqual(8);
  });
});

describe("switch", () => {
  it("is on only for exactly SAV_ACK_CLOSE=on", () => {
    expect(savAckClosureEnabled({})).toBe(false);
    for (const value of ["off", "ON", "true", "1", " on"]) expect(savAckClosureEnabled({ SAV_ACK_CLOSE: value })).toBe(false);
    expect(savAckClosureEnabled({ SAV_ACK_CLOSE: "on" })).toBe(true);
  });
});

// The model's stubbed reading of each fixture exchange, as the guideline asks it to answer.
const exchanges: Array<[string, string, string, SavAckClosureAnalysis, boolean]> = [
  ["owner 1", "C'est corrigé", "Ok merci", model(), true],
  ["owner 2", "Non cette feature n'existe pas", "Ok merci", model({ evidenceQuote: "Non cette feature n'existe pas" }), true],
  ["owner 3", "C'est transmis à l'équipe technique", "Ok merci", model({ decision: "keep_open", lastOutboundState: "open", evidenceQuote: "C'est transmis" }), false],
  ["warm thanks", "Voici la marche à suivre", "Super, merci beaucoup pour votre aide, bonne journée !", model({ evidenceQuote: "Voici la marche à suivre" }), true],
  ["explicit resolution after an open reply", "Nous analysons", "C'est bon, ça fonctionne maintenant", model({ lastOutboundState: "open", customerMessage: "confirms_resolved", evidenceQuote: "Nous analysons" }), true],
  ["we come back", "Nous revenons vers vous", "Bien reçu, merci", model({ decision: "keep_open", lastOutboundState: "open" }), false],
  ["question to the customer", "Pouvez-vous nous envoyer une capture ?", "Ok merci", model({ decision: "keep_open", lastOutboundState: "open" }), false],
  ["still broken", "C'est corrigé", "Merci mais ça ne marche toujours pas", model({ decision: "keep_open", customerMessage: "other" }), false],
  ["thanks for the transfer", "Transféré au service concerné", "Merci pour le transfert", model({ decision: "keep_open", lastOutboundState: "open", customerMessage: "other" }), false],
  ["unsure", "C'est corrigé", "ok… on verra", model({ decision: "unsure", confidence: "low", customerMessage: "other" }), false],
  ["close with medium confidence", "C'est corrigé", "Merci, à voir", model({ confidence: "medium" }), false],
  ["incoherent close (open reply + pure ack)", "En cours de correction", "Ok merci", model({ lastOutboundState: "open" }), false],
  ["incoherent close (customer other)", "C'est corrigé", "Merci, et pour l'export ?", model({ customerMessage: "other" }), false],
];

describe("model decision → close or nothing", () => {
  it.each(exchanges)("%s", (_name, _ours, _customer, reading, close) => {
    const decision = decideAckClosure(facts({ model: reading }));
    expect(decision.close).toBe(close);
    if (decision.close) expect(decision.ticketId).toBe("9001");
  });
  it("names the basis", () => {
    expect(decideAckClosure(facts())).toEqual({ close: true, basis: "conclusive_reply_acknowledged", ticketId: "9001" });
    expect(decideAckClosure(facts({ model: model({ customerMessage: "confirms_resolved", lastOutboundState: "unknown" }) })))
      .toEqual({ close: true, basis: "customer_confirms_resolution", ticketId: "9001" });
  });
});

describe("system limits hold whatever the model says", () => {
  const limits: Array<[string, Partial<AckClosureFacts>, string]> = [
    ["V1 did not classify an acknowledgement", { v1Acknowledgement: false }, "v1_not_acknowledgement"],
    ["no ticket on the thread", { ticketId: null }, "no_ticket"],
    ["malformed ticket id", { ticketId: "abc" }, "no_ticket"],
    ["V2 owns the case", { v2Case: true }, "v2_case"],
    ["finance or cancellation on the dossier", { sensitiveDossier: true }, "sensitive_dossier"],
    ["a newer message exists", { newerMessage: true }, "newer_message"],
    ["the previous message is the customer's", { previous: { messageId: OUT, direction: "inbound" } }, "not_a_reply_to_our_outbound"],
    ["no previous message", { previous: null }, "not_a_reply_to_our_outbound"],
    ["no model decision", { model: null }, "model_decision_missing"],
    ["the model judged another outbound", { model: model({ lastOutboundMessageId: MID }) }, "model_outbound_mismatch"],
  ];
  it.each(limits)("%s", (_name, over, reason) => {
    expect(decideAckClosure(facts(over))).toEqual({ close: false, reason });
  });
});

describe("launch configuration and right", () => {
  it("off keeps the previous launch hash; on is a new launch configuration", async () => {
    const { intakeRuntimeConfigurationHash, intakeRuntimeHash, savIntakeRuntimePins } = await import("./runtime-contract");
    const policy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
    const pins = savIntakeRuntimePins.parse({ mailboxId: "30000000-0000-4000-8000-0000000000aa", receivedAfter: "2026-11-18T00:00:00.000Z", createdAfter: "2026-11-18T00:00:00.000Z",
      expiresAt: "2026-11-18T23:00:00.000Z", codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 });
    const environment = { SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake" };
    const hash = intakeRuntimeConfigurationHash(pins, environment);
    expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_ACK_CLOSE: "off" })).toBe(hash);
    expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_ACK_CLOSE: "on" })).not.toBe(hash);
  });
  it("the closure right is a new V1 mutation, accepted by the policy schema", async () => {
    const { savIntakeMutationSchema } = await import("./contract");
    expect(savIntakeMutationSchema.parse("close_acknowledged_ticket")).toBe("close_acknowledged_ticket");
  });
});
