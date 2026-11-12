import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAV_CASE_AWAITING_V2_ATTRIBUTION, SAV_CASE_CONTRACT_REVISION, type CaseEvent, type CaseSnapshot, type CaseTimer } from "@/lib/sav/cases/case-types";

// Supervised V2 pilot pages: synthetic cases only, every network and write forbidden.
const mocks = vi.hoisted(() => ({ staff: vi.fn(), byTicket: vi.fn(), events: vi.fn(), timers: vi.fn(), diagnostics: vi.fn(), list: vi.fn(), pause: vi.fn(), recording: vi.fn(), write: vi.fn(),
  readers: null as null | { get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }, dossier: null as null | { mails: ReturnType<typeof vi.fn>; cards: ReturnType<typeof vi.fn>; handoffNotice?: ReturnType<typeof vi.fn> } }));
vi.mock("@/db", () => ({ requireDb: () => ({}), getDb: () => ({}) }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("@/lib/sav/intake/agent-pause", () => ({ readSavAgentPause: mocks.pause }));
vi.mock("@/lib/sav/cases/case-store", () => ({ readCaseByTicket: mocks.byTicket, listCaseEvents: mocks.events, listCaseTimers: mocks.timers, readCaseDiagnostics: mocks.diagnostics, listCasesPage: mocks.list,
  savCaseRecordingEnabled: mocks.recording, transitionCaseOwner: mocks.write, updateCaseRecord: mocks.write, appendCaseEvent: mocks.write, listDueCaseTimers: mocks.write, scheduleCaseTimer: mocks.write, fireCaseTimer: mocks.write, readCase: mocks.write }));
vi.mock("./case-replies-port", () => ({ get caseReplyReaders() { return mocks.readers; } }));
vi.mock("./case-dossier-port", () => ({ get caseDossierReaders() { return mocks.dossier; } })); // real readers: case-dossier.compose.test.ts
vi.mock("./qualification-diagnostic-port", () => ({ qualificationDiagnosticReader: null }));
vi.mock("./operational-read-port", () => ({ operationalReader: null })); // C9 reader: exercised on the real store in operational-state.compose.test.ts // A6 reader: exercised on the real store in qualification-diagnostic.compose.test.ts
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, usePathname: () => "/studio/sav/v2/123", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));
import { prepareCaseReplyText } from "@/lib/sav/cases/case-reply-outbound";
import { ACCESS_AUTO_APPROVAL_BASIS } from "@/lib/sav/cases/customer-return";
import { encodeCaseReplyCursor, parseCaseReplyCursor } from "./case-replies";
import { buildCasePilotView } from "./case-view";
import EntryPage from "./page";
import CasePage from "./[ticketId]/page";

const caseId = "20000000-0000-4000-8000-000000000001", threadId = "20000000-0000-4000-8000-000000000002", now = new Date("2026-10-31T10:00:00.000Z");
const admission = { revision: "sav-admission-2026-10-27.v1", target: "agent", reasons: ["admitted"], nextStep: "none", families: ["access"], sensitivity: "none", policyRevision: "p1",
  decidedAt: "2026-10-31T08:00:00.000Z", version: 2, inputVersion: 1, qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } } as const;
const snapshot = (over: Partial<CaseSnapshot> = {}, body: Partial<CaseSnapshot["body"]> = {}): CaseSnapshot => ({
  contractRevision: SAV_CASE_CONTRACT_REVISION, caseId, ticketId: "123", threadIds: [threadId], version: 4, owner: "agent", phase: "awaiting_customer", sensitivity: "none",
  createdAt: "2026-10-31T08:00:00.000Z", updatedAt: "2026-10-31T09:00:00.000Z", admission: admission as unknown as CaseSnapshot["admission"], admissionInputVersion: 1,
  body: { openRequests: [{ id: "m1/r0", summary: "Demande d’accès synthétique", family: "access", status: "open", openedAt: "2026-10-31T08:00:00.000Z" }],
    facts: [{ id: "f1", text: "Le client dit ne pas recevoir le code", source: { type: "email", id: "m1" }, at: "2026-10-31T08:00:00.000Z", key: null, kind: "customer_statement" }],
    hypotheses: [], questions: [{ id: "q1", text: "Avez-vous vérifié les indésirables ?", factKeys: [], askedAt: "2026-10-31T08:30:00.000Z", askedInEffect: "e1" }], trials: [],
    waiting: { kind: "customer", since: "2026-10-31T08:30:00.000Z", dueAt: "2026-11-02T09:00:00.000Z", reasonCode: "question_asked" }, handoff: null, cycle: { number: 1 }, revisions: null, ...body },
  ...over,
});
const event = (over: Partial<CaseEvent>): CaseEvent => ({ id: "e1", caseId, kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound", occurredAt: "2026-10-31T08:00:00.000Z",
  sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-10-31T08:00:00.000Z", ...over } as CaseEvent);
const reply = { text: "Bonjour, voici comment retrouver votre accès.", citations: [{ knowledgeId: "k1", contentVersionId: "v1" }], impossibilityClaims: [], accountAdvice: "existing_account_access" };
const proposal = (proposedOn: number, nextAction: Record<string, unknown> = { kind: "answer", requestIds: ["m1/r0"], steps: [{ text: "Ouvrir la page de connexion", knowledge: { knowledgeId: "k1", contentVersionId: "v1" } }], expectedResult: "Accès retrouvé" }) =>
  ({ caseVersion: proposedOn, understanding: { requests: [], newFacts: [] }, nextAction, reply });
const record = (output: unknown, proposedOn: number, waiting: unknown = null, decision: unknown = null) => event({ id: "o1", kind: "observation_recorded", dedupeKey: "observation:o1", caseVersion: 3, direction: "internal",
  detail: { record: { kind: "sav-case-investigation.v1", inputKey: "in:e1", progress: { modelCalls: 1, attempts: [], waiting, proposal: { output, proposedOn }, last: null, closure: null, recordedOn: null }, decision } } });
const timer: CaseTimer = { id: "t1", key: `timer:j2:${caseId}:e1`, caseId, questionEffectId: "e1", sentAt: "2026-10-31T08:30:00.000Z", dueAt: "2026-11-02T09:00:00.000Z", state: "scheduled", scheduledAtCaseVersion: 3, firedAt: null, cancelledAt: null, cancelReason: null };
const running = { level: "running", setting: null, invalid: false } as const;
const listItem = (ticketId: string, over: Record<string, unknown> = {}) => ({ caseId: `20000000-0000-4000-8000-00000000${ticketId.padStart(4, "0")}`, ticketId, owner: "agent", phase: "awaiting_customer", sensitivity: "none", version: 4, threadCount: 1,
  contractRevision: SAV_CASE_CONTRACT_REVISION, contractSupported: true, admission: { target: "agent", reason: "admitted", inputNewer: false }, claimUntil: null, createdAt: "2026-10-31T08:00:00.000Z", updatedAt: "2026-10-31T09:00:00.000Z", ...over });

const replyId = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;
const replyItem = (n: number, status: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ id: replyId(n), caseId, replyKey: `k${n}`, purpose: "question", validation: "approved", payloadHash: "a".repeat(64), caseVersion: 4,
  createdAt: "2026-10-31T09:30:00.000Z", decidedAt: null, revokedAt: null, approvability: { ok: false, reason: "already_decided" },
  status: { code: "queued", sent: "no", terminal: false, hold: null, cancel: null, endedBy: null, j2: { state: "none", dueAt: null }, ...status }, effect: null, ...over });
const replyDetail = (over: Record<string, unknown> = {}) => ({ ...replyItem(1, { code: "awaiting_validation" }, { validation: "proposed", approvability: { ok: true } }),
  recipient: "client@example.test", decidedBy: null, revokedBy: null, authorizationBasis: null, proposal: { subject: "Re: accès", text: "Bonjour, pouvez-vous vérifier vos indésirables ?", question: { id: "q1", text: "Avez-vous vérifié les indésirables ?" } }, ...over });

beforeEach(() => {
  vi.clearAllMocks(); mocks.readers = null; mocks.dossier = null; vi.unstubAllEnvs(); vi.stubGlobal("fetch", () => { throw Error("NETWORK_FORBIDDEN"); });
  mocks.staff.mockResolvedValue({ id: "20000000-0000-4000-8000-000000000003", email: "operateur@example.test", role: "member" }); mocks.recording.mockReturnValue(true);
  mocks.byTicket.mockResolvedValue(snapshot()); mocks.events.mockResolvedValue([event({}), record(proposal(4), 4)]); mocks.timers.mockResolvedValue([timer]); mocks.pause.mockResolvedValue(running);
  mocks.list.mockResolvedValue({ items: [listItem("123"), listItem("456", { sensitivity: "finance", contractSupported: false, admission: { target: "agent", reason: "admitted", inputNewer: true } })], nextCursor: "c2" });
  mocks.diagnostics.mockResolvedValue({ caseId, version: 4, owner: "agent", phase: "awaiting_customer", contractRevision: SAV_CASE_CONTRACT_REVISION, contractSupported: true, eventCount: 2, lastEventKind: "observation_recorded",
    admission: { target: "agent", reason: "admitted", policyRevision: "p1", since: null, inputNewer: false }, claim: null, followUp: null });
});

describe("case view: real states, nothing invented", () => {
  it("SAV-18: a case held by its block's switch shows a visible wait, off or paused, never a silent skip", () => {
    const off = buildCasePilotView({ snapshot: snapshot(), events: [event({})], timers: [], pause: running, now, blockHold: { blockId: "access", reason: "block_off", since: "2026-11-12T09:00:00.000Z" } });
    expect(off.waits).toContainEqual(expect.objectContaining({ label: expect.stringContaining("Bloc éteint"), detail: "Bloc access, motif block_off, depuis 2026-11-12T09:00:00.000Z.", needsPerson: false }));
    const paused = buildCasePilotView({ snapshot: snapshot(), events: [event({})], timers: [], pause: running, now, blockHold: { blockId: "access", reason: "block_paused", since: "2026-11-12T09:00:00.000Z" } });
    expect(paused.waits).toContainEqual(expect.objectContaining({ label: expect.stringContaining("Bloc en pause") }));
    expect(buildCasePilotView({ snapshot: snapshot(), events: [event({})], timers: [], pause: running, now }).waits.some(w => w.label.includes("Bloc"))).toBe(false);
  });
  it("current proposal, open question, customer wait and J2 follow-up", () => {
    const view = buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(4), 4)], timers: [timer], pause: running, now });
    expect(view.proposal).toMatchObject({ state: "found", stale: false, action: "Répondre au client", reply: reply.text, citations: 1 });
    expect(view.openQuestions.map(q => q.text)).toEqual(["Avez-vous vérifié les indésirables ?"]);
    expect(view.waits.map(w => w.label)).toEqual(["Attente du client"]);
    expect(view.followUp?.label).toBe("Relance J2 programmée");
    expect(view.original).toEqual({ at: "2026-10-31T08:00:00.000Z", threadId });
  });
  it("a proposal made on an older version is stale; an invalid one is unreadable, never shown as proposed", () => {
    expect(buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(3), 3)], timers: [], pause: running, now }).proposal).toMatchObject({ state: "found", stale: true });
    expect(buildCasePilotView({ snapshot: snapshot(), events: [event({}), record({ broken: true }, 4)], timers: [], pause: running, now }).proposal).toEqual({ state: "unreadable", recordedOn: 3 });
    expect(buildCasePilotView({ snapshot: snapshot(), events: [event({})], timers: [], pause: running, now }).proposal).toEqual({ state: "none" });
  });
  it("pause, human owner, refused admission and a newer input are all shown; the J2 is kept, not cancelled, under pause", () => {
    const view = buildCasePilotView({ snapshot: snapshot({ owner: "human", phase: "human_owned", admissionInputVersion: 5,
      admission: { ...admission, target: "team", reasons: ["sensitive_family"] } as unknown as CaseSnapshot["admission"] }, { waiting: null }),
      events: [event({}), record(proposal(4), 4, { reason: "technical_exhausted", since: "2026-10-31T09:00:00.000Z", caseVersion: 4 })], timers: [timer],
      pause: { level: "fully_paused", setting: { revision: "sav-agent-pause.v1", agent: "v2", level: "fully_paused", setBy: "ops@example.test", setAt: "2026-10-31T07:00:00.000Z", reason: "test" }, invalid: false }, now: new Date("2026-11-03T10:00:00.000Z") });
    const labels = view.waits.map(w => w.label).join(" | ");
    for (const text of ["pause complète", "Une personne de l’équipe", "traitée par l'équipe", "admission à réévaluer", "Tous les appels permis ont échoué"]) expect(labels).toContain(text);
    expect(view.followUp?.label).toBe("Relance J2 suspendue (pause), conservée");
    expect(buildCasePilotView({ snapshot: snapshot(), events: [], timers: [], pause: { level: "running", setting: null, invalid: true }, now }).waits[0]).toMatchObject({ needsPerson: true, label: expect.stringContaining("illisible") });
  });
  it("a relayed case awaiting its V2 owner is not shown as handed to the team; a real handoff not taken needs a person", () => {
    const awaiting = buildCasePilotView({ snapshot: snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: "awaiting_v2_attribution" } }), events: [], timers: [], pause: running, now });
    expect(awaiting.waits[0]).toEqual({ label: expect.stringContaining("En attente du propriétaire V2"), needsPerson: false });
    expect(awaiting.waits.map(w => w.label).join(" | ")).not.toMatch(/n’agit pas|Transféré/);
    const handed = buildCasePilotView({ snapshot: snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: "knowledge_missing" } }), events: [], timers: [], pause: running, now });
    expect(handed.waits).toEqual(expect.arrayContaining([{ label: "Équipe requise, pas encore pris en charge.", detail: "Motif knowledge_missing", needsPerson: true }]));
    expect(handed.waits.map(w => w.label).join(" | ")).not.toContain("attribution V2");
  });
  it("v10: a request shows its subject from V1's accepted analysis, or why it has none", async () => {
    const subject = { status: "available", text: "Code de connexion non reçu", provenance: { source: "v1_accepted_analysis", field: "ticketSummary", runId: caseId, runVersion: 1, resultHash: "h", validatorRevision: "v", acceptedAt: "2026-10-31T08:05:00.000Z" } };
    const view = buildCasePilotView({ snapshot: snapshot({}, { openRequests: [{ id: "m1/r0", summary: "Demande", family: "access", status: "open", openedAt: "2026-10-31T08:00:00.000Z", subject },
      { id: "m1/r1", summary: "Autre", family: "usage", status: "open", openedAt: "2026-10-31T08:00:00.000Z", subject: { status: "absent", reason: "summary_shared" } },
      { id: "m1/r2", summary: "Ancienne", family: "usage", status: "open", openedAt: "2026-10-31T08:00:00.000Z" }] as CaseSnapshot["body"]["openRequests"] }), events: [], timers: [], pause: running, now });
    expect(view.requests.map(r => r.subject)).toEqual([{ text: "Code de connexion non reçu", acceptedAt: "2026-10-31T08:05:00.000Z" },
      { missing: "le résumé V1 regroupe plusieurs demandes" }, { missing: "sujet non enregistré (demande antérieure ou ouverte par une personne)" }]);
  });
  it("pole B coverage: only no_applicable_knowledge is a knowledge gap; not_searched and every subject_* code say 'not searched', never a gap", async () => {
    const ids = ["m1/r0", "m1/r1", "m1/r2", "m1/r3", "m1/r4", "m1/r5"];
    const body = { openRequests: ids.map(id => ({ id, summary: `Demande ${id}`, family: "access", status: "open", openedAt: "2026-10-31T08:00:00.000Z" })) } as unknown as Partial<CaseSnapshot["body"]>;
    const decision = { coverage: [
      { requestId: "m1/r0", status: "covered", knowledge: [{ knowledgeId: "k1", contentVersionId: "v1" }], limitations: [] },
      { requestId: "m1/r1", status: "no_applicable_knowledge", knowledge: [], limitations: [] },
      { requestId: "m1/r2", status: "not_searched", knowledge: [], limitations: ["subject_unavailable", "subject_source_missing"] },
      { requestId: "m1/r3", status: "not_searched", knowledge: [] },
      { requestId: "m1/r4", status: "not_searched", knowledge: [], limitations: ["request_or_query_budget"] },
      { requestId: "m1/r5", status: "not_searched", knowledge: [], limitations: ["subject_future_code"] },
    ] };
    const view = buildCasePilotView({ snapshot: snapshot({}, body), events: [event({}), record(proposal(4), 4, null, decision)], timers: [], pause: running, now });
    expect(view.requests.map(r => r.knowledge)).toEqual([
      { label: "Fiche trouvée", gap: false },
      { label: "Aucune fiche publiée applicable : vrai manque de la base de connaissances", gap: true },
      { label: "Non recherché : aucune analyse V1 acceptée ne liste cette demande. Ce n’est pas un manque de la base.", gap: false },
      { label: "Non recherché : raison inconnue. Ce n’est pas un manque de la base.", gap: false },
      { label: "Non recherché : limite de budget de la recherche. Ce n’est pas un manque de la base.", gap: false },
      { label: "Non recherché : raison non reconnue (subject_future_code). Ce n’est pas un manque de la base.", gap: false },
    ]);
    expect(view.requests.filter(r => r.knowledge?.gap)).toHaveLength(1);
    mocks.byTicket.mockResolvedValueOnce(snapshot({}, body)); mocks.events.mockResolvedValueOnce([event({}), record(proposal(4), 4, null, decision)]);
    const html = renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Connaissances : Non recherché : aucune analyse V1 acceptée ne liste cette demande. Ce n’est pas un manque de la base.");
    expect(html.match(/vrai manque de la base/g)).toHaveLength(1);
    // No decision recorded: no coverage claimed for any request.
    expect(buildCasePilotView({ snapshot: snapshot({}, body), events: [event({}), record(proposal(4), 4)], timers: [], pause: running, now }).requests.every(r => r.knowledge === null)).toBe(true);
  });
  it("pole B's rules check: a refusal stays visible with its reasons and next step, accepted is never an approval, pause and provenance are shown", async () => {
    const provenance = { knowledgeRevision: "kr-syn-1", knowledge: [{ knowledgeId: "k1", contentVersionId: "v1" }, { knowledgeId: "k2", contentVersionId: "v1" }], modelCalls: 2,
      revisions: { rules: "rules-syn", playbookId: "pb-syn", model: "model-syn", prompt: "prompt-syn" } };
    const refused = { caseVersion: 4, ...provenance, actionsPaused: true, refusal: { kind: "forbidden_case", nextStep: "team" },
      validation: { outcome: "needs_review", rejections: [{ code: "sensitive_requires_human", label: "stored", path: "nextAction" }, { code: "future_code", label: "x", path: "" }],
        unverified: ["answer_relevance"], signals: ["handoff_knowledge_missing_with_cards"] } };
    const view = buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(4), 4, null, refused)], timers: [], pause: running, now });
    expect(view.check).toEqual({ state: "found", decidedOn: 4, stale: false, accepted: false,
      verdict: "Refusée par les règles : à relire. Le refus est conservé, rien n’est présenté comme proposé à l’envoi.",
      refusals: ["Demande sensible (finance, résiliation, abonnement, droits ou identité) : seule une passation à l'équipe est permise.", "Motif de refus non reconnu par cette version (future_code)"],
      nextStep: "Dossier réservé à l'équipe ou non admis pour l'agent : aucune action de l'agent.",
      unverified: ["Adéquation des fiches citées à la demande du client : non vérifiée."],
      signals: ["Transfert pour connaissance manquante alors que des fiches applicables ont été retrouvées pour chaque demande transférée (transfert peut-être injustifié, Q11)."],
      actionsPaused: true, provenance: { knowledgeRevision: "kr-syn-1", cards: 2, modelCalls: 2, revisions: provenance.revisions } });
    mocks.events.mockResolvedValueOnce([event({}), record(proposal(4), 4, null, refused)]);
    const html = renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve({}) }));
    for (const text of ["Contrôle des règles", "Motifs du refus", "Étape suivante : Dossier réservé", "Décidée pendant la pause des actions", "Signaux à mesurer (non bloquants)",
      "connaissances kr-syn-1 · 2 fiches utilisées · 2 appels modèle · règles rules-syn, playbook pb-syn, modèle model-syn, prompt prompt-syn"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<form|<button|type="submit"/);

    const accepted = { caseVersion: 3, actionsPaused: false, refusal: null, validation: { outcome: "accepted", unverified: [], signals: [] } };
    const ok = buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(4), 4, null, accepted)], timers: [], pause: running, now }).check;
    expect(ok).toMatchObject({ state: "found", accepted: true, stale: true, refusals: [], nextStep: null, provenance: { knowledgeRevision: null, cards: 0, modelCalls: null, revisions: null } });
    expect(ok.state === "found" && ok.verdict).toBe("Conforme aux règles vérifiées (observation) : ce n’est ni une validation humaine ni une autorisation d’envoi.");
    // An unknown stored shape is unreadable, never accepted nor refused; no decision recorded is none.
    for (const bad of [{ caseVersion: 4, validation: { outcome: "approved" } }, { validation: { outcome: "accepted" } }, "x"])
      expect(buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(4), 4, null, bad)], timers: [], pause: running, now }).check).toEqual({ state: "unreadable" });
    expect(buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(4), 4)], timers: [], pause: running, now }).check).toEqual({ state: "none" });
  });
  it("a handoff proposal lists what is missing", () => {
    const handoff = { kind: "handoff", reason: "knowledge_missing", requestIds: ["m1/r0"], report: { need: "Accès bloqué", expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: ["Adresse d’inscription"], expectedIntervention: "Vérifier le compte", knowledge: [] } };
    expect(buildCasePilotView({ snapshot: snapshot(), events: [event({}), record(proposal(4, handoff), 4)], timers: [], pause: running, now }).proposal).toMatchObject({ missingInformation: ["Adresse d’inscription"], handoffNeed: "Accès bloqué" });
  });
});

describe("case page: read-only, no fake approval, true states, role-gated diagnostics", () => {
  const render = async (returnTo?: string) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve(returnTo ? { returnTo } : {}) }));
  it("member: request, evidence, wait, proposal and the missing approval/effects stated, no form or button, no write", async () => {
    const html = await render();
    for (const text of ["Demande d’accès synthétique", "Lire le mail original dans la console", `href="/studio/sav/intake/${threadId}"`, "Dit par le client", "Avez-vous vérifié les indésirables ?",
      "Pourquoi le dossier attend", "Attente du client", "Relance J2 programmée", "Répondre au client", reply.text, "Validation humaine de l’envoi", "Rien ne peut être validé ni envoyé depuis cette page",
      "aucun envoi n’est affiché comme envoyé ou confirmé", "Lecture seule"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<form|<button|type="submit"/);
    expect(html).not.toContain("Diagnostic (administration)");
    expect(mocks.diagnostics).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.pause).toHaveBeenCalledWith({}, "v2");
  });
  it("the internal note is a distinct seam with no action; effects are off unless exactly supervised, and still nothing can be sent", async () => {
    for (const [value, label] of [[undefined, "désactivés"], ["auto", "désactivés"], ["supervised", "mode supervisé demandé"]] as const) {
      vi.unstubAllEnvs(); if (value) vi.stubEnv("SAV_CASE_EFFECTS", value);
      const html = await render();
      expect(html).toContain(`<strong>${label}</strong>`);
      expect(html).toContain("Note interne HubSpot"); expect(html).toContain("aucune note n’est proposée ni ajoutée");
      expect(html).not.toMatch(/<form|<button|type="submit"/);
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("a case without a known thread links to no console dossier", async () => {
    mocks.byTicket.mockResolvedValueOnce(snapshot({ threadIds: [] }));
    const html = await render();
    expect(html).toContain("Premier mail reçu"); expect(html).not.toContain("/studio/sav/intake/");
  });
  it("admin and owner also see the technical diagnostic", async () => {
    for (const role of ["admin", "owner"]) {
      mocks.staff.mockResolvedValueOnce({ email: "ops@example.test", role });
      expect(await render()).toContain("Diagnostic (administration)");
    }
  });
  it("stale proposal is flagged; refused access, invalid or unknown ticket read nothing else", async () => {
    mocks.events.mockResolvedValueOnce([event({}), record(proposal(3), 3)]);
    expect(await render()).toContain("cette proposition doit être revalidée");
    mocks.staff.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
    await expect(render()).rejects.toThrow("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
    await expect(CasePage({ params: Promise.resolve({ ticketId: "../x" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
    mocks.byTicket.mockResolvedValueOnce(null);
    await expect(render()).rejects.toThrow("NOT_FOUND");
    // Only the stale render and the unknown ticket reached the reader: refusal and invalid id read nothing.
    expect(mocks.byTicket).toHaveBeenCalledTimes(2);
  });
  it("Retour keeps the entry search; any other target falls back to it", async () => {
    expect(await render("/studio/sav/v2?ticket=123")).toContain('href="/studio/sav/v2?ticket=123"');
    expect(await render("/studio/sav/v2?phase=awaiting_customer&cursor=c1#case-123")).toContain('href="/studio/sav/v2?phase=awaiting_customer&amp;cursor=c1#case-123"');
    for (const target of ["/studio/admin", "/studio/sav/v2/999", "javascript:alert(1)", "//evil.example/studio/sav/v2", "https://evil.example/studio/sav/v2"]) {
      const html = await render(target); expect(html).toContain('href="/studio/sav/v2?ticket=123"'); expect(html).not.toContain("evil"); expect(html).not.toContain("/studio/admin"); expect(html).not.toContain("javascript:"); expect(html).not.toContain("v2/999");
    }
  });
});

describe("case page: pole C's reply registry, read only (SAV-10 raccord)", () => {
  const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve(search) }));
  const back = "/studio/sav/v2?phase=awaiting_customer&cursor=c1#case-123";
  const connect = () => { mocks.readers = { get: vi.fn(), list: vi.fn() }; return mocks.readers; };
  it("without the registry in this build, the page says it is not connected, never that there is no reply", async () => {
    const html = await render({ reply: replyId(1) });
    expect(html).toContain("Le registre des réponses validées n’est pas branché"); expect(html).toContain("cette réponse ne peut pas être lue ici");
    expect(html).not.toContain("Aucune réponse préparée");
  });
  it("lists the case's replies with honest send states: a started send is maybe, only a confirmed receipt is sent; no button", async () => {
    const readers = connect();
    readers.list.mockResolvedValue({ items: [
      replyItem(1, { code: "awaiting_validation" }, { validation: "proposed", approvability: { ok: true } }),
      replyItem(2, { code: "send_unconfirmed", sent: "maybe" }), replyItem(3, { code: "sent_confirmed", sent: "yes", terminal: true, j2: { state: "scheduled", dueAt: "2026-11-02T09:00:00.000Z" } }),
      replyItem(4, { code: "cancelled", cancel: "approval_revoked", endedBy: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_REVOKED", terminal: true }), replyItem(5, { code: "held", hold: "effects_off" }),
      replyItem(6, { code: "future_code", sent: "unknown" }),
    ], next: null });
    const html = await render({ returnTo: back });
    expect(readers.list).toHaveBeenCalledWith({ caseId, limit: 10 }, expect.objectContaining({ env: expect.any(Function) })); expect(readers.get).toHaveBeenCalledWith({ validationId: replyId(1), caseId }, expect.anything()); // the latest reply opens by itself
    for (const text of ["En attente de validation humaine", "Envoi incertain : vérification en cours", "Envoyée, reçu confirmé", "Relance J2 prévue", "Annulée avant l’envoi : validation retirée",
      "Validée, en attente : envois désactivés sur cet environnement", "État non reconnu par cette version (future_code)", "Fin des réponses."]) expect(html).toContain(text);
    expect(html.match(/Peut-être partie/g)).toHaveLength(2); expect(html.match(/reçu Gmail confirmé/g)).toHaveLength(1); expect(html.match(/Rien n’est parti/g)).toHaveLength(4); // 3 rows + the summary of the latest
    expect(html).toContain(`href="/studio/sav/v2/123?${new URLSearchParams({ returnTo: back, reply: replyId(2) })}#v2-reply"`.replace(/&/g, "&amp;"));
    expect(html).not.toMatch(/<form|<button|type="submit"/); expect(mocks.write).not.toHaveBeenCalled();
  });
  it("an unreadable registry is unavailable, never empty; an empty one says so; another case's row is a fault", async () => {
    const readers = connect();
    readers.list.mockRejectedValueOnce(Error('relation "sav.case_reply_validations" does not exist'));
    const failed = await render(); expect(failed).toContain("Registre des réponses indisponible"); expect(failed).not.toContain("Aucune réponse préparée"); expect(failed).not.toContain("relation");
    readers.list.mockResolvedValueOnce({ items: [], next: null });
    expect(await render()).toContain("Aucune réponse préparée enregistrée pour ce dossier.");
    readers.list.mockResolvedValueOnce({ items: [replyItem(1, {}, { caseId: "20000000-0000-4000-8000-000000000999" })], next: null });
    expect(await render()).toContain("Registre des réponses indisponible");
  });
  it("cursor: a forged one reaches no reader; the next page link keeps the way back and is read back exactly", async () => {
    const readers = connect();
    const forged = await render({ replies: "forged", returnTo: back });
    expect(forged).toContain("Lien de page des réponses invalide"); expect(readers.list).not.toHaveBeenCalled();
    expect(parseCaseReplyCursor(encodeCaseReplyCursor({ createdAt: "2026-10-31T09:30:00.000Z", id: "x" }))).toBeNull();
    const next = { createdAt: "2026-10-31T09:30:00.000Z", id: replyId(9) }, token = encodeCaseReplyCursor(next);
    readers.list.mockResolvedValueOnce({ items: [replyItem(1, {})], next });
    expect(await render({ returnTo: back })).toContain(`href="/studio/sav/v2/123?${new URLSearchParams({ returnTo: back, replies: token })}#v2-replies"`.replace(/&/g, "&amp;"));
    readers.list.mockResolvedValueOnce({ items: [], next: null });
    const page2 = await render({ replies: token, returnTo: back });
    expect(readers.list).toHaveBeenLastCalledWith({ caseId, limit: 10, before: next }, expect.anything());
    expect(page2).toContain("Plus aucune réponse sur cette page"); expect(page2).toContain(`href="${back.replace(/&/g, "&amp;")}"`);
  });
  it("one reply shows its exact text and recipient, offers no decision; another case's, an invalid id or a failed read show nothing of it", async () => {
    const readers = connect(); readers.list.mockResolvedValue({ items: [], next: null });
    readers.get.mockResolvedValueOnce(replyDetail());
    const html = await render({ reply: replyId(1) });
    expect(readers.get).toHaveBeenCalledWith({ validationId: replyId(1), caseId }, expect.anything());
    for (const text of ["client@example.test", "Bonjour, pouvez-vous vérifier vos indésirables ?", "Question posée", "aucune validation n’est possible depuis le Studio", "qui peut valider n’est pas encore décidé"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<form|<button|type="submit"/);
    readers.get.mockResolvedValueOnce(replyDetail({ caseId: "20000000-0000-4000-8000-000000000999" }));
    const other = await render({ reply: replyId(1) }); expect(other).toContain("Aucune réponse avec cet identifiant pour ce dossier"); expect(other).not.toContain("client@example.test"); expect(other).not.toContain("pouvez-vous vérifier");
    readers.get.mockRejectedValueOnce(Error("decrypt failed"));
    expect(await render({ reply: replyId(1) })).toContain("Lecture de la réponse impossible");
    readers.get.mockClear();
    expect(await render({ reply: "../1" })).toContain("Identifiant de réponse invalide"); expect(readers.get).not.toHaveBeenCalled();
  });
  it("a refused role or an unknown case reads nothing from the registry", async () => {
    const readers = connect();
    mocks.staff.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
    await expect(render({ reply: replyId(1) })).rejects.toThrow("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
    mocks.byTicket.mockResolvedValueOnce(null);
    await expect(render({ reply: replyId(1) })).rejects.toThrow("NOT_FOUND");
    expect(readers.list).not.toHaveBeenCalled(); expect(readers.get).not.toHaveBeenCalled();
  });
});

describe("entry page", () => {
  const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await EntryPage({ searchParams: Promise.resolve(search) }));
  it("lists pole A's page of cases with filters, cursor and a way back that keeps them and the row anchor", async () => {
    const html = await render({ phase: "awaiting_customer", cursor: "c1" });
    expect(mocks.list).toHaveBeenCalledWith({ phase: "awaiting_customer", owner: undefined, cursor: "c1" });
    expect(html).toContain('id="case-123"'); expect(html).toContain("Ticket 456"); expect(html).toContain("Sensible : équipe");
    expect(html).toContain("admission à réévaluer"); expect(html).toContain("contrat non lisible par cette version");
    expect(html).toContain(`href="/studio/sav/v2/123?${new URLSearchParams({ returnTo: "/studio/sav/v2?phase=awaiting_customer&cursor=c1#case-123" })}"`.replace(/&/g, "&amp;"));
    expect(html).toContain('href="/studio/sav/v2?phase=awaiting_customer&amp;cursor=c2"'); expect(html).toContain('href="/studio/sav/v2?phase=awaiting_customer"');
    expect(html).not.toContain("indisponible"); expect(html).not.toMatch(/Aucun dossier/);
  });
  it("an unreadable list is unavailable, never empty; an empty list says so; the last page has no next link", async () => {
    mocks.list.mockRejectedValueOnce(Error("connection refused"));
    const failed = await render();
    expect(failed).toContain("Liste des dossiers V2 indisponible"); expect(failed).toContain("ce n’est pas une liste vide"); expect(failed).not.toMatch(/Aucun dossier/);
    mocks.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    const empty = await render();
    expect(empty).toContain("Aucun dossier V2 enregistré"); expect(empty).not.toContain("indisponible");
    mocks.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    expect(await render({ owner: "human" })).toContain("Aucun dossier V2 pour ces filtres");
    mocks.list.mockResolvedValueOnce({ items: [listItem("123")], nextCursor: null });
    const last = await render(); expect(last).toContain("Fin de la liste"); expect(last).not.toContain("Page suivante");
  });
  it("an unknown filter or a cursor refused by pole A is invalid, not empty or unavailable", async () => {
    const filter = await render({ phase: "drop table" });
    expect(filter).toContain("Filtre ou page invalide"); expect(mocks.list).not.toHaveBeenCalled();
    mocks.list.mockRejectedValueOnce(Error("SAV_CASE_PAGE_INVALID"));
    const cursor = await render({ cursor: "forged" });
    expect(cursor).toContain("Filtre ou page invalide"); expect(cursor).not.toContain("indisponible"); expect(cursor).not.toMatch(/Aucun dossier/);
  });
  it("a refused role reads nothing; the ticket search still opens a case with its way back", async () => {
    mocks.staff.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
    await expect(render({ ticket: "123" })).rejects.toThrow("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
    expect(mocks.diagnostics).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
    expect(await render({ ticket: "123" })).toContain(`href="/studio/sav/v2/123?returnTo=%2Fstudio%2Fsav%2Fv2%3Fticket%3D123"`);
  });
  it("invalid ticket, unknown ticket and recording off are explicit", async () => {
    const invalid = await render({ ticket: "12a" }); expect(invalid).toContain("ne contient que des chiffres"); expect(mocks.diagnostics).not.toHaveBeenCalled();
    mocks.diagnostics.mockResolvedValueOnce(null); expect(await render({ ticket: "999" })).toContain("Aucun dossier V2 pour ce ticket");
    mocks.recording.mockReturnValueOnce(false); expect(await render()).toContain("Enregistrement des dossiers V2 désactivé");
  });
});

it("the V2 pages import no writer, model, CRM or Gmail module", () => {
  const imports = ["page.tsx", "[ticketId]/page.tsx", "case-view.ts", "case-replies.ts", "case-replies-port.ts"].flatMap(file => readFileSync(path.join(__dirname, file), "utf8").split("\n").filter(line => line.startsWith("import") || line.includes("use server")));
  expect(imports.length).toBeGreaterThan(10);
  expect(imports.join("\n")).not.toMatch(/transitionCaseOwner|updateCaseRecord|appendCaseEvent|claimCase|scheduleCaseTimer|fireCaseTimer|submitCaseReplyProposal|decideCaseReply|revokeCaseReply|enqueueApprovedCaseReply|case-reply-store|use server|hubspot|gmail|gemini|model-dispatch|actions"/i);
});

describe("operator raccord (UX night): owner and admission as stored, wiring of this build, the selected reply as stored", () => {
  const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve(search) }));
  const FINAL = prepareCaseReplyText("Bonjour, pouvez-vous vérifier vos indésirables ?", "fr", "manual_reviewed");

  it("admission: none is unknown (not a refusal), admitted keeps its policy and version, refused keeps its reasons, identity and CRM read unknown when not proven", () => {
    const view = (over: Partial<CaseSnapshot>) => buildCasePilotView({ snapshot: snapshot(over), events: [event({})], timers: [], pause: running, now }).admission;
    expect(view({ admission: null })).toEqual({ state: "unknown", label: expect.stringContaining("Ce n’est pas un refus") });
    expect(view({})).toMatchObject({ state: "admitted", policyRevision: "p1", version: 2, stale: false, identity: "identité inconnue (non prouvée)", crm: "contexte CRM inconnu (lecture absente ou partielle)" });
    expect(view({ admissionInputVersion: 5, admission: { ...admission, target: "team", reasons: ["sensitive_family", "made_up_reason"] } as unknown as CaseSnapshot["admission"] }))
      .toMatchObject({ state: "refused", stale: true, reasons: [expect.any(String), "motif non reconnu par cette version (made_up_reason)"] });
  });

  it("only a recorded personal takeover reads 'taken by a person'; awaiting the V2 attribution or a handoff nobody took is not; nothing written, no form", async () => {
    mocks.byTicket.mockResolvedValueOnce(snapshot({ owner: "human", phase: "human_owned" }, { handoff: { reason: "fixture", humanSince: "2026-10-31T09:10:00.000Z" } }));
    const taken = await render();
    expect(taken).toContain("Ticket pris par une personne de l’équipe le");
    expect(taken).toContain("même après un nouveau mail du client");
    // Repro of the review finding: a case relayed while waiting for its V2 owner is stored owner=human, but nobody took it.
    mocks.byTicket.mockResolvedValueOnce(snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: SAV_CASE_AWAITING_V2_ATTRIBUTION } }));
    const awaiting = await render();
    expect(awaiting).not.toContain("pris par une personne de l’équipe le"); expect(awaiting).not.toContain("Dossier confié à l’équipe");
    expect(awaiting).toContain("En attente du propriétaire V2");
    mocks.byTicket.mockResolvedValueOnce(snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: "decision_refused" } }));
    const handed = await render();
    expect(handed).toContain("Dossier confié à l’équipe, pas encore pris par une personne : l’agent V2 n’agit pas sur ce dossier.");
    expect(handed).not.toContain("pris par une personne de l’équipe le");
    for (const html of [taken, awaiting, handed]) expect(html).not.toMatch(/<form|<button|type="submit"/);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await render()).not.toMatch(/pris par une personne|Dossier confié à l’équipe/); // the agent-owned default shows neither
  });

  it("the wiring panel says what this build wires on the case page and the entry page: wiring does not imply a case is being processed", async () => {
    for (const html of [await render(), renderToStaticMarkup(await EntryPage({ searchParams: Promise.resolve({}) }))]) {
      expect(html).toContain("Diagnostic technique : raccords de cette version");
      expect(html.match(/>Présent, non branché</g)).toHaveLength(1); expect(html.match(/>Absent</g)).toHaveLength(1); expect(html.match(/>Branché</g)).toHaveLength(6);
      expect(html).not.toMatch(/en cours de traitement|traitement en cours/i);
      expect(html).toContain("<details"); // a folded technical diagnostic, not the operator's first read
    }
    const page = await render();
    expect(page.indexOf("Propriétaire et admission")).toBeLessThan(page.indexOf("Pourquoi le dossier attend"));
    expect(page.indexOf("Pourquoi le dossier attend")).toBeLessThan(page.indexOf("Diagnostic technique : raccords de cette version"));
  });

  it("selected reply, proposed with a raw text: no mention is flagged (nothing added), no validation recorded, not queued", async () => {
    mocks.readers = { get: vi.fn().mockResolvedValue(replyDetail()), list: vi.fn().mockResolvedValue({ items: [], next: null }) };
    const html = await render({ reply: replyId(1) });
    for (const text of ["Texte sans la mention IA attendue", "Aucune validation enregistrée : proposition en attente.", "Pas en file d’envoi : aucune exécution enregistrée.", "Empreinte enregistrée du texte et de son destinataire : aaaaaaaaaaaa…"]) expect(html).toContain(text);
    expect(html).toContain("Bonjour, pouvez-vous vérifier vos indésirables ?</blockquote>");
  });

  it("selected reply: approved and queued, started without receipt (verify only), and confirmed are three different things; a receipt is not a resolution", async () => {
    const detail = (status: Record<string, unknown>, effect: unknown) => replyDetail({ validation: "approved", decidedAt: "2026-10-31T09:40:00.000Z", decidedBy: "20000000-0000-4000-8000-000000000009",
      approvability: { ok: false, reason: "already_decided" }, status: { code: "queued", sent: "no", terminal: false, hold: null, cancel: null, endedBy: null, j2: { state: "none", dueAt: null }, ...status }, effect,
      proposal: { subject: "Re: accès", text: FINAL, question: null } });
    const shown = async (d: unknown) => { mocks.readers = { get: vi.fn().mockResolvedValue(d), list: vi.fn().mockResolvedValue({ items: [], next: null }) }; return render({ reply: replyId(1) }); };
    const queued = await shown(detail({}, { reply: null }));
    for (const text of ["Mention IA présente (français)", "Validation enregistrée le", "(enregistrée par le registre ; cette page n’en crée aucune)", "En file d’envoi : aucun envoi commencé."]) expect(queued).toContain(text);
    expect(queued).not.toMatch(/Reçu Gmail confirmé|Envoi incertain/);
    const uncertain = await shown(detail({ code: "send_unconfirmed", sent: "maybe" }, { reply: { state: "uncertain", dispatchedAt: "2026-10-31T09:50:00.000Z", confirmedAt: null, reconcileAttempts: 2, nextReconcileAt: "2026-10-31T10:20:00.000Z" } }));
    for (const text of ["Envoi commencé le", "Envoi incertain : vérification seule, aucun renvoi. 2 vérifications faites, prochaine le"]) expect(uncertain).toContain(text);
    expect(uncertain).not.toContain("Reçu Gmail confirmé");
    const confirmed = await shown(detail({ code: "sent_confirmed", sent: "yes", terminal: true }, { reply: { state: "confirmed", dispatchedAt: "2026-10-31T09:50:00.000Z", confirmedAt: "2026-10-31T09:51:00.000Z", reconcileAttempts: 0, nextReconcileAt: null } }));
    for (const text of ["Reçu Gmail confirmé le", "Un reçu Gmail prouve que le mail est parti, pas que la demande du client est résolue."]) expect(confirmed).toContain(text);
    expect(confirmed).not.toContain("Envoi incertain");
    for (const html of [queued, uncertain, confirmed]) expect(html).not.toMatch(/<form|<button|type="submit"/);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("a stored text claiming an automatic send without its recorded authority is flagged; the stored text is shown as is (escaped), never rewritten", async () => {
    const auto = prepareCaseReplyText("Bonjour <b>test</b>", "fr", "automated");
    mocks.readers = { get: vi.fn().mockResolvedValue(replyDetail({ proposal: { subject: "Re: accès", text: auto, question: null } })), list: vi.fn().mockResolvedValue({ items: [], next: null }) };
    const html = await render({ reply: replyId(1) });
    expect(html).toContain("sans autorisation automatique enregistrée : le texte seul ne donne aucun droit");
    expect(html).toContain("Bonjour &lt;b&gt;test&lt;/b&gt;"); expect(html).not.toContain("<b>test</b>");
  });
});


describe("case owner as stored (UX lot 5)", () => {
  it("the owner is the V2 case's stored owner, stated as such: not a live HubSpot read", async () => {
    const html = renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Responsable du dossier : <strong>Agent V2</strong>");
    expect(html).toContain("tel qu’enregistré dans le dossier V2 ; ce n’est pas une lecture HubSpot en direct");
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe("what the operator reads first: situation, mail, sheet, checks (nothing invented, unavailable is not empty)", () => {
  const page = async (search: Record<string, string> = {}) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve(search) }));
  const mailRow = { gmailMessageId: "m1", from: "client@example.test", subject: "Accès perdu", receivedAt: "2026-10-31T08:00:00.000Z", text: "Bonjour, je ne reçois pas le code.\n\nLe 30 oct., Support a écrit :\n> ancien message" };

  it("three states of a case, each named, none mistaken for another", async () => {
    mocks.byTicket.mockResolvedValue(snapshot());
    expect(await page()).toContain("En attente du client");
    mocks.byTicket.mockResolvedValue(snapshot({ phase: "closed_no_reply" }, { waiting: null }));
    const closed = await page();
    expect(closed).toContain("Fermé sans réponse du client"); expect(closed).toContain("Cette fermeture ne prouve pas que la demande est résolue.");
    mocks.byTicket.mockResolvedValue(snapshot({ phase: "resolved" }, { waiting: null }));
    expect(await page()).toContain("Fermé : résolu");
    mocks.byTicket.mockResolvedValue(snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: "plan_exhausted" } }));
    expect(await page()).toContain("Équipe requise");
    mocks.byTicket.mockResolvedValue(snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: SAV_CASE_AWAITING_V2_ATTRIBUTION } }));
    const attribution = await page();
    expect(attribution).toContain("En attente du propriétaire V2"); expect(attribution).not.toContain("Équipe requise");
    mocks.byTicket.mockResolvedValue(snapshot({ owner: "human", phase: "human_owned" }, { waiting: null, handoff: { reason: "plan_exhausted", humanSince: "2026-10-31T09:30:00.000Z" } }));
    const taken = await page();
    expect(taken).toContain("Pris en charge par une personne"); expect(taken).not.toContain("Équipe requise");
    mocks.byTicket.mockResolvedValue(snapshot({ phase: "reconciling" }, { waiting: null }));
    expect(await page()).toContain("Vérification d’un résultat incertain");
  });

  it("mail: not wired, read failure, empty journal, missing row, undecryptable text and a mail without text are six different sentences", async () => {
    expect(await page()).toContain("Lecture des mails non branchée sur cette version");
    mocks.dossier = { mails: vi.fn().mockRejectedValue(Error("DB_DOWN")), cards: vi.fn().mockResolvedValue([]) };
    const down = await page();
    expect(down).toContain("Mails indisponibles : la lecture a échoué, ce n’est pas une absence de mail."); expect(down).not.toContain("DB_DOWN");
    mocks.events.mockResolvedValueOnce([]);
    expect(await page()).toContain("Aucun mail client confirmé dans le journal de ce dossier.");
    mocks.dossier.mails.mockResolvedValueOnce([]);
    expect(await page()).toContain("confirmé au journal mais introuvable dans les messages de ce dossier");
    mocks.dossier.mails.mockResolvedValueOnce([{ ...mailRow, text: null }]);
    expect(await page()).toContain("Texte illisible : le déchiffrement a échoué, ce n’est pas un mail vide.");
    mocks.dossier.mails.mockResolvedValueOnce([{ ...mailRow, text: "" }]);
    expect(await page()).toContain("Ce mail ne contient aucun texte.");
  });

  it("mail: the customer's words, escaped, from the case's threads only; the quoted history is hidden and said to be", async () => {
    mocks.dossier = { mails: vi.fn().mockResolvedValue([{ ...mailRow, text: "Bonjour <img src=x>\n\nLe 30 oct., Support a écrit :\n> ancien message" }]), cards: vi.fn().mockResolvedValue([]) };
    const html = await page();
    expect(mocks.dossier.mails).toHaveBeenCalledWith({ threadIds: [threadId], gmailMessageIds: ["m1"] }, { kind: "staff_session_verified", staffUserId: "20000000-0000-4000-8000-000000000003" });
    expect(html).toContain("Bonjour &lt;img src=x&gt;"); expect(html).not.toContain("<img"); expect(html).not.toContain("ancien message");
    expect(html).toContain("Historique cité masqué."); expect(html).toContain("Accès perdu"); expect(html).toContain("client@example.test");
  });

  it("sheet: title read from the base; a failed read shows the stored ids and says so; a ref the base lacks gets no invented title; no decision is not 'no sheet'", async () => {
    const decision = { caseVersion: 4, validation: { outcome: "accepted", rejections: [], unverified: [], signals: [] }, knowledge: [{ knowledgeId: "k1", contentVersionId: "v1" }, { knowledgeId: "k2", contentVersionId: "v9" }], accessScope: { revision: "scope-r1", policyRevision: "p1" } };
    mocks.events.mockResolvedValue([event({}), record(proposal(4), 4, null, decision)]);
    mocks.dossier = { mails: vi.fn().mockResolvedValue([]), cards: vi.fn().mockResolvedValue([{ knowledgeId: "k1", contentVersionId: "v1", title: "Se connecter (SYN)", version: 3 }]) };
    const html = await page();
    expect(html).toContain("Se connecter (SYN)"); expect(html).toContain("Fiche k2, version v9 : introuvable dans la base"); expect(html).toContain("Périmètre des sources : scope-r1, politique p1.");
    mocks.dossier.cards.mockRejectedValueOnce(Error("DB_DOWN"));
    const down = await page();
    expect(down).toContain("Titres des fiches indisponibles"); expect(down).toContain("Fiche k1, version v1 : titre non lu"); expect(down).not.toContain("Se connecter (SYN)");
    mocks.events.mockResolvedValue([event({})]);
    expect(await page()).toContain("Aucune décision enregistrée pour la dernière entrée : aucune fiche n’a encore été retenue.");
    mocks.events.mockResolvedValue([event({}), event({ id: "o2", kind: "observation_recorded", dedupeKey: "observation:o2", caseVersion: 3, direction: "internal", detail: { record: { kind: "sav-case-investigation.v1", inputKey: 7 } } })]);
    expect(await page()).toContain("Décision illisible : on ne sait pas quelle fiche a été retenue.");
  });

  it("checks already done: trials with their outcome, answered questions, rule checks and resolution; V1 and V2 told apart", async () => {
    mocks.byTicket.mockResolvedValue(snapshot({}, {
      trials: [{ id: "t1", requestId: "m1/r0", procedure: { knowledgeId: "k1", contentVersionId: "v1" }, askedAt: "2026-10-31T08:10:00.000Z", outcome: "failed", resultAt: "2026-10-31T08:20:00.000Z", result: { text: "Le code n’arrive pas", source: { type: "email", id: "m1" } } }],
      questions: [{ id: "q9", text: "Quelle adresse avez-vous utilisée ?", factKeys: [], askedAt: "2026-10-31T08:05:00.000Z", askedInEffect: "e1", answeredBy: { type: "email", id: "m1" } }] }));
    const stored = record(proposal(4), 4) as CaseEvent & { detail: { record: { progress: Record<string, unknown> } } };
    stored.detail.record.progress.attempts = [{ call: 1, result: "validated", outcome: "accepted", kinds: [], codes: [] }, { call: 2, result: "failed", purpose: "decision", uncertain: true }];
    stored.detail.record.progress.closure = { plan: "ask_confirmation", verdicts: [], reason: "checked" };
    mocks.events.mockResolvedValue([event({ caseVersion: 2, detail: { relay: { kind: "intake_effects_confirmed" } } }), event({ id: "e2", dedupeKey: "inbound:m2", caseVersion: 1, sourceRef: { type: "email", id: "m2" }, detail: { relay: { kind: "v2_customer_return", route: "continue" } } }), event({ id: "e3", dedupeKey: "inbound:m3", caseVersion: 0, sourceRef: { type: "email", id: "m3" }, detail: { relay: { kind: "invented" } } }), stored]);
    const html = await page();
    for (const text of ["Essai fait : échec", "Le code n’arrive pas", "Quelle adresse avez-vous utilisée ?", "Décision contrôlée : conforme aux règles", "Appel de contrôle au résultat incertain", "Résolution : demander confirmation au client",
      "V1 a traité ce mail et confirmé ses effets", "Retour du client sur un dossier V2 ouvert : repris par V2. Suite : le dossier continue.", "Preuve de relais non reconnue par cette version.", "L’agent V2 est responsable de ce dossier."]) expect(html).toContain(text);
    mocks.events.mockResolvedValue([event({})]);
    expect(await page()).toContain("Aucune preuve de relais V1 enregistrée pour ce mail.");
  });

  it("reply summary: uncertain is neither sent nor not sent, a failed registry says nothing left or not; the latest reply opens by itself", async () => {
    const detail = replyDetail({ ...replyItem(1, { code: "send_unconfirmed", sent: "maybe" }) });
    mocks.readers = { get: vi.fn().mockResolvedValue(detail), list: vi.fn().mockResolvedValue({ items: [replyItem(1, { code: "send_unconfirmed", sent: "maybe" })], next: null }) };
    const html = await page();
    expect(html).toContain("Dernière réponse : Envoi incertain : vérification en cours."); expect(html).toContain("1 envoi incertain sur cette page : à ne compter ni comme envoyé ni comme non envoyé.");
    expect(html).not.toContain("Partie chez le client");
    expect(mocks.readers.get).toHaveBeenCalledWith({ validationId: replyId(1), caseId }, expect.anything());
    mocks.readers = { get: vi.fn(), list: vi.fn().mockRejectedValue(Error("DOWN")) };
    expect(await page()).toContain("Réponses : lecture impossible, on ne sait pas si une réponse est partie.");
    expect(mocks.readers.get).not.toHaveBeenCalled();
    mocks.readers = { get: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], next: null }) };
    expect(await page()).toContain("Aucune réponse préparée enregistrée pour ce dossier.");
    mocks.readers = null;
    expect(await page()).toContain("Réponses : registre non branché sur cette version");
  });

  it("automatic mention: only under the recorded authority; the text never proves it, and a person's mention under the automatic basis is an anomaly", async () => {
    const auto = prepareCaseReplyText("Bonjour.", "fr", "automated"), human = prepareCaseReplyText("Bonjour.", "fr", "manual_reviewed");
    const open = async (text: string, authorizationBasis: string | null) => {
      mocks.readers = { get: vi.fn().mockResolvedValue(replyDetail({ authorizationBasis, proposal: { subject: "Re: accès", text, question: null } })), list: vi.fn().mockResolvedValue({ items: [], next: null }) };
      return page({ reply: replyId(1) });
    };
    expect(await open(auto, ACCESS_AUTO_APPROVAL_BASIS)).toContain("avec une base d’autorisation enregistrée par le registre");
    expect(await open(auto, "forged")).toContain("sans autorisation automatique enregistrée");
    expect(await open(human, ACCESS_AUTO_APPROVAL_BASIS)).toContain("incohérent, le registre doit le refuser");
    expect(await open(human, "human_rule")).toContain("Mention IA présente");
  });

  it("a refused access reads nothing, and the page has no action", async () => {
    mocks.dossier = { mails: vi.fn(), cards: vi.fn() }; mocks.readers = { get: vi.fn(), list: vi.fn() };
    mocks.staff.mockRejectedValueOnce(Error("FORBIDDEN"));
    await expect(page()).rejects.toThrow("FORBIDDEN");
    for (const reader of [mocks.dossier.mails, mocks.dossier.cards, mocks.readers.get, mocks.readers.list, mocks.byTicket, mocks.events]) expect(reader).not.toHaveBeenCalled();
    mocks.readers = null; mocks.dossier = { mails: vi.fn().mockResolvedValue([]), cards: vi.fn().mockResolvedValue([]) };
    expect(await page()).not.toMatch(/<form|<button|type="submit"/);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe("team handoff: what is proven about telling the team (successor of befc005d)", () => {
  const page = async () => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId: "123" }), searchParams: Promise.resolve({}) }));
  const required = () => mocks.byTicket.mockResolvedValue(snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: "plan_exhausted" } }));
  const withNotice = (row: unknown) => { mocks.dossier = { mails: vi.fn().mockResolvedValue([]), cards: vi.fn().mockResolvedValue([]), handoffNotice: vi.fn().mockResolvedValue(row) }; };
  const DELIVERED = /Transmis à Ugo|Ugo a reçu|livrée? à Ugo|lue par Ugo/;

  it("no notice, or a read that failed: team required with its next action; nobody is said to have been told, and the stored Slack fields prove nothing", async () => {
    mocks.byTicket.mockResolvedValue(snapshot({ owner: "human", phase: "handoff_pending" }, { waiting: null, handoff: { reason: "plan_exhausted", slackThread: "t1", postedEffect: "e9" } }));
    withNotice(null);
    const none = await page();
    for (const text of ["Équipe requise", "Aucune notification préparée : elles sont désactivées sur cet environnement.", "Action suivante :", "elle n’a pas été prévenue par l’agent"]) expect(none).toContain(text);
    expect(none).not.toMatch(DELIVERED); expect(none).not.toContain("Notification confirmée");
    mocks.dossier!.handoffNotice!.mockRejectedValueOnce(Error("DB_DOWN"));
    const down = await page();
    expect(down).toContain("Notification : lecture impossible, on ne sait pas si elle est partie."); expect(down).not.toContain("DB_DOWN"); expect(down).not.toContain("elle n’a pas été prévenue");
  });

  it("a planned, started or unclear notice is pending or uncertain, never delivered, even when only the ledger's confirmed state lacks its link", async () => {
    required();
    withNotice({ execution: "pending", effect: null, ack: null });
    expect(await page()).toContain("Notification en attente : rien n’est encore parti.");
    withNotice({ execution: "running", effect: "planned", ack: null });
    expect(await page()).toContain("Notification en attente : rien n’est encore parti.");
    for (const effect of ["dispatched", "acked", "uncertain"]) {
      withNotice({ execution: "uncertain", effect, ack: { ts: "1730000000.000100", channel: "CSYNTHETIC1" } });
      const html = await page();
      expect(html).toContain("Notification incertaine"); expect(html).not.toContain("slack.com/archives"); expect(html).not.toMatch(DELIVERED);
    }
    for (const ack of [null, { ts: "pas-un-ts", channel: "CSYNTHETIC1" }, { ts: "1730000000.000100", channel: "https://evil.example" }]) {
      withNotice({ execution: "confirmed", effect: "confirmed", ack });
      const html = await page();
      expect(html).toContain("sans lien lisible"); expect(html).not.toContain("slack.com/archives"); expect(html).not.toContain("Notification confirmée");
    }
    withNotice({ execution: "uncertain", effect: "future_state", ack: null });
    expect(await page()).toContain("état non reconnu");
    withNotice({ execution: "confirmed", effect: "planned", ack: null }); // contradictory ledger: never "nothing left", never confirmed
    const contradictory = await page();
    expect(contradictory).toContain("état non reconnu"); expect(contradictory).not.toContain("rien n’est parti");
    withNotice({ execution: "refused", effect: "planned", ack: null });
    expect(await page()).toContain("Notification arrêtée avant l’envoi : rien n’est parti.");
  });

  it("only a confirmed effect with its link is confirmed, and it still does not say Ugo read it or anyone took the case", async () => {
    required();
    withNotice({ execution: "confirmed", effect: "confirmed", ack: { ts: "1730000000.000100", channel: "CSYNTHETIC1" } });
    const html = await page();
    expect(html).toContain("Notification confirmée : message posté dans le canal Slack. Cela ne prouve ni qu’Ugo l’a lue, ni que quelqu’un a pris le dossier.");
    expect(html).toContain('href="https://slack.com/archives/CSYNTHETIC1/p1730000000000100"');
    expect(html).toContain("Une personne de l’équipe doit prendre le dossier."); expect(html).not.toMatch(DELIVERED);
    expect(mocks.dossier!.handoffNotice).toHaveBeenCalledWith(caseId, { kind: "staff_session_verified", staffUserId: "20000000-0000-4000-8000-000000000003" });
    // No handoff on the case: the ledger is not even read.
    mocks.byTicket.mockResolvedValue(snapshot());
    mocks.dossier!.handoffNotice!.mockClear();
    expect(await page()).not.toContain("Action suivante :"); expect(mocks.dossier!.handoffNotice).not.toHaveBeenCalled();
  });

  it("viewer: built from the console's staff check only; without a verified id nothing is read; the automatic basis is the shared constant", async () => {
    required();
    withNotice({ execution: "confirmed", effect: "confirmed", ack: { ts: "1730000000.000100", channel: "CSYNTHETIC1" } });
    mocks.staff.mockResolvedValue({ email: "operateur@example.test", role: "member" });
    const html = await page();
    expect(mocks.dossier!.mails).not.toHaveBeenCalled(); expect(mocks.dossier!.handoffNotice).not.toHaveBeenCalled();
    expect(html).toContain("Lecture refusée : identité de la session non vérifiée."); expect(html).toContain("Notification : lecture refusée"); expect(html).not.toContain("Notification confirmée");
    expect(ACCESS_AUTO_APPROVAL_BASIS.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(__dirname, "case-replies.ts"), "utf8")).not.toContain(`"${ACCESS_AUTO_APPROVAL_BASIS}"`);
  });
});
