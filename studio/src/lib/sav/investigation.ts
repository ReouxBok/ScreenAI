import { styleSavEmailCoverage } from "./email-writing";
import { assembleSavReplySections, assertSavReplyConsistency, savSemanticPlan, type SavUnderstandingV1, type SavReplyCoverage } from "./understanding";
import type { SavRequestPlan } from "./request-planner";

/** Generic investigation questions are product-independent. They authorize no action,
 * diagnosis, procedure, entitlement or promise. Known keys are deliberately conservative. */
const questions = [
  { key: "desired_outcome", aliases: ["desired_outcome", "expected_result", "goal", "objective"], fr: "Pouvez-vous préciser ce que vous souhaitez faire et ce qui vous bloque actuellement ?", en: "Could you clarify what you want to do and what is currently blocking you?" },
  { key: "product_name", aliases: ["product", "product_name", "application", "app_name"], fr: "Sur quel produit et dans quel écran effectuez-vous cette opération ?", en: "In which product and screen are you performing this operation?" },
  { key: "product_version", aliases: ["version", "app_version", "application_version", "limova_version", "platform_version", "product_version"], fr: "Quelle version du produit utilisez-vous actuellement ?", en: "Which version of the product are you currently using?" },
  { key: "reproduction_time", aliases: ["reproduction_time", "last_occurrence", "diagnostic_timestamp", "event_time", "incident_time"], fr: "À quelle date et heure avez-vous constaté le problème pour la dernière fois ?", en: "At what date and time did you last observe the issue?" },
] as const;

export function addSavInvestigationQuestions(u: SavUnderstandingV1, plans: SavRequestPlan[]): SavRequestPlan[] {
  if (savSemanticPlan(u).replyPolicy !== "compose") return plans;
  let remaining = 3;
  return plans.map((plan, index) => {
    const request = u.requests.find(r => r.id === plan.requestId);
    if (!request || !["technical", "integration", "account", "how_to", "unknown"].includes(request.nature) || plan.mode === "reserved" || plan.nextCheck || plan.procedures?.length) return plan;
    const facts = u.knownFacts.filter(f => !f.requestIds?.length || f.requestIds.includes(request.id));
    // Known facts of another type do not suppress unrelated investigation questions.
    const known = new Set(facts.map(f => f.key.toLowerCase().replace(/[ .-]/g, "_")));
    const missingFacts = plan.missingFacts.slice(0, remaining);
    if (!missingFacts.length) {
      for (const question of questions) {
        if (missingFacts.length >= Math.min(2, remaining)) break;
        if (question.key === "desired_outcome" && request.nature !== "unknown") continue;
        if (question.key === "product_name" && request.product) continue;
        if (question.key === "reproduction_time" && !["technical", "integration"].includes(request.nature)) continue;
        if (question.key === "product_version" && (!request.product || !["technical", "integration", "how_to"].includes(request.nature))) continue;
        if (question.aliases.some(key => known.has(key)) || question.key === "product_version" && facts.some(f => /version|release/i.test(f.key + " " + f.text))) continue;
        missingFacts.push({ id: `investigation.${index}.${question.key}`, key: question.key,
          question: u.language === "en" ? question.en : question.fr, origin: "server:investigation-v1" });
      }
    }
    remaining -= missingFacts.length;
    return { ...plan, missingFacts, mode: missingFacts.length ? "clarification" : plan.mode,
      limits: [...plan.limits, "investigation_only"] };
  });
}

/** Discard rejected composition. Rebuild only from the validated contract and
 * reviewed questions; no model text, product instruction or citation survives. */
export function buildSavInvestigationReply(u: SavUnderstandingV1, plans: SavRequestPlan[]) {
  const policy = savSemanticPlan(u);
  if (policy.replyPolicy !== "compose") throw new Error("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING");
  const coverage: SavReplyCoverage = u.requests.map(request => {
    const plan = plans.find(p => p.requestId === request.id);
    const missing = plan?.mode === "reserved" ? [] : plan?.missingFacts ?? [];
    return { requestId: request.id, kind: missing.length ? "clarification" : "acknowledgement",
      text: [...(u.requests.length > 1 ? [request.summary] : []), u.language === "en" ? "To move forward, I need a few details:" : "Pour avancer, j’ai besoin de quelques précisions :", ...missing.map(f => f.question)].join("\n\n"),
      sourceIds: [], missingInformationIds: missing.map(f => f.id), repeatedAttemptIds: [], repeatJustification: "" };
  });
  if (!coverage.some(p => p.kind === "clarification")) throw new Error("SAV_INVESTIGATION_QUESTION_UNAVAILABLE");
  const assembled = assembleSavReplySections(u, styleSavEmailCoverage(u, coverage));
  const output = { ...assembled, category: policy.category, responseKind: "clarification" as const, citations: [] };
  assertSavReplyConsistency(u, output);
  return output;
}
