import { describe, expect, it } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot, SAV_CASE_ADMISSION_REVISION, type CaseAdmissionRecord } from "./case-types";
import { buildCaseDecisionContext, type CaseDecisionContextInput } from "./decision-context";
import type { CaseDecisionValidation } from "./decision-contract";
import { validateCaseDecision } from "./decision-validator";

// Synthetic SAV-5 v2 reads only: no database, no customer content.
const now = new Date("2026-10-27T12:00:00Z");
const email = (id: string) => ({ type: "email" as const, id });
const k1 = { knowledgeId: "k1", contentVersionId: "k1-v1" };
const card: SavRetrievalCandidate = {
  id: "k1", contentVersionId: "k1-v1", title: "Fiche k1", content: "Procédure synthétique.", source: "test",
  verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
};
/** A positive pole A admission decided after input version `inputVersion`, under policy "policy-r1". */
const agentAdmission = (inputVersion = 1): CaseAdmissionRecord => ({ revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["usage"],
  sensitivity: "none", policyRevision: "policy-r1", decidedAt: "2026-10-20T09:00:02Z", version: inputVersion + 1, inputVersion,
  qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } });
type LooseBody = Partial<Omit<CaseBody, "openRequests">> & { openRequests?: Array<Omit<CaseBody["openRequests"][number], "openedAt"> & { openedAt?: string }> };
const opened = (body: LooseBody): Partial<CaseBody> => body.openRequests ? { ...body, openRequests: body.openRequests.map(row => ({ openedAt: "2026-10-20T09:00:00Z", ...row })) } : body as Partial<CaseBody>;
function body(patch: LooseBody = {}): CaseBody {
  return { ...emptyCaseBody(), ...opened({ openRequests: [{ id: "r1", summary: "TEXTE-CLIENT demande", family: "usage", status: "open" }], ...patch }) } as CaseBody;
}
function snapshot(patch: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version: 4,
    owner: "agent", phase: "awaiting_customer", sensitivity: "none", createdAt: "2026-10-20T09:00:01Z", updatedAt: "2026-10-22T09:00:01Z",
    body: body(), admission: agentAdmission(), admissionInputVersion: 1, ...patch };
}
let seq = 0;
function event(kind: CaseEvent["kind"], direction: CaseEvent["direction"], occurredAt: string, sourceRef: CaseEvent["sourceRef"], patch: Partial<CaseEvent> = {}): CaseEvent {
  seq += 1;
  return { id: `e${seq}`, caseId: "case-1", kind, dedupeKey: `${kind}:${seq}`, caseVersion: seq, direction, occurredAt, sourceRef, detail: null, createdAt: occurredAt, ...patch };
}
const inbound = (id: string, at: string, patch: Partial<CaseEvent> = {}) => event("inbound_confirmed", "customer_inbound", at, email(id), patch);
function input(patch: Partial<CaseDecisionContextInput> = {}): CaseDecisionContextInput {
  seq = 0;
  return { snapshot: snapshot(), events: [inbound("m1", "2026-10-20T09:00:00Z")], knowledge: [card], locale: "fr-FR", audience: "support",
    admission: { admitted: true }, customerTexts: { "email:m1": "Bonjour, ça ne marche pas.", "email:m2": "Merci, ça remarche." }, ...patch };
}
const decide = (nextAction: Record<string, unknown>, requests: Array<Record<string, unknown>> = [{ id: "r1", summary: "Demande.", family: "usage", status: "open" }]) =>
  ({ caseVersion: 4, understanding: { requests, newFacts: [] }, nextAction });
const codes = (result: CaseDecisionValidation) => result.outcome === "needs_review" ? result.rejections.map(row => row.code) : [];
function validate(proposal: unknown, data: CaseDecisionContextInput) {
  const built = buildCaseDecisionContext(data);
  if (!built.ok) throw new Error(`context refused: ${built.problem}`);
  return validateCaseDecision(proposal, built.context, now);
}
const confirmSpontaneous = (source = email("m2")) => ({ kind: "confirm_resolution", requestIds: ["r1"], evidence: [{ requestId: "r1", source, trialId: null, quote: "ça remarche" }] });

describe("SAV-6 context from a SAV-5 v2 case read", () => {
  it("projects the snapshot and its events without customer text", () => {
    seq = 0;
    const events = [inbound("m1", "2026-10-20T09:00:00Z"), event("outbound_observed", "agent_outbound", "2026-10-21T09:00:00Z", email("a1"))];
    const built = buildCaseDecisionContext(input({
      events,
      snapshot: snapshot({ body: body({
        facts: [{ id: "f1", text: "TEXTE-CLIENT fait", source: email("m1"), at: "2026-10-20T09:00:00Z", key: "observed_result", kind: "customer_statement" }],
        questions: [{ id: "q1", text: "TEXTE-CLIENT question ?", factKeys: ["operation_performed"], askedAt: "2026-10-21T09:00:00Z", askedInEffect: "eff-1" },
          { id: "q2", text: "TEXTE-CLIENT question ?", factKeys: ["error_message"], askedAt: "2026-10-19T09:00:00Z", askedInEffect: "eff-0", answeredBy: email("m1") }],
        trials: [{ id: "t1", requestId: "r1", procedure: k1, askedAt: "2026-10-21T09:00:00Z", outcome: "failed", resultAt: "2026-10-22T09:00:00Z" }],
      }) }),
    }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.context).toMatchObject({
      caseId: "case-1", caseVersion: 4, owner: "agent", admission: { admitted: true }, sensitiveCategories: [],
      requests: [{ id: "r1", family: "usage", status: "open" }],
      sources: [{ ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" }, { ref: email("a1"), direction: "agent_outbound", at: "2026-10-21T09:00:00Z" }],
      facts: [{ id: "f1", key: "observed_result", kind: "customer_statement", source: email("m1"), at: "2026-10-20T09:00:00Z" }],
      questions: [{ id: "q1", factKeys: ["operation_performed"], askedAt: "2026-10-21T09:00:00Z", answeredBy: null },
        { id: "q2", factKeys: ["error_message"], askedAt: "2026-10-19T09:00:00Z", answeredBy: email("m1") }],
      trials: [{ id: "t1", requestId: "r1", knowledge: k1, askedAt: "2026-10-21T09:00:00Z", outcome: "failed", resultAt: "2026-10-22T09:00:00Z" }],
      handoffs: [],
    });
    expect(JSON.stringify(built.context)).not.toContain("TEXTE-CLIENT");
  });

  it.each([
    ["another contract revision", () => ({ snapshot: { ...snapshot(), contractRevision: "sav-case-2026-10-27.v1" as never } }), "contract_revision"],
    ["an invalid body", () => ({ snapshot: snapshot({ body: body({ trials: [{ id: "t1", requestId: "r9", procedure: k1, askedAt: "2026-10-21T09:00:00Z", outcome: "pending", resultAt: null }] }) }) }), "body_invalid"],
    ["an event of another case", () => ({ events: [inbound("m1", "2026-10-20T09:00:00Z", { caseId: "case-2" })] }), "event_other_case"],
    ["an event newer than the snapshot", () => ({ events: [inbound("m1", "2026-10-20T09:00:00Z", { caseVersion: 5 })] }), "event_after_snapshot"],
    ["the same event twice", () => ({ events: [inbound("m1", "2026-10-20T09:00:00Z", { id: "x" }), inbound("m2", "2026-10-21T09:00:00Z", { id: "x" })] }), "event_duplicate"],
    ["a direction its kind cannot have", () => ({ events: [inbound("m1", "2026-10-20T09:00:00Z", { direction: "human_outbound" })] }), "event_direction_invalid"],
    ["two messages with one reference", () => ({ events: [inbound("m1", "2026-10-20T09:00:00Z"), inbound("m1", "2026-10-21T09:00:00Z")] }), "source_duplicate"],
  ])("refuses a read with %s instead of repairing it", (_name, patch, problem) => {
    seq = 0;
    const built = buildCaseDecisionContext(input(patch() as Partial<CaseDecisionContextInput>));
    expect(built).toMatchObject({ ok: false, problem });
  });

  it("gives the validator only the facts still in force: a corrected fact replaces the old one (pole A v5 §7.1)", () => {
    const old = { id: "f1", text: "Navigateur : Safari.", source: email("m1"), at: "2026-10-20T09:00:00Z", key: "browser", kind: "customer_statement" as const };
    const fixed = { ...old, id: "f2", text: "Navigateur : Firefox.", at: "2026-10-21T09:00:00Z", replaces: "f1" };
    const built = buildCaseDecisionContext(input({ snapshot: snapshot({ body: body({ facts: [old, fixed] }) }) }));
    // Q8: the projection keeps the nature of each fact (observed / customer statement).
    expect(built.ok && built.context.facts.map(fact => [fact.id, fact.kind])).toEqual([["f2", "customer_statement"]]);
  });
  it("keeps the message when a sensitive-rule owner change cites the same mail, and counts the change", () => {
    seq = 0;
    const events = [inbound("m1", "2026-10-20T09:00:00Z"), event("owner_changed", "internal", "2026-10-20T09:00:02Z", email("m1"))];
    const built = buildCaseDecisionContext(input({ events, snapshot: snapshot({ owner: "human", phase: "handoff_pending", sensitivity: "finance" }) }));
    expect(built).toMatchObject({ ok: true, context: {
      owner: "human", sensitiveCategories: ["finance"],
      sources: [{ ref: email("m1"), direction: "customer_inbound", at: "2026-10-20T09:00:00Z" }], handoffs: [{ at: "2026-10-20T09:00:02Z" }],
    } });
  });
});

describe("SAV-6 decisions validated on a SAV-5 v2 case read", () => {
  it("closes on a later customer message (spontaneous resolution), with a fresh positive admission", () => {
    seq = 0;
    const result = validate(decide(confirmSpontaneous()), input({ events: [inbound("m1", "2026-10-20T09:00:00Z"), inbound("m2", "2026-10-22T09:00:00Z")] }));
    expect(codes(result)).toEqual([]);
    expect(result.outcome).toBe("accepted");
  });
  it("refuses the same decision without admission, with a stale one, or with a human owner", () => {
    const events = () => { seq = 0; return [inbound("m1", "2026-10-20T09:00:00Z"), inbound("m2", "2026-10-22T09:00:00Z")]; };
    expect(codes(validate(decide(confirmSpontaneous()), { ...input({ admission: null }), events: events() }))).toEqual(["admission_missing"]);
    expect(codes(validate(decide(confirmSpontaneous()), { ...input({ admission: { admitted: false, reason: "input_newer" } }), events: events() }))).toEqual(["admission_stale"]);
    expect(codes(validate(decide(confirmSpontaneous()), { ...input({ snapshot: snapshot({ owner: "human", phase: "human_owned" }) }), events: events() }))).toEqual(["case_not_agent_owned"]);
  });
  it("refuses a 'merci' after a human reply or an owner change recorded as events", () => {
    seq = 0;
    const human = [inbound("m1", "2026-10-20T09:00:00Z"), event("outbound_observed", "human_outbound", "2026-10-21T09:00:00Z", { type: "hubspot_email", id: "h1" }), inbound("m2", "2026-10-22T09:00:00Z")];
    expect(codes(validate(decide(confirmSpontaneous()), { ...input(), events: human }))).toEqual(["resolution_evidence_invalid"]);
    seq = 0;
    const owner = [inbound("m1", "2026-10-20T09:00:00Z"), event("owner_changed", "internal", "2026-10-21T09:00:00Z", { type: "studio_command", id: "cmd-1" }), inbound("m2", "2026-10-22T09:00:00Z")];
    expect(codes(validate(decide(confirmSpontaneous()), { ...input(), events: owner }))).toEqual(["resolution_evidence_invalid"]);
  });
  it("refuses a question already answered by a stored fact key, and a procedure that failed without a new fact", () => {
    seq = 0;
    const stored = input({ snapshot: snapshot({ body: body({
      facts: [{ id: "f1", text: "Résultat synthétique.", source: email("m1"), at: "2026-10-20T09:00:00Z", key: "observed_result", kind: "customer_statement" }],
      trials: [{ id: "t1", requestId: "r1", procedure: k1, askedAt: "2026-10-21T09:00:00Z", outcome: "failed", resultAt: "2026-10-22T09:00:00Z" }],
    }) }) });
    const ask = { kind: "ask", questions: [{ text: "Quel résultat obtenez-vous ?", requestId: "r1", reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result", factKey: "observed_result" }] }] };
    expect(codes(validate(decide(ask), stored))).toEqual(["question_already_answered"]);
    const answer = { kind: "answer", requestIds: ["r1"], steps: [{ text: "Refaire l'étape.", knowledge: k1, newFactIds: [] }], expectedResult: "Cela fonctionne." };
    expect(codes(validate(decide(answer), stored))).toEqual(["repeated_failed_procedure"]);
  });
  it("refuses any agent action on a finance case, even when an admission is (wrongly) positive", () => {
    seq = 0;
    const data = input({ snapshot: snapshot({ sensitivity: "finance", body: body({ openRequests: [{ id: "r1", summary: "Demande.", family: "finance", status: "open" }] }) }) });
    const ask = { kind: "ask", questions: [{ text: "Pouvez-vous préciser ?", requestId: "r1", reducesUncertainty: "Préciser.", seeks: [{ kind: "other" }] }] };
    expect(codes(validate(decide(ask, [{ id: "r1", summary: "Demande.", family: "finance", status: "open" }]), data))).toContain("sensitive_requires_human");
  });
});
