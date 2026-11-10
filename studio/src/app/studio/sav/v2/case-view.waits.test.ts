import { describe, expect, it, vi } from "vitest";
import { SAV_CASE_CONTRACT_REVISION, type CaseSnapshot } from "@/lib/sav/cases/case-types";

// Pole B's investigation wait as the operator reads it. NOT COMPOSED: this base's reader (7fa) does not parse pole B's lot 2 record, so the record reader
// is replaced by fixed synthetic records in the exact shapes of B dc7bc67 (`problem` closed code, `embeddingCalls`), of B cadc971 (legacy `detail`) and of
// unknown/garbled values. The integration on B's real reader (I1) needs ROOT's exact composition.
const progress = vi.hoisted(() => ({ waiting: null as null | Record<string, unknown>, modelCalls: 0 as unknown }));
vi.mock("@/lib/sav/cases/investigation-record", () => ({
  readCaseInvestigationProgress: () => ({ state: "found", caseVersion: 3, record: { inputKey: "in:e1", progress: { modelCalls: progress.modelCalls, attempts: [], waiting: progress.waiting, proposal: null, last: null, closure: null, recordedOn: null }, decision: null } }),
}));
vi.mock("@/lib/sav/cases/investigation-runner", () => ({ latestInvestigationInput: () => "in:e1" }));
import { buildCasePilotView, safeContextProblem, storedCount } from "./case-view";

const base = { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "20000000-0000-4000-8000-000000000001", ticketId: "123", threadIds: [], version: 4, owner: "agent", phase: "acting",
  sensitivity: "none", createdAt: "2026-10-31T08:00:00.000Z", updatedAt: "2026-10-31T09:00:00.000Z", admission: null, admissionInputVersion: 0,
  body: { openRequests: [], facts: [], hypotheses: [], questions: [], trials: [], waiting: null, handoff: null, cycle: { number: 1 }, revisions: null } };
const view = (over: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => buildCasePilotView({ snapshot: { ...base, ...over, body: { ...base.body, ...body } } as unknown as CaseSnapshot,
  events: [], timers: [], pause: { level: "running", setting: null, invalid: false }, now: new Date("2026-10-31T10:00:00.000Z") });
const waitOf = (v = view()) => v.waits.find(w => /investigation|Contexte de décision|génération/i.test(`${w.label} ${w.detail ?? ""}`))!;
const SINCE = "2026-10-31T09:30:00.000Z";
const UNKNOWN = "motif technique non reconnu par cette version (détail réservé au rapport technique)";

describe("B lot 2 wait DTO (dc7bc67): closed problem code, real embedding count, generation ≠ embedding", () => {
  it("context_invalid with problem and embeddingCalls=1: safe sentence, 'no generation call' and '1 embedding' side by side", () => {
    progress.modelCalls = 0; progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, problem: "event_duplicate", embeddingCalls: 1 };
    const wait = waitOf();
    expect(wait).toMatchObject({ label: "Contexte de décision impossible à construire depuis le dossier : aucun appel de génération (modèle) de décision.", needsPerson: true });
    expect(wait.detail).toContain("Motif : le journal contient deux fois le même événement.");
    expect(wait.detail).toContain("Appels de génération (modèle) enregistrés : 0. Embeddings envoyés pendant ce passage : 1.");
    expect(`${wait.label} ${wait.detail}`).not.toMatch(/aucun appel fait|aucun embedding/i);
  });

  it("embeddingCalls: 0 is shown as 0; absent, null, negative, fractional or text is 'non enregistré', never 0", () => {
    progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, problem: "body_invalid", embeddingCalls: 0 };
    expect(waitOf().detail).toContain("Embeddings envoyés pendant ce passage : 0.");
    for (const embeddingCalls of [undefined, null, -1, 1.5, "2", Number.NaN]) {
      progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, problem: "body_invalid", ...(embeddingCalls === undefined ? {} : { embeddingCalls }) };
      expect(waitOf().detail, String(embeddingCalls)).toContain("Embeddings envoyés pendant ce passage : non enregistré.");
    }
    expect([storedCount(0), storedCount(3), storedCount(undefined), storedCount("3")]).toEqual([0, 3, null, null]);
  });

  it("the generation count is read the same way: a stored integer, or 'non enregistré'", () => {
    progress.waiting = { reason: "technical_wait", since: SINCE, caseVersion: 3, embeddingCalls: 2 };
    progress.modelCalls = 2; expect(waitOf().detail).toContain("Appels de génération (modèle) enregistrés : 2. Embeddings envoyés pendant ce passage : 2.");
    progress.modelCalls = undefined; expect(waitOf().detail).toContain("Appels de génération (modèle) enregistrés : non enregistré.");
    progress.modelCalls = 0;
  });

  it("every closed problem code has its own sentence; a value outside the list is unknown and not echoed", () => {
    const codes = ["contract_revision", "body_invalid", "event_other_case", "event_after_snapshot", "event_duplicate", "event_direction_invalid", "source_duplicate"];
    expect(new Set(codes.map(problem => safeContextProblem({ problem })))).toHaveProperty("size", 7);
    for (const problem of codes) expect(safeContextProblem({ problem })).not.toBe(UNKNOWN);
    for (const problem of ["zz_private", "__proto__", "constructor", "toString", 7, null]) {
      expect(safeContextProblem({ problem }), String(problem)).toBe(UNKNOWN);
      progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, problem };
      expect(waitOf().detail).not.toMatch(/zz_private|__proto__|constructor|toString/);
    }
  });
});

describe("legacy (cadc971) and unknown records: closed code only, nothing raw", () => {
  it("a legacy detail is read by its leading closed code only; the schema message and ids are never shown", () => {
    progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, detail: "body_invalid: Expected string, received number at body.facts.0.id e-7f3a" };
    const wait = waitOf();
    expect(wait.detail).toContain("Motif : le contenu enregistré du dossier ne respecte pas son format.");
    expect(wait.detail).toContain("Embeddings envoyés pendant ce passage : non enregistré.");
    expect(`${wait.label} ${wait.detail}`).not.toMatch(/Expected string|received number|body\.facts|e-7f3a/);
  });

  it("the closed problem wins over a legacy detail; an unknown legacy code is unknown", () => {
    expect(safeContextProblem({ problem: "source_duplicate", detail: "body_invalid: x" })).toBe("une même source apparaît deux fois");
    for (const detail of ["zz_private: event 20000000-0000-4000-8000-00000000abcd", "", undefined, 42]) {
      expect(safeContextProblem({ detail })).toBe(UNKNOWN);
      progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, detail };
      expect(waitOf().detail).not.toMatch(/zz_private|abcd/);
    }
  });

  it("an unknown wait reason is shown as unknown, needs a person, and echoes neither its detail nor its problem", () => {
    progress.waiting = { reason: "future_reason", since: SINCE, caseVersion: 3, detail: "secret-ish", problem: "zz_private" };
    const wait = waitOf();
    expect(wait).toMatchObject({ label: "Attente d’investigation non reconnue par cette version (future_reason).", needsPerson: true });
    expect(wait.detail).not.toMatch(/secret-ish|zz_private/);
  });
});

describe("who may act: a stored wait never reads as the agent working", () => {
  it("a ticket a person took, with a stored investigation wait: the person's custody is stated and the agent does not act", () => {
    progress.waiting = { reason: "context_invalid", since: SINCE, caseVersion: 3, problem: "body_invalid", embeddingCalls: 1 };
    const v = view({ owner: "human", phase: "human_owned" }, { handoff: { reason: "fixture", humanSince: "2026-10-31T09:10:00.000Z" } });
    expect(v.humanOwned).toBe(true);
    expect(v.waits.map(w => w.label)).toContain("Responsable : Une personne de l’équipe. L’agent n’agit pas sur ce dossier.");
  });

  it("authority withheld: no admission is 'unknown' and needs a person; a refused admission keeps its reasons; neither is the agent's work", () => {
    progress.waiting = null;
    const none = view();
    expect(none.admission.state).toBe("unknown");
    expect(none.waits.map(w => w.label)).toContain("Aucune admission enregistrée : l’agent ne peut pas prendre ce dossier.");
    const refused = view({ admission: { revision: "r", target: "team", reasons: ["sensitive_family"], nextStep: "team_takeover", families: [], sensitivity: "finance", policyRevision: "p1",
      decidedAt: SINCE, version: 2, inputVersion: 1, qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } }, admissionInputVersion: 1 });
    expect(refused.admission.state).toBe("refused");
    expect(refused.waits.some(w => w.needsPerson)).toBe(true);
  });
});

describe("pole B lot 5 wait contract (knowledge_changed) — NOT COMPOSED: B5's shape is announced, its reader is not in this tree", () => {
  it("knowledge_changed: the operator sentence, a pass to resume (not a handover, not a resolution), its since and version kept, true counts", () => {
    progress.modelCalls = 1; progress.waiting = { reason: "knowledge_changed", since: SINCE, caseVersion: 3, embeddingCalls: 2 };
    const wait = waitOf();
    expect(wait).toMatchObject({ label: "Les connaissances ont changé, une nouvelle vérification est nécessaire.", needsPerson: false, kind: "resume" });
    expect(wait.detail).toContain("À reprendre par un nouveau passage d’investigation (aucune reprise automatique n’est branchée dans cette version).");
    expect(wait.detail).toContain("Appels de génération (modèle) enregistrés : 1. Embeddings envoyés pendant ce passage : 2.");
    expect(wait.detail).toContain(`Depuis ${SINCE}, version 3.`);
    expect(`${wait.label} ${wait.detail}`).not.toMatch(/résolu|résolution de la demande$|aucun coût|0 appel payant/i);
    progress.modelCalls = 0;
  });

  it("extra fields a future writer might add (revision ids, messages) are never shown; an absent count is 'non enregistré', never 0", () => {
    progress.waiting = { reason: "knowledge_changed", since: SINCE, caseVersion: 3, fromRevision: "kb-rev-private-111", toRevision: "kb-rev-private-222", message: "ZodError: invalid_type" };
    const wait = waitOf();
    expect(`${wait.label} ${wait.detail}`).not.toMatch(/kb-rev-private|ZodError|invalid_type/);
    expect(wait.detail).toContain("Embeddings envoyés pendant ce passage : non enregistré.");
  });

  it("kinds are derived from pole B's own wording: refused decision = team handover; a wait needing a person = technical; otherwise resume", () => {
    const kind = (reason: string) => { progress.waiting = { reason, since: SINCE, caseVersion: 3 }; return waitOf().kind; };
    expect(kind("decision_refused")).toBe("team");
    expect(kind("technical_exhausted")).toBe("technical");
    expect(kind("knowledge_request_invalid")).toBe("technical");
    expect(kind("deferred_budget")).toBe("resume");
    expect(kind("paused")).toBe("resume");
    expect(kind("future_reason")).toBe("technical");
    progress.waiting = { reason: "decision_refused", since: SINCE, caseVersion: 3 };
    expect(waitOf().detail).toContain("Remise à l’équipe (métier) : ce n’est pas une résolution de la demande.");
  });

  it("a stored reason that names an inherited property is unknown, never a label (own keys only)", () => {
    for (const reason of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      progress.waiting = { reason, since: SINCE, caseVersion: 3 };
      expect(waitOf(), reason).toMatchObject({ label: `Attente d’investigation non reconnue par cette version (${reason}).`, needsPerson: true, kind: "technical" });
    }
  });

  it("an older wait without caseVersion keeps its date and says the version is not recorded", () => {
    progress.waiting = { reason: "technical_wait", since: SINCE };
    expect(waitOf().detail).toContain(`Depuis ${SINCE}, version non enregistrée.`);
  });
});


it("shows the closed transport failure and counts without calling it a generic provider outage", () => {
  progress.modelCalls = 0; progress.waiting = { reason: "technical_wait", since: SINCE, caseVersion: 3,
    diagnostic: { stage: "preflight", code: "input_too_large", networkAttempted: false, inputBytes: 30000, maxInputBytes: 26000, knowledgeCards: 3 } };
  const wait = waitOf();
  expect(wait.label).toContain("Contexte trop volumineux"); expect(wait.detail).toContain("30000 octets / limite 26000");
  expect(wait.detail).toContain("enregistrés : 0"); expect(wait.label).not.toContain("fournisseur");
  progress.modelCalls = 3; progress.waiting = { ...progress.waiting, reason: "technical_exhausted",
    diagnostic: { stage: "http", code: "http_rejected", networkAttempted: true, httpStatus: 403 } };
  const exhausted = waitOf(); expect(exhausted.needsPerson).toBe(true); expect(exhausted.detail).toContain("HTTP 403");
});
