import "server-only";
import { SAV_INTAKE_OPERATIONAL_PROFILE, intakeOperationalTermValid } from "./budget-profile";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { staffUsers, savIntakeExecutionPolicies, auditLogs } from "@/db/schema";
import { canAccessSav } from "../access";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { savIntakeMutationSchema } from "./contract";
import { authorizeSavStaffUser, savRequestUser, type SavClerkUser } from "./console-auth";
export const executionPolicySchema = z.object({
    revision: z.literal("sav-intake-execution-2026-10-21.v1"), mailboxId: z.uuid(), codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
    enginePolicyHash: z.string().regex(/^[a-f0-9]{64}$/), resourcesHash: z.string().regex(/^[a-f0-9]{64}$/),
    receivedAfter: z.iso.datetime(), createdAfter: z.iso.datetime(), expiresAt: z.iso.datetime(), budgetProfile:z.literal(SAV_INTAKE_OPERATIONAL_PROFILE).optional(), maxDossiers: z.number().int().min(1).max(100),
    mutations: z.array(savIntakeMutationSchema).min(1).max(9).refine(a => new Set(a).size === a.length),
    admission: z.discriminatedUnion("kind", [z.object({
            kind: z.literal("automatic")
        }).strict(), z.object({
            kind: z.literal("qualification"), runIds: z.array(z.uuid()).min(1).max(100)
        }).strict()]),
}).strict();
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type ExecutionConfig = {
    policyId: string;
    policyHash: string;
    codeRevision: string;
};
export function intakeExecutionConfig(env: Record<string, string | undefined> = process.env): ExecutionConfig | null {
    if (env.SAV_INTAKE_EXECUTION_MODE !== "execute")
        return null;
    if (env.SAV_WRITES_DISABLED === "true" || env.SAV_INTAKE_EXECUTION_KILL_SWITCH === "1")
        throw Error("SAV_INTAKE_EXECUTION_DISABLED");
    const p = z.object({
        policyId: z.uuid(), policyHash: z.string().regex(/^[a-f0-9]{64}$/), codeRevision: z.string().regex(/^[a-f0-9]{40}$/)
    }).strict().safeParse({
        policyId: env.SAV_INTAKE_EXECUTION_POLICY_ID, policyHash: env.SAV_INTAKE_EXECUTION_POLICY_SHA256, codeRevision: env.VERCEL_GIT_COMMIT_SHA ?? env.SAV_CODE_REVISION
    });
    if (!p.success)
        throw Error("SAV_INTAKE_EXECUTION_CONFIGURATION_REQUIRED");
    return p.data;
}
/** Verified session -> existing authoritative staff row. No provisioning/bypass. */
export async function executionAdministrator() {
    return executionAdministratorFor(await savRequestUser());
}
/** The same administrator checks for a user resolved from a verified MCP token. */
export async function executionAdministratorFor(user: SavClerkUser) {
    const staff = await authorizeSavStaffUser(user, "SAV_INTAKE_EXECUTION_UNAUTHORIZED");
    if (!["admin", "owner"].includes(staff.role))
        throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
    return staff;
}
export type IntakeExecutionPolicyTx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
/** Explicit administrator operation only. `beforeCreate` (renewal) runs inside the approval transaction, after the
 * administrator lock and only when a new policy row would be created, so a concurrent source revocation is serialized. */
export async function approveIntakeExecutionPolicy(raw: unknown, commandId?: string, beforeCreate?: (tx: IntakeExecutionPolicyTx) => Promise<void>) {
    const staff = await executionAdministrator(), policy = executionPolicySchema.parse(raw), now = Date.now();
    if (Date.parse(policy.expiresAt) <= now || (policy.budgetProfile===SAV_INTAKE_OPERATIONAL_PROFILE ? !intakeOperationalTermValid(policy.expiresAt,new Date(now)) : Date.parse(policy.expiresAt) - now > 86400000) || Date.parse(policy.createdAfter) > now || Date.parse(policy.receivedAfter) >= Date.parse(policy.expiresAt))
        throw Error("SAV_INTAKE_EXECUTION_POLICY_INVALID");
    if(commandId) z.uuid().parse(commandId);
    const row = await requireDb().transaction(async (tx) => {
        const [current] = await tx.select().from(staffUsers).where(eq(staffUsers.id, staff.id)).for("update");
        if (!current?.active || !["admin", "owner"].includes(current.role) || !canAccessSav(current.email, current.role))
            throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
        if(commandId) {
            const [existing]=await tx.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id,commandId));
            if(existing) {
                if(existing.state!=="approved"||existing.administratorId!==staff.id||existing.policyHash!==intakeRuntimeHash(policy)) throw Error("SAV_INTAKE_EXECUTION_POLICY_CONFLICT");
                return existing;
            }
        }
        if (beforeCreate) await beforeCreate(tx);
        const [created] = await tx.insert(savIntakeExecutionPolicies).values({
            id:commandId, revision: policy.revision, state: "approved", administratorId: staff.id, policyHash: intakeRuntimeHash(policy), payloadCiphertext: encryptSavPayload(policy)
        }).returning();
        await tx.insert(auditLogs).values({
            actorEmail: staff.email, action: "sav_intake_execution_policy_approved", entityType: "sav_intake_execution_policy", entityId: created.id, technicalMetadata: {
                policyHash: created.policyHash
            }
        });
        return created;
    });
    return {
        id: row.id, policyHash: row.policyHash
    };
}
export async function readIntakeExecutionAuthority(config: ExecutionConfig, now = new Date()) {
    const [row] = await requireDb().select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, config.policyId));
    const [staff] = row ? await requireDb().select().from(staffUsers).where(eq(staffUsers.id, row.administratorId)) : [];
    if (!row || row.state !== "approved" || row.policyHash !== config.policyHash || !staff?.active || !["admin", "owner"].includes(staff.role) || !canAccessSav(staff.email, staff.role))
        throw Error("SAV_INTAKE_EXECUTION_PERMISSION_REVOKED");
    const policy = executionPolicySchema.parse(decryptSavPayload(row.payloadCiphertext));
    if (intakeRuntimeHash(policy) !== row.policyHash || policy.codeRevision !== config.codeRevision || Date.parse(policy.expiresAt) <= now.getTime()
        || policy.budgetProfile===SAV_INTAKE_OPERATIONAL_PROFILE && !intakeOperationalTermValid(policy.expiresAt,now))
        throw Error("SAV_INTAKE_EXECUTION_POLICY_EXPIRED");
    return {
        row, staff, policy
    };
}
/** Night V1 (C): why automatic execution can or cannot start now, read-only, for the console and the MCP.
 * Production evidence: observed runs ended with SAV_INTAKE_EXECUTION_POLICY_EXPIRED after a redeploy, while the
 * console only said « Analyse prête, actions en attente ». Codes only: no hash, id, secret or customer data. */
import type { IntakeExecutionAuthorityState } from "./execution-authority";
export type { IntakeExecutionAuthorityState } from "./execution-authority";
export async function readIntakeExecutionAuthorityState(env: Record<string, string | undefined> = process.env, now = new Date()): Promise<IntakeExecutionAuthorityState> {
    let config: ExecutionConfig | null;
    try { config = intakeExecutionConfig(env); }
    catch (error) { return error instanceof Error && error.message === "SAV_INTAKE_EXECUTION_DISABLED" ? "disabled" : "configuration_required"; }
    if (!config) return "off";
    // Night V1 cycle 1 (M-2): the same checks as readIntakeExecutionAuthority, in its order, each named exactly
    // (no "revoked" for a missing row or an env hash mismatch, no "expired" for an incoherent payload). Read-only.
    try {
        const db = requireDb(), [row] = await db.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, config.policyId));
        if (!row) return "policy_missing";
        if (row.state === "revoked") return "revoked";
        if (row.state !== "approved") return "not_approved";
        if (row.policyHash !== config.policyHash) return "configuration_mismatch";
        const [staff] = await db.select().from(staffUsers).where(eq(staffUsers.id, row.administratorId));
        if (!staff?.active || !["admin", "owner"].includes(staff.role) || !canAccessSav(staff.email, staff.role)) return "approver_unauthorized";
        let policy: z.infer<typeof executionPolicySchema>;
        try { policy = executionPolicySchema.parse(decryptSavPayload(row.payloadCiphertext)); } catch { return "unreadable"; }
        if (intakeRuntimeHash(policy) !== row.policyHash) return "policy_incoherent";
        if (policy.codeRevision !== config.codeRevision) return "code_revision_changed";
        if (Date.parse(policy.expiresAt) <= now.getTime() || policy.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE && !intakeOperationalTermValid(policy.expiresAt, now)) return "expired";
        return "valid";
    } catch { return "unreadable"; }
}
/** Revocation persists independently of directory provisioning. Approval always
 * creates another policy; this primitive never resurrects a revoked record. */
export async function revokeIntakeExecutionPolicy(policyId: string, reason: string) {
    const staff = await executionAdministrator();
    z.uuid().parse(policyId);
    if (reason.trim().length < 10 || reason.length > 2000)
        throw Error("SAV_INTAKE_EXECUTION_POLICY_INVALID");
    return requireDb().transaction(async (tx) => {
        const [current] = await tx.select().from(staffUsers).where(eq(staffUsers.id, staff.id)).for("update");
        if (!current?.active || !["admin", "owner"].includes(current.role) || !canAccessSav(current.email, current.role))
            throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
        const [row] = await tx.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, policyId)).for("update");
        if (!row)
            throw Error("SAV_INTAKE_EXECUTION_POLICY_INVALID");
        await tx.update(savIntakeExecutionPolicies).set({
            state: "revoked", updatedAt: new Date()
        }).where(eq(savIntakeExecutionPolicies.id, row.id));
        await tx.insert(auditLogs).values({
            actorEmail: staff.email, action: "sav_intake_execution_policy_revoked", entityType: "sav_intake_execution_policy", entityId: row.id, technicalMetadata: {
                policyHash: row.policyHash, reasonCiphertext: encryptSavPayload({
                    reason: reason.trim()
                })
            }
        });
        return {
            id: row.id, state: "revoked" as const
        };
    });
}
