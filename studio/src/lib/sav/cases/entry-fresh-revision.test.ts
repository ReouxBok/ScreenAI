import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DB_ALLOWED"); } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { caseFreshQualificationUnderCurrent, decideCaseAdmission } from "./admission-policy";
import type { CaseAdmissionQualification } from "./case-types";
import { relayAdmissionInput } from "./intake-boundary";

/*
 * Assembly of the « 3 blocs » (19/11), root decision: a NEW reading of a mail by the entry is always admitted under the current revision N, never under a
 * policy entry marked `previous` (N-1). A case already admitted under N-1 keeps its stored admission (infra-auto's `block-auto-lifecycle.test.ts`).
 * Synthetic data only; no database, network or model.
 */

const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-11-19T09:00:00.000Z", BLOCK = "collaborators";
const rule = (revision: string, previous?: true) => ({ ruleId: "collaborators-entry-skill", revision, families: ["usage"] as ["usage"], blockId: BLOCK, ...(previous ? { previous } : {}) });
const policy = (revision: string, rules: unknown[]) => ({ revision, admittedFamilies: ["usage"], qualifiedRules: rules, approvedBy: STAFF, approvedAt: AT });
const N1 = policy("policy-n1", [rule("v1")]);
const N2 = policy("policy-n2", [rule("v2"), rule("v1", true)]);
const row = (requestId: string, revision: string) => ({ requestId, family: "usage" as const, provenance: { kind: "qualified_rule" as const, ruleId: "collaborators-entry-skill", revision, at: AT, blockId: BLOCK } });
const qualification = (...rows: CaseAdmissionQualification["requests"]): CaseAdmissionQualification =>
  ({ requests: rows, identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [] });
const target = (value: CaseAdmissionQualification, policyValue: unknown) => decideCaseAdmission({ policy: policyValue, qualification: value, caseSensitivity: "none" }).target;

describe("un dossier neuf est toujours admis sous la révision courante N", () => {
  it("une lecture sous N-1 (`previous`) ne prouve rien pour un dossier neuf ; sous N elle est inchangée", () => {
    const underPrevious = qualification(row("gm-a/r1", "v1"));
    expect(target(underPrevious, N2)).toBe("agent");
    const fresh = caseFreshQualificationUnderCurrent(underPrevious, N2);
    expect(fresh.requests).toEqual([]);
    expect(target(fresh, N2)).not.toBe("agent");
    const underCurrent = qualification(row("gm-b/r1", "v2"));
    expect(caseFreshQualificationUnderCurrent(underCurrent, N2)).toBe(underCurrent);
    expect(target(underCurrent, N2)).toBe("agent");
  });
  it("mail à deux demandes, l'une sous N-1 : seule celle-ci perd sa preuve (le mail ne part pas à l'agent sous N-1)", () => {
    const mixed = qualification(row("gm-c/r1", "v2"), row("gm-c/r2", "v1"));
    expect(caseFreshQualificationUnderCurrent(mixed, N2).requests.map(item => item.requestId)).toEqual(["gm-c/r1"]);
  });
  it("politique sans marqueur `previous`, absente ou illisible : la qualification est rendue telle quelle (comportement d'avant, Accès compris)", () => {
    const value = qualification(row("gm-d/r1", "v1"));
    for (const policyValue of [N1, null, undefined, { nope: true }]) expect(caseFreshQualificationUnderCurrent(value, policyValue)).toBe(value);
    const access = qualification({ requestId: "gm-e/r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "access-entry-skill", revision: "sav-access-entry-skill-2026-11-18.v1", at: AT } });
    const accessPolicy = { ...policy("p-access", [{ ruleId: "access-entry-skill", revision: "sav-access-entry-skill-2026-11-18.v1", families: ["access"] }]), admittedFamilies: ["access"] };
    expect(caseFreshQualificationUnderCurrent(access, accessPolicy)).toBe(access);
  });
  it("à l'entrée (relayAdmissionInput : relais, attribution, création, retour) : sous N-1 personne n'est admis, sous N l'agent", async () => {
    const decision = { classification: "support", requests: [{ id: "r1", kind: "support" }] } as never;
    const admit = async (revision: string) => {
      const { admission } = await relayAdmissionInput({ messageId: "m-1", gmailMessageId: "gm-f", decision, confirmedTicket: true,
        deps: { readAdmissionPolicy: async () => N2 as never, readQualification: async () => qualification(row("gm-f/r1", revision)) } });
      return target(admission.qualification, admission.policy);
    };
    expect(await admit("v1")).not.toBe("agent");
    expect(await admit("v2")).toBe("agent");
  });
});
