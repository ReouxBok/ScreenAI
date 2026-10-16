/** Presentation state only. No model call, provider lookup or mutation. */
const savDossierStates = ["to_process", "to_validate", "learning", "completed"] as const;
export type SavDossierState = typeof savDossierStates[number];
export const savDashboardViews = [...savDossierStates, "other"] as const;
export type SavDashboardView = typeof savDashboardViews[number];
export const savDashboardLabels: Record<SavDashboardView, string> = {
  to_process: "À traiter", to_validate: "À valider", learning: "Suivi HubSpot", completed: "Terminés",
  other: "Autre",
};
export type SavOpeningState = "unopened" | "opened" | "unknown";
export type SavTicketProgress = "not_required" | "required" | "pending" | "uncertain" | "failed" | "confirmed";
export type SavLearningProgress = "none" | "waiting_ticket" | "collecting" | "incomplete" | "catchup" | "qualification" | "candidate";
export function classifySavDossier(input: { opening: SavOpeningState; reviewStatus: string | null; ticket: SavTicketProgress; learning: SavLearningProgress }): SavDossierState {
  if (input.opening === "unopened") return "to_process";
  if (input.reviewStatus !== "approved" || !["confirmed", "not_required"].includes(input.ticket)) return "to_validate";
  if (input.learning !== "none") return "learning";
  return "completed";
}
export function savDashboardNextAction(input: { state: SavDossierState; reviewStatus: string | null; ticket: SavTicketProgress; learning: SavLearningProgress; analysisFailed: boolean }) {
  if (input.state === "to_process") return "Ouvrir et qualifier la demande";
  if (input.reviewStatus !== "approved") return input.reviewStatus === "rejected" ? "Corriger et valider le dossier" : input.analysisFailed ? "Qualifier la demande manuellement" : "Relire et valider le dossier";
  if (input.ticket === "uncertain") return "Vérifier le résultat HubSpot avant toute reprise";
  if (input.ticket === "pending") return "Attendre la confirmation de l’action ticket";
  if (input.ticket === "failed") return "Vérifier l’échec de l’action ticket";
  if (input.ticket === "required") return "Choisir et confirmer l’action ticket";
  const learning = { waiting_ticket: "Vérifier le ticket à suivre", collecting: "Suivre la résolution humaine", incomplete: "Compléter les preuves de résolution", catchup: "Attendre le dernier rattrapage", qualification: "Qualifier le bilan de résolution", candidate: "Examiner la connaissance proposée", none: input.ticket === "not_required" ? "Dossier validé, sans ticket nécessaire" : "Traitement Studio terminé" };
  return learning[input.learning];
}
export function savDashboardReturnHref(raw: unknown) {
  if (typeof raw !== "string" || !raw.startsWith("/studio/sav?") || raw.length > 1_500) return "/studio/sav";
  const url = new URL(raw, "https://studio.invalid");
  if (url.pathname !== "/studio/sav" || url.origin !== "https://studio.invalid") return "/studio/sav";
  const params = new URLSearchParams();
  for (const key of ["view", "q", "page", "sort"]) { const value = url.searchParams.get(key); if (value) params.set(key, value.slice(0, key === "q" ? 200 : 30)); }
  const anchor = /^#dossier-[a-f0-9-]{36}$/i.test(url.hash) ? url.hash : "";
  return `/studio/sav?${params}${anchor}`;
}
