import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { decideCaseAdmission } from "./admission-policy";
import {
  emptyCaseBody, isSmartSupportProvenance, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, SAV_SMART_ENTRY_POLICY_REVISION, smartSupportProvenance,
  type CaseAdmissionQualification, type CaseAdmissionRecord, type CaseEvent, type CaseRequestFamily, type CaseSnapshot,
} from "./case-types";
import { caseReplyTriggerOf } from "./investigation-intent";
import { caseInvestigationReturnAwareQualify, caseReturnContentRule, type CaseReturnRulePort } from "./investigation-return-qualify";
import { caseAdmissionNamesLatestInput, latestInvestigationInput } from "./investigation-runner";
import { CaseQualificationUnavailableError } from "./qualification-diagnostic";
import { caseSmartSupportOpen } from "./smart-support-scope";

/*
 * Production bug 25/11: a customer return on an agent-owned SMART case never reached the smart brain. The Access skill knows only Access, so on « team »
 * without a sensitive family it answers nothing; the return then carried `intake_hint` provenances of family `other`, the classic policy refused them,
 * and the case went to the team. Here: the real return qualification on PGlite (stored mails), its result fed to the real admission rule and to the
 * runner's smart test (`caseSmartSupportOpen`). Doubles only for the return rules (the skill's possible answers). Fictional data only.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "";
const SENDER = "client-retour@exemple.invalid";
const STAFF = "20000000-0000-4000-8000-000000000004";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: "2026-11-01T00:00:00.000Z" };
const readPolicyRecord = async () => ({ policy: POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-12-31T00:00:00.000Z" });
const IDENTITY: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };
const ON = () => true, OFF = () => false;
const later = () => new Date(Date.now() + 1_000);

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-return-fixture-key-32-chars!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning();
  mailboxId = mailbox!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-return-fixture-key-32-chars!!!!");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-return-fixture-key-32-chars!!!!"); });

type Kind = "smart" | "access" | "classic";
/** One case of the given kind with its first mail relayed by V1, then a customer return V2 consumed before V1 (both stored). */
async function caseWithReturn(kind: Kind, returnText: string) {
  const threadId = randomUUID(), firstId = randomUUID(), returnId = randomUUID(), firstAt = new Date(Date.now() - 3_600_000), returnAt = new Date(Date.now() - 60_000);
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values([
    { id: firstId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@exemple.invalid"], subject: "Synthétique",
      bodyCiphertext: encryptSavPayload({ text: "Bonjour, une question support." }), receivedAt: firstAt, gmailMessageId: `gm-${firstId}` },
    { id: returnId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@exemple.invalid"], subject: "Re: Synthétique",
      bodyCiphertext: encryptSavPayload({ text: returnText }), receivedAt: returnAt, gmailMessageId: `gm-${returnId}` },
  ]);
  const family: CaseRequestFamily = kind === "access" ? "access" : "other";
  const provenance = kind === "smart" ? smartSupportProvenance(firstAt.toISOString())
    : { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: firstAt.toISOString() };
  const admission: CaseAdmissionRecord = { revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: ["admitted"], nextStep: "none", families: [family], sensitivity: "none",
    policyRevision: kind === "smart" ? SAV_SMART_ENTRY_POLICY_REVISION : POLICY.revision, ...(kind === "smart" ? { admission: "smart_support" as const } : {}),
    decidedAt: firstAt.toISOString(), version: 2, inputVersion: 1,
    qualification: { requests: [{ requestId: "r1", family, provenance }], identity: IDENTITY, crmContext: "complete", teamSignals: [] } };
  const snapshot: CaseSnapshot = { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: randomUUID(), ticketId: "ticket-syn", threadIds: [threadId], version: 4, owner: "agent", phase: "queued",
    sensitivity: "none", createdAt: firstAt.toISOString(), updatedAt: returnAt.toISOString(), admissionInputVersion: 3, admission,
    body: { ...emptyCaseBody(), openRequests: [{ id: "r1", summary: "Demande support.", family, status: "open", openedAt: firstAt.toISOString() }] } as CaseSnapshot["body"] };
  const event = (id: string, version: number, messageId: string, at: Date, relay: Record<string, unknown>): CaseEvent => ({ id, caseId: snapshot.caseId, kind: "inbound_confirmed",
    dedupeKey: `inbound:gm-${messageId}`, caseVersion: version, direction: "customer_inbound", occurredAt: at.toISOString(), sourceRef: { type: "email", id: `gm-${messageId}` },
    detail: { messageId, relay }, createdAt: at.toISOString() });
  const events = [event(randomUUID(), 1, firstId, firstAt, { kind: "intake_effects_confirmed" }), event(randomUUID(), 3, returnId, returnAt, { kind: "v2_customer_return", messageId: returnId })];
  return { snapshot, events, gmail: `gm-${returnId}` };
}

/** What the Access skill can answer on a return: nothing (« team » with no sensitive family, or unsure), or a sensitive family on every open request. */
const skillNothing = (): CaseReturnRulePort & { calls: number } => {
  const port = Object.assign(async () => { port.calls++; return []; }, { calls: 0 });
  return port;
};
const skillFamily = (family: CaseRequestFamily): CaseReturnRulePort => async ({ requests }) =>
  requests.map(row => ({ requestId: row.requestId, family, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: later().toISOString() } }));
const qualifier = (returnRules: CaseReturnRulePort | undefined, smartSupport?: () => boolean) =>
  caseInvestigationReturnAwareQualify(async () => { throw Error("V1_QUALIFY_NOT_EXPECTED"); },
    { readPolicyRecord, now: () => new Date(), ...(returnRules ? { returnRules } : {}), ...(smartSupport ? { smartSupport } : {}) });
/** The snapshot as the store records it after the re-evaluation: the decision of the real admission rule, on this input. */
const readmitted = (snapshot: CaseSnapshot, qualified: NonNullable<Awaited<ReturnType<ReturnType<typeof qualifier>>>>): CaseSnapshot => {
  const decision = decideCaseAdmission({ ...qualified.admission, caseSensitivity: "none" });
  return { ...snapshot, admission: { ...decision, decidedAt: new Date().toISOString(), version: snapshot.version + 1, inputVersion: snapshot.admissionInputVersion, qualification: qualified.admission.qualification } };
};

describe("a customer return on a smart case reaches the smart brain", () => {
  it("the skill answers nothing: every open request keeps the smart provenance, dated from the mail, and the case stays smart-admitted on this input", async () => {
    const { snapshot, events } = await caseWithReturn("smart", "Merci, mais l'export Google Sheet ne se remplit toujours pas.");
    const skill = skillNothing();
    const qualified = (await qualifier(skill, ON)(snapshot, events))!;
    expect(skill.calls).toBe(1);
    expect(qualified.admission.qualification.requests).toEqual([{ requestId: "r1", family: "other", provenance: smartSupportProvenance(events[1]!.occurredAt) }]);
    const after = readmitted(snapshot, qualified);
    expect(after.admission).toMatchObject({ target: "agent", reasons: ["admitted"], admission: "smart_support", policyRevision: SAV_SMART_ENTRY_POLICY_REVISION });
    // The runner's smart path (`investigation-runner.ts`: `smartSupport() && caseSmartSupportOpen`) and its current-input check both hold.
    expect(caseSmartSupportOpen(after)).toBe(true);
    expect(caseAdmissionNamesLatestInput(after, events)).toBe(true);
  });

  it("no return rule configured: the same smart continuation (the smart brain judges sensitivity)", async () => {
    const { snapshot, events } = await caseWithReturn("smart", "Toujours le même souci sur mes routines.");
    const qualified = (await qualifier(undefined, ON)(snapshot, events))!;
    expect(qualified.admission.qualification.requests.every(row => isSmartSupportProvenance(row.provenance))).toBe(true);
    expect(caseSmartSupportOpen(readmitted(snapshot, qualified))).toBe(true);
  });

  it("a sensitive return (skill or kernel names finance or cancellation) goes to the team, never smart", async () => {
    for (const rule of [skillFamily("finance"), skillFamily("cancellation"), caseReturnContentRule({ ruleId: "rule-access", revision: "r1" }, later)]) {
      const { snapshot, events } = await caseWithReturn("smart", "Je souhaite résilier mon abonnement et être remboursé.");
      const qualified = (await qualifier(rule, ON)(snapshot, events))!;
      expect(qualified.admission.qualification.requests.some(row => isSmartSupportProvenance(row.provenance))).toBe(false);
      const after = readmitted(snapshot, qualified);
      expect(after.admission).toMatchObject({ target: "team", reasons: expect.arrayContaining(["sensitive_family"]) });
      expect(caseSmartSupportOpen(after)).toBe(false);
    }
  });

  it("a rule that fails stays a technical gap on a smart case (retried later, nothing decided)", async () => {
    const { snapshot, events } = await caseWithReturn("smart", "Toujours rien.");
    const failure = qualifier(async () => { throw Error("SKILL_DOWN_SYN"); }, ON)(snapshot, events);
    await expect(failure).rejects.toBeInstanceOf(CaseQualificationUnavailableError);
    await expect(failure).rejects.toMatchObject({ code: "rule_unavailable", nature: "technical" });
  });

  it("the switch off: a smart case's return is qualified exactly as before (team)", async () => {
    const { snapshot, events } = await caseWithReturn("smart", "Toujours le même souci.");
    const off = await qualifier(skillNothing(), OFF)(snapshot, events), legacy = await qualifier(skillNothing())(snapshot, events);
    expect(off).toEqual(legacy);
    expect(off!.admission.qualification.requests).toEqual([{ requestId: "r1", family: "other", provenance: { kind: "intake_hint", source: events[1]!.sourceRef } }]);
    expect(caseSmartSupportOpen(readmitted(snapshot, off!))).toBe(false);
  });
});

describe("non-smart cases: byte-identical with the smart switch on", () => {
  it("an Access case: the same qualification with or without the smart switch, still admitted by the Access rule", async () => {
    const { snapshot, events } = await caseWithReturn("access", "Je ne reçois toujours pas le code.");
    const on = await qualifier(skillFamily("access"), ON)(snapshot, events), legacy = await qualifier(skillFamily("access"))(snapshot, events);
    expect(JSON.stringify(on, (key, value) => key === "at" ? "<at>" : value)).toBe(JSON.stringify(legacy, (key, value) => key === "at" ? "<at>" : value));
    expect(readmitted(snapshot, on!).admission).toMatchObject({ target: "agent", policyRevision: POLICY.revision });
    expect(on!.admission.qualification.requests.some(row => isSmartSupportProvenance(row.provenance))).toBe(false);
  });

  it("a classic (non-smart) case: the same team outcome with or without the smart switch", async () => {
    const { snapshot, events } = await caseWithReturn("classic", "Toujours le même souci.");
    const on = await qualifier(skillNothing(), ON)(snapshot, events), legacy = await qualifier(skillNothing())(snapshot, events);
    expect(on).toEqual(legacy);
    expect(caseSmartSupportOpen(readmitted(snapshot, on!))).toBe(false);
  });
});

describe("no double send", () => {
  it("the reply trigger stays the stored return's per-mail key `inbound:<Gmail id>`, before and after the smart requalification", async () => {
    const { snapshot, events, gmail } = await caseWithReturn("smart", "Toujours le même souci.");
    const before = caseReplyTriggerOf(events, latestInvestigationInput(events)!);
    const qualified = (await qualifier(skillNothing(), ON)(snapshot, events))!;
    expect(before).toBe(`inbound:${gmail}`);
    expect(qualified.sourceRef).toEqual({ type: "email", id: gmail });
    expect(caseReplyTriggerOf(events, latestInvestigationInput(events)!)).toBe(before);
  });
});
