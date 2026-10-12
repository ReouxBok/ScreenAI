import type { SavStructuredProposal } from "@/lib/sav/proposal";
import { savCategoryLabels, savLabel } from "@/lib/sav/labels";

const natureLabels: Record<string, string> = {
  technical: "Dysfonctionnement", technical_issue: "Dysfonctionnement", incident: "Dysfonctionnement", account: "Compte et accès", account_access: "Compte et accès",
  financial_operation: "Opération financière sur le compte", financial_data: "Informations financières du compte", integration: "Intégration", how_to: "Aide à l’utilisation",
  cancellation: "Résiliation", commercial: "Demande commerciale", callback: "Demande de rappel", human_request: "Demande de prise en charge humaine", security: "Sécurité", privacy: "Confidentialité", data_deletion: "Suppression de données", legal: "Demande juridique", non_support: "Demande hors support", acknowledgement: "Accusé de réception", unknown: "Demande à qualifier",
};
const uncertaintyLabels: Record<string, string> = {
  ambiguous_intent: "La demande reste ambiguë.",
  missing_context: "Le contexte disponible est incomplet.", missing_information: "Des informations manquent pour conclure.",
  conflicting_evidence: "Les éléments disponibles se contredisent.", ambiguous_financial_scope: "La portée financière doit être clarifiée.",
  provider_unavailable: "Le fournisseur IA est indisponible.", invalid_output: "Le résultat IA ne respecte pas le contrat de compréhension.", unread_attachment: "Une pièce jointe n’a pas été lue.", truncated_context: "Une partie du contexte n’a pas pu être analysée.",
};

/** The original diagnosis remains distinct from the editable human process. */
export function UnderstandingReview({ original, corrected }: { original: SavStructuredProposal; corrected: SavStructuredProposal }) {
  const u = original.understanding;
  if (!u) return <section aria-label="Compréhension initiale"><h3>Compréhension initiale</h3><p>Analyse historique : compréhension structurée non disponible. Relisez la demande et sa qualification.</p></section>;
  const primary = u.requests.find(request => request.id === u.primaryRequestId);
  const secondary = u.requests.filter(request => request.id !== u.primaryRequestId);
  const usedEvidence = new Set(u.requests.flatMap(request => request.evidenceIds));
  return <section aria-label="Compréhension initiale">
    <h3>Compréhension initiale de l’IA</h3>
    <p role="status">{u.status === "unavailable" ? "Analyse indisponible : la demande doit être qualifiée humainement." : u.status === "needs_clarification" ? "Demande à qualifier : des incertitudes restent à lever." : "Compréhension proposée · à vérifier dans le message."}</p>
    <p><strong>Demande principale :</strong> {primary?.summary ?? "Non déterminée"}</p>
    {primary && <p>Nature : {natureLabels[primary.nature] ?? "Demande à qualifier"}{primary.product ? ` · produit : ${primary.product}` : ""}{primary.feature ? ` · fonction : ${primary.feature}` : ""}.</p>}
    {secondary.length > 0 && <><h4>Autres demandes</h4><ul>{secondary.map(request => <li key={request.id}>{request.summary}</li>)}</ul></>}
    <p>Catégorie IA d’origine : <strong>{savLabel(savCategoryLabels, original.category)}</strong>.</p>
    {original.category !== corrected.category && <p>Catégorie corrigée humainement : <strong>{savLabel(savCategoryLabels, corrected.category)}</strong>. Le diagnostic initial est conservé.</p>}
    <p>Justification initiale : {original.decision.explanation}</p>
    {u.evidence.filter(evidence => usedEvidence.has(evidence.id)).length > 0 && <details><summary>Éléments retenus dans les sources</summary>{u.evidence.filter(evidence => usedEvidence.has(evidence.id)).map(evidence => <blockquote key={evidence.id}><p>{evidence.excerpt}</p><cite>{evidence.source === "current_message" ? "Message actuel" : evidence.source === "history" ? "Historique du fil" : "Contexte CRM"}</cite></blockquote>)}</details>}
    {u.knownFacts.length > 0 && <><h4>Éléments connus</h4><ul>{u.knownFacts.map((fact, index) => <li key={index}>{fact.text}</li>)}</ul></>}
    {u.attemptedSteps.length > 0 && <><h4>Déjà essayé par le client</h4><ul>{u.attemptedSteps.map((step, index) => <li key={index}>{step.text}</li>)}</ul></>}
    {u.missingInformation.length > 0 && <><h4>Informations manquantes</h4><ul>{u.missingInformation.map(item => <li key={item.id}>{item.text}</li>)}</ul></>}
    {u.uncertainties.length > 0 && <><h4>Incertitudes</h4><ul>{u.uncertainties.map((item, index) => <li key={index}>{uncertaintyLabels[item.code] ?? "Un élément de compréhension reste à vérifier dans les sources."}</li>)}</ul></>}
  </section>;
}
