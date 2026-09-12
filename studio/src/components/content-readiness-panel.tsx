import type { ContentReadiness } from "@/lib/content-readiness";

const statusLabel = {
  complete: "Déjà renseigné",
  staff: "À compléter par le staff",
  demonstration: "À démontrer ou tester",
} as const;

export function ContentReadinessPanel({ readiness }: { readiness: ContentReadiness }) {
  return <section className="content-readiness card" aria-labelledby="content-readiness-title">
    <header>
      <div><span className="eyebrow">Complétude du parcours</span><h2 id="content-readiness-title">Ce qu’il reste à transmettre à Charly</h2></div>
      <strong>{readiness.completed}/{readiness.total}</strong>
    </header>
    <div className="readiness-meter" aria-label={`${readiness.percent} % complété`}><span style={{ width: `${readiness.percent}%` }}/></div>
    <ul>{readiness.checks.map((check) => <li className={`readiness-${check.status}`} key={check.key}>
      <span aria-hidden="true">{check.status === "complete" ? "✓" : check.status === "staff" ? "?" : "!"}</span>
      <div><strong>{check.label}</strong><small>{statusLabel[check.status]} · {check.guidance}</small></div>
    </li>)}</ul>
    {readiness.sourcePaths.length > 0 && <details><summary>Sources techniques consultées</summary><ul className="readiness-sources">{readiness.sourcePaths.map((source) => <li key={source}><code>{source}</code></li>)}</ul></details>}
  </section>;
}
