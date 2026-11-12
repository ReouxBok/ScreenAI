import "server-only";
import { requireDb } from "@/db";
import { readSavAgentPause, savAgentPauseCode } from "../intake/agent-pause";
import { createCaseV2WakeDeps, type CaseV2WakeCompositionInput } from "./case-v2-wake-ports";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import { readCaseEffectsMode } from "./case-effects";
import { readHandoffNoticeConfig } from "./case-handoff-notice";
import { caseProvenanceReaders } from "./investigation-pilot-readers";
import { pilotProvenanceGate } from "./pilot-passage-provenance";
import { runCaseEffectsPass, type CaseRuntimeDeps } from "./case-runtime-effects";
import { immediateSendDeadline, type ImmediateCaseReplySend } from "./immediate-send-budget";
import { runCaseV2Wake, type CaseV2WakeDeps } from "./case-v2-wake";
import { readCaseTicketStageConfig } from "./customer-return";
import { readV2EntryPolicyRecord, savV2EntryEnabled } from "./v2-entry";

type Env = Record<string, string | undefined>;
type EffectsInput = { env: Env; deadlineMs: number; network?: typeof fetch };
/** Synthetic-provider tests only (as `createCaseV2WakeDeps`'s `gmail` and the pass's `context`): reachable only through `caseV2EffectsWithTestPorts`. */
type TestPorts = { gmail?: CaseV2WakeCompositionInput["gmail"]; context?: CaseRuntimeDeps["context"]; network?: typeof fetch };

/** The ONE set of guards and ports of every V2 effects run (the catch-up and the immediate send): V2 on, an effect mode on, the budget, the V1 execution
 * config, no pause; then the live signed grant, the canonical adapters and the pilot provenance gate. A refusal names its guard and reads nothing else. */
async function prepareCaseV2Effects(input: EffectsInput, ports: TestPorts = {}): Promise<{ skipped: string } | { deps: CaseV2WakeDeps }> {
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
  const network = ports.network ?? input.network;
  const deps = createCaseV2WakeDeps({
    env: () => env, deadlineMs, policy: { id: config.policyId, hash: config.policyHash },
    since: new Date(policy.createdAfter), readPolicyRecord,
    ...(network ? { network } : {}), ...(ports.gmail ? { gmail: ports.gmail } : {}),
  });
  return { deps: { ...deps, replies: { ...deps.replies, pilotProvenance: pilotProvenanceGate(provenance), ...(ports.context ? { context: ports.context } : {}) } } };
}

async function reconcileWith(input: EffectsInput, ports: TestPorts) {
  const prepared = await prepareCaseV2Effects(input, ports);
  if ("skipped" in prepared) return prepared;
  const result = await runCaseV2Wake(prepared.deps);
  if (result.failures.length) throw Error("SAV_V2_WAKE_FAILED_" + result.failures.map(failure => failure.step).join("_"));
  return result;
}

/** The catch-up worker (`/api/cron/sav-v2-effects`) supplies its own deadline. All passes reuse their individual
 * guards and durable executor; the policy and cutoff come from the live signed grant. Handoff notices, ticket stages and proven closures are
 * run ONLY here: they wait up to one period (10 min) after the event that queued them. */
export async function reconcileCaseV2Effects(input: EffectsInput) {
  return reconcileWith(input, {});
}

function sendNowWith(ports: TestPorts): ImmediateCaseReplySend {
  return async ({ env, executionId, callerDeadlineMs }) => {
    try {
      const deadlineMs = immediateSendDeadline(callerDeadlineMs);
      if (deadlineMs === null) return { skipped: "caller_budget" };
      const prepared = await prepareCaseV2Effects({ env, deadlineMs }, ports);
      if ("skipped" in prepared) return prepared;
      return { pass: await runCaseEffectsPass({ ...prepared.deps.replies, executionId }) };
    } catch (error) {
      return { failed: (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160) };
    }
  };
}

/**
 * Immediate send (11/11): right after a validated reply is queued, ONE supervised pass over THAT execution only, with the guards, ports, claim, lease,
 * receipts and engaged-send check of the catch-up (`prepareCaseV2Effects` + `runCaseEffectsPass`), inside the CALLER's budget (`immediateSendDeadline`:
 * nothing is attempted with less than a full send budget plus a margin left). It never throws: a guard that refuses, a short budget, a failure or a lease
 * held by another pass leaves the execution queued for the catch-up. Nothing here can send twice: the claim is a row lock plus a lease, an engaged effect
 * is never selected, and a confirmed execution is never claimed again. No transport or context can be injected here.
 */
export const sendQueuedCaseReplyNow: ImmediateCaseReplySend = sendNowWith({});

/** Synthetic-provider tests only: the same two entrypoints with a test transport and runtime context. Refused in a production build. */
export function caseV2EffectsWithTestPorts(ports: TestPorts) {
  if (process.env.NODE_ENV === "production") throw Error("SAV_V2_TEST_PORTS_FORBIDDEN");
  return { sendNow: sendNowWith(ports), reconcile: (input: EffectsInput) => reconcileWith(input, ports) };
}
