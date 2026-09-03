import { prepareEvaluationAction, startEvaluationRunAction } from "@/app/studio/actions";
import type { evaluationCases, evaluationRuns, evaluationSuites } from "@/db/schema";
import { EvaluationAutoRefresh } from "@/components/evaluation-auto-refresh";

type EvaluationData = {
  suite: typeof evaluationSuites.$inferSelect;
  cases: Array<typeof evaluationCases.$inferSelect>;
  runs: Array<typeof evaluationRuns.$inferSelect>;
};

const label = (status: string) => status === "passed" ? "Flow réussi" : status === "failed" ? "À corriger" : status === "running" ? "Test en cours" : status === "ready" ? "À lancer" : "Non testé";

export function ContentEvaluationPanel({ itemId, data, testCode, testCaseId, required }: { itemId: string; data: EvaluationData | null; testCode?: string; testCaseId?: string; required?: boolean }) {
  const latest = new Map<string, typeof evaluationRuns.$inferSelect>();
  for (const run of data?.runs ?? []) if (!latest.has(run.caseId)) latest.set(run.caseId, run);
  const testCase = data?.cases[0];
  const run = testCase ? latest.get(testCase.id) : undefined;
  return <section className="content-evaluation card" id="content-evaluation">
    <EvaluationAutoRefresh active={run?.status === "ready" || run?.status === "running"}/>
    <div className="evaluation-heading">
      <div><span className="eyebrow">Un test · tout le flow</span><h2>Vérifier le parcours complet avec Charly</h2><p>Une seule conversation en conditions réelles vérifie la compréhension, les clics, la saisie, la navigation et le résultat final. Le brouillon est isolé et la conversation n’est pas mémorisée.</p></div>
      {data && <div className={`evaluation-score ${data.suite.status}`}><strong>{data.suite.score ?? "—"}</strong><span>/100</span></div>}
    </div>
    {required && <p className="login-error" role="alert">Le flow complet doit réussir avant l’envoi à l’administrateur.</p>}
    {!data ? <form action={prepareEvaluationAction}><input type="hidden" name="itemId" value={itemId}/><button className="primary" type="submit">Préparer le test complet</button></form> : <>
      {testCode && <div className="evaluation-code" role="status"><div><strong>Code prêt pour l’extension</strong><p>Ouvrez Limova, puis choisissez <b>Menu → Tester un parcours</b>.</p></div><code>{testCode}</code></div>}
      {testCase && <div className="evaluation-cases"><article className="evaluation-case evaluation-case-single">
        <div className="evaluation-case-index">01</div>
        <div><div className="evaluation-case-title"><strong>{testCase.title}</strong><span>Obligatoire</span></div><p>Demandez à Charly d’atteindre l’objectif puis laissez-la réaliser l’ensemble du parcours.</p><small>Objectif : {testCase.expectation.objective} · Départ : {testCase.expectation.startPath}</small></div>
        <div className="evaluation-case-action"><span className={`status ${run?.status ?? "not_run"}`}>{label(run?.status ?? "not_run")}{run?.score != null ? ` · ${run.score}/100` : ""}</span><form action={startEvaluationRunAction}><input type="hidden" name="itemId" value={itemId}/><input type="hidden" name="caseId" value={testCase.id}/><button className="button small secondary" type="submit">{run ? "Retester le flow complet" : "Tester le flow complet"}</button></form>{testCode && testCaseId === testCase.id && <small>Le même code couvre tout le parcours</small>}</div>
      </article></div>}
      <div className={`evaluation-gate ${data.suite.status}`}><strong>{data.suite.status === "passed" ? "Prêt pour la review" : "Validation encore verrouillée"}</strong><span>{data.suite.status === "passed" ? "Le flow complet a réussi sur cette version." : "Terminez le flow dans l’extension puis confirmez son résultat une seule fois."}</span></div>
    </>}
  </section>;
}
