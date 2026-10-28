import type { ComparisonActionState } from "./actions";
export const COMPARISON_RESPONSE_LOST = "SAV_INTAKE_COMPARISON_RESPONSE_LOST";
export async function comparisonActionResponse(
  action: (previous: ComparisonActionState, form: FormData) => Promise<ComparisonActionState>,
  previous: ComparisonActionState, form: FormData,
): Promise<ComparisonActionState> {
  try { return await action(previous, form); }
  catch { return { ok: false, code: COMPARISON_RESPONSE_LOST,
    message: "La réponse n’a pas été reçue. Le dossier peut avoir été comparé et facturé. Consultez le rapport avant de poursuivre ; aucun nouvel essai n’a été lancé." }; }
}
