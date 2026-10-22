import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savActions, savIntakeOccupations, savThreads } from "@/db/schema";
import { admissionLock, occupationSchemaInstalled, occupyKeys, releaseKeys } from "./execution-store";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { decryptSavPayload } from "../crypto";
import { z } from "zod";
import { intakeRuntimeHash } from "./runtime-contract";
const attempt = new AsyncLocalStorage<{
    id: string;
    count: number;
}>();
const fail = (): never => { throw Error("SAV_INTAKE_EXECUTION_LEGACY_RECONCILIATION_REQUIRED"); };
type Action = typeof savActions.$inferSelect;
export const withLegacyOccupationAction = <T>(action: Action, fn: () => Promise<T>) => attempt.run({
    id: action.id, count: action.attemptCount
}, fn);
async function needed() {
    if (!await occupationSchemaInstalled())
        return false;
    if (process.env.SAV_INTAKE_EXECUTION_MODE === "execute")
        return true;
    return Boolean((await requireDb().select({
        key: savIntakeOccupations.key
    }).from(savIntakeOccupations).limit(1))[0]);
}
async function scope(action: Action) {
    const [thread] = await requireDb().select().from(savThreads).where(eq(savThreads.id, action.threadId));
    if (!thread)
        return fail();
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token)
        return fail();
    const readers = createSavIntakeHubspotReaders({
        network: (url, init) => fetch(url, {
            ...init, headers: {
                ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}`
            }, redirect: "error"
        })
    });
    const signal = AbortSignal.timeout(15000), addresses = new Set([thread.customerEmail.toLowerCase()]), ids = new Set<string>();
    const keys = [`thread:${thread.id}`], observedSnapshots: unknown[] = [];
    // The effective human-confirmed identity can differ from the incoming
    // sender. These are trusted encrypted server snapshots, never an LLM grant.
    for (const name of ["ticketReviewSnapshotCiphertext", "ticketPreviewSnapshotCiphertext", "ticketCreateRequestCiphertext", "ticketReturnRequestCiphertext"]) {
        const encrypted = action.payload[name];
        if (typeof encrypted !== "string")
            continue;
        const saved = decryptSavPayload<Record<string, unknown>>(encrypted);
        observedSnapshots.push({
            name, saved
        });
        if (typeof saved.customerEmail === "string")
            addresses.add(z.email().parse(saved.customerEmail).toLowerCase());
        if (typeof saved.contactId === "string")
            ids.add(z.string().regex(/^\d{1,30}$/).parse(saved.contactId));
        const proposal = saved.proposal as {
            customerIdentity?: {
                verifiedByHuman?: boolean;
                registrationEmail?: string;
            };
            routing?: {
                contactId?: string;
            };
        } | undefined;
        if (proposal?.customerIdentity?.verifiedByHuman && proposal.customerIdentity.registrationEmail)
            addresses.add(z.email().parse(proposal.customerIdentity.registrationEmail).toLowerCase());
        if (proposal?.routing?.contactId)
            ids.add(z.string().regex(/^\d{1,30}$/).parse(proposal.routing.contactId));
        if (typeof saved.ticketId === "string")
            keys.push(`ticket:${z.string().regex(/^\d{1,30}$/).parse(saved.ticketId)}`);
    }
    if (addresses.size > 10)
        return fail();
    const lookupData: unknown[] = [];
    for (const email of [...addresses].sort()) {
        keys.push(`email:${email}`);
        const lookup = await readers.findContactsByEmail(email, signal);
        if (lookup.status !== "complete")
            return fail();
        lookupData.push({
            email, contacts: lookup.data
        });
        for (const c of lookup.data)
            ids.add(c.id);
    }
    const supplied = action.payload.contactId;
    if (typeof supplied === "string" && /^\d{1,30}$/.test(supplied))
        ids.add(supplied);
    const observations: unknown[] = [lookupData, observedSnapshots];
    for (const id of [...ids].sort()) {
        const linked = await readers.directAssociations(id, signal);
        if (linked.status !== "complete")
            return fail();
        observations.push(linked.data);
        for (const edge of linked.data) {
            ids.add(edge.fromContactId);
            ids.add(edge.toContactId);
        }
    }
    if (ids.size > 20)
        return fail();
    for (const id of ids)
        keys.push(`contact:${id}`);
    const ticket = typeof action.payload.hubspotTicketId === "string" ? action.payload.hubspotTicketId : thread.hubspotTicketId;
    if (ticket)
        keys.push(`ticket:${ticket}`);
    if (typeof action.payload.ticketId === "string")
        keys.push(`ticket:${action.payload.ticketId}`);
    const returned = action.payload.ticketReturn as {
        ticketId?: string;
        replacesClosedTicketId?: string;
    } | undefined;
    if (returned?.ticketId)
        keys.push(`ticket:${returned.ticketId}`);
    if (returned?.replacesClosedTicketId)
        keys.push(`ticket:${returned.replacesClosedTicketId}`);
    return {
        keys: [...new Set(keys)].sort(), hash: intakeRuntimeHash({
            keys: [...keys].sort(), observations
        })
    };
}
/** OFF without 0041 returns before new tables. Existing uncertain scopes stay
 * authoritative after OFF. All cooperating V0 writers use this same protocol. */
export async function guardLegacyIntakeOccupation(action: Action) {
    if (!await needed())
        return;
    const captured = attempt.getStore();
    if (!captured || captured.id !== action.id || captured.count !== action.attemptCount)
        return fail();
    const first = await scope(action);
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savActions).where(eq(savActions.id, action.id)).for("update");
        if (!row || row.status !== "running" || row.attemptCount !== captured.count)
            return fail();
        const marker = row.payload.intakeOccupationAttempt;
        if (marker !== undefined && marker !== captured.count)
            return fail();
        await occupyKeys(tx, action.id, "legacy", first.keys);
        await tx.update(savActions).set({
            payload: sql `${savActions.payload} || ${JSON.stringify({
                intakeOccupationAttempt: captured.count, intakeOccupationScope: first.hash
            })}::jsonb`
        }).where(eq(savActions.id, action.id));
    });
    const second = await scope(action);
    if (first.hash !== second.hash)
        return fail();
}
export async function markLegacyIntakeDispatch(actionId: string) {
    if (!await occupationSchemaInstalled())
        return;
    const captured = attempt.getStore();
    const db = requireDb();
    const scopes = await db.select().from(savIntakeOccupations).where(and(eq(savIntakeOccupations.ownerId, actionId), eq(savIntakeOccupations.ownerKind, "legacy")));
    if (!scopes.length)
        return;
    await db.transaction(async (tx) => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savActions).where(eq(savActions.id, actionId)).for("update");
        if (!captured || captured.id !== actionId || row?.status !== "running" || row.attemptCount !== captured.count || row.payload.intakeOccupationAttempt !== captured.count)
            return fail();
        await tx.update(savActions).set({
            payload: sql `${savActions.payload} || ${JSON.stringify({
                intakeOccupationDispatchedAt: new Date().toISOString()
            })}::jsonb`
        }).where(eq(savActions.id, actionId));
    });
}
export async function releaseLegacyIntakeIfConfirmed(actionId: string) {
    if (!await occupationSchemaInstalled())
        return;
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savActions).where(eq(savActions.id, actionId)).for("update");
        if (row && (row.status === "succeeded" || !row.payload.intakeOccupationDispatchedAt)) {
            await releaseKeys(tx, actionId);
            if (!row.payload.intakeOccupationDispatchedAt)
                await tx.update(savActions).set({
                    payload: sql `${savActions.payload} - 'intakeOccupationAttempt' - 'intakeOccupationScope'`
                }).where(eq(savActions.id, actionId));
        }
    });
}
