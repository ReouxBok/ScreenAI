import "server-only";
import { requireDb } from "@/db";
import { readSavAgentPause, savAgentPauseCode } from "../intake/agent-pause";
import { createCaseV2WakeDeps } from "./case-v2-wake-ports";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import { readCaseEffectsMode } from "./case-effects";
import { readHandoffNoticeConfig } from "./case-handoff-notice";
import { caseProvenanceReaders } from "./investigation-pilot-readers";
import { pilotProvenanceGate } from "./pilot-passage-provenance";
import { runCaseV2Wake } from "./case-v2-wake";
import { readCaseTicketStageConfig } from "./customer-return";
import { readV2EntryPolicyRecord, savV2EntryEnabled } from "./v2-entry";

type Env = Record<string, string | undefined>;

/** The reconcile worker supplies its own deadline. All three passes reuse their individual
 * guards and durable executor; the policy and cutoff come from the live signed grant. */
export async function reconcileCaseV2Effects(input: {
  env: Env;
  deadlineMs: number;
  network?: typeof fetch;
}) {
  const { env, deadlineMs } = input;
  if (!savV2EntryEnabled(env)) return { skipped: "v2_off" };
  if (readCaseEffectsMode(env).mode !== "supervised" && readHandoffNoticeConfig(env).mode !== "on" && readCaseTicketStageConfig(env).mode !== "on") return { skipped: "effects_off" };
  if (Date.now() >= deadlineMs) return { skipped: "deadline" };
  const config = intakeExecutionConfig(env);
  if (!config) return { skipped: "execution_off" };
  const db = requireDb(), intake = await readSavAgentPause(db, "intake"), v2 = await readSavAgentPause(db, "v2");
  const pause = savAgentPauseCode(intake) ?? (v2.invalid || v2.level === "fully_paused" ? savAgentPauseCode(v2) : null);
  if (pause) return { skipped: pause };
  const { policy } = await readIntakeExecutionAuthority(config);
  const readPolicyRecord = async () => readV2EntryPolicyRecord(env);
  const provenance = caseProvenanceReaders({ env: () => env, readPolicyRecord });
  const deps = createCaseV2WakeDeps({
    env: () => env, deadlineMs, policy: { id: config.policyId, hash: config.policyHash },
    since: new Date(policy.createdAfter), readPolicyRecord,
    ...(input.network ? { network: input.network } : {}),
  });
  const result = await runCaseV2Wake({ ...deps, replies: { ...deps.replies, pilotProvenance: pilotProvenanceGate(provenance) } });
  if (result.failures.length) throw Error("SAV_V2_WAKE_FAILED_" + result.failures.map(failure => failure.step).join("_"));
  return result;
}
