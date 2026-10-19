import { isSavCaseLearningFrozen } from "./config";
import { savV0EligibleMessageFilter } from "./cutover";
import { measureSavCase, explicitCustomerConfirmation, observedResolutionEvidence } from "./case-comparison";
import type { SavStructuredProposal } from "./proposal";
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savActions, savProposalReviews, savAnalysisSnapshots, auditLogs, knowledgeFamilySources, knowledgeProjectionCandidates, savDraftVerdicts, savLearningCandidates, savResolutionEvidence, savMessages, savObservationCycles, savObservationEvents, savResolutionObservations, savThreads, savTicketSnapshots } from "@/db/schema";
import { assertKnowledgeUgoApproval } from "@/lib/knowledge/contracts";
import { publicKnowledgeText } from "@/lib/knowledge/conversion";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { isSavAiAuthoredReply } from "./reply-format";
import { collectSavObservationSources, type ObservationEvent, type ObservationSnapshot } from "./observation-source";
import { savStoredReviewReasons, type SavReviewReason } from "./review-contract";
import { processSavLearningResolution, savLearningMaterialText } from "./learning-pipeline";
import { closeSavLearningReservationTx } from "./learning-admission";
const DAY = 24 * 60 * 60 * 1000;
// Keep closed cases observable for late evidence and reopenings until normal
// terminal-dossier retention removes them. Closing alone is not resolution.
function nextDue(now: Date) { return new Date(now.getTime() + DAY); }
/** Invalidate dependent approvals but retain every candidate/version/event as history. */
async function invalidateObservationCandidates(tx: Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0], sourceRef: string, exceptId?: string) {
    const candidates = await tx.select().from(savLearningCandidates).where(eq(savLearningCandidates.sourceRef, sourceRef));
    for (const candidate of candidates) {
        if (candidate.id === exceptId || candidate.status === "rejected") continue;
        await tx.update(savLearningCandidates).set({ status: "rejected", rejectionKind: "superseded", explanation: `${candidate.explanation}\nPreuves actualisées : qualification antérieure devenue obsolète.` }).where(eq(savLearningCandidates.id, candidate.id));
        await closeSavLearningReservationTx(tx, candidate.id);
        if (candidate.contentItemId) await tx.update(savResolutionEvidence).set({ outcome: "superseded", weight: 0 }).where(and(eq(savResolutionEvidence.sourceRef, sourceRef), eq(savResolutionEvidence.itemId, candidate.contentItemId)));
        const sources = await tx.select().from(knowledgeFamilySources).where(or(eq(knowledgeFamilySources.sourceRef, `sav-learning:${candidate.id}`), sql`${knowledgeFamilySources.evidence}->>'learningCandidateId' = ${candidate.id}`));
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
export async function reconcileSavObservations(limit = 5, now = new Date(), options:{deadlineMs?:number;maxComparisons?:number}={}) {
    const due = await requireDb().select({ id: savResolutionObservations.id }).from(savResolutionObservations).where(and(lte(savResolutionObservations.nextSyncAt, now), or(isNull(savResolutionObservations.leaseUntil), lte(savResolutionObservations.leaseUntil, now)))).orderBy(asc(savResolutionObservations.nextSyncAt), asc(savResolutionObservations.id)).limit(Math.min(20, Math.max(1, limit)));
    const results = [];
    const workDeadline=options.deadlineMs??Date.now()+40000;
    const deadline = Math.min(workDeadline,Date.now() + 20000);const collect=cachedCollector();
    for (const row of due) {
        if (Date.now()+12000 > deadline)
            break;
        results.push(await syncSavObservation(row.id, collect, now));

    }
    const ready=await requireDb().select({id:savResolutionObservations.id}).from(savResolutionObservations)
      .innerJoin(savObservationCycles,and(eq(savObservationCycles.observationId,savResolutionObservations.id),eq(savObservationCycles.cycle,savResolutionObservations.cycle)))
      .innerJoin(savThreads,eq(savThreads.id,savResolutionObservations.threadId)).innerJoin(savMessages,eq(savMessages.id,savResolutionObservations.messageId))
      .where(and(eq(savResolutionObservations.closed,true),eq(savThreads.aiPaused,false),savV0EligibleMessageFilter(),sql`jsonb_array_length(${savResolutionObservations.sourceErrors})=0`,
        or(isNull(savResolutionObservations.leaseUntil),lte(savResolutionObservations.leaseUntil,now)),or(isNull(savObservationCycles.qualification),eq(savObservationCycles.qualification,"evidence_observed")),
        or(isNull(savObservationCycles.learningDisposition),inArray(savObservationCycles.learningDisposition,["open_limit","weekly_limit"])),isNull(savObservationCycles.candidateId)))
      .orderBy(asc(savObservationCycles.updatedAt)).limit(options.maxComparisons===0?0:20);
    const comparisons=[];
    for(const row of ready){
      if(comparisons.length>=Math.min(1,options.maxComparisons??1)||Date.now()+19000>workDeadline)break;
      const result=await prepareSavObservationLearning(row.id,now);
      if(result.disposition!=="not_evaluable")comparisons.push(result);
    }
    return { processed: results,comparisons,deferred:ready.length>comparisons.length };
}
export async function syncSavObservation(id: string, collect: (id: string) => Promise<ObservationSnapshot> = collectSavObservationSources, now = new Date()) {
    if(isSavCaseLearningFrozen())return {id,status:"frozen"};
    const db = requireDb();
    const token = randomUUID();
    const claim = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, id)).for("update");
        if (!row || row.leaseUntil && row.leaseUntil > now)
            return null;
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId));
        // The application's confirmed link is the only binding authority. No contact search.
        const ticketId = thread?.hubspotTicketId ?? row.hubspotTicketId;
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
        snapshot = claim.hubspotTicketId ? await collect(claim.hubspotTicketId) : {ticketId:`gmail:${claim.threadId}`,updatedAt:now.toISOString(),status:"open",subject:"Fil Gmail autorisé",events:[],errors:["gmail:outbound_coverage_unverified"]};
        if (snapshot.ticketId !== (claim.hubspotTicketId ?? `gmail:${claim.threadId}`) || !Number.isFinite(Date.parse(snapshot.updatedAt)))
            throw new Error("SAV_OBSERVATION_SOURCE_INVALID");
    }
    catch (error) {
        await db.update(savResolutionObservations).set({ state: "sources_incomplete", sourceErrors: [sourceError(error)], leaseToken: null, leaseUntil: null, nextSyncAt: nextDue(now), updatedAt: now }).where(and(eq(savResolutionObservations.id, id), eq(savResolutionObservations.leaseToken, token)));
        return { id, status: "sources_incomplete" };
    }
    return db.transaction(async (tx) => {
        const [row] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, id)).for("update");
        if (!row || row.leaseToken !== token)
            return { id, status: "lease_lost" };
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId));
        if (thread?.hubspotTicketId && thread.hubspotTicketId !== snapshot.ticketId)
            throw new Error("SAV_OBSERVATION_LINK_CHANGED");
        const release = { leaseToken: null, leaseUntil: null, nextSyncAt: nextDue(now), updatedAt: now };
        if (row.remoteUpdatedAt && row.remoteUpdatedAt > new Date(snapshot.updatedAt)) {
            await tx.update(savResolutionObservations).set(release).where(eq(savResolutionObservations.id, id));
            return { id, status: "stale_source" };
        }
        const messages = await tx.select().from(savMessages).where(eq(savMessages.threadId, row.threadId)).orderBy(desc(savMessages.receivedAt)).limit(200);
        if (messages.length === 200)
            snapshot.errors.push("gmail:message_limit_200");
        const events: ObservationEvent[] = [...snapshot.events];
        for (const message of messages) {
            const storedBody=decryptSavPayload<{text:string;headers?:Record<string,string>}>(message.bodyCiphertext);
            const body=storedBody.text;
            if (body.length > 8000) snapshot.errors.push(`gmail:${message.gmailMessageId}:truncated_8000`);
            events.push({ ...(storedBody.headers?.["message-id"]?{messageIdentity:storedBody.headers["message-id"].trim().toLowerCase()}:{}), fullContentHash: savContentHash(body), truncated: body.length > 8000, sourceRef: `gmail:${message.gmailMessageId}`, kind: message.direction === "inbound" ? "customer_reply" : isSavAiAuthoredReply(body) ? "ai_reply" : "human_reply", occurredAt: message.receivedAt.toISOString(), text: body.slice(0, 8000), author: message.fromEmail, provenance: "Gmail / fil lié synchronisé", associationTicketId: snapshot.ticketId, remoteUpdatedAt: null });
        }
        const reviewRows=messages.length?await tx.select().from(savProposalReviews).where(inArray(savProposalReviews.messageId,messages.map(m=>m.id))).orderBy(asc(savProposalReviews.reviewedAt)).limit(201):[];
        if(reviewRows.length>200)snapshot.errors.push("studio:review_limit_200");
        for(const review of reviewRows.slice(0,200)){
            const before=decryptSavPayload<Record<string,unknown>>(review.beforeCiphertext),after=decryptSavPayload<Record<string,unknown>>(review.afterCiphertext);
            const changes=Object.fromEntries(Object.keys(after).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])).map(key=>[key,{before:before[key]??null,after:after[key]??null}]));
            const comment=decryptSavPayload<{text:string;justification?:string}>(review.commentCiphertext);
            const text=JSON.stringify({messageId:review.messageId,agentRunId:review.agentRunId,scope:review.reviewScope,status:review.status,verdict:review.verdict,dimensions:review.dimensions,changes,comment:comment.text,justification:comment.justification??null});
            if(text.length>8000)snapshot.errors.push("studio:review_truncated_8000");
            events.push({sourceRef:`studio:review:${review.id}`,kind:"dossier_review",occurredAt:review.reviewedAt.toISOString(),text:text.slice(0,8000),author:review.reviewedBy,provenance:"Studio / correction humaine, à examiner sans présumer sa justesse",associationTicketId:snapshot.ticketId,remoteUpdatedAt:null,fullContentHash:savContentHash(text),truncated:text.length>8000});
        }
        const confirmedActions=await tx.select().from(savActions).where(and(eq(savActions.threadId,row.threadId),eq(savActions.actorType,"human"),eq(savActions.status,"succeeded"))).orderBy(asc(savActions.executedAt)).limit(201);
        if(confirmedActions.length>200)snapshot.errors.push("studio:action_limit_200");
        for(const action of confirmedActions.slice(0,200))events.push({sourceRef:`studio:action:${action.id}`,kind:"action_confirmed",occurredAt:(action.executedAt??action.updatedAt).toISOString(),text:JSON.stringify({kind:action.kind,messageId:action.messageId,decisionId:action.decisionId,ticketId:action.payload.hubspotTicketId??null,ticketReturnCompletedAt:action.payload.ticketReturnCompletedAt??null}),author:action.actorEmail,provenance:"Studio / résultat fournisseur confirmé dans le journal d’action",associationTicketId:snapshot.ticketId,remoteUpdatedAt:null});
        const identities=new Map<string,ObservationEvent>();
        for(let index=events.length-1;index>=0;index--){const event=events[index];if(!event.messageIdentity)continue;const previous=identities.get(event.messageIdentity);if(previous){previous.sourceAliases=[...(previous.sourceAliases??[]),event.sourceRef];events.splice(index,1);}else identities.set(event.messageIdentity,event);}
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
        const [verdict] = row.verdictId ? await tx.select().from(savDraftVerdicts).where(eq(savDraftVerdicts.id,row.verdictId)) : [];
        const [baseline] = row.snapshotId ? await tx.select().from(savAnalysisSnapshots).where(eq(savAnalysisSnapshots.id,row.snapshotId)) : [];
        const baselinePayload=baseline ? decryptSavPayload<{proposal:SavStructuredProposal;analysisCreatedAt:string}>(baseline.payloadCiphertext) : null;
        const rejected=verdict ? decryptSavPayload<{body:string;proposal:SavStructuredProposal}>(verdict.snapshotCiphertext) : {body:baselinePayload?.proposal.replyDraft??"",proposal:baselinePayload?.proposal??null};
        const [existing] = await tx.select().from(savObservationCycles).where(and(eq(savObservationCycles.observationId, id), eq(savObservationCycles.cycle, cycle)));
        const cycleStart = cycle > 1 ? existing?.createdAt ?? new Date(snapshot.updatedAt) : null;
        const relevant = events.filter(e => !cycleStart || new Date(e.occurredAt) >= cycleStart);
        const human = relevant.filter(e => e.kind === "human_reply" || e.kind === "note");
        const lastCustomer=relevant.filter(e=>e.kind==="customer_reply").at(-1);
        const customerConfirmation = lastCustomer&&explicitCustomerConfirmation(lastCustomer.text)&&human.some(h=>h.occurredAt<lastCustomer.occurredAt)?[lastCustomer]:[];
        const refusalReasons=verdict?savStoredReviewReasons(decryptSavPayload<{reasons?:unknown}>(verdict.reasonCiphertext).reasons):[];
        const measurements=measureSavCase(rejected.proposal,relevant,{ticketId:row.hubspotTicketId,closed:snapshot.status==="closed",errors:snapshot.errors,baselineAt:baselinePayload?.analysisCreatedAt??row.createdAt.toISOString(),cycle});
        const summary = { subject: snapshot.subject, draftRefused: rejected.body, ...(refusalReasons.length ? { refusalReasons } : {}), refusalReason: verdict?decryptSavPayload<{text:string}>(verdict.reasonCiphertext).text:"", category: rejected.proposal?.category??"unknown", reasonCode: rejected.proposal?.decision.reasonCode??"unknown", measurements:{revision:measurements.revision,axes:measurements.axes,coverage:measurements.coverage}, baselineProposal:rejected.proposal, baselineAt:baselinePayload?.analysisCreatedAt??row.createdAt.toISOString(),
            events: relevant, humanEvidence: human.map(e => ({ sourceRef: e.sourceRef, contentHash: savContentHash(e), kind: e.kind, occurredAt: e.occurredAt })), customerConfirmation: customerConfirmation.map(e => e.sourceRef), sourceErrors: snapshot.errors, coverage: "Emails HubSpot associés et fil Gmail synchronisé uniquement. Boîtes externes non enregistrées, appels et opérations hors CRM non observables. Une tâche terminée n’atteste pas une opération exécutée.", outcome: snapshot.errors.length || snapshot.status === "unknown" ? "insufficient_sources" : human.length ? "human_evidence_to_qualify" : "closed_without_human_evidence" };
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
        const values = { status, summaryCiphertext: encryptSavPayload(summary), sourceHash: hash, closedAt: closed ? (existing?.closedAt ?? new Date(snapshot.updatedAt)) : null, updatedAt: now, ...(changed ? { qualification: null, qualifiedBy: null, qualifiedAt: null, candidateId: null, learningDisposition: null } : {}) };
        const [savedCycle] = existing ? await tx.update(savObservationCycles).set(values).where(eq(savObservationCycles.id, existing.id)).returning() : await tx.insert(savObservationCycles).values({ ...values, observationId: id, cycle, ...(cycle > 1 ? { createdAt: new Date(snapshot.updatedAt) } : {}) }).returning();
        const closedCatchupUntil = snapshot.status === "open" ? null : closed ? (row.closedCatchupUntil ?? new Date(now.getTime() + DAY)) : row.closedCatchupUntil;
        release.nextSyncAt = nextDue(now);
        const state = !row.hubspotTicketId ? "gmail_only" : snapshot.errors.length || snapshot.status === "unknown" ? "sources_incomplete" : closed ? savedCycle.candidateId ? "candidate_ready" : "closed_to_analyze" : "active";
        await tx.update(savResolutionObservations).set({ ...release, state, cycle, closedCatchupUntil, closed: snapshot.status === "unknown" ? row.closed : closed, remoteUpdatedAt: new Date(snapshot.updatedAt), lastSyncAt: now, sourceErrors: snapshot.errors }).where(eq(savResolutionObservations.id, id));
        if(row.hubspotTicketId) await tx.insert(savTicketSnapshots).values({ hubspotTicketId: snapshot.ticketId, subject: snapshot.subject, status, transcriptCiphertext: encryptSavPayload({ transcript: events }), contentHash: hash, humanIntervened: human.length > 0, resolvedAt: closed ? new Date(snapshot.updatedAt) : null, hubspotUpdatedAt: new Date(snapshot.updatedAt), processedAt: now, updatedAt: now }).onConflictDoUpdate({ target: savTicketSnapshots.hubspotTicketId, set: { subject: snapshot.subject, status, transcriptCiphertext: encryptSavPayload({ transcript: events }), contentHash: hash, humanIntervened: human.length > 0, resolvedAt: closed ? new Date(snapshot.updatedAt) : null, hubspotUpdatedAt: new Date(snapshot.updatedAt), processedAt: now, updatedAt: now } });
        return { id, status: state, cycle };
    });
}
const qualification = z.object({ observationId: z.uuid(), cycleId: z.uuid(), sourceHash: z.string().length(43), outcome: z.enum(["resolved", "closed_without_resolution", "abandoned", "duplicate", "finance", "cancellation", "insufficient_sources"]), evidenceRef: z.string().max(300).default(""), evidenceHash: z.string().max(43).default(""), resolution: z.string().trim().max(10000).default(""), justification: z.string().trim().min(20).max(2000), customerConfirmationRef:z.string().max(300).default(""), unconfirmedAcknowledged: z.boolean().default(false) }).strict();
export async function qualifySavObservation(raw: unknown, actorEmail: string) {
    assertKnowledgeUgoApproval(actorEmail);
    const input = qualification.parse(raw);
    const db = requireDb();
    const result = await db.transaction(async (tx) => {
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
                occurredAt?: string;
            }>;
            customerConfirmation: string[];
            sourceErrors: string[];
        }>(cycle.summaryCiphertext);
        let candidateId = cycle.candidateId;
        let pipeline: null | { ticketId: string; threadId: string; observationId: string; cycleId: string; evidenceOccurredAt: string; sourceRef: string; cycleStartedAt: Date; subject: string; resolution: string; evidenceRef: string; sourceHash: string; cycleSourceHash: string; customerConfirmed: boolean } = null;
        if (input.outcome === "resolved") {
            const proof = summary.humanEvidence.find(e => e.sourceRef === input.evidenceRef && e.contentHash === input.evidenceHash);
            if (observation.sourceErrors.length || summary.sourceErrors.length || !proof || input.resolution.length < 20 || (input.customerConfirmationRef ? !summary.customerConfirmation.includes(input.customerConfirmationRef) : !input.unconfirmedAcknowledged) || summary.category === "billing" || summary.reasonCode === "cancellation_human_only")
                throw new Error("SAV_OBSERVATION_QUALIFICATION_REQUIRED");
            const resolution = publicKnowledgeText(input.resolution);
            const justification = publicKnowledgeText(input.justification);
            const contentHash = savContentHash({ sourceHash: cycle.sourceHash, proof, resolution, justification, customerConfirmationRef:input.customerConfirmationRef });
            const [existingCandidate] = cycle.candidateId ? await tx.select().from(savLearningCandidates).where(eq(savLearningCandidates.id, cycle.candidateId)) : [];
            let sameQualification = false;
            if (existingCandidate?.status === "pending" && typeof existingCandidate.proposedPatch.ciphertext === "string") {
                try {
                    const patch = decryptSavPayload<{ cycleSourceHash?: string; finalHumanResolution: string; sourceMessageId: string; customerConfirmed: boolean }>(existingCandidate.proposedPatch.ciphertext);
                    sameQualification = patch.cycleSourceHash === cycle.sourceHash && savLearningMaterialText(patch.finalHumanResolution) === savLearningMaterialText(resolution) && patch.sourceMessageId === input.evidenceRef && patch.customerConfirmed === Boolean(input.customerConfirmationRef);
                } catch { /* invalid ciphertext cannot be reused */ }
            }
            if (sameQualification) candidateId = cycle.candidateId;
            else {
                candidateId = null;
                pipeline = { ticketId: observation.hubspotTicketId!, threadId: observation.threadId, observationId: observation.id, cycleId: cycle.id, evidenceOccurredAt: proof.occurredAt ?? "invalid", sourceRef: `sav-observation:${cycle.id}`, cycleStartedAt: cycle.createdAt,
                    subject: summary.subject, resolution, evidenceRef: input.evidenceRef, sourceHash: contentHash, cycleSourceHash: cycle.sourceHash,
                    customerConfirmed: Boolean(input.customerConfirmationRef) };
            }
        }
        else
            candidateId = null;
        if (candidateId !== cycle.candidateId) await invalidateObservationCandidates(tx, `sav-observation:${cycle.id}`, candidateId ?? undefined);
        await tx.update(savObservationCycles).set({ candidateId, learningDisposition: null, qualification: input.outcome, qualifiedBy: actorEmail, qualifiedAt: new Date() }).where(eq(savObservationCycles.id, cycle.id));
        await tx.update(savResolutionObservations).set({ state: candidateId ? "candidate_ready" : "closed_to_analyze" }).where(eq(savResolutionObservations.id, observation.id));
        const qualificationEvent:ObservationEvent={sourceRef:`qualification:${cycle.id}`,kind:"human_qualification",occurredAt:new Date().toISOString(),text:`Résultat : ${input.outcome}\nJustification : ${input.justification}\nPreuve : ${input.evidenceRef || "aucune"}`,author:actorEmail,provenance:"Qualification explicite Studio Ugo",associationTicketId:observation.hubspotTicketId!,remoteUpdatedAt:null};
        await tx.insert(savObservationEvents).values({observationId:observation.id,sourceRef:qualificationEvent.sourceRef,contentHash:savContentHash({input,actorEmail}),kind:qualificationEvent.kind,occurredAt:new Date(qualificationEvent.occurredAt),payloadCiphertext:encryptSavPayload(qualificationEvent)}).onConflictDoNothing();
        await tx.insert(auditLogs).values({ actorEmail, action: "sav_observation_qualified", entityType: "sav_observation_cycle", entityId: cycle.id, technicalMetadata: { sourceHash: cycle.sourceHash, outcome: input.outcome, candidateId } });
        return { candidateId, pipeline };
    });
    if (!result.pipeline) return { candidateId: result.candidateId };
    const evaluated = await processSavLearningResolution({
        ticketId: result.pipeline.ticketId, threadId: result.pipeline.threadId, observationId: result.pipeline.observationId, cycleId: result.pipeline.cycleId, evidenceOccurredAt: result.pipeline.evidenceOccurredAt, sourceRef: result.pipeline.sourceRef, origin: "observation",
        cycleStartedAt: result.pipeline.cycleStartedAt, snapshotId: result.pipeline.sourceHash,
        snapshotHash: result.pipeline.sourceHash, subject: result.pipeline.subject, resolution: result.pipeline.resolution,
        provenance: "human_resolution", sourceMessageId: result.pipeline.evidenceRef, evidenceRef: result.pipeline.evidenceRef,
        evidenceExcerpt: result.pipeline.resolution.slice(0, 240), customerConfirmed: result.pipeline.customerConfirmed,
        cycleSourceHash: result.pipeline.cycleSourceHash,
    });
    const candidateId = evaluated && typeof evaluated === "object" && "candidateId" in evaluated && typeof evaluated.candidateId === "string" ? evaluated.candidateId : null;
    await db.transaction(async (tx) => {
        const [current] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, input.observationId)).for("update");
        const [cycle] = await tx.select().from(savObservationCycles).where(eq(savObservationCycles.id, input.cycleId));
        if (!current?.closed || current.cycle !== cycle?.cycle || cycle?.sourceHash !== result.pipeline!.cycleSourceHash || cycle.qualification !== "resolved") return;
        const disposition = "reasonCode" in evaluated ? String(evaluated.reasonCode) : evaluated.disposition;
        await tx.update(savObservationCycles).set({ candidateId, learningDisposition: disposition }).where(eq(savObservationCycles.id, input.cycleId));
        await tx.update(savResolutionObservations).set({ state: candidateId ? "candidate_ready" : "qualified_without_candidate" }).where(eq(savResolutionObservations.id, input.observationId));
    });
    return { candidateId };
}
export async function getSavObservations(threadId: string) {
    const rows = await requireDb().select().from(savResolutionObservations).where(eq(savResolutionObservations.threadId, threadId)).orderBy(desc(savResolutionObservations.createdAt));
    const result = [];
    for (const row of rows) {
        const cycles = await requireDb().select().from(savObservationCycles).where(eq(savObservationCycles.observationId, row.id)).orderBy(desc(savObservationCycles.cycle));
        const qualifications=await requireDb().select().from(savObservationEvents).where(and(eq(savObservationEvents.observationId,row.id),eq(savObservationEvents.kind,"human_qualification"))).orderBy(desc(savObservationEvents.occurredAt)).limit(50);
        const comparisonRows=await requireDb().select().from(savObservationEvents).where(and(eq(savObservationEvents.observationId,row.id),eq(savObservationEvents.kind,"case_comparison"))).orderBy(desc(savObservationEvents.occurredAt)).limit(20);
        result.push({ ...row,comparisons:comparisonRows.map(event=>decryptSavPayload<{revision:string;sourceHash:string;inputTokens:number|null;outputTokens:number|null;durationMs:number;decision:import("./learning-comparator").SavLearningComparison}>(event.payloadCiphertext)),qualifications:qualifications.map(e=>decryptSavPayload<ObservationEvent>(e.payloadCiphertext)), cycles: cycles.map(c => ({ ...c, summary: decryptSavPayload<{
                    measurements?:ReturnType<typeof measureSavCase>;
                    baselineProposal?:SavStructuredProposal|null;
                    subject: string;
                    draftRefused: string;
                    refusalReason: string;
                    refusalReasons?: SavReviewReason[];
                    events: ObservationEvent[];
                    humanEvidence: Array<{
                        sourceRef: string;
                        contentHash: string;
                        kind: string;
                occurredAt?: string;
                    }>;
                    customerConfirmation: string[];
                    coverage: string;
                    outcome: string;
                }>(c.summaryCiphertext) })) });
    }
    return result;
}

/** Automatic preparation only. Human knowledge review/publication remains the
 * existing gate. A source observation never becomes a human resolution verdict. */
export async function prepareSavObservationLearning(id:string,now=new Date(),options:Parameters<typeof processSavLearningResolution>[1]={}) {
 if(isSavCaseLearningFrozen())return {disposition:"frozen"};
 const db=requireDb();
 const prepared=await db.transaction(async tx=>{
  const [row]=await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id,id)).for("update");
  if(!row?.closed||row.sourceErrors.length||row.leaseUntil&&row.leaseUntil>now)return null;
  const [thread]=await tx.select({paused:savThreads.aiPaused}).from(savThreads).where(eq(savThreads.id,row.threadId));
  const [eligible]=await tx.select({id:savMessages.id}).from(savMessages).where(and(eq(savMessages.id,row.messageId),savV0EligibleMessageFilter()));
  if(thread?.paused || !eligible || process.env.SAV_AI_ANALYSIS==="false") return null;
  const [cycle]=await tx.select().from(savObservationCycles).where(and(eq(savObservationCycles.observationId,id),eq(savObservationCycles.cycle,row.cycle)));
  if(!cycle||cycle.candidateId||cycle.qualification&&cycle.qualification!=="evidence_observed"||cycle.learningDisposition&&!["open_limit","weekly_limit"].includes(cycle.learningDisposition))return null;
  const summary=decryptSavPayload<{subject:string;category:string;reasonCode:string;events:ObservationEvent[];baselineProposal:SavStructuredProposal|null;baselineAt:string;sourceErrors:string[]}>(cycle.summaryCiphertext);
  if(summary.sourceErrors.length||summary.category==="billing"||/cancellation|refund|legal|security/.test(summary.reasonCode)){
    await tx.update(savObservationCycles).set({learningDisposition:summary.sourceErrors.length?"source_coverage_incomplete":"sensitive_review_required"}).where(eq(savObservationCycles.id,cycle.id));return null;
  }
  const proof=observedResolutionEvidence(summary.events.filter(e=>e.occurredAt>=(summary.baselineAt??row.createdAt.toISOString())),summary.baselineProposal??null);
  if(!proof){await tx.update(savObservationCycles).set({learningDisposition:"insufficient_independent_evidence"}).where(eq(savObservationCycles.id,cycle.id));return null;}
  await tx.update(savObservationCycles).set({qualification:"evidence_observed",qualifiedBy:null,qualifiedAt:null}).where(eq(savObservationCycles.id,cycle.id));
  return {row,cycle,summary,proof};
 });
 if(!prepared)return {disposition:"not_evaluable"};
 const {row,cycle,summary,proof}=prepared;
 let result:Awaited<ReturnType<typeof processSavLearningResolution>>;
 try { result=await processSavLearningResolution({ticketId:row.hubspotTicketId??undefined,threadId:row.threadId,sourceRef:`sav-observation:${cycle.id}`,origin:"observation",cycleStartedAt:cycle.createdAt,snapshotId:cycle.id,snapshotHash:cycle.sourceHash,subject:summary.subject,resolution:proof.text,provenance:"observed_treatment",sourceMessageId:proof.sourceRef,evidenceRef:proof.sourceRef,evidenceExcerpt:proof.text.slice(0,240),evidenceOccurredAt:proof.occurredAt,customerConfirmed:explicitCustomerConfirmation(summary.events.filter(e=>e.kind==="customer_reply"&&e.occurredAt>proof.occurredAt).at(-1)?.text??""),cycleSourceHash:cycle.sourceHash,observationId:row.id,cycleId:cycle.id,caseContext:{baseline:summary.baselineProposal,baselineAt:summary.baselineAt,events:summary.events}},{...options,now});
 } catch(error) {if(error instanceof Error && error.message==="SAV_DERIVED_DAILY_BUDGET_EXHAUSTED") {await db.update(savResolutionObservations).set({state:"waiting_budget"}).where(eq(savResolutionObservations.id,id));return {disposition:"deferred",reasonCode:"daily_budget"};}throw error;}
 if(result.disposition==="duplicate" && !result.candidateId && result.reasonCode==="comparison_started") return result;
 const candidateId="candidateId" in result&&typeof result.candidateId==="string"?result.candidateId:null;
 await db.transaction(async tx=>{
  const [current]=await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id,id)).for("update");
  const [currentCycle]=await tx.select().from(savObservationCycles).where(eq(savObservationCycles.id,cycle.id));
  if(!current?.closed||current.cycle!==cycle.cycle||currentCycle?.sourceHash!==cycle.sourceHash)return;
  await tx.update(savObservationCycles).set({candidateId,learningDisposition:"reasonCode" in result?String(result.reasonCode):result.disposition}).where(eq(savObservationCycles.id,cycle.id));
  await tx.update(savResolutionObservations).set({state:candidateId?"candidate_ready":"observed_without_candidate"}).where(eq(savResolutionObservations.id,id));
 });
 return result;
}
