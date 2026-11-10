/** SAV-84 block harness: runs the JSON case manifest (test/sav-block-harness-cases.json) through
 * the real pure admission code. No network, no model, no database, no production key: a
 * preflight refuses a manifest that carries any of them. To add a case, add a JSON entry and
 * rerun the same command. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseAdmissionStatus, decideCaseAdmission } from "./admission-policy";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { savTicketReturnPlan } from "../ticket-lifecycle";
import { SAV_CASE_ADMISSION_REASONS, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";

const STAFF = "00000000-0000-4000-8000-000000000084";
const AT = "2026-11-10T12:00:00.000Z";
const MANIFEST_PATH = join(__dirname, "../../../../test/sav-block-harness-cases.json");
const raw = readFileSync(MANIFEST_PATH, "utf8");

type AdmissionCase = { id: string; family: string; policy: string; requests: [string, string][]; caseSensitivity?: "none" | "finance" | "cancellation";
  teamSignals?: ("confirmed_bug" | "out_of_capability")[]; identity?: "confirmed" | "ambiguous" | "absent" | "unknown"; crmContext?: "complete" | "incomplete" | "unknown";
  expect: { target: string; reasons: string[]; sensitivity?: string } };
type StatusCase = { id: string; owner: string; admission: { target: string; policyRevision: string; inputVersion: number } | null; admissionInputVersion: number; currentPolicy: string | null; expect: string };
type ReturnCase = { id: string; status: "open" | "closed"; closedAt?: string | null; stage?: string; returnedAt: string; expect: string };
type Manifest = { schema: string; policies: Record<string, Record<string, unknown> | null>; admission: AdmissionCase[]; status: StatusCase[]; ticketReturn: ReturnCase[] };

/** Refuses anything that could reach or mirror production: real addresses, URLs, keys, tokens. */
export function harnessPreflight(text: string): string[] {
  const problems: string[] = [];
  for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) if (!email.endsWith(".invalid")) problems.push(`email:${email}`);
  if (/https?:\/\//i.test(text)) problems.push("url");
  if (/\b(sk-[\w-]{8,}|AIza[\w-]{10,}|pat-[\w-]{8,}|xox[bp]-[\w-]+|Bearer\s+\S+)/.test(text)) problems.push("secret");
  if (/\b(DATABASE_URL|POSTGRES_URL|GEMINI_API_KEY|HUBSPOT_|GMAIL_|VERCEL_)\w*/.test(text)) problems.push("env");
  return problems;
}

const manifest = JSON.parse(raw) as Manifest;
const provenance = (spec: string): CaseAdmissionQualification["requests"][number]["provenance"] => {
  if (spec === "human") return { kind: "human", staffUserId: STAFF, at: AT };
  if (spec === "hint") return { kind: "intake_hint", source: { type: "email", id: "gm-harness" } };
  const rule = /^rule:([^@]+)@(.+)$/.exec(spec);
  if (!rule) throw Error(`HARNESS_PROVENANCE_INVALID:${spec}`);
  return { kind: "qualified_rule", ruleId: rule[1]!, revision: rule[2]!, at: AT };
};
const policyOf = (name: string) => {
  if (!(name in manifest.policies)) throw Error(`HARNESS_POLICY_UNKNOWN:${name}`);
  const policy = manifest.policies[name];
  return policy && { ...policy, approvedBy: STAFF, approvedAt: AT };
};
const qualificationOf = (c: AdmissionCase) => ({
  requests: c.requests.map(([family, spec], index) => ({ requestId: `r${index + 1}`, family, provenance: provenance(spec) })),
  identity: (c.identity ?? "confirmed") === "confirmed" ? { status: "confirmed", source: { type: "hubspot_object", id: "contact-harness" } } : { status: c.identity },
  crmContext: c.crmContext ?? "complete",
  teamSignals: (c.teamSignals ?? []).map(kind => ({ kind, source: { type: "email", id: "gm-harness" } })),
}) as CaseAdmissionQualification;

describe("SAV-84 block harness: manifest", () => {
  it("passes the preflight: synthetic only, no URL, key, env name or real address", () => {
    expect(harnessPreflight(raw)).toEqual([]);
  });
  it("the preflight refuses a production-looking manifest", () => {
    expect(harnessPreflight('{"to":"client@gmail.com","u":"https://api.hubapi.com","k":"sk-abcdefghijkl","e":"DATABASE_URL"}')).toEqual(["email:client@gmail.com", "url", "secret", "env"]);
    expect(harnessPreflight('{"to":"client@example.invalid"}')).toEqual([]);
  });
  it("has the expected schema, unique ids and known reason codes", () => {
    expect(manifest.schema).toBe("sav-block-harness.cases.v1");
    const ids = [...manifest.admission, ...manifest.status, ...manifest.ticketReturn].map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of manifest.admission) for (const reason of c.expect.reasons) expect(SAV_CASE_ADMISSION_REASONS).toContain(reason);
  });
});

describe("SAV-84 block harness: admission (real decideCaseAdmission)", () => {
  it.each(manifest.admission.map(c => [c.id, c] as const))("%s", (_id, c) => {
    const decision = decideCaseAdmission({ policy: policyOf(c.policy), qualification: qualificationOf(c), caseSensitivity: c.caseSensitivity ?? "none" });
    expect({ target: decision.target, reasons: decision.reasons }).toEqual({ target: c.expect.target, reasons: c.expect.reasons });
    if (c.expect.sensitivity) expect(decision.sensitivity).toBe(c.expect.sensitivity);
    // Only an admitted case goes to the agent; nothing else proceeds silently.
    expect(decision.nextStep).toBe(decision.target === "agent" ? "none" : decision.target === "team" ? "team_takeover" : "qualify");
  });
});

describe("SAV-84 block harness: who may act (real caseAdmissionStatus)", () => {
  it.each(manifest.status.map(c => [c.id, c] as const))("%s", (_id, c) => {
    const snapshot = { owner: c.owner, admissionInputVersion: c.admissionInputVersion,
      admission: c.admission && { ...c.admission, decidedAt: AT, version: c.admission.inputVersion } } as unknown as Pick<CaseSnapshot, "owner" | "admission" | "admissionInputVersion">;
    const status = caseAdmissionStatus(snapshot, c.currentPolicy);
    expect(status.admitted ? "admitted" : status.reason).toBe(c.expect);
  });
});

describe("SAV-84 block harness: contact ticket return, exact 15 days (real savTicketReturnPlan)", () => {
  const stages = SAV_HUBSPOT_SUPPORT.stages as Record<string, string>;
  it.each(manifest.ticketReturn.map(c => [c.id, c] as const))("%s", (_id, c) => {
    const stageId = c.stage === undefined ? null : stages[c.stage] ?? "stage-unknown-harness";
    expect(savTicketReturnPlan({ id: "ticket-harness", status: c.status, closedAt: c.closedAt ?? null, stageId }, c.returnedAt).operation).toBe(c.expect);
  });
});
