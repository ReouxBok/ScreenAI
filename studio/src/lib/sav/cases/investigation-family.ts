import { retrieveSavKnowledgeByRequest, SAV_RETRIEVAL_LIMITS, type SavRetrievalBackend } from "../request-retrieval";
import type { CaseRequestFamily } from "./case-types";

/*
 * SAV-19: the first V2 family, access, as a CANDIDATE scope. Nothing here activates, admits or publishes anything:
 * admission stays with the approved policy (pole A), and a card becomes usable only through the existing human
 * validation and publication. This module lists what the family needs and inventories, read only, which published
 * and applicable cards cover it, so that the gaps are visible before any pilot. Topic queries are search phrases, not
 * support content; the wording of the cards themselves lives in the knowledge base, never in code.
 */

export const SAV_CASE_PILOT_FAMILY_REVISION = "sav-case-pilot-family-2026-10-30.candidate";

export type CaseFamilyTopic = {
  id: string; query: string;
  /** `decision_pending`: Ugo has not decided the procedure yet (SAV-88 §10.6); a card found for it is not enough. */
  decision: "decided" | "decision_pending";
};

export const SAV_CASE_PILOT_FAMILY_CANDIDATE = Object.freeze({
  revision: SAV_CASE_PILOT_FAMILY_REVISION,
  /** Candidate only: the code never reads this as a permission. */
  status: "candidate" as const,
  family: "access" as CaseRequestFamily,
  /** Never in this family, whatever a card says: the gate keeps these cases with the team before any read. */
  excluded: ["finance", "cancellation", "subscription", "rights", "identity"] as CaseRequestFamily[],
  topics: Object.freeze([
    { id: "access_link_and_address", query: "se connecter à la plateforme avec l'adresse e-mail d'inscription", decision: "decided" },
    { id: "first_login_onboarding", query: "première connexion écran d'accueil assistante onboarding", decision: "decided" },
    { id: "payment_screen_at_login", query: "écran demandant de payer ou de souscrire à la connexion", decision: "decided" },
    { id: "previously_connected_blocked", query: "client déjà connecté auparavant qui ne peut plus accéder", decision: "decided" },
    { id: "login_code_not_received", query: "code de connexion non reçu vérifier adresse et courriers indésirables", decision: "decided" },
    { id: "login_code_still_missing", query: "code de connexion toujours absent après vérifications", decision: "decision_pending" },
    { id: "login_code_refused", query: "code de connexion refusé ou expiré", decision: "decision_pending" },
    { id: "payment_screen_persists", query: "paiement toujours demandé avec le bon lien et la bonne adresse", decision: "decision_pending" },
    { id: "new_onboarding_or_wrong_space", query: "nouvel onboarding ou mauvais espace après une connexion antérieure", decision: "decision_pending" },
  ] satisfies CaseFamilyTopic[]),
});

export type CaseFamilyTopicInventory = {
  topic: string; decision: CaseFamilyTopic["decision"];
  /** `covered`: at least one published, applicable card was retrieved; `gap`: the search ran and found none;
   * `not_searched`: a budget limit, never an absence; `search_unavailable`: the search failed, never an absence. */
  status: "covered" | "gap" | "not_searched" | "search_unavailable";
  cards: Array<{ knowledgeId: string; contentVersionId: string; title: string }>;
};

/** Read-only inventory of one family's topics against the published knowledge. Writes and publishes nothing. */
export async function inventoryCaseFamilyKnowledge(topics: readonly CaseFamilyTopic[], backend: SavRetrievalBackend, scope: { locale: string; audience: "support" | "lead"; now: Date }) {
  const rows: CaseFamilyTopicInventory[] = [], revisions = new Set<string | null>();
  // The search takes a few requests at a time; topics are searched in batches of that size.
  for (let start = 0; start < topics.length; start += SAV_RETRIEVAL_LIMITS.requests) {
    const batch = topics.slice(start, start + SAV_RETRIEVAL_LIMITS.requests);
    const result = await retrieveSavKnowledgeByRequest({ requests: batch.map(topic => ({ id: topic.id, summary: topic.query })), locale: scope.locale, audience: scope.audience, now: scope.now }, backend);
    revisions.add(result.revision);
    for (const topic of batch) {
      const found = result.requests.find(row => row.requestId === topic.id);
      const cards = (found?.candidateKeys ?? []).flatMap(key => {
        const source = result.sources.find(row => row.key === key);
        return source ? [{ knowledgeId: source.id, contentVersionId: source.contentVersionId, title: source.title }] : [];
      });
      const status: CaseFamilyTopicInventory["status"] = cards.length ? "covered" : found?.status === "no_source" ? "gap"
        : found?.status === "search_unavailable" || found?.status === "revision_unstable" ? "search_unavailable" : "not_searched";
      rows.push({ topic: topic.id, decision: topic.decision, status, cards });
    }
  }
  // One revision across batches, or the inventory mixes two states of the knowledge base and says so.
  return { revision: revisions.size === 1 ? [...revisions][0]! : null, consistent: revisions.size === 1, topics: rows,
    gaps: rows.filter(row => row.status !== "covered" || row.decision === "decision_pending").map(row => row.topic) };
}
