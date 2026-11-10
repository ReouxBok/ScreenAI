import { describe, expect, it } from "vitest";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot } from "./case-types";
import { selectCaseKnowledge } from "./investigation-knowledge";
import {
  runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts, type CaseInvestigationProgress,
  type CaseInvestigationRecord,
} from "./investigation-runner";

/*
 * Night 01/11, B4 freshness audit: the knowledge a decision cites, from the search to the validated, recorded proposal.
 * Real modules end to end: the runner, `selectCaseKnowledge`, the intake's per-request retrieval and the decision
 * validator. Only the search backend (a synthetic catalogue with a movable revision), the model answers and the store
 * are doubles. SYN data only: no database, model, embedding, network or customer content. Relevance is not judged
 * here: the backend returns what a query matches, as the index does without a threshold.
 */

const NOW = new Date("2026-10-27T12:00:00Z");
const availability = { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" };
const card = (id: string, version = `${id}-v1`, patch: Partial<SavRetrievalCandidate> = {}, extra: Record<string, unknown> = {}): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"], ...extra }, availability: { ...availability }, ...patch,
});
const archived = (value: SavRetrievalCandidate): SavRetrievalCandidate => ({ ...value, availability: { ...value.availability, archived: true } });

/** A synthetic catalogue: every query gets `cards`; `revision` is what the active knowledge pointer reads now. */
function catalogue(initial: { revision: string; cards: SavRetrievalCandidate[] }) {
  const state = { ...initial, down: false, reads: 0, searches: 0, duringSearch: undefined as undefined | (() => void) };
  const port: SavRetrievalBackend = {
    readRevision: async () => { state.reads++; return state.revision; },
    search: async queries => {
      state.searches++;
      if (state.down) throw Error("SEARCH_DOWN_FIXTURE");
      state.duringSearch?.();
      return queries.map(() => state.cards.map(value => structuredClone(value)));
    },
  };
  return { state, port };
}

const request = { id: "r1", summary: "Demande « support » relevée par l'analyse V1 du mail m1.", family: "usage" as const, status: "open" as const, openedAt: "2026-10-20T09:00:00Z" };
const snapshot = (version = 2): CaseSnapshot => ({
  contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version, owner: "agent", phase: "queued", sensitivity: "none",
  createdAt: "2026-10-20T09:00:01Z", updatedAt: "2026-10-20T09:00:01Z", body: { ...emptyCaseBody(), openRequests: [request] } as CaseBody,
  admission: { revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["usage"], sensitivity: "none", policyRevision: "policy-r1",
    decidedAt: "2026-10-20T09:00:02Z", version: 2, inputVersion: 1, qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } },
  admissionInputVersion: 1,
});
const inbound: CaseEvent = { id: "e1", caseId: "case-1", kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound",
  occurredAt: "2026-10-20T09:00:00Z", sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-10-20T09:00:01Z" };

type Ref = { knowledgeId: string; contentVersionId: string };
const understanding = { requests: [{ id: "r1", summary: "Demande.", family: "usage", status: "open" }], newFacts: [] };
const answer = (ref: Ref = { knowledgeId: "k1", contentVersionId: "k1-v1" }) => ({ caseVersion: 2, understanding,
  nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Refaire l'étape synthétique.", knowledge: ref }], expectedResult: "Cela fonctionne." } });
const ask = () => ({ caseVersion: 2, understanding,
  nextAction: { kind: "ask", questions: [{ text: "Quel résultat obtenez-vous après l'opération ?", requestId: "r1", reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result" }] }] } });
const ok = (output: unknown): CaseInvestigationModelResult => ({ status: "ok", output });

/** The runner's ports on the real knowledge selection over `kb`; `onModel` runs while the model call is in flight. */
function ports(kb: ReturnType<typeof catalogue>, options: { model: CaseInvestigationModelResult[]; onModel?: (call: number) => void; progress?: Map<string, CaseInvestigationProgress>; afterSearch?: () => void }) {
  const calls: CaseInvestigationModelRequest[] = [], records: CaseInvestigationRecord[] = [], answers = [...options.model];
  const progress = options.progress ?? new Map<string, CaseInvestigationProgress>();
  const run: CaseInvestigationPorts = {
    scope: { locale: "fr-FR", audience: "support" },
    pauseState: async () => "running",
    readCase: async () => ({ snapshot: snapshot(), events: [inbound] }),
    admissionPolicyRevision: async () => "policy-r1",
    reevaluateAdmission: async () => "handed_off",
    claim: async () => ({ token: "lease-1", actionsPaused: false }),
    release: async () => {},
    knowledge: async snap => {
      const read = await selectCaseKnowledge(snap, kb.port, { locale: "fr-FR", audience: "support", now: NOW }, () => "Connexion impossible au compte synthétique.");
      options.afterSearch?.();
      return read;
    },
    customerTexts: async () => ({ "email:m1": "Bonjour, je n'arrive pas à faire l'opération." }),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { calls.push(request); options.onModel?.(calls.length); return answers.shift() ?? { status: "failed", uncertain: false }; },
    progress: {
      load: async (caseId, inputKey) => structuredClone(progress.get(`${caseId}:${inputKey}`) ?? null),
      save: async (caseId, inputKey, value) => { progress.set(`${caseId}:${inputKey}`, structuredClone(value)); },
    },
    record: async record => { records.push(structuredClone(record)); },
    now: () => NOW,
    readTicketOwner: async () => "v2",
  };
  return { run, calls, records, progress };
}

describe("B4 freshness: what already protects the knowledge cited by a decision (real selection, retrieval and validator)", () => {
  it("witness: a stable catalogue, a valid card linked to its request; the decision is recorded with that revision and card", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const p = ports(kb, { model: [ok(answer())] });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(p.records[0]).toMatchObject({ knowledgeRevision: "kb-r1", knowledge: [{ knowledgeId: "k1", contentVersionId: "k1-v1" }],
      coverage: [{ requestId: "r1", status: "covered", knowledge: [{ knowledgeId: "k1", contentVersionId: "k1-v1" }] }] });
  });

  it("a revision that moves during the search, twice: unavailable (revision_unstable), a technical wait, no model call, never « no knowledge »", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    let n = 0;
    kb.state.duringSearch = () => { kb.state.revision = `kb-r${++n + 1}`; };
    const p = ports(kb, { model: [ok(answer())] });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "technical_wait", modelCalls: 0 });
    expect({ calls: p.calls.length, records: p.records.length, searches: kb.state.searches }).toEqual({ calls: 0, records: 0, searches: 2 });
    expect(p.progress.get("case-1:in:e1")?.waiting?.reason).toBe("technical_wait");
  });

  it("a search outage is unavailable, not empty: a technical wait, no model call; an empty catalogue is a real gap the model is told about", async () => {
    const down = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    down.state.down = true;
    const p = ports(down, { model: [ok(answer())] });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "technical_wait", modelCalls: 0 });
    expect(p.calls).toEqual([]);
    const empty = catalogue({ revision: "kb-r1", cards: [] });
    const q = ports(empty, { model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", q.run)).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect(q.calls[0]!.coverage).toEqual([expect.objectContaining({ requestId: "r1", status: "no_applicable_knowledge", knowledge: [] })]);
  });

  it.each([
    ["expired (validUntil before today)", card("k1", "k1-v1", {}, { validUntil: "2026-10-26" })],
    ["archived", archived(card("k1"))],
    ["disabled for the AI", card("k1", "k1-v1", { availability: { ...availability, aiEnabled: false } })],
    ["unpublished", card("k1", "k1-v1", { availability: { ...availability, published: false } })],
    ["verified more than 90 days ago", card("k1", "k1-v1", { verifiedAt: "2026-07-01T00:00:00Z" })],
  ])("a card %s at search time is never offered nor citable: the decision citing it is refused, nothing accepted", async (_name, value) => {
    const kb = catalogue({ revision: "kb-r1", cards: [value] });
    const p = ports(kb, { model: [ok(answer()), ok(answer()), ok(answer())] });
    const report = await runCaseInvestigation("case-1", "observe", p.run);
    expect(p.calls[0]!.knowledge).toEqual([]);
    expect(p.calls[0]!.coverage).toEqual([expect.objectContaining({ status: "no_applicable_knowledge", knowledge: [] })]);
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review" });
    expect(p.records[0]!.validation).toMatchObject({ outcome: "needs_review", rejections: expect.arrayContaining([expect.objectContaining({ code: "knowledge_reference_unknown" })]) });
    expect(p.records[0]!.knowledge).toEqual([]);
  });

  it.each([
    ["another content version of the card offered", { knowledgeId: "k1", contentVersionId: "k1-v0" }, "knowledge_revision_mismatch"],
    ["a card never offered", { knowledgeId: "k9", contentVersionId: "k9-v1" }, "knowledge_reference_unknown"],
  ])("a citation with %s is refused, never accepted", async (_name, ref, code) => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const p = ports(kb, { model: [ok(answer(ref)), ok(answer(ref)), ok(answer(ref))] });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "recorded", outcome: "needs_review" });
    expect(p.records[0]!.validation).toMatchObject({ rejections: expect.arrayContaining([expect.objectContaining({ code })]) });
  });

  it("two content versions of one card in the same search: neither is offered (multiple_versions_for_active_card), the request is not covered", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1", "k1-v1"), card("k1", "k1-v2")] });
    const p = ports(kb, { model: [ok(ask())] });
    await runCaseInvestigation("case-1", "observe", p.run);
    expect(p.calls[0]!.knowledge).toEqual([]);
    expect(p.calls[0]!.coverage![0]!.status).not.toBe("covered");
  });
});

describe("B4 freshness F1: the knowledge revision is read again before a model call and before the decision is recorded", () => {
  it("archived while the model answers (publication, archive and AI switch all move the revision): nothing recorded on the old revision; the next pass searches again and refuses the stale citation", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const progress = new Map<string, CaseInvestigationProgress>();
    const p = ports(kb, { progress, model: [ok(answer())], onModel: () => { kb.state.revision = "kb-r2"; kb.state.cards = [archived(card("k1"))]; } });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toEqual({ status: "knowledge_requeue", caseId: "case-1", caseVersion: 2,
      searchedRevision: "kb-r1", currentRevision: "kb-r2", modelCalls: 1 });
    expect(p.records).toEqual([]);
    // The call and its proposal are kept: nothing is paid again for them, nothing is reset.
    expect(progress.get("case-1:in:e1")).toMatchObject({ modelCalls: 1, recordedOn: null, proposal: { proposedOn: 2 } });
    const again = ports(kb, { progress, model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", again.run)).toMatchObject({ status: "recorded", modelCalls: 2 });
    expect(again.calls[0]!.feedback.map(row => row.code)).toContain("knowledge_reference_unknown");
    expect(again.records[0]).toMatchObject({ knowledgeRevision: "kb-r2", knowledge: [] });
  });

  it("a new content version published while the model answers: the citation of the old version is never recorded as accepted", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const p = ports(kb, { model: [ok(answer())], onModel: () => { kb.state.revision = "kb-r2"; kb.state.cards = [card("k1", "k1-v2")]; } });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "knowledge_requeue", currentRevision: "kb-r2" });
    expect(p.records).toEqual([]);
  });

  it("moved after the search, before any model call: no call is paid on knowledge already outdated", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const p = ports(kb, { model: [ok(answer())], afterSearch: () => { kb.state.revision = "kb-r2"; } });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "knowledge_requeue", searchedRevision: "kb-r1", currentRevision: "kb-r2", modelCalls: 0 });
    expect(p.calls).toEqual([]);
    expect(p.records).toEqual([]);
  });

  it("an unreadable revision at the last read: not recorded (fail closed), the proposal kept", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const p = ports(kb, { model: [ok(answer())], onModel: () => { kb.port.readRevision = async () => { throw Error("KB_UNREADABLE"); }; } });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "knowledge_requeue", searchedRevision: "kb-r1", currentRevision: null, modelCalls: 1 });
    expect(p.records).toEqual([]);
  });

  it("witness: the revision read again but unchanged; recorded as before, one model call", async () => {
    const kb = catalogue({ revision: "kb-r1", cards: [card("k1")] });
    const p = ports(kb, { model: [ok(answer())], onModel: () => { kb.state.cards = [card("k1")]; } });
    expect(await runCaseInvestigation("case-1", "observe", p.run)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(p.records[0]!.knowledgeRevision).toBe("kb-r1");
  });
});
