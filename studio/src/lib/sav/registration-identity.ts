import { z } from "zod";
import { savEvidenceContains } from "./evidence-text";
import { styleSavEmailCoverage } from "./email-writing";
import { assembleSavReplySections, assertSavReplyConsistency, savSemanticPlan, type SavUnderstandingSource, type SavUnderstandingV1 } from "./understanding";
import type { SavDossierContext } from "./dossier-context";

export const SAV_REGISTRATION_IDENTITY_REVISION = "sav-registration-identity-2026-10-19.v1";

export function savRegistrationPrerequisiteApplies(u: SavUnderstandingV1) {
  return savSemanticPlan(u).replyPolicy === "compose" && u.customerRelationship?.kind !== "prospect";
}

/** A contact lookup failure is never evidence that the customer does not exist. */
export function savRegistrationIdentityStatus(crm: SavDossierContext["crm"]) {
  if (crm.data?.contactFound && crm.data.contactId) return "identified" as const;
  return crm.status === "ready" && !crm.errorCode && crm.data && !crm.data.errorCode
    && !crm.data.contactFound && !crm.data.contactId ? "not_found" as const : "unavailable" as const;
}

/** Retain a customer's evidenced registration address as an UNVERIFIED hint.
 * It never authorizes a lookup, context disclosure or account action.
 * Callers supply current body / same-customer inbound history, never CRM notes,
 * signatures, quoted forwards, attachments or other-conversation candidates. */
export function savSuppliedRegistrationEmail(u: SavUnderstandingV1, sources: SavUnderstandingSource[]) {
  const addresses = new Set<string>();
  for (const fact of u.knownFacts.filter(f => f.key === "registration_email")) {
    for (const id of fact.evidenceIds) {
      const proof = u.evidence.find(e => e.id === id);
      const source = sources.find(s => s.sourceId === proof?.sourceId && s.source === proof?.source);
      if (!proof || !source || !savEvidenceContains(source.text, proof.excerpt)) continue;
      // The understanding supplies the meaning; the actual customer quote must
      // contain the same address. A short reply may consist of that address only.
      if (/(?:n[’']est\s+pas|not\s+(?:my|our)|(?:is|was)\s+not)/iu.test(proof.excerpt)) continue;
      if (/(?:\b(?:du|de mon|de notre|d’un autre|d'une autre)\s+(?:client|collègue)\b|\b(?:of|for)\s+(?:my|our|another)\s+(?:colleague|customer|client)\b)/iu.test(proof.excerpt)) continue;
      const emails = proof.excerpt.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [];
      if (emails.length !== 1 || !fact.text.toLowerCase().includes(emails[0].toLowerCase())) continue;
      const parsed = z.email().safeParse(emails[0]);
      if (parsed.success) addresses.add(parsed.data.toLowerCase());
    }
  }
  return { email: addresses.size === 1 ? [...addresses][0] : null, ambiguous: addresses.size > 1 };
}

/** Server-owned clarification, selected BEFORE product composition. It is still
 * assessed by the common consistency, grounding and semantic coherence guards. */
export function buildSavRegistrationClarification(u: SavUnderstandingV1, state: "not_found" | "unavailable" | "confirmation_required", supplied: { email: string | null; ambiguous: boolean }) {
  const en = u.language === "en";
  const question = supplied.ambiguous
    ? en ? "Which of the addresses you provided did you use to register with Limova?" : "Parmi les adresses indiquées, laquelle avez-vous utilisée lors de votre inscription à Limova ?"
    : supplied.email
      ? en ? "Could you check the registration address you provided, or tell us whether you registered with a different address?" : "Pourriez-vous vérifier l’adresse d’inscription indiquée, ou nous préciser si vous vous êtes inscrit avec une autre adresse ?"
      : en ? "To find your account and help you, could you tell us the email address you used to register with Limova?" : "Pour retrouver votre compte et vous accompagner, pourriez-vous nous préciser l’adresse email utilisée lors de votre inscription à Limova ?";
  const info = en ? "Before preparing an action on your account, we need to verify which account your request concerns."
    : "Avant de préparer une action sur votre compte, nous devons vérifier le compte concerné par votre demande.";
  const suppliedNotice = state === "confirmation_required" ? en ? "Thank you for providing your registration email address."
    : "Merci pour l’adresse email d’inscription indiquée." : "";
  const primary = u.primaryRequestId ?? u.requests[0].id;
  const ids = new Set([...u.requests, ...u.knownFacts, ...u.attemptedSteps, ...u.missingInformation, ...u.evidence].map(item => item.id));
  let questionId = "registration_identity_question";
  for (let i = 1; ids.has(questionId); i++) questionId = `registration_identity_question_${i}`;
  // As with the request planner, only the questions for the next permitted step
  // are exposed. Demands, facts, attempted steps and their evidence stay intact.
  const understanding: SavUnderstandingV1 = { ...u, missingInformation: state === "not_found" ? [{ id: questionId,
    key: supplied.email || supplied.ambiguous ? "registration_email_confirmation" : "registration_email", text: question, requestIds: [primary] }] : [] };
  const coverage = styleSavEmailCoverage(understanding, u.requests.map(r => ({ requestId: r.id,
    text: `${en ? "Your request concerns" : "Votre demande concerne"} : ${r.summary.slice(0, 320)}${r.id === primary ? `\n\n${suppliedNotice ? `${suppliedNotice}\n\n` : ""}${info}${state === "not_found" ? `\n\n${question}` : ""}` : ""}`,
    kind: r.id === primary && state === "not_found" ? "clarification" as const : "acknowledgement" as const,
    sourceIds: [], missingInformationIds: r.id === primary && state === "not_found" ? [questionId] : [], repeatedAttemptIds: [], repeatJustification: "" })));
  const reply = assembleSavReplySections(understanding, coverage);
  const responseKind: "clarification" | "acknowledgement" = state === "not_found" ? "clarification" : "acknowledgement";
  assertSavReplyConsistency(understanding, { ...reply, category: savSemanticPlan(u).category, responseKind, citations: [] });
  return { ...reply, understanding, responseKind };
}
