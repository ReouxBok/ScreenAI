import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload, savContentHash } from "../crypto";
import { savAutomationMode, isSavPilotMode } from "../config";
import { savReplyFooter } from "../reply-format";
import { savEffectiveReceivedAt } from "../message-order";
import { canAccessSav } from "../access";
import { intakeMessageHistorical } from "./launch-boundary";
import { intakeThreadHumanHeld } from "./legacy-pause";
import { readSavExternalCompletion } from "../external-completion";
import { readSavIntakeCurrent } from "./runtime-store";
import { savIntakeRuntimeConfig, intakeRuntimeHash } from "./runtime-contract";
import { assertSavAgentActionsAllowed } from "./agent-pause";
import { executionAdministrator } from "./execution-policy";
import { assertPureCommercialDecision, commercialForwardResourceSchema, commercialForwardDeliveryState, COMMERCIAL_FORWARD_PURPOSE } from "./commercial-forward-contract";
type Action = typeof savActions.$inferSelect;
const previewSchema = z.object({ purpose: z.literal(COMMERCIAL_FORWARD_PURPOSE), threadId: z.uuid(), messageId: z.uuid(), runId: z.uuid(), actorEmail: z.email(), sourceHash: z.string(), outboundHash: z.string(), issuedAt: z.number(), from: z.email(), to: z.email(), subject: z.string().max(1200), text: z.string().max(110000), resourceHash: z.string() }).strict();
const oneLine = (s: string) => s.replace(/[\r\n\0]+/g, " ").trim();
const enabled = () => { if (isSavPilotMode() || savAutomationMode() === "shadow" || process.env.SAV_INTAKE_EXECUTION_KILL_SWITCH === "1" || process.env.SAV_WRITES_DISABLED === "true")
    throw Error("SAV_COMMERCIAL_WRITES_DISABLED"); };
export const isSavCommercialForward = (a: Pick<Action, "payload">) => a.payload.purpose === COMMERCIAL_FORWARD_PURPOSE;
async function loadContext(threadId: string) {
    const db = requireDb();
    await assertSavAgentActionsAllowed(db);
    const runtime = savIntakeRuntimeConfig();
    if (!runtime)
        throw Error("SAV_COMMERCIAL_RUNTIME_REQUIRED");
    const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId)).limit(1);
    if (!thread || thread.aiPaused || await intakeThreadHumanHeld(threadId))
        throw Error("SAV_COMMERCIAL_HUMAN_HOLD");
    const current = await readSavIntakeCurrent(threadId, runtime);
    if (!current?.fresh || !current.sourceMatches || current.leaseToken || current.leaseUntil && current.leaseUntil > new Date())
        throw Error("SAV_COMMERCIAL_CURRENT_ANALYSIS_REQUIRED");
    const decision = assertPureCommercialDecision(current.payload.plan?.decision);
    if (decision.threadId !== threadId || decision.messageId !== current.messageId)
        throw Error("SAV_COMMERCIAL_CONTEXT_CHANGED");
    const [message] = await db.select().from(savMessages).where(eq(savMessages.id, current.messageId)).limit(1);
    if (!message?.gmailMessageId || !thread.gmailThreadId || await intakeMessageHistorical(message.id) || await readSavExternalCompletion(message))
        throw Error("SAV_COMMERCIAL_CONTEXT_CHANGED");
    const [laterOutbound] = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "outbound"), sql `${savEffectiveReceivedAt} >= ${message.receivedAt}`)).limit(1);
    if (laterOutbound)
        throw Error("SAV_COMMERCIAL_HUMAN_HISTORY_REVIEW_REQUIRED");
    const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.id, message.mailboxId)).limit(1);
    if (!mailbox || mailbox.email.toLowerCase() !== "contact@limova.ai" || thread.mailboxId !== mailbox.id)
        throw Error("SAV_COMMERCIAL_MAILBOX_INVALID");
    const ref = runtime.policy.resources.commercial;
    if (!ref || intakeRuntimeHash(ref) !== intakeRuntimeHash(current.payload.plan?.supervisedResource))
        throw Error("SAV_COMMERCIAL_RESOURCE_CHANGED");
    const catalogue = JSON.parse(process.env.SAV_INTAKE_RUNTIME_RESOURCES ?? "[]") as Array<{
        resource: unknown;
        text: string;
    }>;
    const item = catalogue.find(x => intakeRuntimeHash(x.resource) === intakeRuntimeHash(ref));
    if (!item)
        throw Error("SAV_COMMERCIAL_RESOURCE_REQUIRED");
    const resource = commercialForwardResourceSchema.parse(JSON.parse(item.text));
    if (resource.recipient.toLowerCase() === mailbox.email.toLowerCase() || resource.recipient.toLowerCase() === message.fromEmail.toLowerCase())
        throw Error("SAV_COMMERCIAL_INTERNAL_RECIPIENT_REQUIRED");
    const body = decryptSavPayload<{
        text: string;
    }>(message.bodyCiphertext).text;
    if (typeof body !== "string" || body.length > 100000)
        throw Error("SAV_COMMERCIAL_MESSAGE_TOO_LARGE");
    const outbound = { from: mailbox.email.toLowerCase(), to: resource.recipient, subject: `${resource.subjectPrefix} : ${oneLine(message.subject)}`, text: `${resource.introduction}\n\nLes pièces jointes ne sont pas incluses dans ce transfert.\n\n${savReplyFooter("fr")}\n\n---------- Email transféré ----------\nDe : ${oneLine(message.fromEmail)}\nDate : ${message.receivedAt.toISOString()}\nObjet : ${oneLine(message.subject)}\n\n${body}` };
    const resourceHash = intakeRuntimeHash(ref), outboundHash = savContentHash(outbound), sourceHash = savContentHash({ runId: current.id, source: current.currentSourceHash, decision, resourceHash, outboundHash });
    return { thread, message, mailbox, current, resourceHash, outbound, sourceHash, outboundHash };
}
async function existing(threadId: string, messageId: string, db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) { const rows = await db.select().from(savActions).where(and(eq(savActions.threadId, threadId), sql `${savActions.payload}->>'purpose' = ${COMMERCIAL_FORWARD_PURPOSE}`)); if (rows.some(a => a.status !== "succeeded" && a.payload.forwardDispatchedAt))
    throw Error("SAV_COMMERCIAL_RECONCILIATION_REQUIRED"); return rows.find(a => a.idempotencyKey === `gmail:commercial-forward:${messageId}`); }
export async function prepareSavCommercialForward(threadId: string) { const actor = await executionAdministrator(); enabled(); const c = await loadContext(z.uuid().parse(threadId)); if (commercialForwardDeliveryState(await existing(threadId, c.message.id)) !== "available")
    throw Error("SAV_COMMERCIAL_ALREADY_REQUESTED"); const issuedAt = Date.now(), p = previewSchema.parse({ purpose: COMMERCIAL_FORWARD_PURPOSE, threadId, messageId: c.message.id, runId: c.current.id, actorEmail: actor.email, issuedAt, sourceHash: c.sourceHash, outboundHash: c.outboundHash, resourceHash: c.resourceHash, ...c.outbound }); return { token: encryptSavPayload(p), ...c.outbound, expiresAt: new Date(issuedAt + 900000).toISOString(), requires: "Review full history, prior transfer and human replies before confirming. No model call." }; }
export async function queueSavCommercialForward(token: string) {
    const actor = await executionAdministrator();
    enabled();
    const p = previewSchema.parse(decryptSavPayload(token));
    if (p.actorEmail !== actor.email || p.issuedAt > Date.now() || Date.now() - p.issuedAt > 900000)
        throw Error("SAV_COMMERCIAL_PREVIEW_EXPIRED");
    const c = await loadContext(p.threadId);
    return requireDb().transaction(async (tx) => {
        await tx.select().from(savThreads).where(eq(savThreads.id, p.threadId)).for("update");
        if (savContentHash({ from: p.from, to: p.to, subject: p.subject, text: p.text }) !== c.outboundHash || c.sourceHash !== p.sourceHash || c.outboundHash !== p.outboundHash || c.resourceHash !== p.resourceHash)
            throw Error("SAV_COMMERCIAL_PREVIEW_STALE");
        const old = await existing(p.threadId, p.messageId, tx);
        if (old && commercialForwardDeliveryState(old) !== "available")
            return { actionId: old.id, status: commercialForwardDeliveryState(old) };
        const values = { threadId: p.threadId, messageId: p.messageId, kind: "send_reply", actorType: "human", actorEmail: actor.email, status: "pending", attemptCount: 0, errorCode: null, scheduledAt: null, payload: { purpose: COMMERCIAL_FORWARD_PURPOSE, manualReplyConfirmed: true, forwardConfirmedAt: new Date().toISOString(), previewCiphertext: token, sourceHash: p.sourceHash, outboundHash: p.outboundHash }, updatedAt: new Date() } as const;
        const [action] = await tx.insert(savActions).values({ ...values, idempotencyKey: `gmail:commercial-forward:${p.messageId}` }).returning();
        await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_commercial_forward_confirmed", entityType: "sav_action", entityId: action.id, technicalMetadata: { runId: p.runId, resourceHash: p.resourceHash, outboundHash: p.outboundHash } });
        return { actionId: action.id, status: "pending" };
    });
}
export async function assertSavCurrentCommercialForward(action: Action) {
    enabled();
    if (!isSavCommercialForward(action) || action.kind !== "send_reply" || action.actorType !== "human" || !action.actorEmail || action.pilotBatchId || action.payload.manualReplyConfirmed !== true || !action.payload.forwardConfirmedAt || action.payload.followupSequence)
        throw Error("SAV_COMMERCIAL_CONFIRMATION_REQUIRED");
    const [staff] = await requireDb().select().from(staffUsers).where(eq(staffUsers.email, action.actorEmail)).limit(1);
    if (!staff?.active || !["admin", "owner"].includes(staff.role) || !canAccessSav(staff.email, staff.role))
        throw Error("SAV_COMMERCIAL_ACTOR_REVOKED");
    const p = previewSchema.parse(decryptSavPayload(String(action.payload.previewCiphertext ?? ""))), c = await loadContext(action.threadId);
    if (p.actorEmail !== action.actorEmail || p.messageId !== action.messageId || p.threadId !== action.threadId || savContentHash({ from: p.from, to: p.to, subject: p.subject, text: p.text }) !== c.outboundHash || p.sourceHash !== c.sourceHash || p.outboundHash !== c.outboundHash || action.payload.sourceHash !== c.sourceHash || action.payload.outboundHash !== c.outboundHash)
        throw Error("SAV_COMMERCIAL_PREVIEW_STALE");
    return { ...c, preview: p };
}
