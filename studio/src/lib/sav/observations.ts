import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, knowledgeFamilySources, knowledgeProjectionCandidates, savDraftVerdicts, savLearningCandidates, savResolutionEvidence, savMessages, savObservationCycles, savObservationEvents, savResolutionObservations, savThreads, savTicketSnapshots } from "@/db/schema";
import { assertKnowledgeUgoApproval } from "@/lib/knowledge/contracts";
import { publicKnowledgeText } from "@/lib/knowledge/conversion";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { isSavAiAuthoredReply } from "./reply-format";
import { collectSavObservationSources, type ObservationEvent, type ObservationSnapshot } from "./observation-source";
import { savStoredReviewReasons, type SavReviewReason } from "./review-contract";
const DAY = 24 * 60 * 60 * 1000;
const STOPPED = new Date("9999-01-01T00:00:00Z");
function nextDue(row: {
    closedCatchupUntil: Date | null;
}, now: Date) { return row.closedCatchupUntil && now >= row.closedCatchupUntil ? STOPPED : new Date(now.getTime() + DAY); }
/** Invalidate dependent approvals but retain every candidate/version/event as history. */
async function invalidateObservationCandidates(tx: Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0], sourceRef: string, exceptId?: string) {
    const candidates = await tx.select().from(savLearningCandidates).where(eq(savLearningCandidates.sourceRef, sourceRef));
    for (const candidate of candidates) {
        if (candidate.id === exceptId || candidate.status === "rejected") continue;
        await tx.update(savLearningCandidates).set({ status: "rejected", explanation: `${candidate.explanation}\nPreuves actualisées : qualification antérieure devenue obsolète.` }).where(eq(savLearningCandidates.id, candidate.id));
        if (candidate.contentItemId) await tx.update(savResolutionEvidence).set({ outcome: "superseded", weight: 0 }).where(and(eq(savResolutionEvidence.sourceRef, sourceRef), eq(savResolutionEvidence.itemId, candidate.contentItemId)));
        const sources = await tx.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.sourceRef, `sav-learning:${candidate.id}`));
        for (const source of sources) await tx.update(knowledgeProjectionCandidates).set({ status: "rejected", explanation: "La preuve SAV source est devenue obsolète. Nouvelle qualification requise." }).where(eq(knowledgeProjectionCandidates.sourceId, source.id));
        await tx.insert(auditLogs).values({ actorEmail: "system", action: "sav_observation_candidate_invalidated", entityType: "sav_learning_candidate", entityId: candidate.id, technicalMetadata: { previousStatus: candidate.status, sourceRef } });
    }
}
const sourceError = (e: unknown) => e instanceof Error && /^[A-Z0-9_:]+$/.test(e.message) ? e.message : "SOURCE_UNAVAILABLE";
export async function hasSavTicketObservation(ticketId: string) {
    const [row] = await requireDb().select({ id: savResolutionObservations.id }).from(savResolutionObservations).innerJoin(savThreads, eq(savThreads.id, savResolutionObservations.threadId)).where(or(eq(savResolutionObservations.hubspotTicketId, ticketId), eq(savThreads.hubspotTicketId, ticketId))).limit(1);
    return Boolean(row);
}
function cachedCollector() {
 const cache = new Map<string,Promise<ObservationSnapshot>>();
 return async(ticketId:string)=>{let pending=cache.get(ticketId);if(!pending){pending=collectSavObservationSources(ticketId);cache.set(ticketId,pending);}return structuredClone(await pending);};
}
export async function refreshSavTicketObservations(ticketId: string) {
    const rows = await requireDb().select({ id: savResolutionObservations.id }).from(savResolutionObservations).innerJoin(savThreads, eq(savThreads.id, savResolutionObservations.threadId)).where(or(eq(savResolutionObservations.hubspotTicketId, ticketId), eq(savThreads.hubspotTicketId, ticketId)));
    const results = [];const collect=cachedCollector();
    for (const row of rows)
        results.push(await syncSavObservation(row.id,collect));
    return results;
}
/** Every tracked dossier is due once a day; small worker batches drain the due
 * queue across passages, rather than limiting daily coverage to five tickets. */
export async function reconcileSavObservations(limit = 5, now = new Date()) {
    const due = await requireDb().select({ id: savResolutionObservations.id }).from(savResolutionObservations).where(and(lte(savResolutionObservations.nextSyncAt, now), or(isNull(savResolutionObservations.leaseUntil), lte(savResolutionObservations.leaseUntil, now)))).orderBy(asc(savResolutionObservations.nextSyncAt), asc(savResolutionObservations.id)).limit(Math.min(20, Math.max(1, limit)));
    const results = [];
    const deadline = Date.now() + 20000;const collect=cachedCollector();
    for (const row of due) {
        if (Date.now() >= deadline)
            break;
        results.push(await syncSavObservation(row.id, collect, now));
    }
    return { processed: results };
}
export async function syncSavObservation(id: string, collect: (id: string) => Promise<ObservationSnapshot> = collectSavObservationSources, now = new Date()) {
    const db = requireDb();
    const token = randomUUID();
    const claim = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, id)).for("update");
        if (!row || row.leaseUntil && row.leaseUntil > now)
            return null;
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId));
        // The application's confirmed link is the only binding authority. No contact search.
        const ticketId = thread?.hubspotTicketId ?? row.hubspotTicketId;
        if (!ticketId) {
            await tx.update(savResolutionObservations).set({ state: "waiting_ticket", nextSyncAt: new Date(now.getTime() + DAY), updatedAt: now }).where(eq(savResolutionObservations.id, id));
            return null;
        }
        if (row.hubspotTicketId && row.hubspotTicketId !== ticketId) {
            await tx.update(savResolutionObservations).set({ state: "sources_incomplete", sourceErrors: ["ticket_link_changed"], nextSyncAt: new Date(now.getTime() + DAY), updatedAt: now }).where(eq(savResolutionObservations.id, id));
            return null;
        }
        await tx.update(savResolutionObservations).set({ hubspotTicketId: ticketId, leaseToken: token, leaseUntil: new Date(now.getTime() + 10 * 60 * 1000) }).where(eq(savResolutionObservations.id, id));
        return { ...row, hubspotTicketId: ticketId };
    });
    if (!claim)
        return { id, status: "waiting_or_leased" };
    let snapshot: ObservationSnapshot;
    try {
        snapshot = await collect(claim.hubspotTicketId);
        if (snapshot.ticketId !== claim.hubspotTicketId || !Number.isFinite(Date.parse(snapshot.updatedAt)))
            throw new Error("SAV_OBSERVATION_SOURCE_INVALID");
    }
    catch (error) {
        await db.update(savResolutionObservations).set({ state: "sources_incomplete", sourceErrors: [sourceError(error)], leaseToken: null, leaseUntil: null, nextSyncAt: nextDue(claim, now), updatedAt: now }).where(and(eq(savResolutionObservations.id, id), eq(savResolutionObservations.leaseToken, token)));
        return { id, status: "sources_incomplete" };
    }
    return db.transaction(async (tx) => {
        const [row] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, id)).for("update");
        if (!row || row.leaseToken !== token)
            return { id, status: "lease_lost" };
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId));
        if (thread?.hubspotTicketId && thread.hubspotTicketId !== snapshot.ticketId)
            throw new Error("SAV_OBSERVATION_LINK_CHANGED");
        const release = { leaseToken: null, leaseUntil: null, nextSyncAt: nextDue(row, now), updatedAt: now };
        if (row.remoteUpdatedAt && row.remoteUpdatedAt > new Date(snapshot.updatedAt)) {
            await tx.update(savResolutionObservations).set(release).where(eq(savResolutionObservations.id, id));
            return { id, status: "stale_source" };
        }
        const messages = await tx.select().from(savMessages).where(eq(savMessages.threadId, row.threadId)).orderBy(desc(savMessages.receivedAt)).limit(200);
        if (messages.length === 200)
            snapshot.errors.push("gmail:message_limit_200");
        const events: ObservationEvent[] = [...snapshot.events];
        for (const message of messages) {
            const body = decryptSavPayload<{
                text: string;
            }>(message.bodyCiphertext).text;
            if (body.length > 8000) snapshot.errors.push(`gmail:${message.gmailMessageId}:truncated_8000`);
            events.push({ fullContentHash: savContentHash(body), truncated: body.length > 8000, sourceRef: `gmail:${message.gmailMessageId}`, kind: message.direction === "inbound" ? "customer_reply" : isSavAiAuthoredReply(body) ? "ai_reply" : "human_reply", occurredAt: message.receivedAt.toISOString(), text: body.slice(0, 8000), author: message.fromEmail, provenance: "Gmail / fil lié synchronisé", associationTicketId: snapshot.ticketId, remoteUpdatedAt: null });
        }
        events.sort((a, b) => `${a.occurredAt}:${a.sourceRef}`.localeCompare(`${b.occurredAt}:${b.sourceRef}`));
        while (Buffer.byteLength(JSON.stringify(events), "utf8") > 64 * 1024) {
            events.shift();
            if (!snapshot.errors.includes("timeline:truncated_64k"))
                snapshot.errors.push("timeline:truncated_64k");
        }
        for (const event of events) {
            if (event.associationTicketId !== snapshot.ticketId || !Number.isFinite(Date.parse(event.occurredAt)))
                throw new Error("SAV_OBSERVATION_PROVENANCE_INVALID");
            await tx.insert(savObservationEvents).values({ observationId: id, sourceRef: event.sourceRef, contentHash: savContentHash(event), kind: event.kind, occurredAt: new Date(event.occurredAt), payloadCiphertext: encryptSavPayload(event) }).onConflictDoNothing();
        }
        const cycle = row.closed && snapshot.status === "open" ? row.cycle + 1 : row.cycle;
        const [verdict] = await tx.select().from(savDraftVerdicts).where(eq(savDraftVerdicts.id, row.verdictId));
        const rejected = decryptSavPayload<{
            body: string;
            proposal: {
                category: string;
                decision: {
                    reasonCode: string;
                };
            };
        }>(verdict.snapshotCiphertext);
        const [existing] = await tx.select().from(savObservationCycles).where(and(eq(savObservationCycles.observationId, id), eq(savObservationCycles.cycle, cycle)));
        const cycleStart = cycle > 1 ? existing?.createdAt ?? new Date(snapshot.updatedAt) : null;
        const relevant = events.filter(e => !cycleStart || new Date(e.occurredAt) >= cycleStart);
        const human = relevant.filter(e => e.kind === "human_reply" || e.kind === "note");
        const customerConfirmation = relevant.filter(e => e.kind === "customer_reply" && !/\b(pas|non|not|never|encore|toujours|plus|jamais)\b/i.test(e.text) && human.some(h => h.occurredAt < e.occurredAt) && /(?:^|[^a-zà-ÿ])(?:résolu|réglé|fonctionne|ça marche|resolved|works now)(?:$|[^a-zà-ÿ])/i.test(e.text));
        const refusalReasons = savStoredReviewReasons(decryptSavPayload<{ reasons?: unknown }>(verdict.reasonCiphertext).reasons);
        const summary = { subject: snapshot.subject, draftRefused: rejected.body, ...(refusalReasons.length ? { refusalReasons } : {}), refusalReason: decryptSavPayload<{
                text: string;
            }>(verdict.reasonCiphertext).text, category: rejected.proposal.category, reasonCode: rejected.proposal.decision.reasonCode,
            events: relevant, humanEvidence: human.map(e => ({ sourceRef: e.sourceRef, contentHash: savContentHash(e), kind: e.kind })), customerConfirmation: customerConfirmation.map(e => e.sourceRef), sourceErrors: snapshot.errors, coverage: "Emails HubSpot associés et fil Gmail synchronisé uniquement. Boîtes externes non enregistrées, appels et opérations hors CRM non observables. Une tâche terminée n’atteste pas une opération exécutée.", outcome: snapshot.errors.length || snapshot.status === "unknown" ? "insufficient_sources" : human.length ? "human_evidence_to_qualify" : "closed_without_human_evidence" };
        const hash = savContentHash(summary);
        const changed = existing?.sourceHash !== hash;
        if (changed && existing) await invalidateObservationCandidates(tx, `sav-observation:${existing.id}`);
        // A reopened cycle also invalidates the previous resolution, without erasing its history.
        if (cycle !== row.cycle) {
            const previous = await tx.select().from(savObservationCycles).where(and(eq(savObservationCycles.observationId, id), eq(savObservationCycles.cycle, row.cycle)));
            for (const old of previous) await invalidateObservationCandidates(tx, `sav-observation:${old.id}`);
        }
        const closed = snapshot.status === "closed";
        const status = snapshot.status === "unknown" ? "unknown" : closed ? "closed" : "open";
        const values = { status, summaryCiphertext: encryptSavPayload(summary), sourceHash: hash, closedAt: closed ? (existing?.closedAt ?? new Date(snapshot.updatedAt)) : null, updatedAt: now, ...(changed ? { qualification: null, qualifiedBy: null, qualifiedAt: null, candidateId: null } : {}) };
        const [savedCycle] = existing ? await tx.update(savObservationCycles).set(values).where(eq(savObservationCycles.id, existing.id)).returning() : await tx.insert(savObservationCycles).values({ ...values, observationId: id, cycle, ...(cycle > 1 ? { createdAt: new Date(snapshot.updatedAt) } : {}) }).returning();
        const closedCatchupUntil = snapshot.status === "open" ? null : closed ? (row.closedCatchupUntil ?? new Date(now.getTime() + DAY)) : row.closedCatchupUntil;
        release.nextSyncAt = nextDue({ closedCatchupUntil }, now);
        const state = snapshot.errors.length || snapshot.status === "unknown" ? "sources_incomplete" : closed ? savedCycle.candidateId ? "candidate_ready" : "closed_to_analyze" : "active";
        await tx.update(savResolutionObservations).set({ ...release, state, cycle, closedCatchupUntil, closed: snapshot.status === "unknown" ? row.closed : closed, remoteUpdatedAt: new Date(snapshot.updatedAt), lastSyncAt: now, sourceErrors: snapshot.errors }).where(eq(savResolutionObservations.id, id));
        await tx.insert(savTicketSnapshots).values({ hubspotTicketId: snapshot.ticketId, subject: snapshot.subject, status, transcriptCiphertext: encryptSavPayload({ transcript: events }), contentHash: hash, humanIntervened: human.length > 0, resolvedAt: closed ? new Date(snapshot.updatedAt) : null, hubspotUpdatedAt: new Date(snapshot.updatedAt), processedAt: now, updatedAt: now }).onConflictDoUpdate({ target: savTicketSnapshots.hubspotTicketId, set: { subject: snapshot.subject, status, transcriptCiphertext: encryptSavPayload({ transcript: events }), contentHash: hash, humanIntervened: human.length > 0, resolvedAt: closed ? new Date(snapshot.updatedAt) : null, hubspotUpdatedAt: new Date(snapshot.updatedAt), processedAt: now, updatedAt: now } });
        return { id, status: state, cycle };
    });
}
const qualification = z.object({ observationId: z.uuid(), cycleId: z.uuid(), sourceHash: z.string().length(43), outcome: z.enum(["resolved", "closed_without_resolution", "abandoned", "duplicate", "finance", "cancellation", "insufficient_sources"]), evidenceRef: z.string().max(300).default(""), evidenceHash: z.string().max(43).default(""), resolution: z.string().trim().max(10000).default(""), justification: z.string().trim().min(20).max(2000), customerConfirmationRef:z.string().max(300).default(""), unconfirmedAcknowledged: z.boolean().default(false) }).strict();
export async function qualifySavObservation(raw: unknown, actorEmail: string) {
    assertKnowledgeUgoApproval(actorEmail);
    const input = qualification.parse(raw);
    const db = requireDb();
    return db.transaction(async (tx) => {
        const [observation] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, input.observationId)).for("update");
        if(observation?.leaseUntil && observation.leaseUntil>new Date())throw new Error("SAV_OBSERVATION_SYNC_IN_PROGRESS");
        const [cycle] = await tx.select().from(savObservationCycles).where(and(eq(savObservationCycles.id, input.cycleId), eq(savObservationCycles.observationId, input.observationId)));
        if (!observation?.closed || cycle?.cycle !== observation.cycle || cycle.status !== "closed" || cycle.sourceHash !== input.sourceHash)
            throw new Error("SAV_OBSERVATION_STALE");
        const summary = decryptSavPayload<{
            subject: string;
            category: string;
            reasonCode: string;
            humanEvidence: Array<{
                sourceRef: string;
                contentHash: string;
                kind: string;
            }>;
            customerConfirmation: string[];
            sourceErrors: string[];
        }>(cycle.summaryCiphertext);
        let candidateId = cycle.candidateId;
        if (input.outcome === "resolved") {
            const proof = summary.humanEvidence.find(e => e.sourceRef === input.evidenceRef && e.contentHash === input.evidenceHash);
            if (observation.sourceErrors.length || summary.sourceErrors.length || !proof || input.resolution.length < 20 || (input.customerConfirmationRef ? !summary.customerConfirmation.includes(input.customerConfirmationRef) : !input.unconfirmedAcknowledged) || summary.category === "billing" || summary.reasonCode === "cancellation_human_only")
                throw new Error("SAV_OBSERVATION_QUALIFICATION_REQUIRED");
            const resolution = publicKnowledgeText(input.resolution);
            const justification = publicKnowledgeText(input.justification);
            const contentHash = savContentHash({ sourceHash: cycle.sourceHash, proof, resolution, justification, customerConfirmationRef:input.customerConfirmationRef });
            const values = { threadId: observation.threadId, hubspotTicketId: observation.hubspotTicketId, sourceRef: `sav-observation:${cycle.id}`, sourceContentHash: contentHash, proposedPatch: { ciphertext: encryptSavPayload({ subject: publicKnowledgeText(summary.subject), finalHumanResolution: resolution, sourceSnapshotId: `observation:${cycle.id}`, sourceMessageId: input.evidenceRef, provenance: "human_resolution", customerConfirmed: Boolean(input.customerConfirmationRef), qualificationBy: actorEmail, qualificationJustification: justification, sourceHash: cycle.sourceHash }) }, explanation: justification, evidenceTicketIds: observation.hubspotTicketId ? [observation.hubspotTicketId] : [], createdBy: "human" as const };
            const [previous] = await tx.select().from(savLearningCandidates).where(and(eq(savLearningCandidates.sourceRef, values.sourceRef), isNotNull(savLearningCandidates.contentItemId))).orderBy(desc(savLearningCandidates.createdAt), desc(savLearningCandidates.id)).limit(1);
            await tx.insert(savLearningCandidates).values({ ...values, contentItemId: previous?.contentItemId ?? null }).onConflictDoNothing();
            const [candidate] = await tx.select().from(savLearningCandidates).where(and(eq(savLearningCandidates.sourceRef, values.sourceRef), eq(savLearningCandidates.sourceContentHash, contentHash)));
            candidateId = candidate.id;
            await tx.update(savLearningCandidates).set({ contentItemId: candidate.contentItemId ?? previous?.contentItemId ?? null,
                ...(candidate.status === "rejected" ? { status: "pending" as const, reviewedBy: null, reviewedAt: null } : {}) }).where(eq(savLearningCandidates.id, candidate.id));
        }
        else
            candidateId = null;
        if (candidateId !== cycle.candidateId) await invalidateObservationCandidates(tx, `sav-observation:${cycle.id}`, candidateId ?? undefined);
        await tx.update(savObservationCycles).set({ candidateId, qualification: input.outcome, qualifiedBy: actorEmail, qualifiedAt: new Date() }).where(eq(savObservationCycles.id, cycle.id));
        await tx.update(savResolutionObservations).set({ state: candidateId ? "candidate_ready" : "closed_to_analyze" }).where(eq(savResolutionObservations.id, observation.id));
        const qualificationEvent:ObservationEvent={sourceRef:`qualification:${cycle.id}`,kind:"human_qualification",occurredAt:new Date().toISOString(),text:`Résultat : ${input.outcome}\nJustification : ${input.justification}\nPreuve : ${input.evidenceRef || "aucune"}`,author:actorEmail,provenance:"Qualification explicite Studio Ugo",associationTicketId:observation.hubspotTicketId!,remoteUpdatedAt:null};
        await tx.insert(savObservationEvents).values({observationId:observation.id,sourceRef:qualificationEvent.sourceRef,contentHash:savContentHash({input,actorEmail}),kind:qualificationEvent.kind,occurredAt:new Date(qualificationEvent.occurredAt),payloadCiphertext:encryptSavPayload(qualificationEvent)}).onConflictDoNothing();
        await tx.insert(auditLogs).values({ actorEmail, action: "sav_observation_qualified", entityType: "sav_observation_cycle", entityId: cycle.id, technicalMetadata: { sourceHash: cycle.sourceHash, outcome: input.outcome, candidateId } });
        return { candidateId };
    });
}
export async function getSavObservations(threadId: string) {
    const rows = await requireDb().select().from(savResolutionObservations).where(eq(savResolutionObservations.threadId, threadId)).orderBy(desc(savResolutionObservations.createdAt));
    const result = [];
    for (const row of rows) {
        const cycles = await requireDb().select().from(savObservationCycles).where(eq(savObservationCycles.observationId, row.id)).orderBy(desc(savObservationCycles.cycle));
        const qualifications=await requireDb().select().from(savObservationEvents).where(and(eq(savObservationEvents.observationId,row.id),eq(savObservationEvents.kind,"human_qualification"))).orderBy(desc(savObservationEvents.occurredAt)).limit(50);
        result.push({ ...row,qualifications:qualifications.map(e=>decryptSavPayload<ObservationEvent>(e.payloadCiphertext)), cycles: cycles.map(c => ({ ...c, summary: decryptSavPayload<{
                    subject: string;
                    draftRefused: string;
                    refusalReason: string;
                    refusalReasons?: SavReviewReason[];
                    events: ObservationEvent[];
                    humanEvidence: Array<{
                        sourceRef: string;
                        contentHash: string;
                        kind: string;
                    }>;
                    customerConfirmation: string[];
                    coverage: string;
                    outcome: string;
                }>(c.summaryCiphertext) })) });
    }
    return result;
}
