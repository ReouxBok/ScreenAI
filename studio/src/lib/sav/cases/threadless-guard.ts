import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMailboxes, savSyncState, savIntakeExecutionPolicies } from "@/db/schema";
import { readSavAgentPause, savAgentPauseCode } from "../intake/agent-pause";
import type { SavIntakeMutation } from "../intake/contract";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import type { ExecutionTx } from "../intake/execution-store";
import { admissionPolicyRevisionPort } from "./admission-runtime";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";
import { readCaseEffectsMode } from "./case-effects";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import { readCaseAccessScope } from "./investigation-access-scope";
import { caseAccessScopeConfigReader } from "./investigation-pilot-readers";
import { readV2EntryPolicyRecord, savV2EntryEnabled } from "./v2-entry";
import { savV2NewThreadEnabled } from "./threadless-config";
import { THREADLESS_MAILBOX } from "./threadless-transport";

type Env = Record<string, string | undefined>;
type Reader = Pick<ExecutionTx, "select">;

export async function threadlessSchemaInstalled(db: Reader) {
  const [row] = await db.select({ status: savSyncState.status }).from(savSyncState).where(eq(savSyncState.key, "sav-case-schema-v10"));
  return row?.status === "installed";
}

export async function threadlessActionAllowed(env: Env, db: Reader = requireDb()) {
  if (!savV2NewThreadEnabled(env) || !savV2EntryEnabled(env) || env.SAV_WRITES_DISABLED === "true"
      || readCaseEffectsMode(env).mode !== "supervised") return false;
  const intake = await readSavAgentPause(db, "intake");
  const v2 = await readSavAgentPause(db, "v2");
  return !savAgentPauseCode(intake) && !savAgentPauseCode(v2);
}

export async function threadlessAccessRevision(env: Env, db: Reader = requireDb()): Promise<string | null> {
  if (savBlockReplyGate(await readSavBlockSwitch(db, SAV_CASE_ACCESS_BLOCK_ID)).send === "never") return null;
  try {
    const revision = await admissionPolicyRevisionPort({ read: async () => readV2EntryPolicyRecord(env), now: () => new Date() })();
    const scope = await readCaseAccessScope(caseAccessScopeConfigReader(() => env), revision, SAV_CASE_ACCESS_BLOCK_ID);
    return scope.ok ? revision : null;
  } catch { return null; }
}

export async function readThreadlessAuthority(env: Env, permission: SavIntakeMutation, observedAt: string) {
  try {
    const config = intakeExecutionConfig(env);
    if (!config) return null;
    const { policy } = await readIntakeExecutionAuthority(config);
    if (policy.admission.kind !== "automatic" || !policy.mutations.includes(permission)
        || Date.parse(observedAt) <= Math.max(Date.parse(policy.receivedAfter), Date.parse(policy.createdAfter))) return null;
    const [mailbox] = await requireDb().select({ id: savMailboxes.id }).from(savMailboxes)
      .where(and(eq(savMailboxes.id, policy.mailboxId), eq(savMailboxes.email, THREADLESS_MAILBOX), eq(savMailboxes.active, true)));
    return mailbox ? { config, policy, mailboxId: mailbox.id } : null;
  } catch { return null; }
}

export type ThreadlessAuthority = NonNullable<Awaited<ReturnType<typeof readThreadlessAuthority>>>;

/** Serialize the start with a concurrent policy revocation. The granted payload is immutable. */
export async function threadlessAuthorityStillGranted(tx: ExecutionTx, authority: ThreadlessAuthority, permission: SavIntakeMutation) {
  const [row] = await tx.select({ state: savIntakeExecutionPolicies.state, hash: savIntakeExecutionPolicies.policyHash })
    .from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, authority.config.policyId)).for("share");
  return row?.state === "approved" && row.hash === authority.config.policyHash
    && Date.parse(authority.policy.expiresAt) > Date.now() && authority.policy.mutations.includes(permission);
}
