import { z } from "zod";
import { SavContractValidationError } from "./validation-diagnostics";
import { renderSavProcedureGroup, savSupportDeliveryProjectionSchema, savDeliveryGroups, savProcedureGroupsSchema } from "@/lib/knowledge/support-delivery";
import { diagnosticKnowledgeSchema } from "@/lib/knowledge/diagnostic-contract";
import { savEvidenceContains, normalizeSavEvidenceText } from "./evidence-text";
import { canonicalSavFactKey, savRequestDomain, type SavActivePlaybook } from "./playbook-contract";
import { savSemanticPlan, type SavUnderstandingV1, type SavReplyCoverage } from "./understanding";
import type { SavRequestRetrievalResult, SavRequestRetrievalSource } from "./request-retrieval";

export const SAV_REQUEST_PLANNER_REVISION = "sav-request-planner-2026-10-17.v4";
export const savRequestPlanSchema = z.object({
  requestId: z.string(), domain: z.string(), mode: z.enum(["solution", "clarification", "knowledge_gap", "reserved", "provider_failure"]),
  card: z.object({ id: z.string(), versionId: z.string() }).nullable(),
  missingFacts: z.array(z.object({ id: z.string(), key: z.string(), question: z.string(), origin: z.string() })),
  nextCheck: z.object({ id: z.string(), instruction: z.string(), expectedResult: z.string(), sourceId: z.string() }).nullable(),
  procedures: savProcedureGroupsSchema.optional(),
  repeatAllowed: z.boolean(), limits: z.array(z.string()),
});
export type SavRequestPlan = z.infer<typeof savRequestPlanSchema>;
export const savHarnessTraceSchema = z.object({ revision: z.string(), playbookVersionId: z.string(),
  playbookCharacters: z.number(), retrievalRevision: z.string().nullable(), plans: z.array(savRequestPlanSchema),
  retrievalAlerts: z.array(z.object({ code: z.string(), sourceKey: z.string().optional() })).max(61).optional(),
}).strict();
export type SavHarnessTrace = z.infer<typeof savHarnessTraceSchema>;

function sourceSteps(source: SavRequestRetrievalSource): string[] {
  const delivery = savSupportDeliveryProjectionSchema.safeParse(source.resolution?.delivery);
  // The retrieval wire format serializes qualified instructions once in its
  // catalog; persisted resolution.steps remains readable by the previous code.
  if (delivery.success && delivery.data.mode === "procedure") return delivery.data.steps.map(s => s.instruction);
  return Array.isArray(source.resolution?.steps) ? source.resolution.steps as string[] : [];
}
function cardCanSupport(source: SavRequestRetrievalSource, now: Date) {
  const verified = Date.parse(source.verifiedAt ?? "");
  return source.contentVersionId && (sourceSteps(source).length || source.resolution?.delivery && savSupportDeliveryProjectionSchema.safeParse(source.resolution.delivery).success)
    && Number.isFinite(verified) && verified <= now.getTime() && now.getTime() - verified <= 90 * 86400000
    && (!source.resolution?.validUntil || String(source.resolution.validUntil) >= now.toISOString().slice(0, 10));
}
export function planSavRequests(u: SavUnderstandingV1, retrieval: SavRequestRetrievalResult, playbook: SavActivePlaybook, now = new Date()): SavRequestPlan[] {
  const policy = savSemanticPlan(u);
  const canonical = (key: string) => canonicalSavFactKey(key, playbook.document);
  let remainingQuestions = 15;
  return u.requests.map(request => {
    const known = new Set(u.knownFacts.filter(f => f.requestIds?.includes(request.id) || !f.requestIds?.length && u.requests.length === 1).map(f => canonical(f.key)));
    const ambiguousFacts = new Set(u.requests.length > 1 ? u.knownFacts.filter(f => !f.requestIds?.length).map(f => canonical(f.key)) : []);
    const domain = savRequestDomain(request);
    const found = retrieval.requests.find(r => r.requestId === request.id);
    const limits = [...(ambiguousFacts.size ? ["fact_scope_requires_review"] : []), ...(u.knownFacts.some(f => !playbook.document.facts.some(known => known.key === canonical(f.key))) ? ["unknown_fact_key"] : []), ...(found?.limitations ?? []), ...u.uncertainties.filter(e => !e.requestIds.length || e.requestIds.includes(request.id)).map(e => e.code)];
    const base: SavRequestPlan = { requestId: request.id, domain, mode: "knowledge_gap", card: null, missingFacts: [], nextCheck: null, repeatAllowed: false, limits };
    if (policy.replyPolicy !== "compose") return { ...base, mode: "reserved" };
    if (!found || ["search_unavailable", "revision_unstable"].includes(found.status)) return { ...base, mode: "provider_failure" };
    const sources = retrieval.sources.filter(s => found.candidateKeys.includes(s.key) && s.requestIds.includes(request.id) && cardCanSupport(s, now));
    if (sources.some(s => (s.resolution?.conflictsWith as string[] | undefined)?.some(id => sources.some(other => other.id === id))))
      return { ...base, limits: [...limits, "contradictory_cards"] };
    if (found.status === "budget_exceeded") return { ...base, limits: [...limits, "retrieval_budget_exceeded"] };
    const source = sources[0];
    if (source) {
      base.card = { id: source.id, versionId: source.contentVersionId };
      const delivery = source.resolution?.delivery === undefined ? null : savSupportDeliveryProjectionSchema.safeParse(source.resolution.delivery);
      if (delivery && !delivery.success) return { ...base, limits: [...limits, "invalid_support_delivery"] };
      if (delivery?.success && delivery.data.mode === "internal") return { ...base, limits: [...limits, "internal_guidance_only"] };
      if (delivery?.success && delivery.data.mode === "procedure") {
        const attempts = u.attemptedSteps.filter(a => (!a.checkCardId || a.checkCardId === source.id) && (!a.requestIds?.length || a.requestIds.includes(request.id)));
        if (u.status !== "qualified" || u.uncertainties.some(e => (!e.requestIds.length || e.requestIds.includes(request.id)) && ["ambiguous_intent", "conflicting_evidence", "unread_attachment", "truncated_context"].includes(e.code)))
          return { ...base, limits: [...limits, "procedure_context_requires_review"] };
        if (attempts.length) return { ...base, limits: [...limits, "procedure_attempt_requires_review"] };
        const procedures = savDeliveryGroups(delivery.data).filter(g => g.steps.every(step => savEvidenceContains(source.content, step.instruction)
          && sourceSteps(source).some(instruction => savEvidenceContains(instruction, step.instruction)))
          && renderSavProcedureGroup(g, u.language === "en" ? "en" : "fr").length + request.summary.length + 100 <= 4000);
        return procedures.length === delivery.data.groups.length && procedures.length ? { ...base, mode: procedures.some(g => !g.requiresHuman) ? "solution" : "knowledge_gap", procedures } : { ...base, limits: [...limits, "procedure_requires_review"] };
      }
      const diagnostic = diagnosticKnowledgeSchema.safeParse(source.resolution?.diagnostic);
      if (source.resolution?.diagnostic && !diagnostic.success) base.limits.push("invalid_diagnostic");
      if (diagnostic.success) {
        for (const fact of diagnostic.data.requiredFacts) {
          const key = canonical(fact.key);
          const question = u.language === "en" ? fact.questionEn : fact.question;
          if (!known.has(key) && !ambiguousFacts.has(key) && question && !base.missingFacts.some(f => f.key === key)) base.missingFacts.push({ id: `plan.${u.requests.indexOf(request)}.${key}`, key, question, origin: `card:${source.id}:${source.contentVersionId}` });
        }
        const blockedKeys = new Set([...base.missingFacts.map(f => f.key), ...ambiguousFacts]);
        const scopedAttempts = u.attemptedSteps.filter(f => (!f.checkCardId || f.checkCardId === source.id) && (!f.requestIds?.length || f.requestIds.includes(request.id)));
        const attempted = new Set(scopedAttempts.flatMap(f => [f.key, ...(f.checkId ? [f.checkId] : [])]));
        const relevantAttempts = scopedAttempts.filter(f => !f.checkId || diagnostic.data.checks.some(c => c.id === f.checkId));
        const unlinkedAttempt = relevantAttempts.some(f => !diagnostic.data.checks.some(c => c.id === f.checkId || c.id === f.key || c.evidenceStepId === f.key));
        const branchTargets = new Set(diagnostic.data.checks.flatMap(c => [c.ifExpected, c.ifNot].filter(Boolean)));
        let check = diagnostic.data.checks.find(c => !branchTargets.has(c.id));
        if (unlinkedAttempt) { check = undefined; base.limits.push("attempt_mapping_requires_review"); }
        const visited = new Set<string>();
        while (check && (attempted.has(check.id) || attempted.has(check.evidenceStepId))) {
          if (visited.has(check.id)) { check = undefined; base.limits.push("diagnostic_cycle"); break; }
          visited.add(check.id);
          const attemptedStep = scopedAttempts.find(f => f.checkId === check!.id || f.key === check!.id || f.key === check!.evidenceStepId);
          const result = attemptedStep?.checkId === check.id && attemptedStep.checkVersionId === source.contentVersionId && (u.requests.length === 1 || attemptedStep.requestIds?.includes(request.id)) ? attemptedStep.outcome : null;
          const next = result === "expected" ? check.ifExpected : result === "not_expected" ? check.ifNot : null;
          if (!next) { check = undefined; base.limits.push("attempt_result_requires_review"); break; }
          check = diagnostic.data.checks.find(c => c.id === next);
        }
        if (check && (!check.prerequisites.every(key => known.has(canonical(key)))
          || diagnostic.data.requiredFacts.some(f => f.requiredFor.includes(check!.id) && blockedKeys.has(canonical(f.key))))) check = undefined;
        if (check && savEvidenceContains(source.content, check.instruction) && (source.resolution?.steps as string[]).some(step => savEvidenceContains(step, check.instruction)))
          base.nextCheck = { id: check.id, instruction: check.instruction, expectedResult: check.expectedResult, sourceId: source.id };
      } else if (!u.attemptedSteps.some(f => (!f.checkCardId || f.checkCardId === source.id) && (!f.requestIds?.length || f.requestIds.includes(request.id))) && u.status === "qualified") {
        // Legacy active cards remain consumable. No invented branch or outcome.
        const instruction = (source.resolution!.steps as string[])[0];
        if (instruction && savEvidenceContains(source.content, instruction)) base.nextCheck = { id: "legacy.first", instruction, expectedResult: "", sourceId: source.id };
      } else base.limits.push("diagnostic_enrichment_required");
    }
    if (!base.missingFacts.length) for (const fact of playbook.document.facts) {
      const question = u.language === "en" ? fact.questionEn : fact.question;
      if (question && !known.has(fact.key) && !ambiguousFacts.has(fact.key) && (fact.domains.includes(domain) || fact.domains.includes("general")))
        base.missingFacts.push({ id: `plan.${u.requests.indexOf(request)}.${fact.key}`, key: fact.key, question, origin: `playbook:${playbook.versionId}` });
    }
    const maximumQuestions = Math.min(3, remainingQuestions);
    if (base.missingFacts.length > maximumQuestions) { base.missingFacts = base.missingFacts.slice(0, maximumQuestions); base.limits.push("question_budget"); }
    remainingQuestions -= base.missingFacts.length;
    // Ambiguity permits questions, never a forced technical solution.
    if (u.status !== "qualified") base.nextCheck = null;
    if (base.nextCheck) base.mode = "solution";
    else if (base.missingFacts.length) base.mode = "clarification";
    return base;
  });
}

/** Server-owned acknowledgement, questions and steps; model coverage is checked before assembly. */
export function assembleSavPlannedReply(u: SavUnderstandingV1, raw: SavReplyCoverage, plans: SavRequestPlan[]) {
  return u.requests.map(request => {
    const part = raw.find(p => p.requestId === request.id);
    const plan = plans.find(p => p.requestId === request.id);
    if (!part || !plan) throw new SavContractValidationError("SAV_REQUEST_PLAN_COVERAGE_REQUIRED", "request_plan_required", "coverage.requestId");
    // A free-form question cannot bypass the validated question dictionary.
    if (/[?？]/u.test(part.text) || part.sourceIds.some(id => id !== plan.card?.id) || part.repeatedAttemptIds.length)
      throw new SavContractValidationError("SAV_REPLY_OUTSIDE_REQUEST_PLAN", "unplanned_content_or_reference", "coverage");
    if (part.kind === "solution" && !plan.nextCheck && !plan.procedures?.length) throw new SavContractValidationError("SAV_REPLY_OUTSIDE_REQUEST_PLAN", "solution_without_authorized_step", "coverage.kind");
    // No free-form composition can insert another advice/step outside the selected plan.
    const options = plan.procedures ?? [];
    const selected = options.find(g => g.id === part.procedureGroupId);
    const procedure = selected?.requiresHuman ? undefined : selected;
    if ((part.procedureGroupId && !selected) || (options.length > 0 && !selected && part.kind === "solution")) throw new Error("SAV_PROCEDURE_SELECTION_REQUIRED");
    const needsHuman = !plan.nextCheck && !procedure && !plan.missingFacts.length;
    const fragments = [u.language === "en"
      ? `${needsHuman ? "The team needs to review your request" : "Your request"}: ${request.summary}`
      : `${needsHuman ? "L’équipe doit vérifier votre demande" : "Votre demande"} : ${request.summary}`];
    if (procedure) fragments.push(renderSavProcedureGroup(procedure, u.language === "en" ? "en" : "fr"));
    if (plan.nextCheck) {
      fragments.push(plan.nextCheck.instruction);
      if (plan.nextCheck.expectedResult) fragments.push(plan.nextCheck.expectedResult);
    }
    for (const fact of plan.missingFacts) if (!fragments.some(text => normalizeSavEvidenceText(text).includes(normalizeSavEvidenceText(fact.question)))) fragments.push(fact.question);
    return { ...part, procedureGroupId: undefined, text: fragments.join("\n\n"), kind: plan.nextCheck || procedure ? "solution" as const : plan.missingFacts.length ? "clarification" as const : "handoff" as const,
      sourceIds: plan.nextCheck ? [plan.nextCheck.sourceId] : procedure && plan.card ? [plan.card.id] : [], missingInformationIds: plan.missingFacts.map(f => f.id), repeatedAttemptIds: [], repeatJustification: "" };
  });
}
