import "server-only";
import { and, count, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, contentItems, contentVersions, knowledgeProjectionCandidates, savKnowledgeActivations, savLearningAdmissionAttempts, savLearningAdmissionCases, savLearningCandidates, savObservationCycles, savObservationEvents, savResolutionObservations } from "@/db/schema";
import { knowledgeComparisonInventory } from "@/lib/knowledge/hubspot-import";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { redactSavLearningText } from "./learning-extraction";
import { SAV_LEARNING_POLICY_REVISION, bindSavLearningReservationTx, claimSavLearningComparisonTx, assertSavLearningComparisonClaimTx, releaseSavLearningComparisonTx, finishSavLearningComparisonTx, getSavLearningCutover, isSavLearningCycleEligible, lockSavLearningAdmissionTx, recordSavLearningSignal, reserveSavLearningCapacityTx, reserveSavLearningModelCallTx } from "./learning-admission";
import { compareSavLearningResolution, validateSavLearningComparison, SAV_LEARNING_COMPARATOR_PROMPT_REVISION, SAV_LEARNING_COMPARATOR_REVISION, type SavLearningComparisonInput } from "./learning-comparator";
import { isSavCaseLearningFrozen, savGeminiApiKey } from "./config";
import { isSavCrmLearningSourceCurrent } from "./learning-source";

type Db = ReturnType<typeof requireDb>;
type LearningPatch = { subject: string; finalHumanResolution: string; sourceSnapshotId: string; sourceSnapshotHash?: string; sourceCycleStartedAt?: string; cycleSourceHash?: string; provenance: "human_resolution"|"observed_treatment"; customerConfirmed: boolean; sourceMessageId: string; conditions: string[]; expectedResult: string; limitations: string[]; groupSignature?: string; comparisonSnapshot?: string };
function safeText(value: string, max: number) { return redactSavLearningText(value).replace(/\s+/g, " ").trim().slice(0, max); }
export function savLearningMaterialText(value: string) { return safeText(value, 4000).normalize("NFKC").toLocaleLowerCase("fr").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
export function savLearningProofHash(input: { sourceRef: string; cycleStartedAt: Date | string; evidenceRef: string; sourceMessageId: string; resolution: string; customerConfirmed: boolean }) {
  return savContentHash({ sourceRef: input.sourceRef, cycleStartedAt: new Date(input.cycleStartedAt).toISOString(), evidenceRef: input.evidenceRef, sourceMessageId: input.sourceMessageId, normalizedResolution: savLearningMaterialText(input.resolution), customerConfirmed: input.customerConfirmed });
}
async function comparisonContext(db: Pick<Db, "select"> = requireDb()) {
  const inventory = await knowledgeComparisonInventory(db, "sav");
  // Never silently hide part of the catalogue from the comparator.
  if (inventory.length > 100) throw new Error("SAV_LEARNING_COMPARATOR_CONTEXT_INCOMPLETE");
  const rows = await db.select().from(savLearningCandidates).where(and(
    or(isNotNull(savLearningCandidates.admissionGroupKey), eq(savLearningCandidates.createdBy, "human")),
    or(isNull(savLearningCandidates.rejectionKind), ne(savLearningCandidates.rejectionKind, "superseded")),
  )).orderBy(savLearningCandidates.id).limit(101);
  return buildComparisonContext(inventory, rows);
}
async function buildComparisonContext(inventory: Awaited<ReturnType<typeof knowledgeComparisonInventory>>, rows: Array<typeof savLearningCandidates.$inferSelect>) {
  const openCandidates: SavLearningComparisonInput["openCandidates"] = [], priorRejections: NonNullable<SavLearningComparisonInput["priorRejections"]> = [];
  for (const row of rows) {
    if (row.rejectionKind === "superseded") continue;
    if (typeof row.proposedPatch.ciphertext !== "string") throw new Error("SAV_LEARNING_COMPARATOR_CONTEXT_INCOMPLETE");
    const patch = decryptSavPayload<LearningPatch>(row.proposedPatch.ciphertext);
    const common = { ref: "candidate:" + row.id, groupKey: row.admissionGroupKey, subject: safeText(patch.subject, 300), resolution: safeText(patch.finalHumanResolution, 4000), caseCount: row.evidenceCaseCount };
    if (row.status === "rejected") priorRejections.push({ ...common, groupSignature: patch.groupSignature ?? null });
    else openCandidates.push(common);
  }
  if (rows.length > 100 || openCandidates.length > 50 || priorRejections.length > 50) throw new Error("SAV_LEARNING_COMPARATOR_CONTEXT_INCOMPLETE");
  const knowledge = inventory.map(({ ref, versionId, title, body }) => ({ ref, versionId, title: safeText(title, 300), body: safeText(body, 2500) }));
  // Fingerprint full material, not only titles or a possibly unchanged version label.
  const snapshot = savContentHash({ inventory, openCandidates, priorRejections, candidates: rows.map(row => ({ id: row.id, status: row.status, sourceHash: row.sourceContentHash, groupKey: row.admissionGroupKey, rejectionKind: row.rejectionKind })) });
  return { knowledge, openCandidates, priorRejections, snapshot, locks: {
    contentIds: [...new Set(inventory.filter(entry => entry.ref.startsWith("content:")).map(entry => entry.ref.slice(8)))],
    versionIds: [...new Set(inventory.filter(entry => entry.ref.startsWith("content:")).map(entry => entry.versionId))],
    projectionIds: inventory.filter(entry => entry.ref.startsWith("candidate:")).map(entry => entry.ref.slice(10)),
    learningIds: rows.map(row => row.id),
  } };
}

export type SavLearningResolutionInput = {
  caseContext?: import("./learning-comparator").SavLearningComparisonInput["caseContext"];
  ticketId?: string; threadId?: string; sourceRef?: string; origin?: "hubspot" | "observation"; cycleStartedAt: Date | string; snapshotId: string; snapshotHash: string; subject: string;
  resolution: string; provenance: string; sourceMessageId: string | null; evidenceRef?: string; evidenceExcerpt?: string; evidenceOccurredAt?: string; customerConfirmed: boolean; productVersion?: string | null; cycleSourceHash?: string; observationId?: string; cycleId?: string;
};
export async function processSavLearningResolution(input: SavLearningResolutionInput, options: { now?: Date; apiKey?: string; model?: string; fetch?: typeof fetch } = {}) {
  if(input.caseContext&&isSavCaseLearningFrozen())return {disposition:"frozen" as const};
  const now = options.now ?? new Date(), origin = input.origin ?? "hubspot", sourceRef = input.sourceRef ?? ("hubspot:" + input.ticketId);
  const signal = async (reasonCode: string, sourceHash = input.snapshotHash) => {
    await recordSavLearningSignal({ sourceRef, sourceHash, origin, reasonCode, details: { policyRevision: SAV_LEARNING_POLICY_REVISION } }, now);
    return { disposition: "signal" as const, reasonCode };
  };
  const cutover = await getSavLearningCutover();
  if (!isSavLearningCycleEligible(input.cycleStartedAt, cutover)) return signal(cutover ? "cycle_before_learning_cutover" : "cutover_not_active");
  if (input.evidenceOccurredAt && !isSavLearningCycleEligible(input.evidenceOccurredAt, cutover)) return signal("evidence_before_learning_cutover");
  if (!["human_resolution", "observed_treatment"].includes(input.provenance) || !input.sourceMessageId || input.resolution.trim().length < 20) return signal("human_resolution_proof_required");
  const resolution = safeText(input.resolution, 4000), subject = safeText(input.subject, 500), evidenceRef = input.evidenceRef ?? ("hubspot-message:" + input.sourceMessageId);
  const proofHash = savLearningProofHash({ sourceRef, cycleStartedAt: input.cycleStartedAt, evidenceRef, sourceMessageId: input.sourceMessageId, resolution, customerConfirmed: input.customerConfirmed });
  const sourceHash=input.cycleSourceHash?savContentHash({proofHash,cycleSourceHash:input.cycleSourceHash}):proofHash;
  let context: Awaited<ReturnType<typeof comparisonContext>>;
  try { context = await comparisonContext(); } catch { return signal("comparison_context_incomplete", sourceHash); }
  if (context.priorRejections.some(prior => savLearningMaterialText(prior.resolution) === savLearningMaterialText(resolution))) return signal("rejected_unchanged_proof", sourceHash);
  const comparisonInput: SavLearningComparisonInput = { sourceRef, subject, resolution, evidenceRef, evidenceExcerpt: input.evidenceExcerpt ?? resolution.slice(0, 240), productVersion: input.productVersion ?? null,
    caseContext: input.caseContext, customerConfirmed: input.customerConfirmed, knowledge: context.knowledge, openCandidates: context.openCandidates, priorRejections: context.priorRejections };
  const inputHash = savContentHash({ sourceHash, snapshot: context.snapshot });
  let savedComparison: Awaited<ReturnType<typeof compareSavLearningResolution>> | null = null;
  if (input.observationId && input.cycleId) {
    const [saved] = await requireDb().select().from(savObservationEvents).where(and(eq(savObservationEvents.observationId,input.observationId),eq(savObservationEvents.sourceRef,`comparison:${input.cycleId}:${input.cycleSourceHash}`))).limit(1);
    if (saved) {
      const previous = decryptSavPayload<Awaited<ReturnType<typeof compareSavLearningResolution>> & {knowledgeHash?:string}>(saved.payloadCiphertext);
      if (previous.knowledgeHash !== savContentHash(context.knowledge)) return signal("deferred_knowledge_changed",sourceHash);
      try { validateSavLearningComparison(previous.decision,comparisonInput); savedComparison = previous; }
      catch { return signal("deferred_comparison_requires_review",sourceHash); }
    }
  }
  const claim = await requireDb().transaction(async tx => {
    const claimed = await claimSavLearningComparisonTx(tx, { sourceRef, sourceHash, origin, inputHash, now, resumeDeferred:Boolean(savedComparison) });
    if (!claimed.claimed) return { duplicate: true as const };
    if (savedComparison) return {duplicate:false as const,signalId:claimed.signalId,leaseToken:claimed.leaseToken};
    // A provider outcome lost to an interruption is uncertain, never permission
    // to spend another call for the same cycle/evidence revision.
    const proofKey = savContentHash({ sourceRef, sourceHash });
    const [dispatched] = await tx.select({id:auditLogs.id}).from(auditLogs).where(and(eq(auditLogs.action,"sav_derived_call_reserved"),sql`${auditLogs.technicalMetadata}->>'proofKey' = ${proofKey}`)).limit(1);
    if (input.caseContext && dispatched) {
      await finishSavLearningComparisonTx(tx, claimed.signalId, {state:"signal",reasonCode:"comparison_interrupted"}, now, claimed.leaseToken);
      return {duplicate:true as const};
    }
    await reserveSavLearningModelCallTx(tx, now, input.caseContext ? proofKey : undefined);
    return { duplicate: false as const, signalId: claimed.signalId, leaseToken: claimed.leaseToken };
  });
  if (claim.duplicate) {
    const [prior] = await requireDb().select().from(savLearningAdmissionAttempts).where(and(eq(savLearningAdmissionAttempts.sourceRef, sourceRef), eq(savLearningAdmissionAttempts.sourceHash, sourceHash))).limit(1);
    return { disposition: "duplicate" as const, candidateId: prior?.candidateId ?? null, reasonCode: prior?.reasonCode ?? "duplicate_source" };
  }
  try {
  let comparison: Awaited<ReturnType<typeof compareSavLearningResolution>>;
  try { comparison = savedComparison ?? await compareSavLearningResolution(comparisonInput, { apiKey: options.apiKey ?? savGeminiApiKey(), model: options.model ?? process.env.SAV_AI_MODEL ?? "gemini-3.6-flash", fetch: options.fetch }); }
  catch (error) {
    const errorCode = error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message) ? error.message : "SAV_LEARNING_COMPARATOR_FAILED";
    await requireDb().transaction(tx => finishSavLearningComparisonTx(tx, claim.signalId, { reasonCode: "comparison_error", state: "signal", errorCode,
      comparatorRevision: SAV_LEARNING_COMPARATOR_REVISION, promptRevision: SAV_LEARNING_COMPARATOR_PROMPT_REVISION, inputHash }, now, claim.leaseToken));
    return { disposition: "signal" as const, reasonCode: "comparison_error", errorCode };
  }
  const decision = comparison.decision;
  return await requireDb().transaction(async tx => {
    // Match source-writer order, then take the shared admission lock and fenced claim.
    let sourceCurrent = !input.caseContext || !isSavCaseLearningFrozen();
    sourceCurrent &&= origin !== "hubspot" || Boolean(input.ticketId && await isSavCrmLearningSourceCurrent({ ticketId: input.ticketId,
      snapshotId: input.snapshotId, snapshotHash: input.snapshotHash, cycleStartedAt: input.cycleStartedAt }, tx, true));
    if (input.observationId && input.cycleId) {
      const [observation] = await tx.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, input.observationId)).for("update");
      const [cycle] = await tx.select().from(savObservationCycles).where(eq(savObservationCycles.id, input.cycleId));
      sourceCurrent &&= Boolean(observation?.closed && !observation.sourceErrors.length && cycle?.observationId === observation.id
        && cycle.cycle === observation.cycle && cycle.sourceHash === input.cycleSourceHash && ["resolved","evidence_observed"].includes(cycle.qualification??""));
    }
    await lockSavLearningAdmissionTx(tx);
    await assertSavLearningComparisonClaimTx(tx, claim.signalId, claim.leaseToken);
    if (!sourceCurrent) {
      await finishSavLearningComparisonTx(tx, claim.signalId, { reasonCode: "source_changed", state: "signal" }, now, claim.leaseToken);
      return { disposition: "signal" as const, reasonCode: "source_changed" };
    }
    // A human review can own candidate/projection before its content item. Never
    // wait in the reverse order: abort and release this comparison for a later invocation.
    const { contentIds, versionIds, projectionIds, learningIds } = context.locks;
    if (contentIds.length) {
      await tx.select({ id: contentItems.id }).from(contentItems).where(inArray(contentItems.id, contentIds)).orderBy(contentItems.id).for("share", { noWait: true });
      await tx.select({ id: savKnowledgeActivations.itemId }).from(savKnowledgeActivations).where(inArray(savKnowledgeActivations.itemId, contentIds)).orderBy(savKnowledgeActivations.itemId).for("share", { noWait: true });
    }
    if (versionIds.length) await tx.select({ id: contentVersions.id }).from(contentVersions).where(inArray(contentVersions.id, versionIds)).orderBy(contentVersions.id).for("share", { noWait: true });
    if (projectionIds.length) await tx.select({ id: knowledgeProjectionCandidates.id }).from(knowledgeProjectionCandidates).where(inArray(knowledgeProjectionCandidates.id, projectionIds)).orderBy(knowledgeProjectionCandidates.id).for("share", { noWait: true });
    if (learningIds.length) await tx.select({ id: savLearningCandidates.id }).from(savLearningCandidates).where(inArray(savLearningCandidates.id, learningIds)).orderBy(savLearningCandidates.id).for("share", { noWait: true });
    if(input.cycleId && input.observationId && input.caseContext) await tx.insert(savObservationEvents).values({observationId:input.observationId,sourceRef:`comparison:${input.cycleId}:${input.cycleSourceHash}`,contentHash:savContentHash(decision),kind:"case_comparison",occurredAt:now,payloadCiphertext:encryptSavPayload({inputHash:comparison.inputHash,knowledgeHash:savContentHash(context.knowledge),revision:comparison.revision,promptRevision:comparison.promptRevision,model:comparison.model,inputTokens:comparison.inputTokens,outputTokens:comparison.outputTokens,durationMs:comparison.durationMs,sourceHash:input.cycleSourceHash,decision})}).onConflictDoNothing();
    const finish = (reasonCode: string, candidateId: string | null = null, groupKey: string | null = null) => finishSavLearningComparisonTx(tx, claim.signalId, {
      reasonCode, candidateId, groupKey, state: candidateId ? "open" : "signal", comparatorRevision: comparison.revision, promptRevision: comparison.promptRevision,
      modelName: comparison.model, inputHash: comparison.inputHash, inputTokens: comparison.inputTokens, outputTokens: comparison.outputTokens, durationMs: comparison.durationMs,
      details: { outcome: decision.outcome, policyRevision: SAV_LEARNING_POLICY_REVISION },
    }, now, claim.leaseToken);
    let currentSnapshot: string;
    try { currentSnapshot = (await comparisonContext(tx)).snapshot; } catch { await finish("comparison_context_incomplete"); return { disposition: "signal" as const, reasonCode: "comparison_context_incomplete" }; }
    if (currentSnapshot !== context.snapshot) {
      await finish("comparison_context_changed"); return { disposition: "signal" as const, reasonCode: "comparison_context_changed" };
    }
    if(input.caseContext && decision.suggestionKind!=="knowledge") {await finish("specialist_review_required");return {disposition:"signal" as const,reasonCode:"specialist_review_required"};}
    const matchedCandidate = context.openCandidates.find(candidate => candidate.ref === decision.matchedRef);
    if (["not_reusable", "insufficient_evidence", "conflict"].includes(decision.outcome) || decision.outcome === "already_covered" && !matchedCandidate) {
      await finish(decision.outcome); return { disposition: "signal" as const, reasonCode: decision.outcome };
    }
    // A gap in another pending proposal needs its own human revision; never lose it by counting it as identical evidence.
    if (decision.outcome === "amendment" && decision.matchedRef?.startsWith("candidate:")) {
      await finish("candidate_revision_required", matchedCandidate ? matchedCandidate.ref.slice(10) : null); return { disposition: "signal" as const, reasonCode: "candidate_revision_required" };
    }
    const signature = savLearningMaterialText(decision.groupSignature ?? "");
    const groupKey = (matchedCandidate ? matchedCandidate.groupKey ?? matchedCandidate.ref : null) ?? `${decision.outcome === "amendment" ? decision.matchedRef : "new"}:${savContentHash({ signature }).slice(0, 32)}`;
    const [existing] = await tx.select().from(savLearningCandidates).where(and(matchedCandidate ? eq(savLearningCandidates.id, matchedCandidate.ref.slice(10)) : eq(savLearningCandidates.admissionGroupKey, groupKey), inArray(savLearningCandidates.status, ["pending", "approved"]))).limit(1);
    if (existing) {
      const patch = decryptSavPayload<LearningPatch>(String(existing.proposedPatch.ciphertext));
      if (decision.outcome !== "already_covered" && savLearningMaterialText(patch.finalHumanResolution) !== savLearningMaterialText(decision.resolution)) {
        await finish("candidate_revision_required"); return { disposition: "signal" as const, reasonCode: "candidate_revision_required" };
      }
      await tx.insert(savLearningAdmissionCases).values({ groupKey, caseHash: savContentHash(existing.hubspotTicketId ?? existing.sourceRef), candidateId: existing.id, sourceRef: existing.sourceRef }).onConflictDoNothing();
      await tx.insert(savLearningAdmissionCases).values({ groupKey, caseHash: savContentHash(input.ticketId ?? sourceRef), candidateId: existing.id, sourceRef }).onConflictDoNothing();
      const [{ total }] = await tx.select({ total: count() }).from(savLearningAdmissionCases).where(and(eq(savLearningAdmissionCases.groupKey, groupKey), eq(savLearningAdmissionCases.candidateId, existing.id)));
      await tx.update(savLearningCandidates).set({ evidenceTicketIds: [...new Set([...existing.evidenceTicketIds, ...(input.ticketId ? [input.ticketId] : [])])].slice(0, 3), evidenceCaseCount: total }).where(eq(savLearningCandidates.id, existing.id));
      await finish("grouped_existing_candidate", existing.id, groupKey);
      return { disposition: "grouped" as const, candidateId: existing.id, caseCount: total };
    }
    if (decision.outcome === "already_covered") { await finish("comparison_context_changed"); return { disposition: "signal" as const, reasonCode: "comparison_context_changed" }; }
    const capacity = await reserveSavLearningCapacityTx(tx, { reservationKey: savContentHash({ sourceRef, sourceHash, groupKey }), proposalKind: decision.outcome === "amendment" ? "amendment" : "new", now });
    if (!capacity.ok) { await finish(capacity.reasonCode); return { disposition: "signal" as const, reasonCode: capacity.reasonCode }; }
    const patch: LearningPatch = { subject: safeText(decision.subject, 500), finalHumanResolution: safeText(decision.resolution, 4000), sourceSnapshotId: input.snapshotId,
      sourceSnapshotHash: input.snapshotHash, sourceCycleStartedAt: new Date(input.cycleStartedAt).toISOString(),
      cycleSourceHash: input.cycleSourceHash, provenance: input.provenance==="observed_treatment"?"observed_treatment":"human_resolution", customerConfirmed: input.customerConfirmed, sourceMessageId: input.sourceMessageId!,
      conditions: decision.conditions.map(value => safeText(value, 500)), expectedResult: safeText(decision.expectedResult, 500), limitations: decision.limitations.map(value => safeText(value, 500)),
      groupSignature: decision.groupSignature ?? undefined, comparisonSnapshot: context.snapshot };
    const [candidate] = await tx.insert(savLearningCandidates).values({ threadId: input.threadId ?? null, hubspotTicketId: input.ticketId ?? null, sourceRef,
      sourceContentHash: savContentHash({ sourceHash, decision, snapshotHash: input.snapshotHash, cycleStartedAt: new Date(input.cycleStartedAt).toISOString() }), contentItemId: decision.outcome === "amendment" && decision.matchedRef?.startsWith("content:") ? decision.matchedRef.slice(8) : null,
      status: "pending", proposedPatch: { ciphertext: encryptSavPayload(patch) }, explanation: safeText(decision.rationale, 700), evidenceTicketIds: input.ticketId ? [input.ticketId] : [],
      evidenceCaseCount: 1, admissionGroupKey: groupKey, createdBy: "system" }).returning();
    await bindSavLearningReservationTx(tx, capacity.reservation.id, candidate.id);
    await tx.insert(savLearningAdmissionCases).values({ groupKey, caseHash: savContentHash(input.ticketId ?? sourceRef), candidateId: candidate.id, sourceRef });
    await finish(decision.outcome, candidate.id, groupKey);
    return { disposition: "admitted" as const, candidateId: candidate.id };
  });
  } catch (error) {
    // No provider/CRM mutation is retried here. A later invocation can reclaim the proof.
    try { await requireDb().transaction(tx => releaseSavLearningComparisonTx(tx, claim.signalId, claim.leaseToken)); }
    catch { /* A database outage leaves the fenced claim recoverable after lease expiry. */ }
    throw error;
  }
}
