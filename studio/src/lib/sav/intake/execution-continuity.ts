import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, staffUsers, savIntakeExecutions, savIntakeRuns, savIntakeEffects, savIntakeHumanEvents, savMessages, savThreads, savIntakeExecutionPolicies } from "@/db/schema";
import { canAccessSav } from "../access";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { readSavExternalCompletion } from "../external-completion";
import { intakeRuntimeHash, intakeRuntimeConfigurationHash, savIntakeRuntimePins, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { executionAdministrator, executionPolicySchema, intakeExecutionConfig } from "./execution-policy";
import { intakeRunConfigurationBound } from "./human-binding";
import { admissionLock, executionMessageHash, executionJournal, assertNoLegacyConflict } from "./execution-store";
import { savIntakeSourceSnapshot, intakeSourceMatches } from "./runtime-store";
import { savIntakePlanFingerprint } from "./engine";
import type { Execution, ExecutionPayload, ExecutionOptions } from "./execution-types";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

const action = "sav_intake_execution_continuity_approved";
const entity = "sav_intake_execution_continuity";
const fault = (): never => { throw Error("SAV_INTAKE_EXECUTION_CONTINUITY_REFUSED"); };
type Db = Pick<ReturnType<typeof requireDb>, "select">;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({ executionId: z.uuid(), runId: z.uuid(), runHash: hash, oldRuntimeHash: hash,
  planHash: hash, inputHash: hash, executionHash: hash,
  effects: z.array(z.object({ id: z.uuid(), intentHash: hash, receiptHash: hash.nullable() }).strict()).max(8) }).strict();
const grantSchema = z.object({ revision: z.literal("sav-intake-continuity.v1"), actorId: z.uuid(), sourcePolicyId: z.uuid(), sourcePolicyHash: hash,
  targetPolicyId: z.uuid(), targetPolicyHash: hash, targetRuntimeHash: hash, sourceCodeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  bindings: z.array(bindingSchema).min(1).max(100) }).strict();
type Grant = z.infer<typeof grantSchema>;
const active = (s: typeof staffUsers.$inferSelect | undefined) => Boolean(s?.active && ["admin", "owner"].includes(s.role) && canAccessSav(s.email, s.role));
const policyFacts = (raw: unknown) => { const { codeRevision, ...rest } = executionPolicySchema.parse(raw); void codeRevision;
  return { ...rest, mutations: [...rest.mutations].sort() }; };
const receipt = (e: typeof savIntakeEffects.$inferSelect) => e.state === "confirmed"
  ? intakeRuntimeHash({ ack: e.ackCiphertext, verification: e.verificationCiphertext, at: e.confirmedAt }) : null;

/** Explicit compatibility set: no historical credentials, rules or budget are
 * substituted. Only an unchanged runtime, built with a reviewed v5/v6/v8 prompt,
 * can supply an execution-only witness for the old observation. */
function sourceRuntime(runtime: IntakeRuntimeConfig, codeRevision: string, oldHash: string, env: ReturnType<ExecutionOptions["env"]>) {
  const { mode, policy, configHash, model, ...rest } = runtime; void mode; void policy; void configHash; void model;
  const pins = savIntakeRuntimePins.parse({ ...rest, codeRevision });
  const matches = [undefined, "sav-intake-semantic-2026-10-23.v5", "sav-intake-semantic-2026-10-24.v6", "sav-intake-semantic-2026-10-25.v8"].some(prompts => intakeRuntimeConfigurationHash(pins, env, prompts) === oldHash);
  if (!matches) return fault();
  return { ...runtime, codeRevision, configHash: oldHash };
}

async function localBinding(db: Db, execution: Execution, payload: ExecutionPayload, runtime: IntakeRuntimeConfig) {
  if (!execution.runId) return fault();
  const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, execution.runId));
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, execution.threadId));
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, execution.messageId));
  const [latest] = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, execution.threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!run?.isCurrent || !["observed", "waiting"].includes(run.state) || run.id !== payload.lastRunId || run.messageId !== execution.messageId || run.version !== execution.runVersion
    || run.humanChoiceCiphertext !== payload.local.humanChoice || !thread || thread.aiPaused || !message || latest?.id !== message.id
    || message.mailboxId !== runtime.mailboxId || executionMessageHash(message) !== payload.local.messageHash
    || thread.status !== payload.local.status || thread.hubspotTicketId !== payload.local.ticketId
    || thread.humanRequestedAt?.toISOString() !== (payload.local.humanRequestedAt ?? undefined)
    || intakeRuntimeHash({ mailbox: thread.mailboxId, gmail: thread.gmailThreadId, customer: thread.customerEmail }) !== payload.local.threadIdentityHash
    || message.createdAt <= new Date(runtime.createdAfter) || message.receivedAt <= new Date(runtime.receivedAfter)
    || await readSavExternalCompletion(message, db)
    || payload.plan.fingerprint !== savIntakePlanFingerprint(payload.plan)
    || decryptSavPayload<{ plan?: { fingerprint?: string } }>(run.payloadCiphertext).plan?.fingerprint !== payload.acceptedFingerprint) return fault();
  const [human] = await db.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.messageId, message.id),
    sql`(${savIntakeHumanEvents.kind}='refuse' or ${savIntakeHumanEvents.state} in ('pending','reading'))`)).limit(1);
  if (human || !intakeSourceMatches(await savIntakeSourceSnapshot(db as Parameters<typeof savIntakeSourceSnapshot>[0], message, new Date()), payload.local.sourceHash)) return fault();
  return run;
}

async function manifest(db: Db, sourcePolicyId: string, options: ExecutionOptions, actorId: string, executionIds?: readonly string[]): Promise<Grant> {
  z.uuid().parse(sourcePolicyId);
  if (sourcePolicyId === options.config.policyId || options.signal.aborted) return fault();
  const liveRuntime = savIntakeRuntimeConfig(options.env()), liveConfig = intakeExecutionConfig(options.env());
  if (!liveRuntime || !liveConfig || intakeRuntimeHash(liveRuntime) !== intakeRuntimeHash(options.runtime) || intakeRuntimeHash(liveConfig) !== intakeRuntimeHash(options.config)) return fault();
  const [target] = await db.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, options.config.policyId));
  const policy = target && executionPolicySchema.parse(decryptSavPayload(target.payloadCiphertext));
  const [targetOwner] = target ? await db.select().from(staffUsers).where(eq(staffUsers.id, target.administratorId)) : [];
  if (!target || target.state !== "approved" || !policy || !active(targetOwner) || target.policyHash !== options.config.policyHash
    || intakeRuntimeHash(policy) !== target.policyHash || intakeRuntimeHash(executionPolicySchema.parse(options.policy)) !== target.policyHash || Date.parse(policy.expiresAt) <= Date.now()) return fault();
  const [source] = await db.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, sourcePolicyId));
  const previous = source && executionPolicySchema.parse(decryptSavPayload(source.payloadCiphertext));
  const [owner] = source ? await db.select().from(staffUsers).where(eq(staffUsers.id, source.administratorId)) : [];
  if (!source || source.state !== "approved" || !previous || !active(owner) || intakeRuntimeHash(previous) !== source.policyHash
    || Date.parse(previous.expiresAt) <= Date.now() || intakeRuntimeHash(policyFacts(previous)) !== intakeRuntimeHash(policyFacts(policy))
    || policy.codeRevision !== options.runtime.codeRevision || policy.enginePolicyHash !== options.runtime.policyHash || policy.resourcesHash !== options.runtime.resourcesHash) return fault();
  const selected = executionIds ? z.array(z.uuid()).min(1).max(100).parse([...executionIds]).sort() : null;
  if (selected && new Set(selected).size !== selected.length) return fault();
  const executions = await db.select().from(savIntakeExecutions).where(and(eq(savIntakeExecutions.policyId, source.id), selected ? inArray(savIntakeExecutions.id, selected) : undefined,
    inArray(savIntakeExecutions.state, ["pending", "waiting", "running", "uncertain"]))).orderBy(savIntakeExecutions.id).limit(101);
  if (!executions.length || executions.length > 100 || selected && executions.length !== selected.length) return fault();
  const bindings: Grant["bindings"] = [];
  for (const e of executions) {
    if (options.signal.aborted || e.policyHash !== source.policyHash || e.leaseUntil && e.leaseUntil > new Date()) return fault();
    const payload = decryptSavPayload<ExecutionPayload>(e.payloadCiphertext);
    // This release supports a direct transition, never a chain of old grants.
    if (payload.authorityContinuityId) return fault();
    const runtime = sourceRuntime(options.runtime, previous.codeRevision, payload.runtimeConfigHash, options.env());
    const run = await localBinding(db, e, payload, runtime);
    if (!await intakeRunConfigurationBound(run, runtime, db)) return fault();
    const effects = await db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, e.id)).orderBy(savIntakeEffects.id);
    if (effects.some(f => intakeRuntimeHash(decryptSavPayload(f.intentCiphertext)) !== f.intentHash)) return fault();
    bindings.push({ executionId: e.id, runId: run.id, runHash: intakeRuntimeHash(run.payloadCiphertext), oldRuntimeHash: payload.runtimeConfigHash,
      planHash: intakeRuntimeHash(payload.plan), inputHash: intakeRuntimeHash(payload.input), executionHash: intakeRuntimeHash(e.payloadCiphertext),
      effects: effects.map(f => ({ id: f.id, intentHash: f.intentHash, receiptHash: receipt(f) })) });
  }
  return grantSchema.parse({ revision: "sav-intake-continuity.v1", actorId, sourcePolicyId: source.id, sourcePolicyHash: source.policyHash,
    targetPolicyId: target.id, targetPolicyHash: target.policyHash, targetRuntimeHash: options.runtime.configHash, sourceCodeRevision: previous.codeRevision, bindings });
}

/** No provider call. The operator approves the exact bounded manifest, including
 * immutable receipts, only after the old deployment's workers have drained. */
export async function previewIntakeExecutionContinuity(sourcePolicyId: string, options: ExecutionOptions, executionIds?: readonly string[]) {
  const actor = await executionAdministrator(), grant = await manifest(requireDb(), sourcePolicyId, options, actor.id, executionIds);
  return { hash: intakeRuntimeHash(grant), executionIds: grant.bindings.map(b => b.executionId), sourcePolicyId, targetPolicyId: grant.targetPolicyId };
}
export async function approveIntakeExecutionContinuity(sourcePolicyId: string, expectedHash: string, options: ExecutionOptions, executionIds?: readonly string[]) {
  hash.parse(expectedHash);
  const selected = executionIds ? z.array(z.uuid()).min(1).max(100).parse([...executionIds]) : null;
  if (selected && new Set(selected).size !== selected.length) return fault();
  const actor = await executionAdministrator();
  return requireDb().transaction(async tx => {
    await admissionLock(tx);
    const ownersRead = await tx.select().from(savIntakeExecutionPolicies).where(inArray(savIntakeExecutionPolicies.id, [sourcePolicyId, options.config.policyId]));
    const owners = [...new Set([actor.id, ...ownersRead.map(p => p.administratorId)])].sort();
    const staff = await tx.select().from(staffUsers).where(inArray(staffUsers.id, owners)).orderBy(staffUsers.id).for("update");
    if (owners.some(id => !active(staff.find(s => s.id === id)))) return fault();
    await tx.select().from(savIntakeExecutionPolicies).where(inArray(savIntakeExecutionPolicies.id, [sourcePolicyId, options.config.policyId])).orderBy(savIntakeExecutionPolicies.id).for("update");
    const rows = await tx.select().from(savIntakeExecutions).where(and(eq(savIntakeExecutions.policyId, sourcePolicyId),
      selected ? inArray(savIntakeExecutions.id, selected) : undefined,
      inArray(savIntakeExecutions.state, ["pending", "waiting", "running", "uncertain"]))).orderBy(savIntakeExecutions.id).limit(101).for("update");
    if (rows.length) {
      await tx.select().from(savThreads).where(inArray(savThreads.id, [...new Set(rows.map(r => r.threadId))].sort())).orderBy(savThreads.id).for("update");
      const runs = rows.map(r => r.runId).filter((id): id is string => Boolean(id));
      if (runs.length) await tx.select().from(savIntakeRuns).where(inArray(savIntakeRuns.id, runs.sort())).orderBy(savIntakeRuns.id).for("update");
    }
    const grant = await manifest(tx, sourcePolicyId, options, actor.id, executionIds);
    if (options.signal.aborted || intakeRuntimeHash(grant) !== expectedHash) return fault();
    const id = randomUUID();
    await tx.insert(auditLogs).values({ id, actorEmail: actor.email, action, entityType: entity, entityId: options.config.policyId, technicalMetadata: { grantCiphertext: encryptSavPayload(grant) } });
    // Source stays approved: revoking it is a business stop, never interpreted
    // as a deployment. The operator must drain and fence the old deployment.
    await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_intake_execution_policy_replaced", entityType: "sav_intake_execution_policy", entityId: sourcePolicyId,
      technicalMetadata: { continuityId: id, sourcePolicyHash: grant.sourcePolicyHash, targetPolicyId: grant.targetPolicyId, targetPolicyHash: grant.targetPolicyHash } });
    for (const binding of grant.bindings) {
      const row = rows.find(r => r.id === binding.executionId)!;
      const payload = decryptSavPayload<ExecutionPayload>(row.payloadCiphertext);
      await assertNoLegacyConflict(tx, payload.keys);
      payload.runtimeConfigHash = options.runtime.configHash; payload.authorityContinuityId = id;
      await tx.update(savIntakeExecutions).set({ policyId: grant.targetPolicyId, policyHash: grant.targetPolicyHash, payloadCiphertext: encryptSavPayload(payload) }).where(eq(savIntakeExecutions.id, row.id));
      await executionJournal(tx, row.id, "authority_rotated", { continuityId: id, priorPolicyId: sourcePolicyId, policyId: grant.targetPolicyId, runId: binding.runId });
    }
    if (options.signal.aborted) return fault();
    return { id, executionIds: grant.bindings.map(b => b.executionId) };
  });
}

/** Execution-only witness. The original run/config and AI ledger stay intact. */
export async function intakeExecutionConfigurationBound(e: Execution, payload: ExecutionPayload, runtime: IntakeRuntimeConfig, db: Db = requireDb()) {
  if (!e.runId) return false;
  const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, e.runId));
  if (!run) return false;
  if (!payload.authorityContinuityId) return intakeRunConfigurationBound(run, runtime, db);
  try {
    const [record] = await db.select().from(auditLogs).where(eq(auditLogs.id, payload.authorityContinuityId));
    if (!record || record.action !== action || record.entityType !== entity) return false;
    const encrypted = record.technicalMetadata?.grantCiphertext;
    if (typeof encrypted !== "string") return false;
    const grant = grantSchema.parse(decryptSavPayload(encrypted)), binding = grant.bindings.find(b => b.executionId === e.id);
    if (!binding || record.entityId !== grant.targetPolicyId || e.policyId !== grant.targetPolicyId || e.policyHash !== grant.targetPolicyHash
      || runtime.configHash !== grant.targetRuntimeHash || payload.runtimeConfigHash !== runtime.configHash || run.id !== binding.runId
      || intakeRuntimeHash(run.payloadCiphertext) !== binding.runHash || intakeRuntimeHash(payload.plan) !== binding.planHash || intakeRuntimeHash(payload.input) !== binding.inputHash) return false;
    const policies = await db.select().from(savIntakeExecutionPolicies).where(inArray(savIntakeExecutionPolicies.id, [grant.sourcePolicyId, grant.targetPolicyId]));
    const previous = policies.find(p => p.id === grant.sourcePolicyId), target = policies.find(p => p.id === grant.targetPolicyId);
    if (!previous || previous.state !== "approved" || previous.policyHash !== grant.sourcePolicyHash || !target || target.state !== "approved" || target.policyHash !== grant.targetPolicyHash) return false;
    const oldPolicy = executionPolicySchema.parse(decryptSavPayload(previous.payloadCiphertext)), newPolicy = executionPolicySchema.parse(decryptSavPayload(target.payloadCiphertext));
    if (intakeRuntimeHash(oldPolicy) !== previous.policyHash || intakeRuntimeHash(newPolicy) !== target.policyHash
      || oldPolicy.codeRevision !== grant.sourceCodeRevision || newPolicy.codeRevision !== runtime.codeRevision
      || intakeRuntimeHash(policyFacts(oldPolicy)) !== intakeRuntimeHash(policyFacts(newPolicy)) || Date.parse(oldPolicy.expiresAt) <= Date.now()) return false;
    const staff = await db.select().from(staffUsers).where(inArray(staffUsers.id, [...new Set([grant.actorId, previous.administratorId, target.administratorId])]));
    if ([grant.actorId, previous.administratorId, target.administratorId].some(id => !active(staff.find(s => s.id === id)))) return false;
    const [revoked] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityType, "sav_intake_execution_policy"),
      inArray(auditLogs.entityId, [grant.sourcePolicyId, grant.targetPolicyId]), eq(auditLogs.action, "sav_intake_execution_policy_revoked"))).limit(1);
    if (revoked) return false;
    const replacements = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, grant.sourcePolicyId), eq(auditLogs.action, "sav_intake_execution_policy_replaced")));
    if (!replacements.some(r => r.technicalMetadata?.continuityId === record.id)) return false;
    const effects = await db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, e.id));
    if (effects.some(f => intakeRuntimeHash(decryptSavPayload(f.intentCiphertext)) !== f.intentHash)
      || binding.effects.some(old => { const current = effects.find(f => f.id === old.id); return !current || current.intentHash !== old.intentHash || old.receiptHash && receipt(current) !== old.receiptHash; })) return false;
    const oldRuntime = { ...runtime, codeRevision: grant.sourceCodeRevision, configHash: binding.oldRuntimeHash };
    await localBinding(db, e, payload, oldRuntime);
    return await intakeRunConfigurationBound(run, oldRuntime, db);
  } catch { return false; }
}
