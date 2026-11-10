import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import {
  caseDecisionRejectionLabels, caseDecisionSignalLabels, caseDecisionUnverifiedLabels, SAV_CASE_DECISION_CONTRACT_REVISION,
  type CaseDecisionValidation, type CaseDecisionValidationContext,
} from "./decision-contract";
import { requestsCredential, validateCaseDecision } from "./decision-validator";

// Synthetic fixtures only. Cases C01–C10 are paraphrased patterns from the private scoping, without any customer content.
const now = new Date("2026-10-27T12:00:00Z");
type Context = CaseDecisionValidationContext;
// Fixtures list sources in arrival order; `order` defaults to that position. A date-only handoff has no order.
type Source = Omit<Context["sources"][number], "order"> & { order?: number };
type ContextPatch = Partial<Omit<Context, "sources" | "handoffs">> & { sources?: Source[]; handoffs?: Array<{ at: string; order?: number | null }> };
const THANKS_TEXT = "Bonjour, merci, ça remarche maintenant !";
const email = (id: string) => ({ type: "email" as const, id });
function card(id: string, resolution: Record<string, unknown> = {}, patch: Partial<SavRetrievalCandidate> = {}): SavRetrievalCandidate {
  return { id, contentVersionId: `${id}-v1`, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "test",
    verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null, resolution: { steps: ["Étape synthétique"], ...resolution },
    availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" }, ...patch };
}
function context(patch: ContextPatch = {}): Context {
  const fallback: Source[] = [{ ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" }];
  const { sources: rows = fallback, handoffs = [], ...rest } = patch;
  const sources = rows.map((row, index) => ({ ...row, order: row.order ?? index + 1 }));
  const customerTexts = Object.fromEntries(sources.filter(row => row.direction === "customer_inbound").map(row => [`${row.ref.type}:${row.ref.id}`, THANKS_TEXT]));
  return { caseId: "case-1", caseVersion: 3, owner: "agent", admission: { admitted: true }, locale: "fr-FR", audience: "support", sensitiveCategories: [],
    requests: [{ id: "r1", family: "usage", status: "open" }], customerTexts,
    facts: [], questions: [], trials: [], knowledge: [card("k1"), card("k2")], ...rest,
    sources, handoffs: handoffs.map(row => ({ at: row.at, order: row.order ?? null })) };
}
const request = (id: string, family = "usage", status = "open", extra: Record<string, unknown> = {}) =>
  ({ id, summary: `Demande synthétique ${id}`, family, status, ...extra });
function proposal(nextAction: Record<string, unknown> = { kind: "observe_only" }, patch: Record<string, unknown> = {}) {
  return { caseVersion: 3, understanding: { requests: [request("r1")], newFacts: [] }, nextAction, ...patch };
}
const ref = (id: string) => ({ knowledgeId: id, contentVersionId: `${id}-v1` });
const ask = (seeks: Array<Record<string, unknown>> = [{ kind: "observed_result" }], text = "Quel résultat obtenez-vous après l'opération ?", requestId = "r1") =>
  ({ kind: "ask", questions: [{ text, requestId, reducesUncertainty: "Savoir où l'opération échoue.", seeks }] });
const answer = (knowledge = "k1", newFactIds: string[] = [], requestIds = ["r1"]) =>
  ({ kind: "answer", requestIds, steps: [{ text: "Suivre l'étape de la fiche.", knowledge: ref(knowledge), newFactIds }], expectedResult: "La fonction est disponible." });
const reply = (text: string, extra: Record<string, unknown> = {}) => ({ text, citations: [], impossibilityClaims: [], accountAdvice: "none", ...extra });
const handoff = (reason = "knowledge_missing", extra: Record<string, unknown> = {}, requestIds = ["r1"]) => ({ kind: "handoff", reason, requestIds, report: {
  need: "Besoin synthétique.", expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [],
  expectedIntervention: "Vérification par l'équipe.", knowledge: [], ...extra } });
const confirm = (evidence: Array<Record<string, unknown>>, requestIds = ["r1"]) => ({ kind: "confirm_resolution", requestIds, evidence });
const codes = (result: CaseDecisionValidation) => result.outcome === "needs_review" ? result.rejections.map(row => row.code) : [];
const run = (input: unknown, ctx: Context = context()) => validateCaseDecision(input, ctx, now);
const accepted = (input: unknown, ctx?: Context) => { const result = run(input, ctx); expect(codes(result)).toEqual([]); expect(result.outcome).toBe("accepted"); return result; };

afterEach(() => vi.unstubAllGlobals());

describe("login closure requires the customer's whole, latest positive statement", () => {
  const source = email("new");
  const quote = "Je peux de nouveau utiliser Limova";
  const decision = proposal(confirm([{ requestId: "r1", source, trialId: null, quote }]), { understanding: { requests: [request("r1", "access")], newFacts: [] } });
  const validate = (latest: string) => run(decision, context({
    requests: [{ id: "r1", family: "access", status: "open" }],
    sources: [{ ref: email("old"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" },
      { ref: source, direction: "customer_inbound", at: "2026-10-20T10:00:00Z" }],
    customerTexts: { "email:old": "Connexion impossible.", "email:new": latest },
  }));
  it("accepts a direct statement for independent verification", () => {
    expect(validate(quote + ". Merci !").outcome).toBe("accepted");
  });
  it.each([quote + " ?", quote + ", mais je reste bloqué.", "On me dit « " + quote + " ».", "Toujours bloqué.\n> " + quote,
    quote + ".\n--\nMais non, je reste bloqué."])("refuses an extracted or contradicted quote: %s", text => {
    expect(codes(validate(text))).toContain("resolution_evidence_invalid");
  });
});

describe("SAV-6 decision contract", () => {
  it("accepts an observation and always states what it did not verify", () => {
    const result = accepted(proposal());
    expect(result).toMatchObject({ contractRevision: SAV_CASE_DECISION_CONTRACT_REVISION, unverified: ["request_classification"], signals: [] });
  });
  it.each([
    ["missing action", { caseVersion: 3, understanding: { requests: [], newFacts: [] } }],
    ["unknown action", proposal({ kind: "close_ticket" })],
    ["extra field", proposal({ kind: "observe_only" }, { autonomy: "full" })],
    ["answer without knowledge", proposal({ kind: "answer", requestIds: ["r1"], steps: [{ text: "Étape" }], expectedResult: "ok" })],
    ["question without uncertainty", proposal({ kind: "ask", questions: [{ text: "Quoi ?", requestId: "r1", seeks: [{ kind: "other" }] }] })],
  ])("rejects a malformed proposal (%s) as needs_review, never as a handoff", (_name, input) => {
    const result = run(input);
    expect(result.outcome).toBe("needs_review");
    expect(new Set(codes(result))).toEqual(new Set(["proposal_schema_invalid"]));
  });
  it("gives every reason, judgment and signal a French label", () => {
    for (const labels of [caseDecisionRejectionLabels, caseDecisionUnverifiedLabels, caseDecisionSignalLabels])
      for (const label of Object.values(labels)) expect(label).toMatch(/^[A-ZÀ-Ü][^]{15,}[.:a-z]$/u);
  });
  it("refuses an inconsistent validation context instead of guessing", () => {
    const ctx = context({ trials: [
      { id: "t1", requestId: "r1", knowledge: ref("k1"), askedAt: "2026-10-21T09:00:00Z", outcome: "pending", resultAt: null },
      { id: "t1", requestId: "r1", knowledge: ref("k2"), askedAt: "2026-10-21T09:00:00Z", outcome: "pending", resultAt: null },
    ] });
    expect(codes(run(proposal(), ctx))).toEqual(["context_invalid"]);
    expect(codes(validateCaseDecision(proposal(), context(), new Date("invalid")))).toEqual(["context_invalid"]);
  });
});

describe("SAV-6 structural invariants", () => {
  it("rejects a decision taken on a stale case version", () => {
    expect(codes(run(proposal(ask(), { caseVersion: 2 })))).toEqual(["case_version_stale"]);
    accepted(proposal(ask(), { caseVersion: 3 }));
  });
  it.each(["human", "system_hold"] as const)("only lets the agent observe silently when the owner is %s", owner => {
    const ctx = context({ owner });
    expect(codes(run(proposal(ask()), ctx))).toEqual(["case_not_agent_owned"]);
    expect(codes(run(proposal(handoff()), ctx))).toEqual(["case_not_agent_owned"]);
    accepted(proposal(), ctx);
    expect(codes(run(proposal({ kind: "observe_only" }, { reply: reply("Bonjour") }), ctx))).toEqual(["observe_only_with_reply"]);
  });
  it("rejects references to unknown requests and accepts known ones", () => {
    expect(codes(run(proposal(ask(undefined, undefined, "r9"))))).toEqual(["request_reference_unknown"]);
    accepted(proposal(ask(undefined, undefined, "r1")));
  });
  it("rejects a decision that silently drops a still-open request or repeats one", () => {
    const ctx = context({ requests: [{ id: "r1", family: "usage", status: "open" }, { id: "r2", family: "technical", status: "open" }] });
    expect(codes(run(proposal(ask()), ctx))).toEqual(["open_request_omitted"]);
    const both = { requests: [request("r1"), request("r2", "technical")], newFacts: [] };
    accepted(proposal(ask(), { understanding: both }), ctx);
    expect(codes(run(proposal(ask(), { understanding: { requests: [request("r1"), request("r1"), request("r2", "technical")], newFacts: [] } }), ctx))).toEqual(["request_duplicate"]);
  });
  it("accepts every SAV-5 source type, including CRM objects and timers", () => {
    const sources: Source[] = [
      { ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" },
      { ref: { type: "hubspot_object", id: "o1" }, direction: "internal", at: "2026-10-20T10:00:00Z" },
      { ref: { type: "timer", id: "j2-1" }, direction: "internal", at: "2026-10-20T11:00:00Z" },
    ];
    const newFacts = [{ id: "f1", key: null, statement: "État CRM relu.", kind: "observed", source: { type: "hubspot_object", id: "o1" } }];
    accepted(proposal(ask(), { understanding: { requests: [request("r1")], newFacts } }), context({ sources }));
  });
  it("rejects facts whose source is absent from the case", () => {
    const fact = (source: Record<string, unknown>) => ({ requests: [request("r1")], newFacts: [{ id: "f1", key: null, statement: "Fait synthétique.", kind: "customer_statement", source }] });
    expect(codes(run(proposal(ask(), { understanding: fact(email("m404")) })))).toEqual(["source_reference_unknown"]);
    accepted(proposal(ask(), { understanding: fact(email("m1")) }));
  });
  it("C05: records the customer's own diagnosis as a statement, never as an observed fact", () => {
    const ctx = context({ sources: [
      { ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" },
      { ref: { type: "attachment", id: "m1:2" }, direction: "customer_inbound", at: "2026-10-20T09:00:00Z" },
      // An attachment listed without a direction of its own still belongs to the customer's mail (pole A v7, Q6/Q8).
      { ref: { type: "attachment", id: "m1:3" }, direction: "internal", at: "2026-10-20T09:00:00Z" },
      { ref: { type: "hubspot_note", id: "n1" }, direction: "internal", at: "2026-10-20T09:30:00Z" },
    ] });
    const fact = (kind: string, source: Record<string, unknown>) => ({ requests: [request("r1")], newFacts: [{ id: "f1", key: "error_message", statement: "Cause supposée par le client.", kind, source }] });
    expect(codes(run(proposal(ask([{ kind: "reproduction_steps" }]), { understanding: fact("observed", email("m1")) }), ctx))).toEqual(["customer_statement_as_observed"]);
    accepted(proposal(ask([{ kind: "reproduction_steps" }]), { understanding: fact("customer_statement", email("m1")) }), ctx);
    // Q8 (Ugo 28/10): what the customer shows in a screenshot is a statement too, never a finding.
    for (const id of ["m1:2", "m1:3"]) {
      expect(codes(run(proposal(ask([{ kind: "reproduction_steps" }]), { understanding: fact("observed", { type: "attachment", id }) }), ctx))).toEqual(["customer_statement_as_observed"]);
      accepted(proposal(ask([{ kind: "reproduction_steps" }]), { understanding: fact("customer_statement", { type: "attachment", id }) }), ctx);
    }
    // A finding of the team in a CRM note stays an observation.
    accepted(proposal(ask([{ kind: "reproduction_steps" }]), { understanding: fact("observed", { type: "hubspot_note", id: "n1" }) }), ctx);
  });
});

describe("SAV-6 validated knowledge", () => {
  it("accepts an answer citing an active revision and flags relevance as unverified", () => {
    expect(accepted(proposal(answer("k1"))).unverified).toEqual(["request_classification", "answer_relevance"]);
  });
  it.each([
    ["unknown card", context({ knowledge: [card("k2")] }), "knowledge_reference_unknown", undefined],
    ["other revision", context({ knowledge: [card("k1", {}, { contentVersionId: "k1-v2" })] }), "knowledge_revision_mismatch", undefined],
    ["expired source", context({ knowledge: [card("k1", { validUntil: "2026-10-26" })] }), "knowledge_not_valid", "expired"],
    ["unverified source", context({ knowledge: [card("k1", {}, { verifiedAt: null })] }), "knowledge_not_valid", "unverified"],
    ["stale verification", context({ knowledge: [card("k1", {}, { verifiedAt: "2026-06-01T00:00:00Z" })] }), "knowledge_not_valid", "stale"],
    ["unpublished", context({ knowledge: [card("k1", {}, { availability: { ...card("k1").availability, published: false } })] }), "knowledge_not_valid", "unpublished"],
  ] as const)("rejects an answer citing an %s", (_name, ctx, code, detail) => {
    const result = run(proposal(answer("k1")), ctx);
    expect(codes(result)).toEqual([code]);
    if (detail && result.outcome === "needs_review") expect(result.rejections[0].detail).toBe(detail);
  });
  it("keeps a card valid through its expiry day", () => {
    accepted(proposal(answer("k1")), context({ knowledge: [card("k1", { validUntil: "2026-10-27" })] }));
  });
  it("rejects a card replaced by a newer applicable card", () => {
    const ctx = context({ knowledge: [card("k1"), card("k3", { supersedes: ["k1"] })] });
    expect(codes(run(proposal(answer("k1")), ctx))).toEqual(["knowledge_superseded"]);
    accepted(proposal(answer("k3")), ctx);
  });
  it("contradiction: rejects picking one side and accepts a handoff citing both sources", () => {
    const ctx = context({ knowledge: [card("k1", { conflictsWith: ["k2"] }), card("k2")] });
    const result = run(proposal(answer("k2")), ctx);
    expect(codes(result)).toEqual(["knowledge_conflict"]);
    if (result.outcome === "needs_review") expect(result.rejections[0].detail).toBe("k1|k2");
    accepted(proposal(handoff("knowledge_conflict", { knowledge: [ref("k1"), ref("k2")] })), ctx);
    expect(codes(run(proposal(handoff("knowledge_conflict", { knowledge: [ref("k1")] })), ctx))).toEqual(["handoff_conflict_sources_missing"]);
    expect(codes(run(proposal(handoff("knowledge_conflict", { knowledge: [ref("k1"), ref("k404")] })), ctx))).toEqual(["handoff_report_reference_invalid", "handoff_conflict_sources_missing"]);
  });
  it("does not treat a conflict with an expired card as a live contradiction", () => {
    accepted(proposal(answer("k1")), context({ knowledge: [card("k1", { conflictsWith: ["k2"] }), card("k2", { validUntil: "2026-10-01" })] }));
  });
});

describe("SAV-6 repeated failed procedure (C02)", () => {
  const failed = (requestId = "r1", knowledge = "k1") => ({ id: "t1", requestId, knowledge: ref(knowledge), askedAt: "2026-10-21T09:00:00Z", outcome: "failed" as const, resultAt: "2026-10-22T09:00:00Z" });
  const ctx = (patch: ContextPatch = {}) => context({ trials: [failed()], ...patch });
  it("rejects the same procedure again without a new fact", () => {
    expect(codes(run(proposal(answer("k1")), ctx()))).toEqual(["repeated_failed_procedure"]);
  });
  it("accepts it when a fact recorded after the failure is cited", () => {
    accepted(proposal(answer("k1", ["f1"])), ctx({ facts: [{ id: "f1", key: "error_message", kind: "customer_statement", source: email("m1"), at: "2026-10-23T09:00:00Z" }] }));
  });
  it("accepts a new fact extracted from a message received after the failure", () => {
    const sources: Source[] = [{ ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" }, { ref: email("m2"), direction: "customer_inbound", at: "2026-10-24T09:00:00Z" }];
    const understanding = { requests: [request("r1")], newFacts: [{ id: "f2", key: "error_message", statement: "Nouveau message d'erreur.", kind: "customer_statement", source: email("m2") }] };
    accepted(proposal(answer("k1", ["f2"]), { understanding }), ctx({ sources }));
  });
  it("rejects a 'new' fact that predates the failure or does not exist", () => {
    const facts: Context["facts"] = [{ id: "f0", key: null, kind: "customer_statement", source: email("m1"), at: "2026-10-20T09:00:00Z" }];
    expect(codes(run(proposal(answer("k1", ["f0", "f404"])), ctx({ facts })))).toEqual(["new_fact_reference_invalid", "new_fact_reference_invalid", "repeated_failed_procedure"]);
  });
  it("does not block a different procedure or the same one on another request", () => {
    accepted(proposal(answer("k2")), ctx());
    const two = context({ requests: [{ id: "r1", family: "usage", status: "open" }, { id: "r2", family: "usage", status: "open" }], trials: [failed("r2")] });
    accepted(proposal(answer("k1"), { understanding: { requests: [request("r1"), request("r2")], newFacts: [] } }), two);
  });
});

describe("SAV-6 questions", () => {
  it("C04: rejects asking again for information the customer already gave", () => {
    const facts: Context["facts"] = [{ id: "f1", key: "phone_number", kind: "customer_statement", source: email("m1"), at: "2026-10-20T09:00:00Z" }];
    expect(codes(run(proposal(ask([{ kind: "configuration", factKey: "phone_number" }])), context({ facts })))).toEqual(["question_already_answered"]);
    accepted(proposal(ask([{ kind: "observed_result", factKey: "diagnostic_status" }])), context({ facts }));
  });
  it("C03: keeps the known version and asks about configuration instead", () => {
    const facts: Context["facts"] = [{ id: "f1", key: "app_version", kind: "customer_statement", source: email("m1"), at: "2026-10-20T09:00:00Z" }];
    expect(codes(run(proposal(ask([{ kind: "environment", factKey: "app_version" }])), context({ facts })))).toEqual(["question_already_answered"]);
    accepted(proposal(ask([{ kind: "configuration" }, { kind: "observed_result" }])), context({ facts }));
  });
  it("treats a fact extracted from the current message as already answered", () => {
    const understanding = { requests: [request("r1")], newFacts: [{ id: "f1", key: "error_message", statement: "Message d'erreur fourni.", kind: "customer_statement", source: email("m1") }] };
    expect(codes(run(proposal(ask([{ kind: "error_message", factKey: "error_message" }]), { understanding })))).toEqual(["question_already_answered"]);
  });
  it("rejects re-asking a pending question until the customer has written again", () => {
    const questions: Context["questions"] = [{ id: "q1", factKeys: ["error_message"], askedAt: "2026-10-21T09:00:00Z", answeredBy: null }];
    expect(codes(run(proposal(ask([{ kind: "error_message", factKey: "error_message" }])), context({ questions })))).toEqual(["question_already_pending"]);
    const sources: Source[] = [{ ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" }, { ref: email("m2"), direction: "customer_inbound", at: "2026-10-22T09:00:00Z" }];
    accepted(proposal(ask([{ kind: "error_message", factKey: "error_message" }])), context({ questions, sources }));
  });
  it("lists free-text overlap as unverified rather than pretending to detect it", () => {
    expect(accepted(proposal(ask())).unverified).toContain("question_overlap_semantics");
  });
  it("rejects a declared request for a secret", () => {
    expect(codes(run(proposal(ask([{ kind: "credential" }]))))).toEqual(["credential_requested"]);
  });
});

describe("SAV-6 credential tripwire on outgoing text", () => {
  it.each([
    "Pouvez-vous nous transmettre le code de vérification reçu ?",
    "Envoyez-nous le code reçu par SMS.",
    "Merci de nous indiquer votre mot de passe.",
    "Pourriez-vous me communiquer votre jeton d'accès ?",
    "Indiquez-nous votre code à 6 chiffres.",
    "Veuillez partager votre clé API.",
  ])("blocks %s", text => {
    expect(requestsCredential(text)).toBe(true);
    expect(codes(run(proposal(ask([{ kind: "other" }], text))))).toEqual(["credential_request_pattern"]);
  });
  it.each([
    "Ne communiquez jamais votre mot de passe, même à notre équipe.",
    "Merci de ne pas nous envoyer votre mot de passe.",
    "N'envoyez votre mot de passe à personne, pas même à notre équipe.",
    "Ne nous communiquez votre code de vérification sous aucun prétexte.",
    "Le code de vérification vous est envoyé par e-mail : pensez à vérifier vos indésirables.",
    "Indiquez-nous si vous avez bien reçu le code de vérification.",
    "Pouvez-vous nous indiquer l'adresse e-mail utilisée à l'inscription ?",
    "Envoyez-nous une capture de l'écran d'erreur.",
    "Je n'arrive pas à recevoir le code, pouvez-vous m'aider ?",
  ])("lets through %s", text => {
    expect(requestsCredential(text)).toBe(false);
  });
  // Night 29→30/10: a reply written in English for an English-speaking customer is read by the tripwire too.
  it.each([
    "Please send us your password.",
    "Could you share the verification code you received?",
    "Send us the 2FA code.",
    "Kindly provide your API key.",
    "Can you tell us your login code?",
    "Reply with the code you received by SMS.",
    "Please give me the 6-digit code.",
  ])("blocks in English: %s", text => {
    expect(requestsCredential(text)).toBe(true);
    expect(codes(run(proposal(ask([{ kind: "other" }], text))))).toEqual(["credential_request_pattern"]);
  });
  it.each([
    "Never share your password with anyone, not even our team.",
    "Do not send us your password.",
    "Please don’t send your verification code to anyone.",
    "You will receive a verification code by email.",
    "Enter the verification code on the login page.",
    "Please send us a screenshot of the error.",
    "Let us know if you received the code.",
  ])("lets through in English: %s", text => {
    expect(requestsCredential(text)).toBe(false);
  });
  it("also checks the reply text, without echoing it in the rejection", () => {
    const text = "Bonjour, envoyez-nous votre mot de passe MARQUEUR-PRIVE.";
    const result = run(proposal(ask(), { reply: reply(text) }));
    expect(codes(result)).toEqual(["credential_request_pattern"]);
    expect(JSON.stringify(result)).not.toContain("MARQUEUR-PRIVE");
  });
});

describe("SAV-6 sensitive requests stay human", () => {
  it.each([["finance"], ["cancellation"], ["subscription"], ["rights"], ["identity"]] as const)("case flagged %s: only handoff or observation", category => {
    const ctx = context({ sensitiveCategories: [category] });
    for (const action of [ask(), answer("k1"), confirm([{ requestId: "r1", source: email("m1"), trialId: "t1", quote: "ça remarche" }])])
      expect(codes(run(proposal(action), ctx))).toContain("sensitive_requires_human");
    accepted(proposal(handoff("sensitive_request")), ctx);
    accepted(proposal(), ctx);
  });
  it("M6: a finance request mixed with usage blocks an autonomous answer on the whole case", () => {
    const ctx = context({ requests: [{ id: "r1", family: "usage", status: "open" }, { id: "r2", family: "finance", status: "open" }] });
    const understanding = { requests: [request("r1"), request("r2", "finance")], newFacts: [] };
    expect(codes(run(proposal(answer("k1"), { understanding }), ctx))).toEqual(["sensitive_requires_human"]);
    accepted(proposal(handoff("sensitive_request", {}, ["r1", "r2"]), { understanding }), ctx);
  });
  it("rejects reclassifying a sensitive request as ordinary", () => {
    const ctx = context({ requests: [{ id: "r1", family: "cancellation", status: "open" }] });
    expect(codes(run(proposal(answer("k1")), ctx))).toEqual(["sensitive_request_downgraded", "sensitive_requires_human"]);
  });
  it("C01: subscription-linked access stays human and never advises a new account", () => {
    const understanding = { requests: [request("r1", "subscription")], newFacts: [] };
    const ctx = context({ requests: [{ id: "r1", family: "subscription", status: "open" }] });
    expect(codes(run(proposal(answer("k1"), { understanding }), ctx))).toEqual(["sensitive_requires_human"]);
    accepted(proposal(handoff("sensitive_request"), { understanding, reply: reply("Nous transmettons votre demande à l'équipe.") }), ctx);
    expect(codes(run(proposal(handoff("sensitive_request"), { understanding, reply: reply("Transmis.", { accountAdvice: "new_account" }) }), ctx))).toEqual(["account_advice_forbidden"]);
  });
  it("Q8 (Ugo 28/10): a customer's claim of rights stays a statement and unlocks no rights action", () => {
    const ctx = context({ facts: [{ id: "f1", key: "account_role", kind: "customer_statement", source: email("m1"), at: "2026-10-20T09:00:00Z" }] });
    // "I am the account administrator": recording it as an observation is refused.
    const asObserved = { requests: [request("r1")], newFacts: [{ id: "f2", key: "account_role", statement: "Le client est administrateur.", kind: "observed", source: email("m1") }] };
    expect(codes(run(proposal(ask(), { understanding: asObserved }), ctx))).toEqual(["customer_statement_as_observed"]);
    // Granting the right it claims is a rights request: only the team acts on it, whatever the customer says.
    const grant = { requests: [request("r1"), request("r2", "rights")], newFacts: [] };
    expect(codes(run(proposal(answer("k1"), { understanding: grant }), ctx))).toEqual(["sensitive_requires_human"]);
    accepted(proposal(handoff("sensitive_request", {}, ["r1", "r2"]), { understanding: grant }), ctx);
  });
  it("Q10 (Ugo 28/10): a proposal cannot carry an admission or a qualification of its own", () => {
    const qualification = { requests: [{ requestId: "r1", family: "usage", provenance: { kind: "qualified_rule", ruleId: "rule-1", revision: "1", at: "2026-10-20T09:00:00Z" } }] };
    for (const extra of [{ qualification }, { admission: { target: "agent" } }])
      expect(codes(run(proposal(ask(), extra)))).toEqual(["proposal_schema_invalid"]);
  });
  it("detects a sensitive request first introduced by the proposal", () => {
    const understanding = { requests: [request("r1"), request("r2", "finance")], newFacts: [] };
    expect(codes(run(proposal(answer("k1"), { understanding })))).toEqual(["sensitive_requires_human"]);
  });
});

describe("SAV-6 access path", () => {
  const ctx = context({ requests: [{ id: "r1", family: "access", status: "open" }] });
  const understanding = { requests: [request("r1", "access")], newFacts: [] };
  const withReply = (text: string, extra: Record<string, unknown> = {}) => proposal(ask([{ kind: "account_email" }]), { understanding, reply: reply(text, extra) });
  it("N2: accepts a reply recalling the canonical link", () => {
    accepted(withReply("Connectez-vous sur https://new.limova.ai avec l'adresse d'inscription. Est-ce votre première connexion ? Écrivez-nous à contact@limova.ai si besoin."), ctx);
  });
  it.each([
    ["missing link", "Pouvez-vous réessayer de vous connecter ?", ["access_link_missing"]],
    ["other host", "Connectez-vous sur https://app.limova.ai.", ["access_link_missing", "access_link_invalid"]],
    ["insecure link", "Connectez-vous sur http://new.limova.ai.", ["access_link_missing", "access_link_invalid"]],
    ["extra host", "Connectez-vous sur https://new.limova.ai ou sur limova.ai.", ["access_link_invalid"]],
  ])("rejects %s", (_name, text, expected) => {
    expect(codes(run(withReply(text), ctx))).toEqual(expected);
  });
  // Review B (28/10): the host is read by the URL parser, exactly; a prefix of it is not the canonical link.
  it.each([
    ["a longer host", "Connectez-vous sur https://new.limova.ai.attacker.invalid avec votre adresse.", ["https://new.limova.ai.attacker.invalid"]],
    ["user info", "Connectez-vous sur https://new.limova.ai@attacker.invalid avec votre adresse.", ["https://new.limova.ai@attacker.invalid"]],
    ["user info on the right host", "Connectez-vous sur https://support@new.limova.ai.", ["https://support@new.limova.ai"]],
    ["a port", "Connectez-vous sur https://new.limova.ai:8443.", ["https://new.limova.ai:8443"]],
    ["the host in a path", "Connectez-vous sur https://attacker.invalid/new.limova.ai.", ["https://attacker.invalid/new.limova.ai"]],
    ["a look-alike host", "Connectez-vous sur https://new.limovа.ai.", ["https://new.limovа.ai"]],
    ["a glued scheme", "Connectez-vous sur voir:https://attacker.invalid.", ["https://attacker.invalid"]],
    ["a bare longer host", "Connectez-vous sur new.limova.ai.attacker.invalid.", ["new.limova.ai.attacker.invalid"]],
  ])("rejects a forged canonical link: %s", (_name, text, details) => {
    const result = run(withReply(text), ctx);
    expect(codes(result)).toEqual(["access_link_missing", ...details.map(() => "access_link_invalid")]);
    expect(result.outcome === "needs_review" && result.rejections.filter(row => row.code === "access_link_invalid").map(row => row.detail)).toEqual(details);
  });
  // Night 29→30/10: what the URL parser normalises, what a redirect can hide, and the brand's other names.
  it("reads foreign and full-width hosts as the URL parser does: a foreign letter is another host, full-width letters the same one", () => {
    // Cyrillic і (U+0456): punycode, another host.
    expect(codes(run(withReply("Connectez-vous sur https://new.lіmova.ai."), ctx))).toEqual(["access_link_missing", "access_link_invalid"]);
    // Full-width letters and the ideographic full stop are mapped by the parser to new.limova.ai itself: same destination.
    accepted(withReply("Connectez-vous sur https://ｎｅｗ.limova.ai."), ctx);
    accepted(withReply("Connectez-vous sur https://new.limova。ai ."), ctx);
  });
  it.each([
    ["a redirect in the query", "https://new.limova.ai/?next=https://attacker.invalid"],
    ["an undocumented path", "https://new.limova.ai/invente"],
    ["a redirect parameter", "https://new.limova.ai?redirect_url=attacker"],
    ["a fragment", "https://new.limova.ai/#https://attacker.invalid"],
  ])("rejects a canonical host carrying %s: a redirect could hide behind it", (_name, link) => {
    const result = run(withReply(`Connectez-vous sur ${link} avec votre adresse.`), ctx);
    expect(codes(result)).toEqual(["access_link_missing", "access_link_invalid"]);
  });
  it.each([
    ["another top-level domain", "Connectez-vous sur https://new.limova.ai (et non limova.com).", ["limova.com"]],
    ["a subdomain elsewhere", "Connectez-vous sur https://new.limova.ai ou app.limova.fr.", ["app.limova.fr"]],
    ["a look-alike name", "Connectez-vous sur https://new.limova.ai ou www.limova-login.com.", ["www.limova-login.com"]],
    ["full-width letters", "Connectez-vous sur https://new.limova.ai ou ｌｉｍｏｖａ.com.", ["ｌｉｍｏｖａ.com"]],
    ["another address", "Connectez-vous sur https://new.limova.ai ou écrivez à support@limova.invalid.", ["support@limova.invalid"]],
  ])("rejects the brand's other names written without a scheme: %s", (_name, text, details) => {
    const result = run(withReply(text), ctx);
    expect(codes(result)).toEqual(details.map(() => "access_link_invalid"));
    expect(result.outcome === "needs_review" && result.rejections.map(row => row.detail)).toEqual(details);
  });
  it("still accepts the brand name, the canonical host written bare and a limova.ai address", () => {
    accepted(withReply("L'équipe Limova vous répond : connectez-vous sur https://new.limova.ai (new.limova.ai) ou écrivez à contact@limova.ai. Merci d'utiliser Limova."), ctx);
  });
  it("still finds the canonical link inside sentence punctuation, next to a forged one, and leaves the reply text as written", () => {
    for (const text of ["(https://new.limova.ai).", "« https://new.limova.ai » !", "Lien : https://new.limova.ai/, puis votre adresse.", "HTTPS://NEW.LIMOVA.AI ?", "https://new.limova.ai:443…"])
      accepted(withReply(`Connectez-vous ici ${text}`), ctx);
    const text = "Connectez-vous sur https://new.limova.ai et non sur https://new.limova.ai.attacker.invalid.", input = withReply(text);
    expect(codes(run(input, ctx))).toEqual(["access_link_invalid"]);
    expect(input).toMatchObject({ reply: { text } });
  });
  it("rejects advising a new subscription or account, and allows existing-account access", () => {
    expect(codes(run(withReply("Rendez-vous sur https://new.limova.ai.", { accountAdvice: "new_subscription" }), ctx))).toEqual(["account_advice_forbidden"]);
    accepted(withReply("Rendez-vous sur https://new.limova.ai.", { accountAdvice: "existing_account_access" }), ctx);
  });
  it("accepts the exact official Markdown link and refuses mismatched visible and destination addresses", () => {
    accepted(withReply("Ouvrez [new.limova.ai](https://new.limova.ai)."), ctx);
    for (const link of ["[limova.ai](https://new.limova.ai)", "[new.limova.ai](https://limova.ai)"])
      expect(codes(run(withReply("Ouvrez " + link), ctx))).toContain("access_link_invalid");
  });
  it("does not impose the access link outside the access path", () => {
    accepted(proposal(ask(), { reply: reply("Pouvez-vous préciser l'opération effectuée ?") }));
  });
  it("only signals undeclared subscription wording, without blocking", () => {
    expect(accepted(withReply("Inutile de souscrire à nouveau : connectez-vous sur https://new.limova.ai."), ctx).signals).toEqual(["account_wording_without_advice"]);
  });
});

describe("SAV-6 impossibility claims (C07)", () => {
  const claim = (knowledge: string) => ({ impossibilityClaims: [{ requestId: "r1", statement: "Ce champ n'est pas synchronisé.", knowledge: ref(knowledge) }] });
  it("rejects an impossibility without an applicable card", () => {
    expect(codes(run(proposal(ask(), { reply: reply("Ce champ n'est pas synchronisé.", claim("k404")) })))).toEqual(["impossibility_without_valid_source"]);
    expect(codes(run(proposal(ask(), { reply: reply("Ce champ n'est pas synchronisé.", claim("k1")) }), context({ knowledge: [card("k1", { validUntil: "2026-10-01" })] })))).toEqual(["impossibility_without_valid_source"]);
  });
  it("accepts a cited impossibility but marks the card's support as unverified", () => {
    expect(accepted(proposal(ask(), { reply: reply("Ce champ n'est pas synchronisé.", claim("k1")) })).unverified).toContain("impossibility_statement_support");
  });
  it("accepts a targeted question or a documented handoff when no card covers the capability", () => {
    accepted(proposal(ask([{ kind: "configuration" }, { kind: "other" }])));
    accepted(proposal(handoff("knowledge_missing", { missingInformation: ["Capacité non documentée."] })));
  });
  it("only signals undeclared impossibility wording (judgment to qualify, not a word list that blocks)", () => {
    const result = accepted(proposal(ask(), { reply: reply("Si ce n'est pas possible de votre côté, dites-le-nous.") }));
    expect(result.signals).toEqual(["impossibility_wording_without_claim"]);
  });
});

describe("SAV-44 admission on top of ownership", () => {
  const agentActions = () => [ask(), answer("k1"), handoff(), confirm([{ requestId: "r1", source: email("m1"), trialId: "t1", quote: "ça remarche" }])];
  it.each([
    ["no admission is known", null, "admission_missing"],
    ["the admission is negative", { admitted: false as const, reason: "not_admitted" as const }, "admission_not_positive"],
    ["no admission policy is approved", { admitted: false as const, reason: "policy_missing" as const }, "admission_missing"],
    ["a newer input arrived after the admission", { admitted: false as const, reason: "input_newer" as const }, "admission_stale"],
    ["the admission policy changed", { admitted: false as const, reason: "policy_changed" as const }, "admission_stale"],
  ])("refuses every agent action when %s", (_name, admission, code) => {
    for (const action of agentActions()) expect(codes(run(proposal(action), context({ admission })))).toContain(code);
  });
  it("still lets the agent observe without an admission", () => {
    accepted(proposal(), context({ admission: null }));
    accepted(proposal(), context({ admission: { admitted: false, reason: "not_admitted" } }));
  });
  it("owner=agent with a fresh positive admission is required together", () => {
    accepted(proposal(ask()));
    expect(codes(run(proposal(ask()), context({ owner: "human" })))).toEqual(["case_not_agent_owned"]);
  });
  it("rejects an admission that is not a pole A status as an invalid context", () => {
    expect(codes(run(proposal(), context({ admission: { admitted: "yes" } as never })))).toEqual(["context_invalid"]);
  });
});

describe("SAV-6 resolution and 'merci'", () => {
  const trial = (patch: Partial<Context["trials"][number]> = {}) => ({ id: "t1", requestId: "r1", knowledge: ref("k1"), askedAt: "2026-10-21T09:00:00Z", outcome: "pending" as const, resultAt: null, ...patch });
  const sources = (...rows: Source[]): Source[] => [{ ref: email("m1"), direction: "customer_inbound" as const, at: "2026-10-20T09:00:00Z" }, ...rows];
  const thanks = { ref: email("m2"), direction: "customer_inbound" as const, at: "2026-10-22T09:00:00Z" };
  const evidence = (requestId = "r1", trialId = "t1", source = email("m2"), quote = "ça remarche") => ({ requestId, source, trialId, quote });
  describe("exact quote (Ugo, 27/10/2026)", () => {
    it("accepts the customer's words copied exactly, ignoring case, accents, quotes and spacing", () => {
      for (const quote of ["ça remarche", "CA  REMARCHE maintenant", "« merci, ça remarche »"])
        accepted(proposal(confirm([evidence("r1", "t1", email("m2"), quote)])), context({ trials: [trial()], sources: sources(thanks) }));
    });
    it("matches the customer's words the same way in other languages and scripts (night 29→30/10)", () => {
      const texts = [
        ["Thanks, it works again!", "IT WORKS again"], ["Danke, es funktioniert wieder.", "es funktioniert wieder"], ["Gracias, ya funciona", "ya funcióna"],
        ["شكرا، يعمل الآن", "يعمل الآن"], ["谢谢，现在可以登录了", "现在可以登录了"], ["Спасибо, всё работает", "все работает"],
      ];
      for (const [text, quote] of texts)
        accepted(proposal(confirm([evidence("r1", "t1", email("m2"), quote)])), context({ trials: [trial()], sources: sources(thanks), customerTexts: { "email:m1": "Bonjour.", "email:m2": text } }));
      // Words that are not in the message stay refused, whatever the language.
      expect(codes(run(proposal(confirm([evidence("r1", "t1", email("m2"), "it works")])), context({ trials: [trial()], sources: sources(thanks), customerTexts: { "email:m1": "Bonjour.", "email:m2": "It still does not work." } })))).toEqual(["resolution_quote_not_found"]);
    });
    it("refuses words that are not in that message, or a message whose text could not be read", () => {
      const ctx = context({ trials: [trial()], sources: sources(thanks) });
      expect(codes(run(proposal(confirm([evidence("r1", "t1", email("m2"), "tout est réglé")])), ctx))).toEqual(["resolution_quote_not_found"]);
      expect(codes(run(proposal(confirm([evidence("r1", "t1", email("m2"), "ça ne marche pas")])), ctx))).toEqual(["resolution_quote_not_found"]);
      expect(codes(run(proposal(confirm([evidence()])), { ...ctx, customerTexts: {} }))).toEqual(["resolution_quote_unverifiable"]);
    });
  });
  describe("arrival order instead of message clocks (Ugo, 27/10/2026)", () => {
    it("refuses a closure when a human reply arrived before the thanks, even if its clock says later", () => {
      const human = { ref: { type: "hubspot_email" as const, id: "h1" }, direction: "human_outbound" as const, at: "2026-10-22T10:00:00Z" };
      const ctx = context({ trials: [trial()], sources: sources(human, thanks) });
      expect(codes(run(proposal(confirm([evidence()])), ctx))).toEqual(["resolution_evidence_invalid"]);
    });
    it("accepts it when the human reply arrived after the thanks, even if its clock says earlier", () => {
      const human = { ref: { type: "hubspot_email" as const, id: "h1" }, direction: "human_outbound" as const, at: "2026-10-21T15:00:00Z" };
      accepted(proposal(confirm([evidence()])), context({ trials: [trial()], sources: sources(thanks, human) }));
    });
    it("refuses when a transfer known only by its date has the same date as the thanks (ambiguous => no closure)", () => {
      const ctx = context({ trials: [trial()], sources: sources(thanks), handoffs: [{ at: thanks.at }] });
      expect(codes(run(proposal(confirm([evidence()])), ctx))).toEqual(["resolution_evidence_invalid"]);
      accepted(proposal(confirm([evidence()])), context({ trials: [trial()], sources: sources(thanks), handoffs: [{ at: "2026-10-23T09:00:00Z" }] }));
    });
    it("refuses a context where two sources share an arrival number", () => {
      const result = run(proposal(), context({ sources: [{ ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z", order: 1 }, { ...thanks, order: 1 }] }));
      expect(result).toMatchObject({ outcome: "needs_review", rejections: [{ code: "context_invalid", detail: "order.duplicate" }] });
    });
  });
  it("N3: accepts a customer confirmation that follows the procedure", () => {
    expect(accepted(proposal(confirm([evidence()])), context({ trials: [trial()], sources: sources(thanks) })).unverified).toContain("resolution_semantics");
  });
  it("M3: a thanks after a transfer is not a resolution", () => {
    const ctx = context({ trials: [trial()], sources: sources(thanks), handoffs: [{ at: "2026-10-21T15:00:00Z" }] });
    const result = run(proposal(confirm([evidence()])), ctx);
    expect(codes(result)).toEqual(["resolution_evidence_invalid"]);
    if (result.outcome === "needs_review") expect(result.rejections[0].detail).toBe("human_intervened_after_trial");
  });
  it("M3: a thanks after a human proposed an appointment is not a resolution", () => {
    const ctx = context({ trials: [trial()], sources: sources({ ref: { type: "hubspot_email", id: "h1" }, direction: "human_outbound", at: "2026-10-21T15:00:00Z" }, thanks) });
    expect(codes(run(proposal(confirm([evidence()])), ctx))).toEqual(["resolution_evidence_invalid"]);
  });
  it.each([
    ["no step was ever given", context({ sources: sources(thanks) }), evidence(), "trial_unknown"],
    ["the message predates the step", context({ trials: [trial({ askedAt: "2026-10-23T09:00:00Z" })], sources: sources(thanks) }), evidence(), "evidence_before_trial"],
    ["the step failed afterwards", context({ trials: [trial({ outcome: "failed", resultAt: "2026-10-23T09:00:00Z" })], sources: sources(thanks) }), evidence(), "trial_failed"],
    ["the evidence is our own message", context({ trials: [trial()], sources: sources({ ref: email("m2"), direction: "agent_outbound", at: "2026-10-22T09:00:00Z" }) }), evidence(), "source_not_customer"],
  ])("rejects a resolution when %s", (_name, ctx, item, detail) => {
    const result = run(proposal(confirm([item])), ctx);
    expect(codes(result)).toEqual(["resolution_evidence_invalid"]);
    if (result.outcome === "needs_review") expect(result.rejections[0].detail).toBe(detail);
  });
  it("C08: a subject-only request gets a targeted question, not a resolution", () => {
    accepted(proposal(ask([{ kind: "operation_performed" }, { kind: "observed_result" }], "Quelle opération avez-vous effectuée et quel résultat avez-vous obtenu ?")));
    expect(codes(run(proposal(confirm([{ requestId: "r1", source: email("m1"), trialId: "t1", quote: "ça remarche" }]))))).toEqual(["resolution_evidence_invalid"]);
    const result = run(proposal(confirm([{ requestId: "r1", source: email("m1"), trialId: null, quote: "ça remarche" }])));
    expect(codes(result)).toEqual(["resolution_evidence_invalid"]);
    if (result.outcome === "needs_review") expect(result.rejections[0].detail).toBe("evidence_is_initial_message");
  });
  describe("customer reports it works again without any step from us (closed, decided 27/10/2026)", () => {
    const spontaneous = (source = email("m2")) => ({ requestId: "r1", source, trialId: null, quote: "ça remarche" });
    it("closes the case on a later customer message, the meaning staying a judgment to qualify", () => {
      expect(accepted(proposal(confirm([spontaneous()])), context({ sources: sources(thanks) })).unverified).toContain("resolution_semantics");
      accepted(proposal(ask(undefined, undefined, "r2"), { understanding: { requests: [request("r1", "usage", "open", { status: "resolved", resolvedBy: { source: email("m2"), trialId: null, quote: "ça remarche" } }), request("r2", "integration")], newFacts: [] } }),
        context({ requests: [{ id: "r1", family: "usage", status: "open" }, { id: "r2", family: "integration", status: "open" }], sources: sources(thanks) }));
    });
    it.each([
      ["a transfer happened before", context({ sources: sources(thanks), handoffs: [{ at: "2026-10-21T15:00:00Z" }] }), email("m2"), "human_intervened_before_evidence"],
      ["a human replied before", context({ sources: sources({ ref: { type: "hubspot_email", id: "h1" }, direction: "human_outbound", at: "2026-10-21T15:00:00Z" }, thanks) }), email("m2"), "human_intervened_before_evidence"],
      ["the evidence is our own message", context({ sources: sources({ ref: email("m2"), direction: "agent_outbound", at: "2026-10-22T09:00:00Z" }) }), email("m2"), "source_not_customer"],
    ])("still rejects it when %s", (_name, ctx, source, detail) => {
      const result = run(proposal(confirm([spontaneous(source)])), ctx);
      expect(codes(result)).toEqual(["resolution_evidence_invalid"]);
      if (result.outcome === "needs_review") expect(result.rejections[0].detail).toBe(detail);
    });
    it("still refuses to close while another request stays open", () => {
      const ctx = context({ requests: [{ id: "r1", family: "usage", status: "open" }, { id: "r2", family: "integration", status: "open" }], sources: sources(thanks) });
      expect(codes(run(proposal(confirm([spontaneous()]), { understanding: { requests: [request("r1", "usage"), request("r2", "integration")], newFacts: [] } }), ctx))).toEqual(["other_requests_open"]);
    });
  });
  describe("several requests (C06, C09)", () => {
    const ctx = context({ requests: [{ id: "r1", family: "usage", status: "open" }, { id: "r2", family: "integration", status: "open" }], trials: [trial(), trial({ id: "t2", requestId: "r2" })], sources: sources(thanks) });
    const both = (r1: Record<string, unknown> = {}) => ({ requests: [request("r1", "usage", "open", r1), request("r2", "integration")], newFacts: [] });
    it("rejects closing the case while another request stays open", () => {
      expect(codes(run(proposal(confirm([evidence()]), { understanding: both() }), ctx))).toEqual(["other_requests_open"]);
    });
    it("accepts resolving one request with evidence and continuing on the other", () => {
      accepted(proposal(ask(undefined, undefined, "r2"), { understanding: both({ status: "resolved", resolvedBy: { source: email("m2"), trialId: "t1", quote: "ça remarche" } }) }), ctx);
      accepted(proposal(confirm([evidence(), evidence("r2", "t2")], ["r1", "r2"]), { understanding: both() }), ctx);
    });
    it("rejects marking a request resolved without evidence, or acting on it afterwards", () => {
      expect(codes(run(proposal(ask(undefined, undefined, "r2"), { understanding: both({ status: "resolved" }) }), ctx))).toEqual(["request_resolved_without_evidence"]);
      expect(codes(run(proposal(ask(undefined, undefined, "r1"), { understanding: both({ status: "resolved", resolvedBy: { source: email("m2"), trialId: "t1", quote: "ça remarche" } }) }), ctx))).toEqual(["request_not_open"]);
    });
    it("rejects a confirmation missing evidence for one of its requests", () => {
      const result = run(proposal(confirm([evidence()], ["r1", "r2"]), { understanding: both() }), ctx);
      expect(codes(result)).toEqual(["resolution_evidence_invalid"]);
      if (result.outcome === "needs_review") expect(result.rejections[0].detail).toBe("evidence_missing");
    });
  });
  it("C10: handles the new need without reopening the resolved diagnosis", () => {
    const ctx = context({ requests: [{ id: "r-old", family: "integration", status: "resolved" }, { id: "r2", family: "usage", status: "open" }] });
    const understanding = { requests: [request("r2")], newFacts: [] };
    accepted(proposal(answer("k1", [], ["r2"]), { understanding }), ctx);
    expect(codes(run(proposal(ask(undefined, undefined, "r-old"), { understanding }), ctx))).toEqual(["request_not_open"]);
  });
});

describe("SAV-7 weekend: a card supports only the requests it was retrieved for", () => {
  const coverage = (rows: Array<[string, string[], ("covered" | "no_applicable_knowledge")?]>) =>
    rows.map(([requestId, ids, status]) => ({ requestId, family: "usage" as const, status: status ?? (ids.length ? "covered" as const : "no_applicable_knowledge" as const), knowledge: ids.map(ref), limitations: [] }));
  const two = { requests: [{ id: "r1", family: "usage" as const, status: "open" as const }, { id: "r2", family: "usage" as const, status: "open" as const }] };
  const both = { understanding: { requests: [request("r1"), request("r2")], newFacts: [] } };
  it("given as a plain list (no coverage), the cards are checked as before, with no link rule", () => {
    accepted(proposal(answer("k2")));
  });
  it("an answer step citing a card retrieved for another request is refused with its own code; the linked card is accepted", () => {
    const ctx = context({ ...two, coverage: coverage([["r1", ["k1"]], ["r2", ["k2"]]]) });
    const result = run(proposal(answer("k1", [], ["r2"]), both), ctx);
    expect(result.outcome === "needs_review" && result.rejections.map(row => [row.code, row.path, row.detail])).toEqual([["knowledge_not_linked_to_request", "nextAction.steps.0.knowledge", "k1"]]);
    accepted(proposal(answer("k2", [], ["r2"]), both), ctx);
  });
  it("a reply may cite the card of any open request; an impossibility needs a card retrieved for its own request", () => {
    const ctx = context({ ...two, coverage: coverage([["r1", ["k1"]], ["r2", ["k2"]]]) });
    accepted(proposal(answer("k2", [], ["r2"]), { ...both, reply: reply("Bonjour, voici les étapes.", { citations: [ref("k1"), ref("k2")] }) }), ctx);
    const claim = { impossibilityClaims: [{ requestId: "r2", statement: "Ce champ n'est pas synchronisé.", knowledge: ref("k1") }] };
    expect(codes(run(proposal(answer("k2", [], ["r2"]), { ...both, reply: reply("Ce champ n'est pas synchronisé.", claim) }), ctx))).toEqual(["knowledge_not_linked_to_request"]);
  });
  it("an invalid card keeps its own code: the link rule never hides why a card is refused", () => {
    const ctx = context({ knowledge: [card("k1", { validUntil: "2026-10-01" })], coverage: coverage([["r1", ["k1"]]]) });
    expect(codes(run(proposal(answer("k1")), ctx))).toEqual(["knowledge_not_valid"]);
  });
  it("a handoff for missing knowledge while every handed-off request had cards is measured, never refused", () => {
    const covered = run(proposal(handoff()), context({ coverage: coverage([["r1", ["k1"]]]) }));
    expect(covered).toMatchObject({ outcome: "accepted", signals: ["handoff_knowledge_missing_with_cards"] });
    expect(run(proposal(handoff()), context({ coverage: coverage([["r1", []]]) }))).toMatchObject({ outcome: "accepted", signals: [] });
  });
});

describe("SAV-6 purity", () => {
  const deepFreeze = <T>(value: T): T => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  it("is deterministic, does not mutate its inputs and never touches the network", () => {
    const fetch = vi.fn(() => { throw new Error("network"); });
    vi.stubGlobal("fetch", fetch);
    const ctx = deepFreeze(context({ knowledge: [card("k1", { conflictsWith: ["k2"] }), card("k2")] }));
    const input = deepFreeze(proposal(answer("k1"), { reply: reply("Bonjour", { citations: [ref("k2")] }) }));
    const first = validateCaseDecision(input, ctx, now), second = validateCaseDecision(input, ctx, now);
    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("imports nothing beyond the contract, the fact-key schema, the existing knowledge validity rule and pole A's pure admission rule", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const imports = (file: string) => [...readFileSync(path.join(dir, file), "utf8").matchAll(/from "([^"]+)"/g)].map(match => match[1]).sort();
    // `../message-context`: the shared, pure split of a mail into the customer's own words and what they quote (nothing behind it but the schema library).
    expect(imports("decision-validator.ts")).toEqual(["../message-context", "../request-retrieval", "./decision-contract", "./investigation-access-scope", "./restored-access"]);
    expect(imports("restored-access.ts")).toEqual(["../message-context"]);
    expect(imports("../message-context.ts")).toEqual(["zod"]);
    expect(imports("decision-contract.ts")).toEqual(["../playbook-contract", "../request-retrieval", "./admission-policy", "./case-types", "./investigation-access-scope", "zod"]);
    // Pilot ACCÈS scope (3/11): a pure datum check, nothing behind it but the schema library.
    expect(imports("investigation-access-scope.ts")).toEqual(["zod"]);
    expect(imports("decision-context.ts")).toEqual(["../request-retrieval", "./admission-policy", "./case-types", "./decision-contract"]);
    // Pole A's admission rule is pure: no store, database or clock behind it.
    expect(imports("admission-policy.ts")).toEqual(["./case-types"]);
  });
});
