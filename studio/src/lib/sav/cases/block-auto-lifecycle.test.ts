import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { caseAdmissionRuleStage, decideCaseAdmission, type CaseAdmissionInput } from "./admission-policy";
import { openCaseEvent, readCase } from "./case-store";
import { caseAdmissionPolicySchema, caseAdmissionRuleLifecycleProblem, caseDedupeKey, caseRequestId, type CaseAdmissionQualification } from "./case-types";
import { sweepCaseAdmissionsAfterPolicyChange, type CaseAdmissionSweepPorts } from "./investigation-policy-sweep";
import { caseAdmissionSweepStorePorts } from "./investigation-store-ports";
import { j2AutoGate, readCaseOpenBlocks } from "./j2-auto-reminder";
import { parseCaseBlockScopeList, SAV_CASE_BLOCK_SCOPE_REVISION } from "./investigation-access-scope";
import type { SavAutoOpenBlock } from "./block-auto-reply";

/*
 * 19/11, on the real pole A store (PGlite), synthetic data only:
 *   - revision lifecycle (METHODE §3): a policy lists a block rule's N and N-1 (`previous: true`); a case admitted under N-1 ends under N-1; a new
 *     case is admitted under N; once N-1 leaves the policy its open cases go to the team (`revision_withdrawn`). The sweep is NOT wired here.
 *   - J2 follows the allow-list (`j2AutoGate`): the timer case's block(s), listed, switched explicitly to `auto`, not paused.
 *   - the block scope list accepts the new blocks' families (`usage`, `integration`), never `access` nor the login template.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_400_000;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-11-19T09:00:00.000Z", BLOCK = "syn-widget";
const widget = (revision: string, previous?: true) => ({ ruleId: "rule-widget", revision, families: ["usage"] as ["usage"], blockId: BLOCK, ...(previous ? { previous } : {}) });
const policy = (revision: string, rules: unknown[]) => ({ revision, admittedFamilies: ["usage"], qualifiedRules: rules, approvedBy: STAFF, approvedAt: AT });
const N1 = policy("policy-n1", [widget("r1")]);
const N2 = policy("policy-n2", [widget("r2"), widget("r1", true)]);
const N3 = policy("policy-n3", [widget("r2")]);
const qualification = (revision: string, requestId: string): CaseAdmissionQualification => ({
  requests: [{ requestId, family: "usage", provenance: { kind: "qualified_rule", ruleId: "rule-widget", revision, at: AT, blockId: BLOCK } }],
  identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [],
});
async function blockCase(policyValue: unknown, revision: string) {
  const ticketId = String(++ticketSeq), threadId = randomUUID(), gmail = `gm-${ticketId}`, requestId = caseRequestId(gmail, "r1");
  const admission: CaseAdmissionInput = { policy: policyValue, qualification: qualification(revision, requestId) };
  return (await openCaseEvent({ ticketId, threadId, admission, opens: [{ id: requestId, summary: "Demande synthétique." }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}
const ports = (revision: string, policyValue: unknown): CaseAdmissionSweepPorts => caseAdmissionSweepStorePorts({
  enabled: true, pauseState: async () => "running", now: () => new Date(), admissionPolicyRevision: async () => revision, approvedPolicy: async () => policyValue });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "block-lifecycle-fixture-key-32-chars!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-block-switch.v1:%"));
  await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-agent-pause.v1:%"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the policy lists a rule's N and N-1 (`previous: true`)", () => {
  it("a policy written before the marker parses unchanged, two current revisions included; the marker brings its checks only where it is used", () => {
    expect(caseAdmissionPolicySchema.safeParse(policy("p", [widget("r1"), widget("r2")])).success).toBe(true);
    expect(caseAdmissionPolicySchema.safeParse(N2).success).toBe(true);
    const problems: Array<[unknown[], string]> = [
      [[widget("r1", true)], "rule_previous_without_current"],
      [[widget("r2"), widget("r3"), widget("r1", true)], "rule_too_many_revisions"],
      [[widget("r2"), widget("r2", true)], "rule_revision_duplicate"],
      [[widget("r2", true), widget("r1", true)], "rule_previous_without_current"],
      [[widget("r2"), { ...widget("r1", true), blockId: "syn-other" }], "rule_block_changed"],
      [[widget("r2"), { ...widget("r1", true), blockId: undefined, families: ["usage"] }], "rule_block_changed"],
    ];
    for (const [rules, problem] of problems) {
      expect(caseAdmissionRuleLifecycleProblem(rules as never)).toBe(problem);
      expect(caseAdmissionPolicySchema.safeParse(policy("p", rules)).success).toBe(false);
    }
    expect(caseAdmissionPolicySchema.safeParse(policy("p", [{ ...widget("r1"), previous: false }])).success).toBe(false);
  });
  it("under N and N-1, a qualification under either revision is proven; the stage says which entry it stands on", () => {
    const decide = (revision: string, value: unknown) => decideCaseAdmission({ policy: value, qualification: qualification(revision, "gm-x/r1"), caseSensitivity: "none" }).target;
    expect([decide("r1", N2), decide("r2", N2), decide("r1", N3), decide("r2", N1)]).toEqual(["agent", "agent", "qualification", "qualification"]);
    const parsed = (value: unknown) => caseAdmissionPolicySchema.parse(value);
    expect(caseAdmissionRuleStage(qualification("r1", "gm-x/r1"), parsed(N2))).toBe("previous");
    expect(caseAdmissionRuleStage(qualification("r2", "gm-x/r1"), parsed(N2))).toBe("current");
    expect(caseAdmissionRuleStage(qualification("r1", "gm-x/r1"), parsed(N3))).toBe("withdrawn");
    expect(caseAdmissionRuleStage(qualification("r1", "gm-x/r1"), parsed(policy("p", [{ ...widget("r1"), ruleId: "rule-other" }])))).toBeNull();
    expect(caseAdmissionRuleStage(null, parsed(N2))).toBeNull();
  });
  it("sweep (called by the test, wired nowhere): N-1 cases end under N-1 while it is listed, then go to the team as `revision_withdrawn`", async () => {
    const old = await blockCase(N1, "r1");
    expect(old).toMatchObject({ owner: "agent", admission: { target: "agent", policyRevision: "policy-n1" } });
    // N approved next to N-1: the N-1 case stays with the agent, reported under N-1; a new mail is admitted under N.
    const kept = await sweepCaseAdmissionsAfterPolicyChange(ports("policy-n2", N2), { limit: 200 });
    expect(kept).toMatchObject({ status: "done", policyRevision: "policy-n2" });
    expect("cases" in kept && kept.cases.find(row => row.caseId === old.caseId)).toEqual({ caseId: old.caseId, outcome: "kept_agent", stage: "previous" });
    expect(await readCase(old.caseId)).toMatchObject({ owner: "agent", admission: { target: "agent", policyRevision: "policy-n2" } });
    const fresh = await blockCase(N2, "r2");
    expect(fresh).toMatchObject({ owner: "agent", admission: { target: "agent", policyRevision: "policy-n2" } });
    // N-1 leaves the policy: its last open case goes to the team with the reason; the N case is kept, reported exactly as before (no stage).
    const retired = await sweepCaseAdmissionsAfterPolicyChange(ports("policy-n3", N3), { limit: 200 });
    const cases = "cases" in retired ? retired.cases : [];
    expect(cases.find(row => row.caseId === old.caseId)).toEqual({ caseId: old.caseId, outcome: "to_team", reason: "qualification_unproven", detail: "revision_withdrawn" });
    expect(cases.find(row => row.caseId === fresh.caseId)).toEqual({ caseId: fresh.caseId, outcome: "kept_agent" });
    expect((await readCase(old.caseId))!.owner).toBe("human");
  });
  it("a policy whose lifecycle is malformed is refused by the sweep before any case is read", async () => {
    let listed = 0;
    const broken = policy("policy-bad", [widget("r3"), widget("r2"), widget("r1", true)]);
    const report = await sweepCaseAdmissionsAfterPolicyChange({ ...ports("policy-bad", broken), listCases: async () => { listed++; return []; } });
    expect(report).toEqual({ status: "refused", reason: "policy_invalid" });
    expect(listed).toBe(0);
  });
});

describe("J2 follows the allow-list (`j2AutoGate`)", () => {
  const APPROVER = "30000000-0000-4000-8000-0000000000aa";
  const env = (list: string, j2 = "on") => ({ SAV_V2_J2_AUTO: j2, SAV_V2_AUTO_REPLY: list, SAV_V2_AUTO_APPROVER_ID: APPROVER });
  const setSwitch = async (blockId: string, mode: "off" | "draft" | "auto", paused = false) => {
    const values = { key: `sav-block-switch.v1:${blockId}`, status: "active", cursor: encryptSavPayload({ revision: "sav-block-switch.v1", blockId, mode, paused,
      setBy: "admin@example.invalid", setAt: new Date().toISOString(), reason: "Réglage synthétique" }) };
    await f.db.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
  };
  const pause = async (agent: "intake" | "v2") => {
    const values = { key: `sav-agent-pause.v1:${agent}`, status: "active", cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level: "actions_paused",
      setBy: "admin@example.invalid", setAt: new Date().toISOString(), reason: "Pause synthétique" }) };
    await f.db.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
  };
  const blocks = (...ids: Array<string | null>) => async (): Promise<SavAutoOpenBlock[]> => ids.map(id => ({ family: id === "access" ? "access" : "usage", blockId: id }));

  it("`access` alone: exactly as before (the Access switch, explicit); the case's blocks are never read", async () => {
    const read = vi.fn(blocks(BLOCK));
    expect(await j2AutoGate(env("access"), f.db as never, read)).toBe("block_off");
    await setSwitch("access", "auto");
    expect(await j2AutoGate(env("access"), f.db as never, read)).toBeNull();
    expect(await j2AutoGate(env("access"), f.db as never)).toBeNull();
    expect(await j2AutoGate(env("access", "off"), f.db as never, read)).toBe("j2_auto_off");
    expect(await j2AutoGate(env(""), f.db as never, read)).toBe("j2_auto_off");
    expect(read).not.toHaveBeenCalled();
  });
  it("a longer list: the timer case's own block, listed, explicitly `auto`, not paused; never a default block", async () => {
    const list = env(`access,${BLOCK}`);
    expect(await j2AutoGate(list, f.db as never, blocks(BLOCK))).toBe("block_off");
    await setSwitch(BLOCK, "draft");
    expect(await j2AutoGate(list, f.db as never, blocks(BLOCK))).toBe("block_draft");
    await setSwitch(BLOCK, "auto", true);
    expect(await j2AutoGate(list, f.db as never, blocks(BLOCK))).toBe("block_paused");
    await setSwitch(BLOCK, "auto");
    expect(await j2AutoGate(list, f.db as never, blocks(BLOCK))).toBeNull();
    expect(await j2AutoGate(list, f.db as never, blocks("syn-other"))).toBe("block_not_allowed");
    expect(await j2AutoGate(list, f.db as never, blocks(null))).toBe("block_unknown");
    expect(await j2AutoGate(list, f.db as never)).toBe("block_unknown");
    expect(await j2AutoGate(list, f.db as never, async () => { throw Error("UNREADABLE"); })).toBe("block_unknown");
    expect(await j2AutoGate(list, f.db as never, async () => null)).toBe("block_unknown");
    // Access under the longer list: its own explicit switch, as before.
    expect(await j2AutoGate(list, f.db as never, blocks("access"))).toBe("block_off");
    await setSwitch("access", "auto");
    expect(await j2AutoGate(list, f.db as never, blocks("access"))).toBeNull();
    await pause("v2");
    expect(await j2AutoGate(list, f.db as never, blocks(BLOCK))).toBe("paused");
  });
  it("a case of two blocks: a draft until the pair is qualified, then both switches must be explicitly `auto`", async () => {
    await setSwitch("access", "auto");
    await setSwitch(BLOCK, "auto");
    expect(await j2AutoGate(env(`access,${BLOCK}`), f.db as never, blocks("access", BLOCK))).toBe("multi_block_draft");
    expect(await j2AutoGate(env(`access,${BLOCK},access+${BLOCK}`), f.db as never, blocks("access", BLOCK))).toBeNull();
    await setSwitch(BLOCK, "auto", true);
    expect(await j2AutoGate(env(`access,${BLOCK},access+${BLOCK}`), f.db as never, blocks("access", BLOCK))).toBe("block_paused");
  });
  it("the case's blocks are read from its stored admission (`readCaseOpenBlocks`), never guessed from the family", async () => {
    const c = await blockCase(N1, "r1");
    expect(await readCaseOpenBlocks(f.db as never, c.caseId)).toEqual([{ family: "usage", blockId: BLOCK }]);
    expect(await readCaseOpenBlocks(f.db as never, randomUUID())).toBeNull();
  });
});

describe("block scopes accept the new blocks' families", () => {
  const scope = (family: string, firstReply?: string) => ({ schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: BLOCK, family, policyRevision: "p", revision: "r",
    sources: [{ knowledgeId: "k", contentVersionId: "v", use: "answer", ...(firstReply ? { firstReply } : {}) }] });
  it("`usage` (Collaborators, Charly Max) and `integration` (Integrations) are read; `access` and the login template stay Access's alone", () => {
    expect(parseCaseBlockScopeList([scope("usage")], "p", BLOCK).ok).toBe(true);
    expect(parseCaseBlockScopeList([scope("integration", "procedure_steps")], "p", BLOCK).ok).toBe(true);
    expect(parseCaseBlockScopeList([scope("access")], "p", BLOCK).ok).toBe(false);
    expect(parseCaseBlockScopeList([scope("technical")], "p", BLOCK).ok).toBe(false);
    expect(parseCaseBlockScopeList([scope("integration", "login_code_steps")], "p", BLOCK).ok).toBe(false);
  });
  it("a policy may list `integration` for a block's rule; `access` stays reserved to the Access block", () => {
    const rule = { ruleId: "rule-int", revision: "r1", families: ["integration"], blockId: "syn-int" };
    expect(caseAdmissionPolicySchema.safeParse({ ...policy("p", [rule]), admittedFamilies: ["integration"] }).success).toBe(true);
    expect(caseAdmissionPolicySchema.safeParse({ ...policy("p", [{ ...rule, families: ["access"] }]), admittedFamilies: ["access"] }).success).toBe(false);
  });
});
