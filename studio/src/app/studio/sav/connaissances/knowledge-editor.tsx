"use client";

import type { CanonicalKnowledge, SemanticStep } from "@/lib/knowledge/contracts";
import styles from "./workspace.module.css";

export const emptyKnowledgeDocument: CanonicalKnowledge = {
  schemaVersion: 1, objective: "", applicability: "sav_only", locale: "fr-FR", productVersion: "",
  prerequisites: [], expectedResult: "", exceptions: [], escalation: "", steps: [],
};

export function cleanKnowledgeDocument(document: CanonicalKnowledge): CanonicalKnowledge {
  const lines = (values: string[]) => values.map(value => value.trim()).filter(Boolean);
  return { ...document, prerequisites: lines(document.prerequisites), exceptions: lines(document.exceptions),
    steps: document.steps.map(step => ({ ...step, prerequisites: lines(step.prerequisites), exceptions: lines(step.exceptions) })),
    ...(document.supportContext ? { supportContext: { ...document.supportContext, symptoms: lines(document.supportContext.symptoms), diagnosticQuestions: lines(document.supportContext.diagnosticQuestions) } } : {}),
  };
}

export function KnowledgeEditor({ document, onChange, disabled = false }: { document: CanonicalKnowledge; onChange: (document: CanonicalKnowledge) => void; disabled?: boolean }) {
  function updateStep(index: number, patch: Partial<SemanticStep>) {
    onChange({ ...document, steps: document.steps.map((step, position) => position === index ? { ...step, ...patch } : step) });
  }
  return <fieldset disabled={disabled} className={styles.editor}>
    <legend>Contenu de la connaissance</legend>
    <label>Demande couverte et valeur pour le client<textarea maxLength={500} rows={3} value={document.objective} onChange={event => onChange({ ...document, objective: event.target.value })}/></label>
    <label>Conditions et prérequis — un par ligne<textarea rows={3} value={document.prerequisites.join("\n")} onChange={event => onChange({ ...document, prerequisites: event.target.value.split("\n") })}/></label>
    <h3>Procédure à suivre</h3>
    {document.steps.map((step, index) => <fieldset key={step.id}>
      <legend>Étape {index + 1}</legend>
      <label>Nom de l’étape<input maxLength={500} value={step.userLabel} onChange={event => updateStep(index, { userLabel: event.target.value })}/></label>
      <label>But de l’étape<input maxLength={500} value={step.objective} onChange={event => updateStep(index, { objective: event.target.value })}/></label>
      <label>Instruction<textarea maxLength={2000} rows={3} value={step.instruction} onChange={event => updateStep(index, { instruction: event.target.value })}/></label>
      <label>Résultat observable<textarea maxLength={5000} rows={2} value={step.expectedResult} onChange={event => updateStep(index, { expectedResult: event.target.value })}/></label>
      <details><summary>Emplacement, conditions et limites de cette étape</summary>
        <div className={styles.editor}>
          <label>Emplacement dans le produit<input maxLength={200} value={step.location} onChange={event => updateStep(index, { location: event.target.value })}/></label>
          <label>Conditions — une par ligne<textarea value={step.prerequisites.join("\n")} onChange={event => updateStep(index, { prerequisites: event.target.value.split("\n") })}/></label>
          <label>Exceptions — une par ligne<textarea value={step.exceptions.join("\n")} onChange={event => updateStep(index, { exceptions: event.target.value.split("\n") })}/></label>
          <label>Quand passer la main<textarea maxLength={5000} value={step.escalation} onChange={event => updateStep(index, { escalation: event.target.value })}/></label>
        </div>
      </details>
      {step.variants.length > 0 && <p className={styles.alert}>Cette étape contient des variantes de contexte. Elles sont conservées et doivent être qualifiées avant validation.</p>}
      <button type="button" className="secondary" onClick={() => onChange({ ...document, steps: document.steps.filter((_, position) => position !== index) })}>Retirer l’étape {index + 1}</button>
    </fieldset>)}
    <div><button type="button" className="secondary" disabled={document.steps.length >= 50} onClick={() => onChange({ ...document, steps: [...document.steps, { id: `step.${crypto.randomUUID()}`, userLabel: "", objective: "", instruction: "", location: "", expectedResult: "", prerequisites: [], exceptions: [], escalation: "", variants: [] }] })}>Ajouter une étape</button></div>
    <label>Résultat attendu de la procédure<textarea maxLength={5000} value={document.expectedResult} onChange={event => onChange({ ...document, expectedResult: event.target.value })}/></label>
    <label>Exceptions et limites — une par ligne<textarea value={document.exceptions.join("\n")} onChange={event => onChange({ ...document, exceptions: event.target.value.split("\n") })}/></label>
    <label>Quand et comment passer la main<textarea maxLength={5000} value={document.escalation} onChange={event => onChange({ ...document, escalation: event.target.value })}/></label>
    <details><summary>Contexte de diagnostic et validité</summary><div className={styles.editor}>
      <label>Situations ou symptômes — un par ligne<textarea value={document.supportContext?.symptoms.join("\n") ?? ""} onChange={event => onChange({ ...document, supportContext: { ...(document.supportContext ?? { symptoms: [], diagnosticQuestions: [], responseTemplate: "" }), symptoms: event.target.value.split("\n") } })}/></label>
      <label>Questions de diagnostic — une par ligne<textarea value={document.supportContext?.diagnosticQuestions.join("\n") ?? ""} onChange={event => onChange({ ...document, supportContext: { ...(document.supportContext ?? { symptoms: [], diagnosticQuestions: [], responseTemplate: "" }), diagnosticQuestions: event.target.value.split("\n") } })}/></label>
      <label>Version du produit, si connue<input maxLength={100} value={document.productVersion} onChange={event => onChange({ ...document, productVersion: event.target.value })}/></label>
      <label>Fin de validité, si applicable<input type="date" value={document.validUntil ?? ""} onChange={event => { const next = { ...document }; if (event.target.value) next.validUntil = event.target.value; else delete next.validUntil; onChange(next); }}/></label>
    </div></details>
  </fieldset>;
}
