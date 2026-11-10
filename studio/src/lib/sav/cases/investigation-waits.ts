import { describeCaseModelTransportDiagnostic } from "./investigation-transport-diagnostic";
import { caseDecisionNextStepLabels, classifyCaseDecisionRefusal } from "./decision-recovery";
import type { CaseInvestigationProgress, CaseInvestigationWaitReason } from "./investigation-runner";

/*
 * No silent queue (Ugo, 27/10/2026): every investigation that is not progressing is listed, oldest first,
 * with its reason, how long it has waited and what unblocks it. Pure projection of stored progress rows:
 * no threshold is invented here, every wait is shown from its first minute. The console screen that reads
 * these rows needs the shared progress storage (pole A) and is not built yet.
 */

export const caseInvestigationWaitLabels: Record<CaseInvestigationWaitReason, { label: string; unblock: string; needsPerson: boolean }> = {
  deferred_budget: { label: "Budget modèle indisponible : aucun appel consommé.", unblock: "Reprise automatique quand le budget le permet.", needsPerson: false },
  case_budget: { label: "Plafond d'appels du dossier atteint sur la période : aucun appel consommé.", unblock: "Reprise automatique quand la période libère des appels ; un dossier qui l'atteint souvent mérite un regard.", needsPerson: false },
  technical_wait: { label: "Échec technique de génération : cause précise non enregistrée, appels restants conservés.", unblock: "Nouvelle tentative au prochain passage, dans le même plafond.", needsPerson: false },
  usage_uncertain: { label: "Appel au résultat incertain : aucun nouvel appel avant vérification.", unblock: "Vérification de l'appel par le registre des appels.", needsPerson: false },
  paused: { label: "Agent V2 en pause pendant l'investigation.", unblock: "Reprise à la levée de la pause, sans appel perdu.", needsPerson: false },
  technical_exhausted: { label: "Tous les appels permis ont échoué techniquement.", unblock: "Une personne doit examiner la panne : aucune reprise automatique.", needsPerson: true },
  decision_refused: { label: "Décision toujours refusée après les corrections permises.", unblock: "L'équipe reprend le dossier avec le rapport : éléments vérifiés, motif du refus, ce qui manque.", needsPerson: true },
  knowledge_request_invalid: { label: "Recherche de connaissances refusée avant tout appel : demande hors limites (clé d'entrée, nombre ou taille des requêtes, taille des vecteurs). Aucun coût.", unblock: "Défaut du code appelant : une personne l'examine ; aucune reprise automatique.", needsPerson: true },
  knowledge_changed: { label: "Connaissances modifiées pendant l'investigation (fiche publiée, archivée ou désactivée), ou version illisible : rien n'est appelé ni enregistré sur l'ancienne version.", unblock: "Nouvelle recherche et revalidation de la proposition au prochain passage, dans le même plafond d'appels ; un embedding déjà payé n'est pas repayé.", needsPerson: false },
  context_invalid: { label: "Contexte de décision impossible à construire depuis le dossier : aucun appel de génération (modèle). La recherche de connaissances a pu être payée : voir le nombre d'embeddings.", unblock: "Une personne examine le code motif ; aucune reprise automatique.", needsPerson: true },
};

export type CaseInvestigationWaitRow = { caseId: string; inputKey: string; progress: CaseInvestigationProgress };
export type CaseInvestigationWaitItem = {
  caseId: string; inputKey: string; caseVersion: number; reason: CaseInvestigationWaitReason;
  since: string; waitingMinutes: number; modelCalls: number; label: string; unblock: string; needsPerson: boolean;
  /** Closed reason code of a context that could not be built (never a raw message), and the embedding calls already sent. */
  problem: string | null; embeddingCalls: number | null;
  /** For a refused decision: the next step its refusal calls for (ask, team, review the model output...). */
  refusalNextStep: string | null;
};

export function listCaseInvestigationWaits(rows: readonly CaseInvestigationWaitRow[], now: Date): CaseInvestigationWaitItem[] {
  return rows.flatMap(({ caseId, inputKey, progress }) => {
    const wait = progress.waiting;
    if (!wait) return [];
    // An unreadable date is shown as the oldest possible wait rather than hidden.
    const since = Date.parse(wait.since), waitingMinutes = Number.isFinite(since) ? Math.max(0, Math.floor((now.getTime() - since) / 60_000)) : Number.MAX_SAFE_INTEGER;
    const refusal = wait.reason === "decision_refused" && progress.last?.outcome === "needs_review" ? classifyCaseDecisionRefusal(progress.last.rejections) : null;
    const diagnostic = describeCaseModelTransportDiagnostic(wait.diagnostic);
    return [{ caseId, inputKey, caseVersion: wait.caseVersion, reason: wait.reason, since: wait.since, waitingMinutes, modelCalls: progress.modelCalls, problem: wait.problem ?? null, embeddingCalls: wait.embeddingCalls ?? null,
      ...caseInvestigationWaitLabels[wait.reason], ...(diagnostic ? { label: `${diagnostic.label} ${diagnostic.detail}` } : {}), refusalNextStep: refusal ? caseDecisionNextStepLabels[refusal.nextStep] : null }];
  }).sort((a, b) => Number(b.needsPerson) - Number(a.needsPerson) || b.waitingMinutes - a.waitingMinutes || a.caseId.localeCompare(b.caseId));
}
