import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState, auditLogs, staffUsers, savIntakeExecutionPolicies } from "@/db/schema";
import { canAccessSav } from "../access";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig } from "./runtime-contract";
import { SAV_INTAKE_OPERATIONAL_PROFILE, intakeOperationalTermValid } from "./budget-profile";
import { executionAdministrator, executionPolicySchema, approveIntakeExecutionPolicy, type ExecutionPolicy, type IntakeExecutionPolicyTx } from "./execution-policy";

/** Renewal of an existing execution policy for the deployed code revision, copied server side.
 * Only codeRevision changes. Admission, mutations, maxDossiers, dates, resources, budget profile and mailbox are
 * copied verbatim from the decrypted source; the browser never sends or receives an encrypted payload or a key.
 * The source row is never rewritten. No provider, CRM or Gmail call, no env change, no activation. */
const REVISION = "sav-intake-execution-renewal-preview.v1";
const key = (id: string) => `sav-intake-renewal-preview:${id}`;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
type Env = Record<string, string | undefined>;
type Db = ReturnType<typeof requireDb> | IntakeExecutionPolicyTx;
export type IntakeRenewalSummary = { mailboxId: string; receivedAfter: string; createdAfter: string; expiresAt: string; budgetProfile: string | null;
  maxDossiers: number; mutations: string[]; admission: { kind: "automatic" } | { kind: "qualification"; runCount: number } };
export type IntakeRenewalReceipt = { policyId: string; policyHash: string; sourcePolicyId: string; sourcePolicyHash: string; fromCodeRevision: string; toCodeRevision: string };
type Preview = { revision: typeof REVISION; actorId: string; sourcePolicyId: string; sourcePolicyHash: string; fromCodeRevision: string; toCodeRevision: string;
  summary: IntakeRenewalSummary; createdAt: string; expiresAt: string; hash: string; leaseUntil?: string; receipt?: IntakeRenewalReceipt };
function refuse(code: string): never { throw Error(`SAV_INTAKE_RENEWAL_${code}`); }
const previewHash = (commandId: string, v: Omit<Preview, "hash" | "leaseUntil" | "receipt">) => intakeRuntimeHash({ commandId, revision: v.revision, actorId: v.actorId,
  sourcePolicyId: v.sourcePolicyId, sourcePolicyHash: v.sourcePolicyHash, fromCodeRevision: v.fromCodeRevision, toCodeRevision: v.toCodeRevision, summary: v.summary,
  createdAt: v.createdAt, expiresAt: v.expiresAt });

/** The deployed revision requested by the server environment, never a value typed in the browser or pinned in code. */
function deployedCodeRevision(env: Env) {
  const parsed = sha.safeParse(env.VERCEL_GIT_COMMIT_SHA ?? env.SAV_CODE_REVISION);
  return parsed.success ? parsed.data : refuse("CODE_REVISION_REQUIRED");
}
/** A typed UUID, or (empty field) the policy the server environment currently names. */
function sourcePolicyId(raw: string, env: Env) {
  const typed = raw.trim();
  if (typed) { const parsed = z.uuid().safeParse(typed); return { id: parsed.success ? parsed.data : refuse("SOURCE_INVALID"), fromEnv: false }; }
  const parsed = z.uuid().safeParse(env.SAV_INTAKE_EXECUTION_POLICY_ID);
  return { id: parsed.success ? parsed.data : refuse("SOURCE_REQUIRED"), fromEnv: true };
}
function summary(policy: ExecutionPolicy): IntakeRenewalSummary {
  return { mailboxId: policy.mailboxId, receivedAfter: policy.receivedAfter, createdAfter: policy.createdAfter, expiresAt: policy.expiresAt, budgetProfile: policy.budgetProfile ?? null,
    maxDossiers: policy.maxDossiers, mutations: [...policy.mutations],
    admission: policy.admission.kind === "automatic" ? { kind: "automatic" } : { kind: "qualification", runCount: policy.admission.runIds.length } };
}

/** Every renewal check (source first, then the live runtime), re-run at preview, at commit and inside the approval transaction (locked). A revoked,
 * unknown, incoherent or expired source, an approver who lost access, an invalid runtime or a runtime whose
 * business pins differ from the source is refused: nothing is resurrected, extended or re-bounded. */
async function renewalBasis(db: Db, id: string, env: Env, now: Date, lock = false) {
  const target = deployedCodeRevision(env);
  const query = db.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) refuse("SOURCE_UNKNOWN");
  if (row.state === "revoked") refuse("SOURCE_REVOKED");
  if (row.state !== "approved") refuse("SOURCE_NOT_APPROVED");
  let source: ExecutionPolicy | null = null;
  try { source = executionPolicySchema.parse(decryptSavPayload(row.payloadCiphertext)); } catch { /* refused below */ }
  if (!source || intakeRuntimeHash(source) !== row.policyHash) return refuse("SOURCE_INCOHERENT");
  const [owner] = await db.select().from(staffUsers).where(eq(staffUsers.id, row.administratorId));
  if (!owner?.active || !["admin", "owner"].includes(owner.role) || !canAccessSav(owner.email, owner.role)) refuse("SOURCE_APPROVER_UNAUTHORIZED");
  if (Date.parse(source.expiresAt) <= now.getTime() || (source.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE
    ? !intakeOperationalTermValid(source.expiresAt, now) : Date.parse(source.expiresAt) - now.getTime() > 86_400_000)) refuse("SOURCE_EXPIRED");
  if (source.codeRevision === target) refuse("NOT_NEEDED");
  let runtime: ReturnType<typeof savIntakeRuntimeConfig> = null;
  try { runtime = savIntakeRuntimeConfig(env, now); } catch { /* refused below */ }
  if (!runtime || runtime.codeRevision !== target) return refuse("RUNTIME_INVALID");
  const live = runtime;
  if (source.mailboxId !== live.mailboxId || source.receivedAfter !== live.receivedAfter || source.createdAfter !== live.createdAfter || source.expiresAt !== live.expiresAt
    || source.enginePolicyHash !== live.policyHash || source.resourcesHash !== live.resourcesHash || source.budgetProfile !== live.budgetProfile) refuse("RUNTIME_DRIFT");
  const renewed = executionPolicySchema.parse({ ...source, codeRevision: target });
  const { codeRevision: from, ...kept } = source, { codeRevision: to, ...copied } = renewed;
  if (intakeRuntimeHash(kept) !== intakeRuntimeHash(copied) || from === to) refuse("SOURCE_INCOHERENT");
  return { row: row!, source, renewed, target };
}

/** First click: a durable, encrypted, actor-bound intent only. No policy, launch boundary or provider call. Fixed 10 min expiry. */
export async function previewIntakeExecutionRenewal(commandId: string, rawSource: string, env: Env = process.env) {
  z.uuid().parse(commandId);
  const actor = await executionAdministrator(), source = sourcePolicyId(rawSource, env), now = new Date();
  const basis = await renewalBasis(requireDb(), source.id, env, now);
  if (source.fromEnv && env.SAV_INTAKE_EXECUTION_POLICY_SHA256 !== basis.row.policyHash) refuse("SOURCE_CONFIGURATION_MISMATCH");
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key(commandId)}))`);
    const [existing] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key(commandId)));
    if (existing) {
      const old = decryptSavPayload<Preview>(existing.cursor!);
      if (old.actorId !== actor.id || old.sourcePolicyId !== basis.row.id || old.sourcePolicyHash !== basis.row.policyHash || old.toCodeRevision !== basis.target) refuse("PREVIEW_CONFLICT");
      return { previewId: commandId, hash: old.hash, expiresAt: old.expiresAt, sourcePolicyId: old.sourcePolicyId, sourcePolicyHash: old.sourcePolicyHash,
        fromCodeRevision: old.fromCodeRevision, toCodeRevision: old.toCodeRevision, summary: old.summary };
    }
    const createdAt = now.toISOString(), expiresAt = new Date(now.getTime() + 600_000).toISOString();
    const value = { revision: REVISION, actorId: actor.id, sourcePolicyId: basis.row.id, sourcePolicyHash: basis.row.policyHash, fromCodeRevision: basis.source.codeRevision,
      toCodeRevision: basis.target, summary: summary(basis.source), createdAt, expiresAt } as const;
    const payload: Preview = { ...value, hash: previewHash(commandId, value) };
    await tx.insert(savSyncState).values({ key: key(commandId), status: "pending", cursor: encryptSavPayload(payload) });
    return { previewId: commandId, hash: payload.hash, expiresAt, sourcePolicyId: payload.sourcePolicyId, sourcePolicyHash: payload.sourcePolicyHash,
      fromCodeRevision: payload.fromCodeRevision, toCodeRevision: payload.toCodeRevision, summary: payload.summary };
  });
}

/** CAS second click by the same administrator. Same command/hash is idempotent and resumable after a crash.
 * The source is re-checked under its row lock inside the canonical approval transaction (revocation race). */
export async function commitIntakeExecutionRenewal(commandId: string, hash: string, env: Env = process.env): Promise<IntakeRenewalReceipt> {
  z.uuid().parse(commandId); z.string().regex(/^[a-f0-9]{64}$/).parse(hash);
  const actor = await executionAdministrator();
  const claim = await requireDb().transaction(async tx => {
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key(commandId))).for("update");
    if (!row?.cursor) return refuse("PREVIEW_REQUIRED");
    const value = decryptSavPayload<Preview>(row.cursor);
    if (value.revision !== REVISION || value.actorId !== actor.id || value.hash !== hash || previewHash(commandId, value) !== hash) refuse("PREVIEW_CONFLICT");
    if (row.status === "committed" && value.receipt) return { done: value.receipt };
    if (row.status === "committing" && Date.parse(value.leaseUntil ?? "") > Date.now()) refuse("COMMIT_PENDING");
    const [created] = await tx.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, commandId));
    if (!created) {
      if (Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.createdAt) > Date.now()) refuse("PREVIEW_EXPIRED");
      const basis = await renewalBasis(tx, value.sourcePolicyId, env, new Date());
      if (basis.row.policyHash !== value.sourcePolicyHash || basis.source.codeRevision !== value.fromCodeRevision || basis.target !== value.toCodeRevision) refuse("PREVIEW_STALE");
    }
    value.leaseUntil = new Date(Date.now() + 30_000).toISOString();
    await tx.update(savSyncState).set({ status: "committing", cursor: encryptSavPayload(value) }).where(eq(savSyncState.key, row.key));
    return { value, created };
  });
  if (claim.done) return claim.done;
  const value = claim.value!;
  let policy: { id: string; policyHash: string };
  try {
    if (claim.created) {
      // Resume after a crash between approval and receipt: the policy already exists; never create a second one.
      if (claim.created.administratorId !== actor.id || claim.created.state !== "approved") refuse("PREVIEW_CONFLICT");
      const [source] = await requireDb().select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, value.sourcePolicyId));
      const facts = (cipher?: string) => { try { const { codeRevision, ...kept } = executionPolicySchema.parse(decryptSavPayload(cipher!)); return { codeRevision, kept: intakeRuntimeHash(kept) }; } catch { return null; } };
      const made = facts(claim.created.payloadCiphertext), from = facts(source?.payloadCiphertext);
      if (!made || !from || source!.policyHash !== value.sourcePolicyHash || made.codeRevision !== value.toCodeRevision || made.kept !== from.kept) refuse("PREVIEW_CONFLICT");
      policy = { id: claim.created.id, policyHash: claim.created.policyHash };
    } else {
      const basis = await renewalBasis(requireDb(), value.sourcePolicyId, env, new Date());
      policy = await approveIntakeExecutionPolicy(basis.renewed, commandId, async tx => {
        const locked = await renewalBasis(tx, value.sourcePolicyId, env, new Date(), true);
        if (locked.row.policyHash !== value.sourcePolicyHash || intakeRuntimeHash(locked.renewed) !== intakeRuntimeHash(basis.renewed)) refuse("PREVIEW_STALE");
      });
    }
  } catch (error) {
    // Release the lease so the explicit refusal is reported again instead of COMMIT_PENDING; no policy was created.
    await requireDb().transaction(async tx => {
      const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key(commandId))).for("update");
      const current = row?.cursor ? decryptSavPayload<Preview>(row.cursor) : null;
      if (row && current && current.leaseUntil === value.leaseUntil && !current.receipt) await tx.update(savSyncState).set({ status: "pending", cursor: encryptSavPayload({ ...current, leaseUntil: undefined }) }).where(eq(savSyncState.key, row.key));
    });
    throw error;
  }
  const receipt: IntakeRenewalReceipt = { policyId: policy.id, policyHash: policy.policyHash, sourcePolicyId: value.sourcePolicyId, sourcePolicyHash: value.sourcePolicyHash,
    fromCodeRevision: value.fromCodeRevision, toCodeRevision: value.toCodeRevision };
  return requireDb().transaction(async tx => {
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key(commandId))).for("update");
    const current = decryptSavPayload<Preview>(row!.cursor!);
    if (current.hash !== hash || current.leaseUntil !== value.leaseUntil) refuse("PREVIEW_CONFLICT");
    await tx.update(savSyncState).set({ status: "committed", cursor: encryptSavPayload({ ...current, receipt }) }).where(eq(savSyncState.key, row!.key));
    await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_intake_execution_policy_renewed", entityType: "sav_intake_execution_policy", entityId: policy.id,
      technicalMetadata: { previewHash: hash, sourcePolicyId: value.sourcePolicyId, sourcePolicyHash: value.sourcePolicyHash, policyHash: policy.policyHash,
        fromCodeRevision: value.fromCodeRevision, toCodeRevision: value.toCodeRevision } });
    return receipt;
  });
}
