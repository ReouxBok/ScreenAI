import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";
import { onboardingSectionLabels } from "@/lib/knowledge/onboarding-sections";

export function KnowledgeDocument({ document }: { document: CanonicalKnowledge }) {
  const checkLabel = (id: string | null) => {
    const check = document.diagnostic?.checks.find(c => c.id === id);
    return id ? `${document.steps.find(step => step.id === check?.evidenceStepId)?.userLabel ?? id} (${id})` : "Arrêter et vérifier avec un humain";
  };
  return <section aria-label="Connaissance complète" style={{ maxWidth: "80ch", lineHeight: 1.65 }}>
    <h3>Objectif et valeur</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.objective}</p>
    {document.supportContext && <>
      {document.supportContext.symptoms.length > 0 && <><h3>Quand utiliser cette connaissance</h3><ul>{document.supportContext.symptoms.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {document.supportContext.diagnosticQuestions.length > 0 && <><h3>Questions de diagnostic</h3><ul>{document.supportContext.diagnosticQuestions.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    </>}
    {document.onboardingContext?.entryPoint && <><h3>Point d’entrée</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.onboardingContext.entryPoint}</p></>}
    {document.diagnostic && <>
      <h3>Informations nécessaires au diagnostic</h3>
      <ul>{document.diagnostic.requiredFacts.map(f => <li key={f.key}><strong>{f.label} ({f.key})</strong> : {f.question}
        {f.questionEn && <p>Question en anglais : {f.questionEn}</p>}
        <p>Nécessaire avant : {f.requiredFor.length ? f.requiredFor.map(checkLabel).join(", ") : "Aucun contrôle spécifié"}</p>
      </li>)}</ul>
      <h3>Contrôles diagnostiques</h3><ol>{document.diagnostic.checks.map(c => <li key={c.id}>
        <h4>{checkLabel(c.id)}</h4><p>{c.instruction}</p>
        <p>Étape source : {c.evidenceStepId}</p>
        <p>Informations préalables : {c.prerequisites.join(", ") || "Aucune"}</p>
        <p>Résultat attendu : {c.expectedResult || "À confirmer."}</p>
        <p>Si le résultat est obtenu : {checkLabel(c.ifExpected)}</p>
        <p>Si le résultat n’est pas obtenu : {checkLabel(c.ifNot)}</p>
      </li>)}</ol>
      <h3>Causes documentées et preuves</h3><ul>{document.diagnostic.knownCauses.map((c, index) => <li key={index}>
        <p>Symptôme : {c.symptom}</p><p>Cause : {c.cause}</p><p>Correction : {c.fix}</p>
        <p>Contrôles de preuve : {c.evidence.map(checkLabel).join(", ")}</p>
      </li>)}</ul>
    </>}
    <h3>Prérequis</h3>{document.prerequisites.length ? <ul>{document.prerequisites.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>Non renseignés dans cette proposition.</p>}
    <h3>Procédure</h3>{document.steps.length ? <ol>{document.steps.map((step) => <li key={step.id} style={{ marginBottom: 20 }}>
      <h4>{step.userLabel}</h4><p style={{ whiteSpace: "pre-wrap" }}>{step.instruction}</p>
      {step.location && <p><strong>Emplacement :</strong> {step.location}</p>}
      {step.prerequisites.length > 0 && <><strong>Conditions de l’étape</strong><ul>{step.prerequisites.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      <p><strong>Résultat observable :</strong> {step.expectedResult || "À confirmer."}</p>
      {step.exceptions.length > 0 && <><strong>Exceptions</strong><ul>{step.exceptions.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {step.escalation && <p><strong>Passage à un humain :</strong> {step.escalation}</p>}
      {step.variants.map((variant, index) => <details key={index}><summary>Variante · {variant.roles.join(", ") || "Rôle à qualifier"}{variant.productVersion ? ` · ${variant.productVersion}` : ""}</summary><p>{variant.instruction}</p><p>Résultat : {variant.expectedResult || "À confirmer."}</p></details>)}
    </li>)}</ol> : <p>La procédure reste à compléter à partir de preuves.</p>}
    <h3>Résultat attendu</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.expectedResult || "À confirmer."}</p>
    <h3>Exceptions et limites</h3>{document.exceptions.length ? <ul>{document.exceptions.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>Non renseignées dans cette proposition.</p>}
    <h3>Passage à un humain</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.escalation || "À préciser."}</p>
    {Boolean(document.onboardingContext?.sourceSections?.length) && <details><summary>Sections sourcées et qualification · {document.onboardingContext?.sourceSections?.length}</summary>
      {document.onboardingContext?.sourceSections?.map((section) => <section key={section.id}><h4>{section.heading}</h4><p>{onboardingSectionLabels[section.classification]}</p><p style={{ whiteSpace: "pre-wrap" }}>{section.content}</p>{section.rationale && <p>Justification : {section.rationale}</p>}</section>)}
    </details>}
    {document.onboardingContext && document.onboardingContext.sourceNotes.length > 0 && <details><summary>Précisions complémentaires de la source · {document.onboardingContext.sourceNotes.length}</summary>{document.onboardingContext.sourceNotes.map((value, index) => <p key={index} style={{ whiteSpace: "pre-wrap" }}>{value}</p>)}</details>}
    {document.supportContext?.responseTemplate && <details><summary>Exemple de réponse à adapter</summary><p style={{ whiteSpace: "pre-wrap" }}>{document.supportContext.responseTemplate}</p></details>}
    {(document.productVersion || document.validUntil) && <p>{document.productVersion && `Version produit : ${document.productVersion}. `}{document.validUntil && `Validité : ${document.validUntil}.`}</p>}
  </section>;
}
