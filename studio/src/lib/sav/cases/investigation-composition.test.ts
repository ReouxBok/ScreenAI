import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import type { SavRetrievalCandidate } from "../request-retrieval";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: importing HubSpot, the model dispatcher or the call ledger fails the file; fetch is a silent spy.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
vi.mock("../intake/runtime-store", () => { throw Error("LEDGER_IMPORTED"); });
import type { CaseAdmissionInput } from "./admission-policy";
import { claimCaseForDecision, listCaseEvents, openCaseEvent, readCase, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";
import { runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * 30/10: B on the composition with pole A af1f76d (contract v8 plus two refusals: a full memory never goes back to the
 * agent, the requests a mail opened are immutable for the agent). Real store on PGlite; fakes only outside A and B: the
 * model, the rules, knowledge, texts, the clock, and the call ledger. The ledger is the ROOT dispatcher's: its replay
 * rule here (one payment per `callKey`) is this test's assumption, the need written in B's contract note, not a
 * contract of ROOT's. Nothing is sent. Synthetic data only.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_700_000;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-10-30T09:00:00.000Z", HOLDER = "sav-v2-investigation";
const staff = { type: "human" as const, staffUserId: STAFF };
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
type Identity = CaseAdmissionQualification["identity"];
const CONFIRMED: Identity = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const qualification = (requests: CaseAdmissionQualification["requests"], identity = CONFIRMED): CaseAdmissionQualification =>
  ({ requests, identity, crmContext: "complete", teamSignals: [] });
const byRule = (id: string, identity = CONFIRMED): CaseAdmissionInput =>
  ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }], identity) });
const hinted = (id: string, family: "unknown" | "identity"): CaseAdmissionInput =>
  ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family, provenance: { kind: "intake_hint", source: { type: "email", id } } }]) });
const RESET = { id: "k-reset", contentVersionId: "k-reset-v1", title: "Réinitialiser l'accès", content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
const RESET_REF = { knowledgeId: RESET.id, contentVersionId: RESET.contentVersionId };

const texts: Record<string, string> = {};
async function mail(ticketId: string, threadId: string, id: string, admission: CaseAdmissionInput, admissionMode?: "exclusions_only") {
  texts[`email:${id}`] = "Bonjour, je n'arrive plus à me connecter.";
  return (await openCaseEvent({ ticketId, threadId, admission, admissionMode, opens: [{ id: caseRequestId(id, "r1"), summary: "Demande synthétique." }], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
}
async function accessCase(gmail: string, identity = CONFIRMED) {
  const ticketId = String(++ticketSeq), threadId = randomUUID();
  return { ticketId, threadId, c: await mail(ticketId, threadId, gmail, byRule(gmail, identity)) };
}
/** Q5 bench: `n` resolved requests written by a person, so the memory holds n + 1 and the next mail may not fit. */
async function filled(gmail: string, n: number) {
  const { ticketId, threadId, c } = await accessCase(gmail);
  const filler = Array.from({ length: n }, (_, i) => ({ id: `${gmail}/filler-${i}`, summary: "Demande synthétique.", family: "usage" as const, status: "resolved" as const, openedAt: AT }));
  const full = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: staff, body: { ...c.body, openRequests: [...c.body.openRequests, ...filler] } });
  return { ticketId, threadId, c: full };
}

const understood = (snapshot: CaseSnapshot) => ({ requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] });
const answer = (request: CaseInvestigationModelRequest): CaseInvestigationModelResult => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "answer", requestIds: [u.requests[0]!.id], steps: [{ text: "Suivre la fiche « Réinitialiser l'accès ».", knowledge: RESET_REF }], expectedResult: "La connexion fonctionne." },
    reply: { text: "Bonjour, voici la marche à suivre depuis https://new.limova.ai : Réinitialiser l'accès.", citations: [RESET_REF], impossibilityClaims: [], accountAdvice: "none" } } };
};

/** Fake ROOT ledger: one payment per `callKey`. A replayed key is never paid again; it gives back the stored result when
 * the ledger knows it, and an uncertain usage when it does not (the provider may have run). */
const ledger = new Map<string, CaseInvestigationModelResult | "unknown">();
let paid = 0;
type Run = { ports: CaseInvestigationPorts; calls: CaseInvestigationModelRequest[]; dead?: { token: string | null; lateRelease: CaseInvestigationPorts["release"] } };
function ports(options: { at?: number; during?: () => Promise<void>; crashAfterPaying?: boolean } = {}): Run {
  const calls: CaseInvestigationModelRequest[] = [];
  const built = caseInvestigationStorePorts({
    // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
    readTicketOwner: async () => "v2",
    holder: HOLDER, scope: { locale: "fr-FR", audience: "support" },
    now: () => new Date(Date.now() + (options.at ?? 6 * 60_000)),
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level, knowledge: async () => [RESET],
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, texts[`${row.type}:${row.id}`]]).filter(([, text]) => text !== undefined)),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => {
      calls.push(request);
      if (options.during) { const during = options.during; options.during = undefined; await during(); }
      const known = ledger.get(request.callKey);
      if (known) return known === "unknown" ? { status: "failed", uncertain: true } : known;
      paid++;
      if (options.crashAfterPaying) { ledger.set(request.callKey, "unknown"); throw Error("PROCESS_KILLED"); }
      const result = answer(request);
      ledger.set(request.callKey, result);
      return result;
    },
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async () => null,
  });
  if (!options.crashAfterPaying) return { ports: built, calls };
  // A killed process runs no `finally`: its claim stays until the TTL and its pending progress is lost. The token is
  // kept only to let the dead process write late (`lateRelease`), as a frozen worker waking up would.
  const dead: NonNullable<Run["dead"]> = { token: null, lateRelease: built.release };
  return { ports: { ...built, release: async (_caseId, token) => { dead.token = token; } }, calls, dead };
}
const run = (caseId: string, r: Run) => runCaseInvestigation(caseId, "observe", r.ports);
const observations = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "observation_recorded");
const journal = async (caseId: string) => (await listCaseEvents(caseId)).map(event => `${event.caseVersion}:${event.kind}`);
async function setV2Pause(level: "actions_paused" | "fully_paused" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "composition-fixture-key-32-chars-xxx");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  ledger.clear(); paid = 0;
});
afterEach(async () => { expect(vi.mocked(fetch).mock.calls).toEqual([]); await setV2Pause(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("B on pole A af1f76d: full memory and immutable requests", () => {
  for (const put of ["technical_hold", "human_takeover"] as const) {
    it(`${put}: a mail the full memory could not take keeps the case with the team; B never runs it`, async () => {
      const { ticketId, threadId, c } = await filled(`gm-cmp-${put}`, 49);
      const moved = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: put, actor: put === "technical_hold" ? { type: "system" } : staff, commandKey: `cmp-${put}`, reason: "fixture" });
      const relayed = await mail(ticketId, threadId, `gm-cmp-${put}-2`, hinted(`gm-cmp-${put}-2`, "unknown"), "exclusions_only");
      expect(relayed).toMatchObject({ owner: moved.case.owner });
      expect(relayed.body.openRequests.map(row => row.id)).not.toContain(`gm-cmp-${put}-2/r1`);
      const back = { caseId: c.caseId, expectedVersion: relayed.version, actor: staff, commandKey: `cmp-${put}-back`, reason: "fixture", admission: byRule(`gm-cmp-${put}`) };
      await expect(put === "technical_hold" ? transitionCaseOwner({ ...back, transition: "hold_release", to: "agent" }) : transitionCaseOwner({ ...back, transition: "hand_back" }))
        .rejects.toThrow("SAV_CASE_BODY_LIMIT_REACHED");
      const r = ports();
      expect(await run(c.caseId, r)).toMatchObject({ status: "skipped", reason: "not_agent_owned", detail: moved.case.owner, modelCalls: 0 });
      expect([r.calls.length, paid, (await observations(c.caseId)).length]).toEqual([0, 0, 0]);
    });
  }

  it("a mail that fills the memory during the call: pole A hands the case to the team, B's decision is not applied and never re-paid", async () => {
    const { ticketId, threadId, c } = await filled("gm-cmp-full-run", 49);
    const during = () => mail(ticketId, threadId, "gm-cmp-full-run-2", hinted("gm-cmp-full-run-2", "unknown"), "exclusions_only").then(() => undefined);
    const r = ports({ during });
    expect(await run(c.caseId, r)).toMatchObject({ status: "stale_requeue", modelCalls: 1 });
    const after = (await readCase(c.caseId))!;
    expect(after).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "body_limit_reached" } } });
    // Pole A cleared the claim with the owner: nothing of this run is written; the paid call stays in the ledger only.
    expect(await observations(c.caseId)).toEqual([]);
    const again = ports();
    expect(await run(c.caseId, again)).toMatchObject({ status: "skipped", reason: "not_agent_owned", detail: "human", modelCalls: 0 });
    expect(paid).toBe(1);
  });

  it("B writes its journal only: the requests stay byte-identical, a future agent writer may move a status, never rewrite one", async () => {
    const { c } = await accessCase("gm-cmp-req");
    const before = JSON.stringify(c.body.openRequests);
    expect(await run(c.caseId, ports())).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const [obs] = await observations(c.caseId);
    // Attribution: the write is B's claim on the version it read, applied once.
    expect(obs!.detail).toMatchObject({ applied: true, reason: null, holder: HOLDER, claimVersion: c.version });
    const now = (await readCase(c.caseId))!, [r1] = now.body.openRequests;
    expect(JSON.stringify(now.body.openRequests)).toBe(before);
    // SIMULATED SAV-10 writer, as the agent: drop, rename, re-family are refused with nothing written; a status move passes.
    const write = (openRequests: typeof now.body.openRequests) => updateCaseRecord({ caseId: c.caseId, expectedVersion: now.version, actor: { type: "agent" }, body: { ...now.body, openRequests } });
    for (const changed of [[], [{ ...r1!, summary: "Autre." }], [{ ...r1!, family: "usage" as const }]]) await expect(write(changed)).rejects.toThrow("SAV_CASE_REQUEST_IMMUTABLE");
    expect((await readCase(c.caseId))!.version).toBe(now.version);
    expect((await write([{ ...r1!, status: "resolved" }])).body.openRequests[0]).toMatchObject({ id: r1!.id, status: "resolved" });
  });
});

describe("B on pole A af1f76d: the case leaves the agent during a call (pole A clears the claim)", () => {
  it("a person takes the case during the call: stale_requeue, nothing written, no crash; the call stays paid once", async () => {
    const { c } = await accessCase("gm-cmp-take");
    const during = async () => { await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: staff, commandKey: "cmp-take", reason: "personal" }); };
    expect(await run(c.caseId, ports({ during }))).toMatchObject({ status: "stale_requeue", currentVersion: c.version + 1, modelCalls: 1 });
    expect(await observations(c.caseId)).toEqual([]);
    expect((await readCase(c.caseId))!).toMatchObject({ owner: "human" });
    expect(paid).toBe(1);
  });

  it("a claim that expired while the case stayed with the agent is still a visible failure", async () => {
    const { c } = await accessCase("gm-cmp-expired");
    const during = async () => {
      expect(await claimCaseForDecision({ caseId: c.caseId, expectedVersion: c.version, holder: "other-worker", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 20 * 60_000) })).toMatchObject({ claimed: true });
    };
    await expect(run(c.caseId, ports({ during }))).rejects.toThrow("SAV_CASE_CLAIM_LOST");
    expect(await observations(c.caseId)).toEqual([]);
  });
});

describe("B on pole A af1f76d: identity, sensitive requests and pauses", () => {
  it("an unconfirmed identity is never admitted: B does not run, whatever the rule says", async () => {
    const { c } = await accessCase("gm-cmp-id", { status: "ambiguous" });
    expect(c.admission).toMatchObject({ target: "qualification", reasons: ["identity_unconfirmed"] });
    expect(c.owner).not.toBe("agent");
    const r = ports();
    expect(await run(c.caseId, r)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(r.calls).toEqual([]);
  });

  it("an identity request relayed on an agent case: the team keeps it, and B's own gate still refuses if it comes back", async () => {
    const { ticketId, threadId, c } = await accessCase("gm-cmp-sens");
    const relayed = await mail(ticketId, threadId, "gm-cmp-sens-2", hinted("gm-cmp-sens-2", "identity"), "exclusions_only");
    expect(relayed.owner).not.toBe("agent");
    expect(relayed.body.openRequests.find(row => row.id === "gm-cmp-sens-2/r1")).toMatchObject({ family: "identity", status: "open" });
    const r = ports();
    expect(await run(c.caseId, r)).toMatchObject({ status: "skipped", reason: "excluded_sensitive", detail: "identity", modelCalls: 0 });
    // Handed back by a person with a clean admission: pole A or B's gate must stop it; never a call on an identity request.
    const back = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: relayed.version, transition: "hand_back", actor: staff, commandKey: "cmp-sens-back", reason: "fixture", admission: byRule("gm-cmp-sens") })
      .then(moved => moved.case.owner, (error: Error) => error.message);
    const again = ports();
    expect(await run(c.caseId, again)).toMatchObject({ status: "skipped", reason: "excluded_sensitive", modelCalls: 0 });
    expect({ back, calls: r.calls.length + again.calls.length, paid }).toEqual({ back: expect.any(String), calls: 0, paid: 0 });
  });

  it("fully paused: no claim, no call; actions paused: one decision, marked", async () => {
    const { c } = await accessCase("gm-cmp-pause");
    await setV2Pause("fully_paused");
    const r = ports();
    expect(await run(c.caseId, r)).toMatchObject({ status: "paused", modelCalls: 0 });
    await setV2Pause("actions_paused");
    expect(await run(c.caseId, ports())).toMatchObject({ status: "recorded", actionsPaused: true, modelCalls: 1 });
    expect([r.calls.length, paid]).toEqual([0, 1]);
  });
});

describe("B on pole A af1f76d: concurrency, crash and resumption without a duplicate", () => {
  it("two runners at once: one claim, one call, one observation", async () => {
    const { c } = await accessCase("gm-cmp-twin");
    const [a, b] = [ports(), ports()];
    const reports = await Promise.all([run(c.caseId, a), run(c.caseId, b)]);
    expect(reports.map(report => report.status).sort()).toEqual(["claim_refused", "recorded"]);
    expect(reports.find(report => report.status === "claim_refused")).toMatchObject({ reason: "busy", modelCalls: 0 });
    expect([a.calls.length + b.calls.length, paid, (await observations(c.caseId)).length]).toEqual([1, 1, 1]);
    expect(await run(c.caseId, ports())).toMatchObject({ status: "already_recorded" });
    expect(paid).toBe(1);
  });

  for (const ledgerKnows of [true, false]) {
    it(`a process killed after paying (${ledgerKnows ? "ledger knows the result" : "result unknown"}): the claim holds until its TTL, the resumed run replays the same key, nothing is paid twice and the dead claim cannot write`, async () => {
      const { c } = await accessCase(`gm-cmp-crash-${ledgerKnows}`);
      const dead = ports({ crashAfterPaying: true });
      await expect(run(c.caseId, dead)).rejects.toThrow("PROCESS_KILLED");
      expect([paid, (await observations(c.caseId)).length]).toEqual([1, 0]);
      if (ledgerKnows) ledger.set(dead.calls[0]!.callKey, answer(dead.calls[0]!));
      // Before the TTL: the dead claim is still live, nobody else calls.
      const early = ports();
      expect(await run(c.caseId, early)).toMatchObject({ status: "claim_refused", reason: "busy", modelCalls: 0 });
      // After the TTL (300 s): same input, same call number, same key; a late write of the dead claim changes nothing.
      let late: unknown;
      const resumed = ports({ at: 6 * 60_000 + 301_000, during: async () => { late = await dead.dead!.lateRelease(c.caseId, dead.dead!.token!).then(() => "released", (error: Error) => error.message); } });
      const report = await run(c.caseId, resumed);
      expect(late).toMatch(/^(released|SAV_CASE_CLAIM_LOST)$/);
      expect(resumed.calls.map(call => call.callKey)).toEqual(dead.calls.map(call => call.callKey));
      expect(report).toMatchObject(ledgerKnows ? { status: "recorded", outcome: "accepted", modelCalls: 1 } : { status: "usage_uncertain", modelCalls: 1 });
      expect(paid).toBe(1);
      const obs = await observations(c.caseId);
      expect(obs).toHaveLength(1);
      expect(obs[0]!.detail).toMatchObject({ holder: HOLDER, claimVersion: c.version });
      // And again: no further call either way.
      const later = ports({ at: 6 * 60_000 + 302_000 });
      expect(await run(c.caseId, later)).toMatchObject({ status: ledgerKnows ? "already_recorded" : "usage_uncertain" });
      expect([later.calls.length, paid]).toEqual([0, 1]);
    });
  }

  it("a stale claim token is refused by pole A: it can neither take nor end another runner's claim", async () => {
    const { c } = await accessCase("gm-cmp-token");
    const live = await claimCaseForDecision({ caseId: c.caseId, expectedVersion: c.version, holder: HOLDER, currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) });
    expect(live).toMatchObject({ claimed: true });
    const before = await journal(c.caseId), r = ports();
    await r.ports.release(c.caseId, randomUUID());
    expect(await run(c.caseId, r)).toMatchObject({ status: "claim_refused", reason: "busy", modelCalls: 0 });
    expect(await journal(c.caseId)).toEqual(before);
    expect((await observations(c.caseId)).length).toBe(0);
  });
});
