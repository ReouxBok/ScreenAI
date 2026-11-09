import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savSyncState, staffUsers } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { canAccessSav } from "../access";
import { executionAdministrator } from "./execution-policy";
import { intakeRuntimeHash } from "./runtime-contract";
import { COMMERCIAL_FORWARD_PURPOSE } from "./commercial-forward-contract";
export const COMMERCIAL_AUTHORITY_KEY = "sav-commercial-delivery-authority.v1";
export const commercialDeliverySettingsSchema = z.object({
    scope: z.literal("commercial_pure_contact_mailbox"), recipient: z.email().max(254).refine(x => x.toLowerCase() !== "contact@limova.ai"),
    subjectPrefix: z.string().min(1).max(100).refine(x => !/[\r\n\0]/.test(x)), introduction: z.string().min(10).max(2000),
    state: z.enum(["enabled", "revoked"]), expiresAt: z.iso.datetime(),
}).strict();
export const commercialAuthorityCommandSchema = z.object({ commandId: z.uuid(), expectedRevision: z.uuid().nullable(), settings: commercialDeliverySettingsSchema }).strict();
const authoritySchema = z.object({ schema: z.literal(COMMERCIAL_AUTHORITY_KEY), revision: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), settings: commercialDeliverySettingsSchema, approvedBy: z.uuid(), approvedEmail: z.email(), approvedAt: z.iso.datetime() }).strict();
const previewSchema = commercialAuthorityCommandSchema.extend({ actorId: z.uuid(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Db = Pick<ReturnType<typeof requireDb>, "select">;
type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
const previewKey = (id: string) => `${COMMERCIAL_AUTHORITY_KEY}:preview:${id}`;
const fail = (reason: string): never => { throw Error(`SAV_COMMERCIAL_AUTHORITY_${reason}`); };
export const lockCommercialDeliveryAuthority = async (tx: Tx) => { await tx.execute(sql `select pg_advisory_xact_lock(hashtext(${COMMERCIAL_AUTHORITY_KEY}))`); };
async function current(db: Db) {
    const [row] = await db.select().from(savSyncState).where(eq(savSyncState.key, COMMERCIAL_AUTHORITY_KEY));
    if (!row)
        return null;
    try {
        const a = authoritySchema.parse(decryptSavPayload(row.cursor!));
        if (a.contentHash !== intakeRuntimeHash(a.settings) || row.status !== a.settings.state)
            throw Error();
        return a;
    }
    catch {
        return fail("INVALID");
    }
}
export async function readCommercialDeliveryAuthority(db: Db = requireDb()) {
    const a = await current(db);
    if (!a)
        return fail("REQUIRED");
    if (a.settings.state !== "enabled")
        return fail("REVOKED");
    if (Date.parse(a.settings.expiresAt) <= Date.now() || Date.parse(a.approvedAt) > Date.now())
        return fail("EXPIRED");
    const [owner] = await db.select().from(staffUsers).where(eq(staffUsers.id, a.approvedBy));
    if (!owner?.active || owner.email !== a.approvedEmail || !["admin", "owner"].includes(owner.role) || !canAccessSav(owner.email, owner.role))
        return fail("ACTOR_REVOKED");
    return a;
}
async function affected(db: Db) {
    const rows=await db.select({id:savActions.id,status:savActions.status}).from(savActions).where(and(sql`${savActions.payload}->>'purpose'=${COMMERCIAL_FORWARD_PURPOSE}`,sql`${savActions.payload}->>'forwardDispatchedAt' is not null`)).orderBy(sql`case when ${savActions.status}='succeeded' then 1 else 0 end`,desc(savActions.updatedAt),savActions.id).limit(101);
    return {dispatched:rows.slice(0,100),dispatchedLimit:100,dispatchedTruncated:rows.length>100,dispatchedIncludesConfirmed:true};
}
export async function getCommercialDeliveryAuthority() {
    await executionAdministrator();
    return {authority:await current(requireDb()),...await affected(requireDb()),warning:"Bounded dispatch history, uncertain or unfinished actions first. Rotation cannot retroactively cancel a reserved message."};
}
export async function previewCommercialDeliveryAuthority(raw: unknown) {
    const input = commercialAuthorityCommandSchema.parse(raw), actor = await executionAdministrator();
    if (Date.parse(input.settings.expiresAt) <= Date.now())
        return fail("EXPIRED");
    return requireDb().transaction(async (tx) => {
        await lockCommercialDeliveryAuthority(tx);
        const key = previewKey(input.commandId), [old] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key));
        if (old) {
            const p = previewSchema.parse(decryptSavPayload(old.cursor!));
            if (p.actorId !== actor.id || intakeRuntimeHash({ commandId: p.commandId, expectedRevision: p.expectedRevision, settings: p.settings }) !== intakeRuntimeHash(input))
                return fail("PREVIEW_CONFLICT");
            return p;
        }
        if ((await current(tx))?.revision !== (input.expectedRevision ?? undefined))
            return fail("REVISION_CHANGED");
        const p = { ...input, actorId: actor.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
        const preview = previewSchema.parse({ ...p, hash: intakeRuntimeHash(p) });
        await tx.insert(savSyncState).values({ key, status: "preview", cursor: encryptSavPayload(preview) });
        return preview;
    });
}
export async function commitCommercialDeliveryAuthority(commandId: string, expectedHash: string) {
    z.uuid().parse(commandId);
    z.string().regex(/^[a-f0-9]{64}$/).parse(expectedHash);
    const actor = await executionAdministrator();
    return requireDb().transaction(async (tx) => {
        await lockCommercialDeliveryAuthority(tx);
        const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actor.id)).for("update");
        if (!staff?.active || staff.email !== actor.email || !["admin", "owner"].includes(staff.role) || !canAccessSav(staff.email, staff.role))
            return fail("ACTOR_REVOKED");
        const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, previewKey(commandId)));
        if (!row)
            return fail("PREVIEW_REQUIRED");
        const p = previewSchema.parse(decryptSavPayload(row.cursor!)), { hash, ...bound } = p;
        if (p.actorId !== actor.id || hash !== expectedHash || intakeRuntimeHash(bound) !== hash)
            return fail("PREVIEW_CONFLICT");
        // Exact retries return their durable receipt even if a newer revision is active.
        if (row.status === "committed")
            return { revision: p.commandId, contentHash: intakeRuntimeHash(p.settings), state: p.settings.state, idempotent: true };
        if (Date.parse(p.expiresAt) <= Date.now() || Date.parse(p.createdAt) > Date.now() || Date.parse(p.settings.expiresAt) <= Date.now())
            return fail("EXPIRED");
        if ((await current(tx))?.revision !== (p.expectedRevision ?? undefined))
            return fail("REVISION_CHANGED");
        const a = authoritySchema.parse({ schema: COMMERCIAL_AUTHORITY_KEY, revision: p.commandId, contentHash: intakeRuntimeHash(p.settings), settings: p.settings, approvedBy: staff.id, approvedEmail: staff.email, approvedAt: new Date().toISOString() });
        await tx.insert(savSyncState).values({ key: COMMERCIAL_AUTHORITY_KEY, status: p.settings.state, cursor: encryptSavPayload(a) }).onConflictDoUpdate({ target: savSyncState.key, set: { status: p.settings.state, cursor: encryptSavPayload(a), updatedAt: new Date() } });
        await tx.update(savSyncState).set({ status: "committed" }).where(eq(savSyncState.key, previewKey(commandId)));
        const dispatched = await affected(tx);
        await tx.insert(auditLogs).values({ actorEmail: staff.email, action: "sav_commercial_delivery_authority_approved", entityType: "sav_commercial_delivery_authority", entityId: a.revision, technicalMetadata: { contentHash: a.contentHash, previousRevision: p.expectedRevision, state: a.settings.state,dispatchedTruncated:dispatched.dispatchedTruncated, dispatchedActionIds: JSON.stringify(dispatched.dispatched.map(x => x.id)) } });
        return { revision: a.revision, contentHash: a.contentHash, state: a.settings.state, idempotent: false, ...dispatched, warning: "Rotation does not cancel already reserved or dispatched messages." };
    });
}
/** Rotation and the irreversible dispatch reservation share this lock. No recipient is read again after reservation. */
export async function reserveCommercialForwardDispatch(actionId: string, revision: string, contentHash: string) {
    return requireDb().transaction(async (tx) => {
        await lockCommercialDeliveryAuthority(tx);
        const a = await readCommercialDeliveryAuthority(tx);
        if (a.revision !== revision || a.contentHash !== contentHash)
            return fail("REVISION_CHANGED");
        const [row] = await tx.update(savActions).set({ payload: sql `${savActions.payload} || ${JSON.stringify({ forwardDispatchedAt: new Date().toISOString(), commercialAuthorityRevision: revision, commercialAuthorityHash: contentHash })}::jsonb`, updatedAt: new Date() }).where(and(eq(savActions.id, actionId), eq(savActions.status, "running"), sql `${savActions.payload}->>'purpose'=${COMMERCIAL_FORWARD_PURPOSE}`, sql `${savActions.payload}->>'forwardDispatchedAt' is null`, sql `${savActions.payload}->>'commercialAuthorityRevision'=${revision}`, sql `${savActions.payload}->>'commercialAuthorityHash'=${contentHash}`)).returning();
        if (!row)
            return fail("DISPATCH_REFUSED");
        return row;
    });
}
