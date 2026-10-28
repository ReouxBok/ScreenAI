import { expect, it } from "vitest";
import { CRM_RECHECK_POLICY, crmRecheckDecision, crmRecheckDelayMs } from "./crm-recheck";
import type { CrmDeltaDiagnostic } from "./execution-context";

const delta = (classification: CrmDeltaDiagnostic["classification"]) => ({ stage: "finalizing", reason: "snapshot_changed", ticketIds: [], eventIds: [], baselineHash: "a", currentHash: "b", classification }) as CrmDeltaDiagnostic;
it("sends a real business change to a person and rechecks only what may settle by itself", () => {
  expect(crmRecheckDecision("SAV_INTAKE_EXECUTION_CRM_CHANGED", delta("business_change"))).toEqual({ decision: "human", cause: "business_change" });
  expect(crmRecheckDecision("SAV_INTAKE_EXECUTION_CRM_CHANGED", delta("unattributed_email"))).toEqual({ decision: "recheck", cause: "unattributed_email" });
  expect(crmRecheckDecision("SAV_INTAKE_EXECUTION_CRM_CHANGED", delta(undefined))).toEqual({ decision: "recheck", cause: "unknown" });
  expect(crmRecheckDecision("SAV_INTAKE_EXECUTION_CRM_READ_HUBSPOT_HTTP_503")).toEqual({ decision: "recheck", cause: "read_incomplete" });
  for (const reason of ["SAV_INTAKE_EXECUTION_ADDRESS_PROOF_UNRESOLVED", "SAV_INTAKE_EXECUTION_ASSOCIATION_INCOMPLETE"]) expect(crmRecheckDecision(reason)).toEqual({ decision: "human", cause: "deterministic" });
  // Other waits keep their existing path: Gmail, pauses, version or authority checks.
  for (const reason of ["SAV_INTAKE_EXECUTION_GMAIL_CHANGED", "SAV_AGENT_PAUSED", "SAV_INTAKE_EXECUTION_VERSION_INCOMPATIBLE", "SAV_INTAKE_EXECUTION_MUTATION_NOT_GRANTED"]) expect(crmRecheckDecision(reason)).toBeNull();
});
it("reuses the existing bounds: 5 rechecks from the 60 s cadence, doubled each time", () => {
  expect(CRM_RECHECK_POLICY).toEqual({ maxRechecks: 5, baseDelayMs: 60_000 });
  expect([1, 2, 3, 4].map(crmRecheckDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
});
