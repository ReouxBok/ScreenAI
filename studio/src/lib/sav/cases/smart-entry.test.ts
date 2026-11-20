import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ message: null as null | { body: string; subject: string; receivedAt: Date }, reads: 0 }));
// The entry reads one stored mail; nothing else of the database is reachable from this file.
vi.mock("@/db", () => ({ requireDb: () => ({ select: () => ({ from: () => ({ where: async () => { state.reads += 1; return state.message ? [state.message] : []; } }) }) }) }));
import { encryptSavPayload } from "../crypto";
import { caseAdmissionStatus, decideCaseAdmission } from "./admission-policy";
import { qualifyTicketIdentity } from "./admission-runtime";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import type { CaseEntryRule } from "./case-blocks";
import type { CaseAdmissionQualification } from "./case-types";
import { savCaseSensitiveWording } from "./investigation-return-qualify";
import {
  isSmartSupportProvenance, SAV_SMART_ENTRY_POLICY_REVISION, SAV_V2_ENTRY_SMART_ENV, savV2EntrySmartOn, smartSupportProvenance,
} from "./smart-entry-switch";
import { firstBlockEvidence } from "./v2-entry";

/*
 * SAV-117 (N4), SYNTHETIC only: the new entry behind `SAV_V2_ENTRY_SMART`. What is proven: only `on` switches it on; off, the block entry answers exactly as
 * before; on, every mail V1 classified support is admitted whatever its topic (no block, no word list, no policy), while a non-support request in the mail,
 * an unconfirmed identity, an incomplete CRM or no ticket keep it with the team.
 */

const AT = "2026-11-20T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000117";
const ACCESS_RULE: CaseEntryRule = { ruleId: "rule-syn-access", revision: "r1", v1Kind: "support", family: "access", at: AT };
const POLICY = { revision: "policy-syn-r1", admittedFamilies: ["access"], approvedBy: STAFF, approvedAt: AT, qualifiedRules: [{ ruleId: "rule-syn-access", revision: "r1", families: ["access"] }] };
const SHEET = { text: "Bonjour, mon Google Sheet est mal rempli par l'assistant, il manque des colonnes.", subject: "Google Sheet mal rempli" };
const INVOICE = { text: "Bonjour, où est ma facture du mois dernier ?", subject: "Facture" };
const LOGIN = { text: "Bonjour, je ne reçois pas le code de connexion à mon compte.", subject: "Connexion impossible" };
const ON = { [SAV_V2_ENTRY_SMART_ENV]: "on", SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([ACCESS_RULE]) };
const OFF = { SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([ACCESS_RULE]) };
const support = (n = 1) => Array.from({ length: n }, (_, i) => ({ requestId: `gm-syn/r${i + 1}`, kind: "support" }));
const mail = (input: { text: string; subject: string }) => { state.message = { body: encryptSavPayload({ text: input.text }), subject: input.subject, receivedAt: new Date(AT) }; };
const evidence = (env: Record<string, string>, requests: { requestId: string; kind: string }[] = support()) =>
  firstBlockEvidence(env, "message-syn", "gm-syn", requests, SAV_CASE_BLOCK_REGISTRY, { accessSkillCompute: "always" });
const confirmed = { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-syn" } };
const qualification = (requests: CaseAdmissionQualification["requests"], over: Partial<CaseAdmissionQualification> = {}): CaseAdmissionQualification =>
  ({ requests, identity: confirmed, crmContext: "complete", teamSignals: [], ...over });
const decide = (q: CaseAdmissionQualification, policy: unknown = null, caseSensitivity: "none" | "finance" | "cancellation" = "none") =>
  decideCaseAdmission({ policy, qualification: q, caseSensitivity });

beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-entry-fixture-key-32-chars!!!!");
  state.message = null; state.reads = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the switch: `on` only", () => {
  it("is on for `on` and off for anything else", () => {
    expect(savV2EntrySmartOn({ SAV_V2_ENTRY_SMART: "on" })).toBe(true);
    for (const value of [undefined, "", "ON", "On", "true", "1", "shadow", " on", "on "]) expect(savV2EntrySmartOn({ SAV_V2_ENTRY_SMART: value })).toBe(false);
  });
});

describe("switch off: the block entry, unchanged", () => {
  it("a Google Sheet mail is nobody's and an Access mail is Access's, with the same provenance bytes as before", async () => {
    mail(SHEET);
    expect(await evidence(OFF)).toEqual([]);
    mail(LOGIN);
    const access = await evidence({ ...OFF, SAV_V2_ENTRY_SMART: "ON" });
    expect(JSON.stringify(access)).toBe(JSON.stringify([{ requestId: "gm-syn/r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-syn-access", revision: "r1", at: AT } }]));
    // The block decision carries no smart label: its bytes are those of before.
    const decision = decide(qualification(access), POLICY);
    expect(decision).toEqual({ revision: "sav-admission-2026-10-27.v1", target: "agent", reasons: ["admitted"], nextStep: "none", families: ["access"], sensitivity: "none", policyRevision: "policy-syn-r1" });
    expect("admission" in decision).toBe(false);
  });
});

describe("switch on: every support mail is admitted, whatever its topic", () => {
  it("a support « Google Sheet mal rempli » is admitted without any block, word list or policy", async () => {
    mail(SHEET);
    const rows = await evidence(ON);
    expect(rows).toEqual([{ requestId: "gm-syn/r1", family: "other", provenance: smartSupportProvenance(AT) }]);
    expect(state.reads).toBe(1);
    expect(decide(qualification(rows))).toEqual({ revision: "sav-admission-2026-10-27.v1", target: "agent", reasons: ["admitted"], nextStep: "none", families: ["other"],
      sensitivity: "none", policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, admission: "smart_support" });
    // The approved policy, present or not, changes nothing: it is not read on this path.
    expect(decide(qualification(rows), POLICY)).toEqual(decide(qualification(rows)));
  });

  it("« où est ma facture » classified support by V1 is admitted: the word list is not read, the smart brain will judge", async () => {
    expect(savCaseSensitiveWording(INVOICE.text, INVOICE.subject)).toBe(true);
    mail(INVOICE);
    const rows = await evidence(ON);
    expect(decide(qualification(rows))).toMatchObject({ target: "agent", admission: "smart_support" });
  });

  it("neither the configured rules nor the Access skill are read: an unreadable rule list does not stop it", async () => {
    mail(SHEET);
    expect(await evidence({ ...ON, SAV_V2_ADMISSION_RULES_JSON: "{not json", SAV_V2_ACCESS_SKILL: "on" })).toHaveLength(1);
  });

  it("a mail of several support requests: each is the agent's, up to the four one reply covers; beyond, the whole mail is the team's", async () => {
    mail(SHEET);
    expect((await evidence(ON, support(4))).map(row => row.requestId)).toEqual(["gm-syn/r1", "gm-syn/r2", "gm-syn/r3", "gm-syn/r4"]);
    expect(await evidence(ON, support(5))).toEqual([]);
  });

  it("support + cancellation (or finance, or any non-support request) in the same mail: the whole mail is the team's", async () => {
    mail(SHEET);
    for (const kind of ["cancellation", "finance", "commercial", "partnership"]) {
      state.reads = 0;
      const rows = await evidence(ON, [{ requestId: "gm-syn/r1", kind: "support" }, { requestId: "gm-syn/r2", kind }]);
      expect([kind, rows, state.reads]).toEqual([kind, [], 0]);
      expect(decide(qualification(rows)).target).not.toBe("agent");
    }
    // The case's sensitivity (V1's finance or cancellation request) still sends it to the team, even on smart evidence.
    const rows = await evidence(ON);
    expect(decide(qualification(rows), null, "cancellation")).toMatchObject({ target: "team", reasons: ["case_sensitive"], nextStep: "team_takeover", sensitivity: "cancellation" });
    // A sensitive family read later on the same requests (a return rule) withdraws it to the team too.
    expect(decide(qualification([...rows, { requestId: "gm-syn/r1", family: "cancellation", provenance: smartSupportProvenance(AT) }]))).toMatchObject({ target: "team" });
  });

  it("an unconfirmed identity, an incomplete CRM or a team signal keeps it with the team", async () => {
    mail(SHEET);
    const rows = await evidence(ON);
    expect(decide(qualification(rows, { identity: { status: "unknown" } }))).toMatchObject({ target: "qualification", reasons: ["identity_unconfirmed"], admission: "smart_support" });
    expect(decide(qualification(rows, { identity: { status: "ambiguous" } })).target).toBe("qualification");
    expect(decide(qualification(rows, { crmContext: "incomplete" }))).toMatchObject({ target: "qualification", reasons: ["context_incomplete"] });
    expect(decide(qualification(rows, { teamSignals: [{ kind: "out_of_capability", source: { type: "email", id: "gm-syn" } }] }))).toMatchObject({ target: "team" });
  });

  it("no ticket: V1's qualification without a ticket disposition confirms nobody, so nothing is admitted", async () => {
    mail(SHEET);
    const rows = await evidence(ON);
    const adapter = { revision: "adapter-syn", decidedBy: "syn", identity: "sender_unique_crm_match" as const };
    const { qualification: base } = qualifyTicketIdentity({ disposition: { kind: "no_ticket" } } as never, adapter, true);
    expect(decide({ ...base, requests: rows })).toMatchObject({ target: "qualification", reasons: ["identity_unconfirmed", "context_incomplete"] });
    // Neither does a stale V1 context (no current confirmed ticket execution).
    const stale = qualifyTicketIdentity({ disposition: { kind: "ticket" } } as never, adapter, false).qualification;
    expect(decide({ ...stale, requests: rows }).target).not.toBe("agent");
  });

  it("no stored mail: nobody is admitted", async () => {
    expect(await evidence(ON)).toEqual([]);
  });

  it("a ticket assigned in HubSpot (the owner handover, N5) goes through the same check: same evidence for its one request, same decision", async () => {
    mail(SHEET);
    const relay = await evidence(ON);
    const handover = await firstBlockEvidence(ON, "message-syn", "gm-syn", [{ requestId: "gm-syn/r1", kind: "support" }], SAV_CASE_BLOCK_REGISTRY, { accessSkillCompute: "always" });
    expect(handover).toEqual(relay);
    expect(decide(qualification(handover))).toEqual(decide(qualification(relay)));
    expect(decide(qualification(handover, { identity: { status: "unknown" } })).target).not.toBe("agent");
  });

  it("the two entries are never mixed: a block rule's request beside a smart one is unproven", () => {
    const smart = { requestId: "gm-syn/r1", family: "other" as const, provenance: smartSupportProvenance(AT) };
    const block = { requestId: "gm-syn/r2", family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-syn-access", revision: "r1", at: AT } };
    expect(decide(qualification([smart, block]), POLICY)).toMatchObject({ target: "qualification", reasons: ["qualification_unproven"], admission: "smart_support" });
    // Only the exact id, revision and block are the smart entry's: a look-alike goes through the block decision (unproven under the policy).
    for (const look of [{ ...smart.provenance, blockId: undefined }, { ...smart.provenance, revision: "smart-entry.v2" }, { ...smart.provenance, ruleId: "smart" }]) {
      expect(isSmartSupportProvenance(look)).toBe(false);
      expect("admission" in decide(qualification([{ ...smart, provenance: JSON.parse(JSON.stringify(look)) }]), POLICY)).toBe(false);
    }
  });

  it("switching off withdraws: the re-read evidence is the block entry's, and a stored smart admission no longer matches the policy in force", async () => {
    mail(SHEET);
    const rows = await evidence(ON);
    expect(await evidence(OFF)).toEqual([]);
    const decision = decide(qualification(rows));
    const snapshot = { owner: "agent" as const, admissionInputVersion: 1, admission: { ...decision, decidedAt: AT, version: 1, inputVersion: 1, qualification: qualification(rows) } };
    expect(caseAdmissionStatus(snapshot, "policy-syn-r1")).toEqual({ admitted: false, reason: "policy_changed" });
    // The seam N8 wires: a V2 actor whose current revision is the smart one accepts it.
    expect(caseAdmissionStatus(snapshot, SAV_SMART_ENTRY_POLICY_REVISION)).toEqual({ admitted: true });
  });
});
