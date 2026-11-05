import { describe, expect, it } from "vitest";
import { authorizeCaseReplyDecision, type CaseReplyAuthorizationRequest } from "./case-reply-validation";
import type { CaseEffectLedgerState } from "./case-effects";
import {
  ACCESS_AUTO_APPROVAL_BASIS, caseTicketStageKey, customerMailOrder, decideAccessAutoApproval, decideCaseTicketStage, decideCustomerReturn, planCaseTicketStage, readAccessAutoApprovalConfig,
  readCaseTicketStageConfig, verifyCaseTicketStage, type AccessAutoApprovalFacts, type CaseTicketStageIntent, type CaseTicketStageLive, type CaseTicketStagePlanInput,
  type CustomerReturnFacts,
} from "./customer-return";
import { accessAutoReplyAuthorizer } from "./customer-return-store";

// Pure contract of the V2 customer return. Every value is synthetic.
const CASE = "30000000-0000-4000-8000-000000000001", APPROVER = "30000000-0000-4000-8000-0000000000aa";
const open: CustomerReturnFacts = { link: "one_case", case: { owner: "agent", phase: "awaiting_customer", sensitivity: "none" }, alreadyRecorded: false, beforeCase: false,
  automated: false, acknowledgement: false, v1Target: "none", olderThanLatest: false, ownerNow: "v2", paused: false };
const closed = (overrides: Partial<CustomerReturnFacts> = {}): CustomerReturnFacts => ({ ...open, case: { owner: "agent", phase: "resolved", sensitivity: "none" }, ...overrides });

describe("route of a new customer mail", () => {
  it("an open agent case whose ticket is still the V2 owner's continues; a « merci » there is B's to read in context, not a closure", () => {
    expect(decideCustomerReturn(open)).toEqual({ route: "continue", reason: "open_case_v2_owner" });
    expect(decideCustomerReturn({ ...open, acknowledgement: true })).toEqual({ route: "continue", reason: "open_case_v2_owner" });
    for (const phase of ["queued", "acting", "technical_wait", "deferred_budget", "needs_review"] as const)
      expect(decideCustomerReturn({ ...open, case: { ...open.case!, phase } }).route).toBe("continue");
  });
  it("no durable link, two cases, an old mail or a replay never continue anything", () => {
    expect(decideCustomerReturn({ ...open, link: "no_case", case: null })).toEqual({ route: "normal_admission", reason: "no_case" });
    expect(decideCustomerReturn({ ...open, link: "several_cases" })).toEqual({ route: "normal_admission", reason: "several_cases" });
    // The store gives no case at all when two hold the thread: the reason stays « several », never « none ».
    expect(decideCustomerReturn({ ...open, link: "several_cases", case: null })).toEqual({ route: "normal_admission", reason: "several_cases" });
    expect(decideCustomerReturn({ ...open, beforeCase: true })).toEqual({ route: "normal_admission", reason: "before_case" });
    expect(decideCustomerReturn({ ...open, alreadyRecorded: true, ownerNow: "human" })).toEqual({ route: "already_recorded" });
  });
  it("a person's ticket is never touched: the team or the hold keeps the case; an owner who changed hands it to the team; unknown waits", () => {
    expect(decideCustomerReturn({ ...open, case: { ...open.case!, owner: "human", phase: "human_owned" } })).toEqual({ route: "leave_to_owner", reason: "case_with_team" });
    expect(decideCustomerReturn({ ...open, case: { ...open.case!, owner: "system_hold" } })).toEqual({ route: "leave_to_owner", reason: "case_on_hold" });
    expect(decideCustomerReturn({ ...open, ownerNow: "human" })).toEqual({ route: "hand_to_team", reason: "human_owner" });
    expect(decideCustomerReturn({ ...open, ownerNow: "none" })).toEqual({ route: "hand_to_team", reason: "v2_owner_removed" });
    expect(decideCustomerReturn({ ...open, ownerNow: "unknown" })).toEqual({ route: "wait", reason: "owner_unread" });
    expect(decideCustomerReturn({ ...open, paused: true })).toEqual({ route: "wait", reason: "paused" });
    expect(decideCustomerReturn({ ...open, case: { ...open.case!, sensitivity: "finance" } })).toEqual({ route: "hand_to_team", reason: "sensitive" });
  });
  it("an automatic reply is no answer: an open case ignores it (J2 kept), a closed one stays closed", () => {
    expect(decideCustomerReturn({ ...open, automated: true })).toEqual({ route: "ignore_automated", reason: "automated" });
    expect(decideCustomerReturn(closed({ automated: true, v1Target: "same_ticket" }))).toEqual({ route: "keep_closed", reason: "automated" });
  });
  it("after closure: V1's confirmed same ticket reopens (owner V2 now), another ticket is a new subject, a thanks keeps it closed, nothing confirmed yet waits", () => {
    expect(decideCustomerReturn(closed({ v1Target: "same_ticket" }))).toEqual({ route: "reopen", reason: "same_incident_v1_confirmed" });
    expect(decideCustomerReturn(closed({ v1Target: "same_ticket", case: { owner: "agent", phase: "closed_no_reply", sensitivity: "none" } })).route).toBe("reopen");
    expect(decideCustomerReturn(closed({ v1Target: "other_ticket" }))).toEqual({ route: "normal_admission", reason: "new_subject" });
    expect(decideCustomerReturn(closed({ acknowledgement: true, v1Target: "same_ticket" }))).toEqual({ route: "keep_closed", reason: "acknowledgement" });
    expect(decideCustomerReturn(closed())).toEqual({ route: "wait", reason: "v1_pending" });
    expect(decideCustomerReturn(closed({ v1Target: "same_ticket", ownerNow: "human" }))).toEqual({ route: "hand_to_team", reason: "human_owner" });
  });
});

const stagesOn = readCaseTicketStageConfig({ SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "syn-waiting", SAV_V2_STAGE_CLOSED: "syn-closed" });
const plan = (overrides: Partial<CaseTicketStagePlanInput> = {}) => planCaseTicketStage({ config: stagesOn, caseId: CASE, ticketId: "8400001",
  case: { owner: "agent", phase: "awaiting_customer", sensitivity: "none", cycle: { number: 1 } }, trigger: { kind: "reply_confirmed", replyKey: `reply:${CASE}:inbound:syn-1`, sentAt: "2026-11-03T10:00:00.000Z" },
  lastCustomerInboundAt: "2026-11-03T09:00:00.000Z", ...overrides });

describe("ticket stages: « attente client » after a confirmed reply, « fermé » after a proven resolution", () => {
  it("stage ids are injected, both, distinct and well-formed, or nothing moves", () => {
    expect(stagesOn).toEqual({ mode: "on", waitingCustomer: "syn-waiting", closed: "syn-closed" });
    expect(readCaseTicketStageConfig({})).toEqual({ mode: "off", why: "disabled" });
    expect(readCaseTicketStageConfig({ SAV_V2_TICKET_STAGES: "auto", SAV_V2_STAGE_WAITING_CUSTOMER: "a", SAV_V2_STAGE_CLOSED: "b" })).toEqual({ mode: "off", why: "disabled" });
    expect(readCaseTicketStageConfig({ SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "a" })).toEqual({ mode: "off", why: "stage_missing" });
    expect(readCaseTicketStageConfig({ SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "a b", SAV_V2_STAGE_CLOSED: "c" })).toEqual({ mode: "off", why: "stage_invalid" });
    expect(readCaseTicketStageConfig({ SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "same", SAV_V2_STAGE_CLOSED: "same" })).toEqual({ mode: "off", why: "stages_equal" });
    expect(plan({ config: readCaseTicketStageConfig({}) })).toEqual({ plan: false, reason: "stages_disabled" });
  });
  it("a confirmed reply plans one waiting stage per reply key; stale after a newer customer mail; never on a team, sensitive or resolved case", () => {
    expect(plan()).toEqual({ plan: true, intent: { key: `case-stage:${CASE}:waiting_customer:reply:${CASE}:inbound:syn-1`, target: "waiting_customer", stageId: "syn-waiting", ticketId: "8400001", caseId: CASE } });
    expect(plan()).toEqual(plan());
    expect(plan({ lastCustomerInboundAt: "2026-11-03T10:00:01.000Z" })).toEqual({ plan: false, reason: "customer_replied_since" });
    expect(plan({ case: { owner: "human", phase: "human_owned", sensitivity: "none", cycle: { number: 1 } } })).toEqual({ plan: false, reason: "owner_not_agent" });
    expect(plan({ case: { owner: "agent", phase: "acting", sensitivity: "finance", cycle: { number: 1 } } })).toEqual({ plan: false, reason: "sensitive" });
    expect(plan({ case: { owner: "agent", phase: "resolved", sensitivity: "none", cycle: { number: 1, endedBy: "resolved" } } })).toEqual({ plan: false, reason: "case_resolved" });
  });
  it("closing needs the cycle ended resolved on that very cycle: a J2 administrative closure or a handoff is not a proven resolution", () => {
    const resolved = { owner: "agent" as const, phase: "resolved" as const, sensitivity: "none" as const, cycle: { number: 2, endedBy: "resolved" as const } };
    expect(plan({ case: resolved, trigger: { kind: "resolution_recorded", cycle: 2 } }))
      .toEqual({ plan: true, intent: { key: `case-stage:${CASE}:closed:cycle-2`, target: "closed", stageId: "syn-closed", ticketId: "8400001", caseId: CASE } });
    expect(plan({ case: { ...resolved, cycle: { number: 2 } }, trigger: { kind: "resolution_recorded", cycle: 2 } })).toEqual({ plan: false, reason: "resolution_not_proven" });
    expect(plan({ case: { ...resolved, phase: "closed_no_reply", cycle: { number: 2, endedBy: "closed_no_reply" } }, trigger: { kind: "resolution_recorded", cycle: 2 } }).plan).toBe(false);
    expect(plan({ case: resolved, trigger: { kind: "resolution_recorded", cycle: 1 } })).toEqual({ plan: false, reason: "resolution_not_proven" });
    expect(() => caseTicketStageKey("not-a-case", "closed", "cycle-1")).toThrow("SAV_CASE_STAGE_KEY_INVALID");
  });

  const live: CaseTicketStageLive = { config: stagesOn, pause: { intake: "running", v2: "running" }, ownerNow: "v2", caseStillTarget: true, customerRepliedSince: false };
  it("the gate: confirmed is final, an engaged write is verified only whatever changed, only a planned one is judged", () => {
    expect(decideCaseTicketStage("confirmed", "closed", { ...live, ownerNow: "human" })).toEqual({ action: "done" });
    for (const engaged of ["dispatched", "acked", "uncertain"] as const)
      expect(decideCaseTicketStage(engaged, "waiting_customer", { ...live, ownerNow: "human", customerRepliedSince: true, pause: { intake: "fully_paused", v2: "invalid" } })).toEqual({ action: "verify_only" });
    expect(decideCaseTicketStage("planned", "waiting_customer", live)).toEqual({ action: "dispatch" });
    expect(decideCaseTicketStage("planned", "waiting_customer", { ...live, config: { mode: "off", why: "disabled" } })).toEqual({ action: "hold", code: "stages_off" });
    expect(decideCaseTicketStage("planned", "waiting_customer", { ...live, pause: { intake: "actions_paused", v2: "running" } })).toEqual({ action: "hold", code: "paused" });
    expect(decideCaseTicketStage("planned", "waiting_customer", { ...live, ownerNow: "unknown" })).toEqual({ action: "hold", code: "owner_unread" });
    expect(decideCaseTicketStage("planned", "closed", { ...live, ownerNow: "human" })).toEqual({ action: "cancel", code: "owner_changed" });
    expect(decideCaseTicketStage("planned", "closed", { ...live, ownerNow: "none" })).toEqual({ action: "cancel", code: "owner_changed" });
    expect(decideCaseTicketStage("planned", "waiting_customer", { ...live, customerRepliedSince: true })).toEqual({ action: "cancel", code: "new_input" });
    expect(decideCaseTicketStage("planned", "closed", { ...live, customerRepliedSince: true })).toEqual({ action: "dispatch" });
    expect(decideCaseTicketStage("planned", "closed", { ...live, caseStillTarget: false })).toEqual({ action: "cancel", code: "case_moved" });
  });

  it("simulated ports: a replay and two concurrent passes write the stage once; an uncertain write is only read back, never sent again", async () => {
    const intent = (plan() as { intent: CaseTicketStageIntent }).intent;
    // In-memory stand-in of the one effect ledger: insert-if-absent by key, then the marker before the write, as the executor does.
    const ledger = new Map<string, CaseEffectLedgerState>(), writes: string[] = [];
    let hubspot: { stage: string | null; ownerId: string | null } | undefined = { stage: "syn-new", ownerId: "900001" };
    let failNextWrite = false;
    const pass = async () => {
      if (!ledger.has(intent.key)) ledger.set(intent.key, "planned");
      const decision = decideCaseTicketStage(ledger.get(intent.key)!, intent.target, live);
      if (decision.action === "dispatch") {
        ledger.set(intent.key, "dispatched");
        writes.push(intent.key);
        await Promise.resolve();
        if (failNextWrite) { failNextWrite = false; ledger.set(intent.key, "uncertain"); return; }
        hubspot = { stage: intent.stageId, ownerId: hubspot?.ownerId ?? null };
      }
      if (decision.action === "dispatch" || decision.action === "verify_only") {
        const verdict = verifyCaseTicketStage(intent, hubspot, "900001");
        ledger.set(intent.key, verdict === "confirmed" ? "confirmed" : "uncertain");
      }
    };
    await Promise.all([pass(), pass()]);
    await pass();
    expect(writes).toEqual([intent.key]);
    expect(ledger.get(intent.key)).toBe("confirmed");

    // Uncertain (timeout after the marker): never resent; an unreadable read keeps it uncertain; the read that sees the stage confirms it.
    ledger.clear(); writes.length = 0; hubspot = { stage: "syn-new", ownerId: "900001" }; failNextWrite = true;
    await pass();
    expect(ledger.get(intent.key)).toBe("uncertain");
    hubspot = undefined;
    await pass();
    expect(ledger.get(intent.key)).toBe("uncertain");
    hubspot = { stage: intent.stageId, ownerId: "900001" };
    await pass();
    expect(writes).toEqual([intent.key]);
    expect(ledger.get(intent.key)).toBe("confirmed");
    expect(verifyCaseTicketStage(intent, { stage: intent.stageId, ownerId: "900777" }, "900001")).toBe("not_applied");
  });
});

describe("access replies without systematic human validation", () => {
  const config = readAccessAutoApprovalConfig({ SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: APPROVER });
  const facts: AccessAutoApprovalFacts = { case: { owner: "agent", sensitivity: "none", admitted: true }, openFamilies: ["access"],
    decision: { accepted: true, scopeCurrent: true, shownSourcesVerified: true, nextAction: "answer" }, ownerNow: "v2" };
  const decide = (overrides: Partial<Parameters<typeof decideAccessAutoApproval>[0]> = {}) =>
    decideAccessAutoApproval({ config, action: "approve", approverId: APPROVER, purpose: "answer", facts, ...overrides });

  it("only the exact opt-in with a dedicated approver id enables the rule", () => {
    expect(config).toEqual({ mode: "on", approverId: APPROVER });
    expect(readAccessAutoApprovalConfig({ SAV_V2_AUTO_REPLY: "all", SAV_V2_AUTO_APPROVER_ID: APPROVER })).toEqual({ mode: "off", why: "disabled" });
    expect(readAccessAutoApprovalConfig({ SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "ugo" })).toEqual({ mode: "off", why: "approver_invalid" });
    expect(decide({ config: { mode: "off", why: "disabled" } })).toEqual({ allowed: false, reason: "auto_disabled" });
  });
  it("approves an access-only, admitted, sourced answer or question on a V2-owned ticket, and nothing else", () => {
    expect(decide()).toEqual({ allowed: true, basis: ACCESS_AUTO_APPROVAL_BASIS });
    expect(decide({ purpose: "question", facts: { ...facts, decision: { ...facts.decision!, nextAction: "ask" } } }).allowed).toBe(true);
    expect(decide({ purpose: "reminder", facts: { ...facts, decision: null } }).allowed).toBe(true);
    const refusals: Array<[Partial<Parameters<typeof decideAccessAutoApproval>[0]>, string]> = [
      [{ action: "revoke" }, "action_not_auto"], [{ action: "decline" }, "action_not_auto"],
      [{ approverId: "30000000-0000-4000-8000-0000000000bb" }, "approver_not_rule"], [{ purpose: "final" }, "purpose_not_auto"], [{ facts: null }, "facts_unread"],
      [{ facts: { ...facts, case: { ...facts.case, admitted: false } } }, "case_not_admitted"],
      [{ facts: { ...facts, case: { ...facts.case, owner: "human" } } }, "case_not_admitted"],
      [{ facts: { ...facts, case: { ...facts.case, sensitivity: "finance" } } }, "sensitive"],
      [{ facts: { ...facts, openFamilies: ["access", "finance"] } }, "not_access_only"], [{ facts: { ...facts, openFamilies: ["usage"] } }, "not_access_only"],
      [{ facts: { ...facts, openFamilies: [] } }, "not_access_only"],
      [{ facts: { ...facts, decision: { ...facts.decision!, accepted: false } } }, "decision_not_accepted"],
      [{ facts: { ...facts, decision: { ...facts.decision!, nextAction: "handoff" } } }, "decision_not_reply"],
      [{ facts: { ...facts, decision: { ...facts.decision!, scopeCurrent: false } } }, "scope_not_current"],
      [{ facts: { ...facts, decision: { ...facts.decision!, shownSourcesVerified: false } } }, "sources_unverified"],
      [{ facts: { ...facts, ownerNow: "human" } }, "owner_not_v2"], [{ facts: { ...facts, ownerNow: "unknown" } }, "owner_unread"],
    ];
    for (const [overrides, reason] of refusals) expect(decide(overrides)).toEqual({ allowed: false, reason });
  });
  it("as the store's authorizer port: an explicit yes only from the rule; no port, a failing port or another approver is a refusal", async () => {
    const request: CaseReplyAuthorizationRequest = { action: "approve", approverId: APPROVER, caseId: CASE, replyKey: `reply:${CASE}:inbound:syn-1`, payloadHash: "b".repeat(64), purpose: "answer" };
    const env = { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: APPROVER };
    expect(await authorizeCaseReplyDecision(accessAutoReplyAuthorizer({ env, readFacts: async () => facts }), request)).toEqual({ allowed: true, basis: ACCESS_AUTO_APPROVAL_BASIS });
    expect(await authorizeCaseReplyDecision(accessAutoReplyAuthorizer({ env }), request)).toEqual({ allowed: false, code: "not_authorized" });
    expect(await authorizeCaseReplyDecision(accessAutoReplyAuthorizer({ env, readFacts: async () => { throw Error("DOWN"); } }), request)).toEqual({ allowed: false, code: "not_authorized" });
    expect(await authorizeCaseReplyDecision(accessAutoReplyAuthorizer({ env: {}, readFacts: async () => facts }), request)).toEqual({ allowed: false, code: "not_authorized" });
    expect(await authorizeCaseReplyDecision(accessAutoReplyAuthorizer({ env, readFacts: async () => facts }), { ...request, approverId: "30000000-0000-4000-8000-0000000000bb" }))
      .toEqual({ allowed: false, code: "not_authorized" });
  });
});

describe("revue d70a : contre-exemple 1, un mail que V1 a confirmé sur un AUTRE ticket", () => {
  it("n'est jamais consommé par un dossier OUVERT du fil : nouvelle admission, jamais continue ni hand_to_team sur l'ancien ticket", () => {
    expect(decideCustomerReturn({ ...open, v1Target: "other_ticket" })).toEqual({ route: "normal_admission", reason: "new_subject" });
    expect(decideCustomerReturn({ ...open, v1Target: "other_ticket", ownerNow: "human" })).toEqual({ route: "normal_admission", reason: "new_subject" });
    expect(decideCustomerReturn({ ...open, v1Target: "other_ticket", case: { ...open.case!, sensitivity: "finance" } })).toEqual({ route: "normal_admission", reason: "new_subject" });
  });
});

describe("revue R03 : ordre explicite des mails d'un dossier", () => {
  const at = (receivedAt: string, createdAt: string, id: string) => ({ receivedAt: new Date(receivedAt), createdAt: new Date(createdAt), id });
  it("réception, puis enregistrement, puis id : une égalité donne la même réponse quel que soit le sens de lecture", () => {
    const T = "2026-11-03T08:30:00.000Z", L = "2026-11-03T08:31:00.000Z";
    expect(customerMailOrder(at(L, T, "a"), at(T, L, "b"))).toBeGreaterThan(0);
    expect(customerMailOrder(at(T, L, "a"), at(T, T, "b"))).toBeGreaterThan(0);
    expect(customerMailOrder(at(T, T, "b"), at(T, T, "a"))).toBe(1);
    expect(customerMailOrder(at(T, T, "a"), at(T, T, "b"))).toBe(-1);
    expect(customerMailOrder(at(T, T, "a"), at(T, T, "a"))).toBe(0);
  });
  it("un mail plus ancien arrivé en retard n'est ni consommé ni donné à l'équipe ; un doublon reste un doublon ; un autre ticket reste un nouveau sujet", () => {
    const late = { ...open, olderThanLatest: true };
    expect(decideCustomerReturn(late)).toEqual({ route: "keep_latest", reason: "older_than_latest" });
    expect(decideCustomerReturn({ ...late, ownerNow: "human" })).toEqual({ route: "keep_latest", reason: "older_than_latest" });
    expect(decideCustomerReturn({ ...late, alreadyRecorded: true })).toEqual({ route: "already_recorded" });
    expect(decideCustomerReturn({ ...late, v1Target: "other_ticket" })).toEqual({ route: "normal_admission", reason: "new_subject" });
    expect(decideCustomerReturn({ ...closed({ v1Target: "same_ticket" }), olderThanLatest: true })).toEqual({ route: "keep_latest", reason: "older_than_latest" });
  });
  it("une exécution V1 non confirmée : son ticket n'est pas connu, le mail attend, ouvert comme fermé", () => {
    expect(decideCustomerReturn({ ...open, v1Target: "pending" })).toEqual({ route: "wait", reason: "v1_pending" });
    expect(decideCustomerReturn(closed({ v1Target: "pending" }))).toEqual({ route: "wait", reason: "v1_pending" });
  });
});
