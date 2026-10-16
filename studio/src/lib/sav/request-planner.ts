import { z } from "zod";
import { diagnosticKnowledgeSchema } from "@/lib/knowledge/diagnostic-contract";
import { savEvidenceContains, normalizeSavEvidenceText } from "./evidence-text";
import { canonicalSavFactKey, savRequestDomain, type SavActivePlaybook } from "./playbook-contract";
import { savSemanticPlan, type SavUnderstandingV1, type SavReplyCoverage } from "./understanding";
import type { SavRequestRetrievalResult, SavRequestRetrievalSource } from "./request-retrieval";

export const SAV_REQUEST_PLANNER_REVISION = "sav-request-planner-2026-10-16.v1";
export const savRequestPlanSchema = z.object({
  requestId: z.string(), domain: z.string(), mode: z.enum(["solution", "clarification", "knowledge_gap", "reserved", "provider_failure"]),
  card: z.object({ id: z.string(), versionId: z.string() }).nullable(),
  missingFacts: z.array(z.object({ id: z.string(), key: z.string(), question: z.string(), origin: z.string() })),
  nextCheck: z.object({ id: z.string(), instruction: z.string(), expectedResult: z.string(), sourceId: z.string() }).nullable(),
  repeatAllowed: z.boolean(), limits: z.array(z.string()),
});
export type SavRequestPlan = z.infer<typeof savRequestPlanSchema>;
export const savHarnessTraceSchema = z.object({ revision: z.string(), playbookVersionId: z.string(),
  playbookCharacters: z.number(), retrievalRevision: z.string().nullable(), plans: z.array(savRequestPlanSchema),
  retrievalAlerts: z.array(z.object({ code: z.string(), sourceKey: z.string().optional() })).max(61).optional(),
}).strict();
export type SavHarnessTrace = z.infer<typeof savHarnessTraceSchema>;

function cardCanSupport(source: SavRequestRetrievalSource, now: Date) {
  const verified = Date.parse(source.verifiedAt ?? "");
  return source.contentVersionId && Array.isArray(source.resolution?.steps) && source.resolution.steps.length
    && Number.isFinite(verified) && verified <= now.getTime() && now.getTime() - verified <= 90 * 86400000
    && (!source.resolution?.validUntil || String(source.resolution.validUntil) >= now.toISOString().slice(0, 10));
}
export function planSavRequests(u: SavUnderstandingV1, retrieval: SavRequestRetrievalResult, playbook: SavActivePlaybook, now = new Date()): SavRequestPlan[] {
  const policy = savSemanticPlan(u);
  const canonical = (key: string) => canonicalSavFactKey(key, playbook.document);
  const known = new Set(u.knownFacts.map(f => canonical(f.key)));
  const attempted = new Set(u.attemptedSteps.flatMap(f => [f.key, ...(f.checkId ? [f.checkId] : [])]));
  let remainingQuestions = 15;
  return u.requests.map(request => {
    const domain = savRequestDomain(request);
    const found = retrieval.requests.find(r => r.requestId === request.id);
    const limits = [...(u.knownFacts.some(f => !playbook.document.facts.some(known => known.key === canonical(f.key))) ? ["unknown_fact_key"] : []), ...(found?.limitations ?? []), ...u.uncertainties.filter(e => !e.requestIds.length || e.requestIds.includes(request.id)).map(e => e.code)];
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
      const diagnostic = diagnosticKnowledgeSchema.safeParse(source.resolution?.diagnostic);
      if (source.resolution?.diagnostic && !diagnostic.success) base.limits.push("invalid_diagnostic");
      if (diagnostic.success) {
        for (const fact of diagnostic.data.requiredFacts) {
          const key = canonical(fact.key);
          const question = u.language === "en" ? fact.questionEn : fact.question;
          if (!known.has(key) && question && !base.missingFacts.some(f => f.key === key)) base.missingFacts.push({ id: `plan.${u.requests.indexOf(request)}.${key}`, key, question, origin: `card:${source.id}:${source.contentVersionId}` });
        }
        const blockedKeys = new Set(base.missingFacts.map(f => f.key));
        const relevantAttempts = u.attemptedSteps.filter(f => !f.checkId || diagnostic.data.checks.some(c => c.id === f.checkId));
        const unlinkedAttempt = relevantAttempts.some(f => !diagnostic.data.checks.some(c => c.id === f.checkId || c.id === f.key || c.evidenceStepId === f.key));
        const branchTargets = new Set(diagnostic.data.checks.flatMap(c => [c.ifExpected, c.ifNot].filter(Boolean)));
        let check = diagnostic.data.checks.find(c => !branchTargets.has(c.id));
        if (unlinkedAttempt) { check = undefined; base.limits.push("attempt_mapping_requires_review"); }
        const visited = new Set<string>();
        while (check && (attempted.has(check.id) || attempted.has(check.evidenceStepId))) {
          if (visited.has(check.id)) { check = undefined; base.limits.push("diagnostic_cycle"); break; }
          visited.add(check.id);
          const attemptedStep = u.attemptedSteps.find(f => f.checkId === check!.id || f.key === check!.id || f.key === check!.evidenceStepId);
          const result = attemptedStep?.checkVersionId === source.contentVersionId ? attemptedStep.outcome : null;
          const next = result === "expected" ? check.ifExpected : result === "not_expected" ? check.ifNot : null;
          if (!next) { check = undefined; base.limits.push("attempt_result_requires_review"); break; }
          check = diagnostic.data.checks.find(c => c.id === next);
        }
        if (check && (!check.prerequisites.every(key => known.has(canonical(key)))
          || diagnostic.data.requiredFacts.some(f => f.requiredFor.includes(check!.id) && blockedKeys.has(canonical(f.key))))) check = undefined;
        if (check && savEvidenceContains(source.content, check.instruction) && (source.resolution?.steps as string[]).some(step => savEvidenceContains(step, check.instruction)))
          base.nextCheck = { id: check.id, instruction: check.instruction, expectedResult: check.expectedResult, sourceId: source.id };
      } else if (!u.attemptedSteps.length && u.status === "qualified") {
        // Legacy active cards remain consumable. No invented branch or outcome.
        const instruction = (source.resolution!.steps as string[])[0];
        if (instruction && savEvidenceContains(source.content, instruction)) base.nextCheck = { id: "legacy.first", instruction, expectedResult: "", sourceId: source.id };
      } else base.limits.push("diagnostic_enrichment_required");
    }
    if (!base.missingFacts.length) for (const fact of playbook.document.facts) {
      const question = u.language === "en" ? fact.questionEn : fact.question;
      if (question && !known.has(fact.key) && (fact.domains.includes(domain) || fact.domains.includes("general")))
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

/** Server-owned questions and steps; the model only supplies a short acknowledgement. */
export function assembleSavPlannedReply(u: SavUnderstandingV1, raw: SavReplyCoverage, plans: SavRequestPlan[]) {
  return u.requests.map(request => {
    const part = raw.find(p => p.requestId === request.id);
    const plan = plans.find(p => p.requestId === request.id);
    if (!part || !plan) throw new Error("SAV_REQUEST_PLAN_COVERAGE_REQUIRED");
    // A free-form question cannot bypass the validated question dictionary.
    if (/[?？]/u.test(part.text) || part.sourceIds.some(id => id !== plan.card?.id) || part.repeatedAttemptIds.length)
      throw new Error("SAV_REPLY_OUTSIDE_REQUEST_PLAN");
    if (part.kind === "solution" && !plan.nextCheck) throw new Error("SAV_REPLY_OUTSIDE_REQUEST_PLAN");
    const fragments = [part.text];
    if (plan.nextCheck) {
      fragments.push(plan.nextCheck.instruction);
      if (plan.nextCheck.expectedResult) fragments.push(plan.nextCheck.expectedResult);
    }
    for (const fact of plan.missingFacts) if (!fragments.some(text => normalizeSavEvidenceText(text).includes(normalizeSavEvidenceText(fact.question)))) fragments.push(fact.question);
    if (!plan.nextCheck && !plan.missingFacts.length && part.kind !== "handoff") fragments.push(u.language === "en" ? "The Limova team needs to review this request before a reliable next step can be proposed." : "L’équipe Limova doit vérifier cette demande avant qu’une prochaine étape fiable puisse être proposée.");
    return { ...part, text: fragments.join("\n\n"), kind: plan.nextCheck ? "solution" as const : plan.missingFacts.length ? "clarification" as const : "handoff" as const,
      sourceIds: plan.nextCheck ? [plan.nextCheck.sourceId] : [], missingInformationIds: plan.missingFacts.map(f => f.id), repeatedAttemptIds: [], repeatJustification: "" };
  });
}
