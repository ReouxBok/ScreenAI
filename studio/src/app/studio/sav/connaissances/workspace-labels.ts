import type { SavKnowledgeRow, SavKnowledgeTab } from "@/lib/knowledge/workspace-contract";

export const knowledgeTabs: Record<SavKnowledgeTab, string> = { production: "En production", automatic: "À valider apprentissage automatique", human: "À valider proposition Humaine" };
export const knowledgeStateLabels: Record<string, string> = {
  active: "En production", production: "En production", draft: "Brouillon interne", pending: "À valider", submitted: "À valider",
  needs_completion: "Complément demandé", needs_recording: "Source à compléter", not_applicable: "Périmètre à qualifier",
  approved: "Validée · à publier", awaiting_publication: "Validée · à publier", approved_unpublished: "Validée · à publier",
  published: "Publiée · à activer", awaiting_activation: "Publiée · à activer", published_inactive: "Publiée · à activer",
  indexing: "Indexation en cours", index_pending: "Indexation en attente", indexing_pending: "Indexation en attente",
  index_error: "Indexation en erreur", indexing_error: "Indexation en erreur", rejected: "Écartée", unknown: "À qualifier", learning: "Résolution à transformer",
};
export function knowledgeState(state: string) { return knowledgeStateLabels[state] ?? "État à vérifier"; }
export function knowledgeDetailUrl(row: Pick<SavKnowledgeRow, "id" | "kind">, from?: string) {
  const query = new URLSearchParams({ kind: row.kind }); if (from) query.set("from", from);
  return `/studio/sav/connaissances/${encodeURIComponent(row.id)}?${query}`;
}
export function safeKnowledgeReturn(value?: string) {
  if (!value) return "/studio/sav/connaissances";
  try { const url = new URL(value, "https://studio.invalid"); return url.origin === "https://studio.invalid" && url.pathname === "/studio/sav/connaissances" ? `${url.pathname}${url.search}` : "/studio/sav/connaissances"; } catch { return "/studio/sav/connaissances"; }
}
export function knowledgeErrorMessage(code: string) {
  if (/FORBIDDEN|UGO_APPROVAL|ACCESS|UNAUTHORIZED/.test(code)) return "Cette action est réservée à un compte autorisé. La publication et l’activation sont réservées à Ugo.";
  if (/STALE|CHANGED|CONFLICT/.test(code)) return "La proposition, sa source ou la version active a changé. Rechargez la fiche et comparez les versions avant de confirmer à nouveau. La version active est conservée.";
  if (/SOURCE|EVIDENCE|INCOMPLETE|COMPLETION|MISSING/.test(code)) return "Les sources ou les informations nécessaires sont incomplètes. Complétez la proposition avant de la soumettre ou de la valider.";
  if (/INDEX|EMBEDDING/.test(code)) return "L’indexation n’a pas abouti. La version utilisée par l’agent est conservée ; reprenez la publication après vérification.";
  if (/DUPLICATE|FAMILY|TARGET/.test(code)) return "Vérifiez la connaissance existante et les sujets proches avant de poursuivre. Une amélioration doit rester liée à sa connaissance d’origine.";
  if (/REASON/.test(code)) return "Ajoutez un motif précis pour conserver la trace de cette décision.";
  return "L’action n’a pas abouti. Vérifiez le contenu et les sources, puis réessayez. Vos saisies sont conservées.";
}

export function knowledgeHistoryLabel(action: string) {
  const labels: Record<string, string> = { knowledge_candidate_approved: "Proposition validée", knowledge_candidate_rejected: "Proposition écartée", knowledge_candidate_completion_requested: "Complément demandé", sav_knowledge_proposal_saved: "Brouillon enregistré", sav_knowledge_proposal_submitted: "Proposition soumise", sav_knowledge_activated: "Version activée pour le SAV", published: "Version publiée", content_published: "Version publiée", content_ai_enabled: "Utilisation activée", content_ai_disabled: "Utilisation suspendue" };
  return labels[action] ?? "Événement de suivi de la connaissance";
}
